import { ghosttyListScript, ghosttyFocusScript } from "./ghostty-applescript.ts";
import { exec } from "../lib/exec.ts";
import type { AgentKind } from "../state/types.ts";
import type { ResolvedTerminal } from "./launcher.ts";

/** A live terminal surface (Ghostty terminal / iTerm session). */
export interface OpenSurface {
  id: string;
  title: string;
  /** Empty unless the surface has shell integration — see note below. */
  cwd: string;
}

// Field/record separators: titles can contain almost any printable character,
// so the delimiters have to be ones that can't appear in one.
const FS = ""; // ASCII character 31 (unit separator)
const RS = ""; // ASCII character 30 (record separator)

const PROCESS_MATCH: Record<ResolvedTerminal, string> = {
  ghostty: "Ghostty.app/Contents/MacOS/ghostty",
  iterm2: "iTerm.app/Contents/MacOS/iTerm2",
  "apple-terminal": "Terminal.app/Contents/MacOS/Terminal",
};

/**
 * Whether the terminal app is running. Deliberately not AppleScript: a
 * `tell application` would *launch* the app, which is unacceptable for
 * something polled every few seconds. Uses `ps` rather than `pgrep` because
 * pgrep is unavailable or restricted in some sandboxed environments, while
 * `ps -axo comm=` always lists the caller's own processes.
 */
export async function appRunning(kind: ResolvedTerminal): Promise<boolean> {
  const res = await exec(["ps", "-axo", "comm="], { timeoutMs: 5_000 });
  if (!res.ok) return false;
  return res.stdout.includes(PROCESS_MATCH[kind]);
}

function itermListScript(): string {
  return [
    `tell application "iTerm"`,
    `  set fs to ASCII character 31`,
    `  set rs to ASCII character 30`,
    `  set out to ""`,
    `  repeat with w in windows`,
    `    repeat with tb in tabs of w`,
    `      repeat with s in sessions of tb`,
    `        set out to out & (id of s) & fs & (name of s) & fs & "" & rs`,
    `      end repeat`,
    `    end repeat`,
    `  end repeat`,
    `  return out`,
    `end tell`,
  ].join("\n");
}

/**
 * Every open surface, in one AppleScript call. Returns null when the terminal
 * isn't running or can't be enumerated — callers treat that as "unknown"
 * rather than "nothing is open".
 *
 * Terminal.app is unsupported: its tabs have no stable identifier to track.
 */
export async function listSurfaces(kind: ResolvedTerminal): Promise<OpenSurface[] | null> {
  if (kind === "apple-terminal") return null;
  if (!(await appRunning(kind))) return [];

  const script = kind === "ghostty" ? ghosttyListScript() : itermListScript();
  const res = await exec(["osascript", "-e", script], { timeoutMs: 10_000 });
  if (!res.ok) return null;

  return res.stdout
    .split(RS)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [id = "", title = "", cwd = ""] = record.split(FS);
      return { id: id.trim(), title, cwd: cwd.trim() };
    })
    .filter((s) => s.id.length > 0);
}

/** Brings a surface (and its window) to the front. */
export async function focusSurface(kind: ResolvedTerminal, id: string): Promise<boolean> {
  if (kind === "apple-terminal") return false;

  const script =
    kind === "ghostty"
      ? ghosttyFocusScript(id)
      : `tell application "iTerm"\n  activate\n  select session id ${JSON.stringify(id)}\nend tell`;

  const res = await exec(["osascript", "-e", script], { timeoutMs: 10_000 });
  return res.ok;
}

export interface TitleState {
  agent?: AgentKind;
  /** The agent is mid-turn right now */
  working: boolean;
}

// Claude Code writes its state into the terminal title: a braille spinner frame
// while it's working, and ✳ when it's sitting idle. Codex sets no title at all,
// so its activity is inferred from session-file mtime instead (see session.ts).
const BRAILLE_SPINNER = /^[⠀-⣿]/;
const CLAUDE_IDLE = /^[✳✻✽*]/;

/** Reads agent state out of a terminal title, where the agent publishes one. */
export function parseTitle(title: string): TitleState {
  const t = title.trim();
  if (BRAILLE_SPINNER.test(t)) return { agent: "claude", working: true };
  if (CLAUDE_IDLE.test(t)) return { agent: "claude", working: false };
  return { working: false };
}
