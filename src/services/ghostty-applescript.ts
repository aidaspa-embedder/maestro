import type { LaunchOptions } from "./launcher.ts";

// Ghostty.sdef defines these stable Apple-event codes. Use raw identifiers so
// compilation does not depend on Launch Services loading Ghostty's terminology.
// Keep launch, polling and focus on the same API (Ghostty 1.3+).
const app = 'application id "com.mitchellh.ghostty"';
const code = {
  configuration: "«event GhstNSCf»", window: "«class Gwnd»",
  terminal: "«class Gtrm»", selectedTab: "«class GWsT»",
  newWindow: "«event GhstNWin»", newTab: "«event GhstNTab»",
  windowConfig: "«class GNwS»", tabConfig: "«class GNtS»", tabWindow: "«class GNtW»",
  directory: "«class GScD»", environment: "«class GScE»",
  command: "«class GScC»", wait: "«class GScW»",
  focus: "«event GhstFcus»", input: "«event GhstInTx»", inputTarget: "«class GItT»",
  id: "«class ID  »", name: "«class pnam»", cwd: "«class Gwdr»",
};
const str = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tell = (lines: string[]) => [`tell ${app}`, ...lines.map(line => `  ${line}`), "end tell"].join("\n");

export function ghosttyLaunchScript(opts: LaunchOptions, command: string | null, path: string): string {
  const lines = ["activate", `set cfg to ${code.configuration}`,
    `set ${code.directory} of cfg to ${str(opts.cwd)}`,
    `set ${code.environment} of cfg to {${str(`PATH=${path}`)}}`];
  if (command) lines.push(`set ${code.command} of cfg to ${str(command)}`, `set ${code.wait} of cfg to true`);
  const window = `set t to ${code.terminal} 1 of ${code.selectedTab} of (${code.newWindow} given ${code.windowConfig}:cfg)`;
  if (opts.target === "tab") lines.push(
    `if (count of every ${code.window}) is 0 then`, `  ${window}`, "else",
    `  set t to ${code.terminal} 1 of (${code.newTab} given ${code.tabWindow}:${code.window} 1, ${code.tabConfig}:cfg)`, "end if");
  else lines.push(window);
  lines.push(`${code.focus} t`);
  if (opts.initialText) lines.push(`delay ${opts.agent === "shell" ? 0.2 : 2}`, `${code.input} ${str(opts.initialText)} given ${code.inputTarget}:t`);
  lines.push(`return ${code.id} of t`);
  return tell(lines);
}

export function ghosttyListScript(): string {
  return tell([
    "set fs to ASCII character 31", "set rs to ASCII character 30", 'set output to ""',
    `repeat with w in every ${code.window}`,
    `  repeat with t in every ${code.terminal} of w`,
    `    set output to output & (${code.id} of t) & fs & (${code.name} of t) & fs & (${code.cwd} of t) & rs`,
    "  end repeat", "end repeat", "return output",
  ]);
}

export function ghosttyFocusScript(id: string): string {
  return tell(["activate", `${code.focus} ${code.terminal} id ${str(id)}`]);
}
