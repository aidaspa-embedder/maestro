import { exec } from "./exec.ts";

/** macOS pbcopy; falls back to wl-copy/xclip so the app isn't Mac-only. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];

  for (const cmd of candidates) {
    const res = await exec(cmd, { stdin: text, timeoutMs: 5_000 });
    if (res.ok) return true;
  }
  return false;
}

/** Opens a URL in the default browser. */
export function openUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return;
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  void exec(cmd, { timeoutMs: 5_000 });
}
