import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../src/lib/exec.ts";
import { ghosttyLaunchScript, ghosttyListScript, ghosttyFocusScript } from "../src/services/ghostty-applescript.ts";

const root = await mkdtemp(join(tmpdir(), "maestro-launcher-"));
const which = spyOn(Bun, "which").mockReturnValue(join(root, "codex"));
afterAll(async () => { which.mockRestore(); await rm(root, { recursive: true, force: true }); });
const calls: string[][] = [];
const success: ExecResult = { ok: true, code: 0, stdout: "surface-id", stderr: "" };
let reply = success;
mock.module("../src/lib/exec.ts", () => ({
  exec: async (args: string[]) => { calls.push(args); return reply; },
}));
const { launchSession } = await import("../src/services/launcher.ts");
const opts = { cwd: "/tmp/work space ' $(literal)", agent: "codex" as const,
  terminal: "ghostty" as const, target: "tab" as const, initialText: 'editable "prompt"\\line\nnext line' };
beforeEach(() => { calls.length = 0; reply = success; });

test("native launch preserves tabs, prompt typing, tracking and required agent flags", async () => {
  const result = await launchSession({ ...opts, args: ["resume", "session-id"] });
  expect(result.ok).toBe(true);
  expect(result.promptNotTyped).toBe(false);
  expect(result.surfaceId).toBe("surface-id");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 2)).toEqual(["osascript", "-e"]);
  const script = calls[0]![2]!;
  for (const value of ["GhstNTab", "GhstInTx", "--yolo", "session-id", opts.cwd]) expect(script).toContain(value);
});

test("launch errors remain visible without silently switching to CLI windows", async () => {
  reply = { ...success, ok: false, code: 1, stderr: "syntax error (-2741)" };
  const result = await launchSession(opts);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("-2741");
  expect(result.fallbackCommand).toContain("--yolo");
  expect(calls).toHaveLength(1);
});

async function compile(source: string) {
  // Finder deliberately supplies no Ghostty terminology. Compilation must not
  // depend on Ghostty being installed or its dictionary being registered.
  const independent = source.replace('application id "com.mitchellh.ghostty"', 'application "Finder"');
  const proc = Bun.spawn(["/usr/bin/osacompile", "-o", join(root, "check.scpt"), "-"], {
    stdin: new TextEncoder().encode(independent), stderr: "pipe", stdout: "pipe",
  });
  return { code: await proc.exited, error: await new Response(proc.stderr).text() };
}

test.skipIf(process.platform !== "darwin")("native scripts compile without Ghostty's scripting dictionary", async () => {
  // Reproduce the reported parser error with the former named command.
  const previous = await compile('tell application id "com.mitchellh.ghostty"\nset cfg to new surface configuration\nend tell');
  expect(previous.code).not.toBe(0);
  expect(previous.error).toContain("Expected");
  for (const agent of ["codex", "claude", "shell"] as const) {
    for (const target of ["window", "tab"] as const) {
      const source = ghosttyLaunchScript({ ...opts, agent, target }, agent === "shell" ? null : "'/bin/sh' -lc 'exec agent'", "/tmp/path with spaces:/usr/bin");
      expect(await compile(source)).toEqual({ code: 0, error: "" });
    }
  }
  expect(await compile(ghosttyListScript())).toEqual({ code: 0, error: "" });
  expect(await compile(ghosttyFocusScript('id"\\\nquoted'))).toEqual({ code: 0, error: "" });
});
