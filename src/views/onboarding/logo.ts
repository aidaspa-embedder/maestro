import { glyph } from "../../theme.ts";

interface AsciiLogo {
  lines: Array<{ mark: string; word: string }>;
  markWidth: number;
  width: number;
}

function logo(mark: string[], word: string[], gap: number): AsciiLogo {
  const markWidth = Math.max(...mark.map(line => line.length)) + gap;
  const wordWidth = Math.max(...word.map(line => line.length));
  return {
    lines: word.map((line, i) => ({ mark: (mark[i] ?? "").padEnd(markWidth), word: line.padEnd(wordWidth) })),
    markWidth,
    width: markWidth + wordWidth,
  };
}

// A six-line lowercase wordmark, with a solid ASCII diamond alongside it.
const LARGE = logo([
  "   /\\   ",
  "  /##\\  ",
  " /####\\ ",
  " \\####/ ",
  "  \\##/  ",
  "   \\/   ",
], [
  "                               _                 ",
  "                              | |                ",
  " _ __ ___    __ _   ___   ___ | |_   _ __   ___  ",
  "| '_ ` _ \\  / _` | / _ \\ / __|| __| | '__| / _ \\ ",
  "| | | | | || (_| ||  __/ \\__ \\| |_  | |   | (_) |",
  "|_| |_| |_| \\__,_| \\___| |___/ \\__| |_|    \\___/ ",
], 3);

// Keep an ASCII treatment in narrow splits without wrapping the larger art.
const LETTERS = [
  ["# #", "###", "###", "# #", "# #"],
  [" # ", "# #", "###", "# #", "# #"],
  ["###", "#  ", "## ", "#  ", "###"],
  ["###", "#  ", "###", "  #", "###"],
  ["###", " # ", " # ", " # ", " # "],
  ["## ", "# #", "## ", "# #", "# #"],
  [" # ", "# #", "# #", "# #", " # "],
];
const COMPACT = logo(["", "", "<>", "", ""], Array.from({ length: 5 }, (_, i) => LETTERS.map(letter => letter[i]).join(" ")), 2);
const TINY = logo([glyph.logo], ["maestro"], 1);

export function introLogo(width: number, height: number): AsciiLogo {
  if (width >= LARGE.width + 4 && height >= LARGE.lines.length + 4) return LARGE;
  if (width >= COMPACT.width && height >= COMPACT.lines.length + 2) return COMPACT;
  return TINY;
}
