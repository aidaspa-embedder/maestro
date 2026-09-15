import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../src/lib/exec.ts";

const root = await mkdtemp(join(tmpdir(), "maestro-launcher-"));
await writeFile(join(root, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const which = spyOn(Bun, "which").mockReturnValue(join(root, "codex"));
afterAll(async () => { which.mockRestore(); await rm(root, { recursive: true, force: true }); });
const calls: string[][] = [];
const success: ExecResult = { ok: true, code: 0, stdout: "surface-id", stderr: "" };
let replies: ExecResult[] = [];
mock.module("../src/lib/exec.ts", () => ({
  exec: async (args: string[]) => { calls.push(args); return replies.shift() ?? success; },
}));
const { launchSession } = await import("../src/services/launcher.ts");
const opts = { cwd: "/tmp/work space ' $(literal)", agent: "codex" as const,
  terminal: "ghostty" as const, target: "tab" as const, initialText: "editable prompt" };
beforeEach(() => { calls.length = 0; replies = []; });

test("Ghostty compile error retries via CLI with literal paths and mandatory flags", async () => {
  replies = [{ ...success, ok: false, code: 1, stderr: "syntax error: Expected identifier or end of line (-2741)" }, success];
  const result = await launchSession({ ...opts, args: ["resume", "session-id"] });
  expect(result.ok).toBe(true);
  expect(result.promptNotTyped).toBe(true);
  expect(result.surfaceId).toBeUndefined();
  expect(calls[0]![0]).toBe("osascript");
  expect(calls[1]!.slice(0, 5)).toEqual(["open", "-na", "Ghostty", "--args", `--working-directory=${opts.cwd}`]);
  expect(calls[1]![5]).toContain("--command=");
  expect(calls[1]![5]).toContain("--yolo");
  expect(calls[1]![5]).toContain("session-id");
  expect(calls[1]!.join(" ")).not.toContain(opts.initialText);
});

test("successful AppleScript launch preserves tracking without opening another window", async () => {
  const result = await launchSession(opts);
  expect(result.ok).toBe(true);
  expect(result.surfaceId).toBe("surface-id");
  expect(calls).toHaveLength(1);
});

test("runtime errors never retry a potentially opened session", async () => {
  replies = [{ ...success, ok: false, code: 1, stderr: "Not authorized to send Apple events (-1743)" }];
  const result = await launchSession(opts);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("-1743");
  expect(calls).toHaveLength(1);
});

test("CLI failure reports the failure and retains the manual launch command", async () => {
  replies = [{ ...success, ok: false, code: 1, stderr: "syntax error (-2741)" },
    { ...success, ok: false, code: 1, stderr: "Unable to find application Ghostty" }];
  const result = await launchSession(opts);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Unable to find");
  expect(result.fallbackCommand).toContain("--yolo");
});
