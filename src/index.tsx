#!/usr/bin/env bun
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import { CONFIG_DIR } from "./lib/paths.ts";

// Keep diagnostics and version fast: renderer/native modules load only for the TUI.
const args = process.argv.slice(2);
const known = new Set(["-v", "--version", "-h", "--help", "--setup", "--no-intro", "--doctor", "--check-connections"]);
if (args.some(a => !known.has(a))) { console.error("Unknown option. Run maestro --help."); process.exit(2); }
if (args.includes("--version") || args.includes("-v")) { console.log(version); process.exit(0); }
if (args.includes("--help") || args.includes("-h")) {
  console.log([
    `maestro ${version} — issue workspaces across GitHub repositories`, "",
    "usage: maestro                 open the TUI; guided setup on first run",
    "       maestro --setup         reopen onboarding",
    "       maestro --no-intro      skip animation (reduced motion)",
    "       maestro --doctor        check tools and local state",
    "       maestro --doctor --check-connections  also verify GitHub and Jira/Linear",
    "       maestro --version       print the version",
    "       maestro --help          show help", "",
    "Native terminal sessions: macOS (Ghostty, iTerm2, Terminal.app).",
    "Claude always runs --dangerously-skip-permissions; Codex always runs --yolo.",
    `config: ${CONFIG_DIR}`, "keys:   ? inside the workspace list",
  ].join("\n"));
  process.exit(0);
}
if (args.includes("--check-connections") && !args.includes("--doctor")) { console.error("--check-connections requires --doctor"); process.exit(2); }
try {
  if (args.includes("--doctor")) {
    const { doctor } = await import("./services/doctor.ts");
    process.exit(await doctor(args.includes("--check-connections")));
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("Maestro needs an interactive terminal. Use --help or --doctor for non-interactive output."); process.exit(2); }
  if (args.includes("--no-intro")) process.env.MAESTRO_REDUCED_MOTION = "1";
  const { acquireInstanceLock } = await import("./lib/instance-lock.ts");
  const release = await acquireInstanceLock(CONFIG_DIR);
  process.once("exit", () => {
    try {
      const lock = join(CONFIG_DIR, "instance.lock");
      if (readFileSync(join(lock, "pid"), "utf8") === String(process.pid)) rmSync(lock, { recursive: true, force: true });
    } catch { /* Already released. */ }
  });
  let renderer: import("@opentui/core").CliRenderer | undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    renderer?.destroy();
    await release();
  };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
  try {
    const { createCliRenderer } = await import("@opentui/core");
    const { createRoot } = await import("@opentui/react");
    const { App } = await import("./app.tsx");
    renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30, useMouse: true });
    renderer.on("destroy", () => { void release(); });
    createRoot(renderer).render(<App setup={args.includes("--setup")} />);
  } catch (error) { await close(); throw error; }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
