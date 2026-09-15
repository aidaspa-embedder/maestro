#!/usr/bin/env bun
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { version } from "../package.json";

/**
 * Builds maestro into a standalone binary, drops it in a bin directory and
 * makes sure that directory is on $PATH.
 *
 *   bun run install:local
 *   bun run install:local --prefix ~/bin
 *   bun run install:local --no-path
 *
 * A compiled binary rather than a symlink into the checkout, on purpose: the
 * TUI is something you launch from anywhere, and it shouldn't break the next
 * time this repo is mid-edit or its node_modules are being reinstalled.
 */

const ROOT = resolve(import.meta.dir, "..");
const INSTALL_HOME = process.env.HOME || homedir();
const BIN_NAME = "maestro";
const MARKER = "# added by maestro";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

if (flag("--help") || flag("-h")) {
  console.log(
    [
      "usage: bun run install:local [--prefix <dir>] [--no-path]",
      "",
      "  --prefix <dir>   where the binary goes (default: $BUN_INSTALL/bin, else ~/.local/bin)",
      "  --no-path        install only — never write to a shell profile",
      "",
      "  $MAESTRO_BIN_DIR overrides the prefix, $MAESTRO_PROFILE the shell profile.",
    ].join("\n"),
  );
  process.exit(0);
}

// ── output ────────────────────────────────────────────────────────────────────

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const plain = (s: string) => s;
const bold = paint("1");
const dim = paint("2");
const blue = paint("38;5;75");
const green = paint("38;5;78");
const yellow = paint("38;5;179");
const red = paint("38;5;203");

type Tone = (s: string) => string;

const LABEL_W = 14;
const DETAIL_W = 48;

const started = Date.now();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const contract = (p: string) => (p.startsWith(INSTALL_HOME + "/") ? "~" + p.slice(INSTALL_HOME.length) : p);

/** Truncates from the left — the tail of a path is the informative half. */
function fit(text: string, width: number): string {
  return text.length <= width ? text : "…" + text.slice(text.length - width + 1);
}

/** Pads before painting, so ANSI codes never throw the columns off. */
function line(mark: string, label: string, detail: string, tone: Tone, took?: number) {
  const body = fit(detail, DETAIL_W - 2).padEnd(DETAIL_W);
  console.log(`  ${mark} ${bold(label.padEnd(LABEL_W))}${tone(body)}${took === undefined ? "" : dim(secs(took))}`);
}

/** Runs a step, printing it as pending and rewriting the line with the result. */
async function step<T>(label: string, run: () => Promise<[string, T] | [string, T, Tone]>): Promise<T> {
  const at = Date.now();
  if (COLOR) process.stdout.write(`  ${dim("·")} ${bold(label.padEnd(LABEL_W))}${dim("…")}`);
  try {
    const [detail, result, tone] = await run();
    if (COLOR) process.stdout.write("\r\x1b[2K");
    line(green("✓"), label, detail, tone ?? plain, Date.now() - at);
    return result;
  } catch (err) {
    if (COLOR) process.stdout.write("\r\x1b[2K");
    line(red("✗"), label, err instanceof Error ? err.message : String(err), red);
    console.log();
    process.exit(1);
  }
}

function humanSize(bytes: number): string {
  return bytes >= 1 << 20 ? `${Math.round(bytes / (1 << 20))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Bun writes its own progress to stdout when captured, to stderr when not. */
function lastLine(res: { stdout: Buffer; stderr: Buffer }): string {
  return [res.stdout.toString(), res.stderr.toString()]
    .join("\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

// ── where it goes ─────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  if (p === "~") return INSTALL_HOME;
  return p.startsWith("~/") ? join(INSTALL_HOME, p.slice(2)) : p;
}

/**
 * $BUN_INSTALL/bin first: it is where `bun install -g` puts things, so a Bun
 * tool lands beside its siblings and is almost always on $PATH already.
 */
function resolveBinDir(): string {
  const explicit = value("--prefix") ?? process.env.MAESTRO_BIN_DIR;
  if (explicit) return resolve(expandTilde(explicit));
  if (process.env.BUN_INSTALL) return join(resolve(expandTilde(process.env.BUN_INSTALL)), "bin");
  return join(INSTALL_HOME, ".local", "bin");
}

const BIN_DIR = resolveBinDir();
const TARGET = join(BIN_DIR, BIN_NAME);

function isOnPath(dir: string): boolean {
  return (process.env.PATH ?? "").split(":").some((entry) => entry && resolve(expandTilde(entry)) === dir);
}

/** Where a login shell of this kind reads an exported PATH from. */
function profileFor(shell: string): { file: string; add: (dir: string) => string } {
  const override = process.env.MAESTRO_PROFILE;
  const exportLine = (dir: string) => `export PATH="${dir.replace(/(["\\$`])/g, "\\$1")}:$PATH"`;
  const name = basename(shell || "");

  if (name === "fish") {
    return {
      file: override ?? join(INSTALL_HOME, ".config", "fish", "config.fish"),
      add: (dir) => `fish_add_path '${dir.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`,
    };
  }
  const file =
    override ??
    (name === "bash"
      ? join(INSTALL_HOME, ".bash_profile")
      : name === "zsh"
        ? join(INSTALL_HOME, ".zshrc")
        : join(INSTALL_HOME, ".profile"));
  return { file, add: exportLine };
}

// ── run ───────────────────────────────────────────────────────────────────────

console.log();
console.log(`  ${blue("◆")} ${bold("maestro")} ${dim(version)}  ${dim(contract(ROOT))}`);
console.log();

await step("dependencies", async () => {
  const res = await Bun.$`bun install --frozen-lockfile`.cwd(ROOT).quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(lastLine(res) || "bun install failed");
  const summary = lastLine(res);
  const packages = /across (\d+) packages/.exec(summary)?.[1];
  const changed = !summary.includes("no changes");
  return [packages ? `${packages} packages${changed ? "" : ", no changes"}` : "ready", null];
});

// Staged beside the target so the rename below is a same-filesystem move, which
// makes the swap atomic — a half-written binary is never on $PATH.
const staging = join(BIN_DIR, `.${BIN_NAME}.${process.pid}.tmp`);

const size = await step("compile", async () => {
  await mkdir(BIN_DIR, { recursive: true });
  const res = await Bun.$`bun build --compile --outfile ${staging} src/index.tsx`.cwd(ROOT).quiet().nothrow();
  if (res.exitCode !== 0) {
    await unlink(staging).catch(() => {});
    throw new Error(lastLine(res) || "build failed");
  }
  const bytes = (await stat(staging)).size;
  return [`src/index.tsx → ${humanSize(bytes)}, self-contained`, bytes];
});

await step("install", async () => {
  await chmod(staging, 0o755);
  await rename(staging, TARGET);
  return [contract(TARGET), null];
});

await step("verify", async () => {
  const res = await Bun.$`${TARGET} --version`.quiet().nothrow();
  const reported = res.stdout.toString().trim();
  if (res.exitCode !== 0) throw new Error(`${BIN_NAME} --version exited ${res.exitCode}`);
  if (reported !== version) throw new Error(`reported ${reported || "nothing"}, expected ${version}`);
  return [`${BIN_NAME} --version → ${reported}`, null];
});

let reload: string | undefined;

await step("PATH", async () => {
  if (isOnPath(BIN_DIR)) return [`${contract(BIN_DIR)} already on PATH`, null];
  if (flag("--no-path")) return [`${contract(BIN_DIR)} is not on PATH (--no-path)`, null, yellow];

  const profile = profileFor(process.env.SHELL ?? "");
  const existing = await readFile(profile.file, "utf8").catch(() => "");
  if (existing.includes(BIN_DIR)) return [`${contract(profile.file)} already adds it`, null];

  await mkdir(resolve(profile.file, ".."), { recursive: true });
  const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await appendFile(profile.file, `${lead}\n${MARKER}\n${profile.add(BIN_DIR)}\n`);
  reload = profile.file;
  return [`${contract(BIN_DIR)} → ${contract(profile.file)}`, null];
});

console.log();
console.log(`  ${green("Installed")} in ${secs(Date.now() - started)}.`);
if (reload) {
  console.log(`  ${dim("Open a new shell, or:")} source ${contract(reload)}`);
  console.log(`  ${dim("Then run:")} ${bold(BIN_NAME)}`);
  console.log();
  console.log(dim(`  The PATH line is a two-line "${MARKER}" block — delete it to undo.`));
} else {
  console.log(`  ${dim("Run:")} ${bold(BIN_NAME)}    ${dim(`${BIN_NAME} --help, or ? inside the workspace list`)}`);
}
console.log();
console.log(dim(`  ${humanSize(size)} at ${contract(TARGET)} — rm it to uninstall.`));
console.log();
