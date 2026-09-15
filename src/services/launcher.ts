import { exec } from "../lib/exec.ts";
import type { AgentKind, TerminalKind } from "../state/types.ts";

/** Escapes a JS string for embedding in an AppleScript string literal. */
function asStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One POSIX shell word, safe across nested login-shell commands. */
export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** Applied centrally to fresh, resumed and clipboard-fallback launches. */
export function agentArgs(agent: AgentKind, args: string[] = []): string[] {
  if (agent === "shell") return [];
  const flag = agent === "claude" ? "--dangerously-skip-permissions" : "--yolo";
  return [...args.filter(a => a !== flag), flag];
}

export type ResolvedTerminal = Exclude<TerminalKind, "auto">;

export interface LaunchOptions {
  /** Working directory for the new session — the workspace's main worktree */
  cwd: string;
  agent: AgentKind;
  /** Extra argv for the agent, e.g. ["--resume", "<id>"] */
  args?: string[];
  /** Handed to the session after it boots; not submitted, so it stays editable */
  initialText?: string;
  terminal: TerminalKind;
  target: "window" | "tab";
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
  /** True when the terminal could not pre-type the prompt (clipboard instead) */
  promptNotTyped?: boolean;
  terminal: ResolvedTerminal;
  /** Stable surface id, so the session can be re-focused later */
  surfaceId?: string;
  /** Equivalent command, offered to the user when the launch fails */
  fallbackCommand: string;
}

const AGENT_COMMAND: Record<AgentKind, string | null> = {
  claude: "claude",
  codex: "codex",
  shell: null, // null = the user's default login shell
};

const APP_NAME: Record<ResolvedTerminal, string> = {
  ghostty: "Ghostty",
  iterm2: "iTerm",
  "apple-terminal": "Terminal",
};

export const TERMINAL_LABEL: Record<ResolvedTerminal, string> = {
  ghostty: "Ghostty",
  iterm2: "iTerm2",
  "apple-terminal": "Terminal.app",
};

/** Absolute path to an agent binary, or null if it isn't installed. */
export function resolveAgent(agent: AgentKind): string | null {
  const name = AGENT_COMMAND[agent];
  return name ? Bun.which(name) : null;
}

/**
 * The terminal maestro is currently running inside. $TERM_PROGRAM is the most
 * reliable signal of "the terminal this user actually uses" — far better than
 * guessing at a system default, which macOS doesn't really expose.
 */
export function detectTerminal(): ResolvedTerminal {
  switch ((process.env.TERM_PROGRAM ?? "").toLowerCase()) {
    case "ghostty":
      return "ghostty";
    case "iterm.app":
      return "iterm2";
    case "apple_terminal":
      return "apple-terminal";
    default:
      // Ghostty is the richest integration, so it's the least-bad default.
      return "ghostty";
  }
}

export function resolveTerminal(kind: TerminalKind): ResolvedTerminal {
  return kind === "auto" ? detectTerminal() : kind;
}

/**
 * Opens a new session in the user's terminal, `cd`'d into the main worktree,
 * with the agent running and the worktree map handed over.
 *
 * The agent is started as `$SHELL -lc 'exec /abs/path/to/agent'`. Both halves
 * matter: a GUI-launched terminal inherits launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so a bare `claude` never resolves — hence
 * the absolute path — while the login shell loads the profile env the agent
 * would normally see.
 *
 * The prompt is typed but never submitted, so you can edit before sending.
 * Terminal.app is the exception: its AppleScript can only run text, not type
 * it, so there the caller falls back to the clipboard.
 */
export async function launchSession(opts: LaunchOptions): Promise<LaunchResult> {
  const terminal = resolveTerminal(opts.terminal);
  const name = AGENT_COMMAND[opts.agent];
  const binary = name ? Bun.which(name) : null;
  opts = { ...opts, args: agentArgs(opts.agent, opts.args) };
  const argSuffix = opts.args!.length ? ` ${opts.args!.map(shQuote).join(" ")}` : "";
  const fallbackCommand = name ? `cd -- ${shQuote(opts.cwd)} && ${shQuote(binary ?? name)}${argSuffix}` : `cd -- ${shQuote(opts.cwd)}`;

  if (name && !binary) {
    return {
      ok: false,
      terminal,
      fallbackCommand,
      error: `${name} is not installed, or not on maestro's PATH`,
    };
  }

  const script =
    terminal === "ghostty"
      ? ghosttyScript(opts, binary)
      : terminal === "iterm2"
        ? itermScript(opts, binary)
        : appleTerminalScript(opts, binary);

  const res = await exec(["osascript", "-e", script], { timeoutMs: 30_000 });

  // Older Ghostty versions (or stale macOS scripting dictionaries) reject the
  // script before executing it. Only retry compile failures: runtime failures
  // could already have opened a session, so retrying those would duplicate it.
  if (!res.ok && terminal === "ghostty" && /\(-274[01]\)/.test(res.stderr)) {
    const command = agentCommand(binary, opts.args);
    const args = ["open", "-na", "Ghostty", "--args", `--working-directory=${opts.cwd}`];
    if (command) args.push(`--command=${command}`, "--wait-after-command=true");
    const fallback = await exec(args, { timeoutMs: 30_000 });
    return {
      ok: fallback.ok,
      terminal,
      fallbackCommand,
      // The CLI opens a new window and cannot pre-type text or return a surface ID.
      promptNotTyped: fallback.ok && Boolean(opts.initialText),
      error: fallback.ok ? undefined : fallback.stderr || "Could not open Ghostty",
    };
  }

  if (!res.ok) {
    const detail = res.stderr.split("\n")[0]?.trim();
    return {
      ok: false,
      terminal,
      fallbackCommand,
      error: detail?.includes("Application isn't running") || detail?.includes("Can't get application")
        ? `${TERMINAL_LABEL[terminal]} isn't available`
        : detail || `Could not drive ${TERMINAL_LABEL[terminal]} via AppleScript`,
    };
  }

  return {
    ok: true,
    terminal,
    fallbackCommand,
    // Ghostty and iTerm scripts return the new surface's stable id on stdout.
    surfaceId: res.stdout.trim() || undefined,
    promptNotTyped: terminal === "apple-terminal" && Boolean(opts.initialText),
  };
}

/** `$SHELL -lc 'exec "/abs/agent" args…'`, or null for a plain login shell. */
export function agentCommand(binary: string | null, args: string[] = []): string | null {
  if (!binary) return null;
  const loginShell = process.env.SHELL || "/bin/zsh";
  const argv = [shQuote(binary), ...args.map(shQuote)].join(" ");
  return `${shQuote(loginShell)} -lc ${shQuote(`exec ${argv}`)}`;
}

// Agents need a beat to boot before they'll accept input; a shell is ready now.
const settleDelay = (agent: AgentKind) => (agent === "shell" ? 0.2 : 2.0);

function ghosttyScript(opts: LaunchOptions, binary: string | null): string {
  const command = agentCommand(binary, opts.args);

  const config = [
    `set cfg to new surface configuration`,
    `set initial working directory of cfg to ${asStr(opts.cwd)}`,
    `set environment variables of cfg to {${asStr(`PATH=${process.env.PATH ?? ""}`)}}`,
  ];
  if (command) {
    config.push(`set command of cfg to ${asStr(command)}`);
    // Without this, a failed launch closes the surface instantly, hiding why.
    config.push(`set wait after command of cfg to true`);
  }

  // A new window is the default; a tab needs an existing window to attach to.
  const open =
    opts.target === "tab"
      ? [
          `if (count of windows) is 0 then`,
          `  set t to terminal 1 of selected tab of (new window with configuration cfg)`,
          `else`,
          `  set t to terminal 1 of (new tab in window 1 with configuration cfg)`,
          `end if`,
        ]
      : [`set t to terminal 1 of selected tab of (new window with configuration cfg)`];

  const typeIn = opts.initialText
    ? [`delay ${settleDelay(opts.agent)}`, `input text ${asStr(opts.initialText)} to t`]
    : [];

  return [
    `tell application "Ghostty"`,
    `  activate`,
    // `return id of t` hands the stable surface id back so the session can be
    // re-focused later instead of launching a duplicate.
    ...[...config, ...open, `focus t`, ...typeIn, `return id of t`].map((l) => `  ${l}`),
    `end tell`,
  ].join("\n");
}

function itermScript(opts: LaunchOptions, binary: string | null): string {
  const command = agentCommand(binary, opts.args);
  // iTerm has no surface-config equivalent, so the cd happens in the shell.
  const run = command ? `cd -- ${shQuote(opts.cwd)} && exec ${command}` : `cd -- ${shQuote(opts.cwd)}`;

  const open =
    opts.target === "tab"
      ? [
          `if (count of windows) is 0 then`,
          `  set w to (create window with default profile)`,
          `else`,
          `  set w to current window`,
          `  tell w to create tab with default profile`,
          `end if`,
        ]
      : [`set w to (create window with default profile)`];

  // `newline no` types without submitting — iTerm's equivalent of input text.
  const typeIn = opts.initialText
    ? [`delay ${settleDelay(opts.agent)}`, `tell current session of w to write text ${asStr(opts.initialText)} newline no`]
    : [];

  return [
    `tell application "iTerm"`,
    `  activate`,
    ...open.map((l) => `  ${l}`),
    `  tell current session of w to write text ${asStr(run)}`,
    ...typeIn.map((l) => `  ${l}`),
    `  return id of current session of w`,
    `end tell`,
  ].join("\n");
}

function appleTerminalScript(opts: LaunchOptions, binary: string | null): string {
  const command = agentCommand(binary, opts.args);
  const run = command ? `cd -- ${shQuote(opts.cwd)} && exec ${command}` : `cd -- ${shQuote(opts.cwd)}`;

  // Terminal.app's `do script` always executes; there is no type-without-run,
  // so the prompt goes to the clipboard instead (see promptNotTyped).
  return [
    `tell application "Terminal"`,
    `  activate`,
    `  do script ${asStr(run)}`,
    `end tell`,
  ].join("\n");
}

/** True when the named terminal is installed. */
export async function terminalAvailable(kind: ResolvedTerminal): Promise<boolean> {
  const res = await exec(
    ["osascript", "-e", `tell application "System Events" to exists application process ${asStr(APP_NAME[kind])}`],
    { timeoutMs: 5_000 },
  );
  return res.ok;
}
