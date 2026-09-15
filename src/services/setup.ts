import { exec } from "../lib/exec.ts";
export interface ToolCheck { name: string; path: string | null; version?: string }
export async function detectTools(): Promise<ToolCheck[]> {
  return Promise.all(["git", "gh", "claude", "codex"].map(async name => {
    const path = Bun.which(name);
    if (!path) return { name, path: null };
    const result = await exec([path, "--version"], { timeoutMs: 5000 });
    return { name, path, version: result.ok ? result.stdout.split("\n")[0] : "installed; version unavailable" };
  }));
}
