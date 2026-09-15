import { createTextAttributes, RGBA } from "@opentui/core";

/**
 * Single source of truth for colour, weight + glyphs. Everything visual pulls
 * from here so the whole app re-skins from one file.
 *
 * Two rules the rest of the UI relies on:
 *   - Hierarchy comes from *weight and hue*, never from a background wash.
 *     `white`/bold is the loudest thing on screen and is spent sparingly.
 *   - Every semantic (ticket state, PR state, checks, priority) has exactly one
 *     helper below, so the same thing is never two colours in two views.
 */

/**
 * Alpha 0 — the engine's "no background" sentinel, so the terminal's own
 * background (including any transparency or blur) shows through. maestro never
 * paints a page background; only deliberate accents like selection are opaque.
 */
export const transparent = RGBA.fromValues(0, 0, 0, 0);

export const theme = {
  // Surfaces — only ever used for small deliberate accents, never a full wash.
  panel: "#12151c",
  panelAlt: "#171b24",

  // Lines
  border: "#232936",
  borderFocus: "#5b8def",

  // Type — five weights, loudest first. Reach for the quietest one that works.
  white: "#ffffff",
  heading: "#e6edf3",
  text: "#c9d1d9",
  textDim: "#6e7681",
  textFaint: "#454c56",

  // Accents
  accent: "#5b8def",
  accentBright: "#7aa2ff",
  accentDim: "#3a5fa8",
  success: "#3fb950",
  successBright: "#56d364",
  warn: "#d29922",
  warnBright: "#e3b341",
  danger: "#f85149",
  dangerBright: "#ff7b72",
  purple: "#a371f7",
  purpleBright: "#bc8cff",
  cyan: "#39c5cf",
  cyanBright: "#56d4dd",
  pink: "#f778ba",
  orange: "#ffa657",
  lime: "#7ee787",
  teal: "#2dd4bf",
  indigo: "#818cf8",

  // Selection
  selBg: "#1f2733",
  selFg: "#e6edf3",
} as const;

/**
 * Terminal attribute bitmasks. `<b>` exists as an element, but spans take an
 * `attributes` number, which composes with `fg` in a single node — so a cell can
 * be "bold white", "dim italic" or "faint struck through" without nesting.
 */
export const attrs = {
  none: 0,
  bold: createTextAttributes({ bold: true }),
  dim: createTextAttributes({ dim: true }),
  italic: createTextAttributes({ italic: true }),
  underline: createTextAttributes({ underline: true }),
  strike: createTextAttributes({ strikethrough: true }),
  boldItalic: createTextAttributes({ bold: true, italic: true }),
  boldUnderline: createTextAttributes({ bold: true, underline: true }),
  dimItalic: createTextAttributes({ dim: true, italic: true }),
} as const;

export const glyph = {
  logo: "◆",
  chevron: "›",
  dot: "●",
  dotOpen: "○",
  check: "✓",
  cross: "✗",
  arrow: "→",
  dash: "—",
  bullet: "•",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  box: "▌",
  /** Thinner than `box`: the level you're navigating inside, not the selection */
  rail: "▏",

  // Tree
  twistyOpen: "▾",
  twistyClosed: "▸",
  treeMid: "├",
  treeEnd: "└",
  treeBar: "─",

  // Ticket / PR vocabulary
  backlog: "◦",
  todo: "○",
  doing: "◐",
  done: "✓",
  canceled: "⊘",
  pr: "⑂",
  branch: "⎇",
  merged: "⬩",
  hidden: "⌁",
  sort: "↕",
  filter: "⊟",
  quote: "│",
  rule: "─",
  ellipsis: "…",
} as const;

/** State-type colours mirroring Linear's own workflow categories. */
export function stateColor(type: string | undefined): string {
  return ticketStyle(type).color;
}

export interface Style {
  color: string;
  glyph: string;
}

/**
 * The one place a Linear workflow category becomes a colour + mark. The mark
 * matters as much as the hue: it is the only part that survives a colourblind
 * reader or a low-contrast terminal theme.
 */
export function ticketStyle(type: string | undefined): Style {
  switch (type) {
    case "completed":
      return { color: theme.purpleBright, glyph: glyph.done };
    case "started":
      return { color: theme.warnBright, glyph: glyph.doing };
    case "unstarted":
      return { color: theme.text, glyph: glyph.todo };
    case "backlog":
      return { color: theme.textFaint, glyph: glyph.backlog };
    case "canceled":
      return { color: theme.textDim, glyph: glyph.canceled };
    default:
      return { color: theme.textDim, glyph: glyph.dotOpen };
  }
}

/**
 * Sort weight for the "status" ordering: what you're working on floats, what
 * you're finished with sinks.
 */
export function stateRank(type: string | undefined): number {
  switch (type) {
    case "started":
      return 0;
    case "unstarted":
      return 1;
    case "backlog":
      return 2;
    case "completed":
      return 3;
    case "canceled":
      return 4;
    default:
      return 2;
  }
}

export function prStyle(state: string, isDraft: boolean): Style & { label: string } {
  if (isDraft) return { label: "draft", color: theme.textDim, glyph: glyph.dotOpen };
  switch (state) {
    case "MERGED":
      return { label: "merged", color: theme.purpleBright, glyph: glyph.merged };
    case "CLOSED":
      return { label: "closed", color: theme.danger, glyph: glyph.cross };
    default:
      return { label: "open", color: theme.successBright, glyph: glyph.dot };
  }
}

export function checksStyle(checks: string): (Style & { label: string }) | undefined {
  switch (checks) {
    case "SUCCESS":
      return { label: "checks", color: theme.success, glyph: glyph.check };
    case "FAILURE":
      return { label: "checks", color: theme.danger, glyph: glyph.cross };
    case "PENDING":
      return { label: "running", color: theme.warn, glyph: glyph.doing };
    default:
      return undefined;
  }
}

export function reviewStyle(decision: string | undefined): (Style & { label: string }) | undefined {
  switch (decision) {
    case "APPROVED":
      return { label: "approved", color: theme.successBright, glyph: glyph.check };
    case "CHANGES_REQUESTED":
      return { label: "changes", color: theme.orange, glyph: "±" };
    case "REVIEW_REQUIRED":
      return { label: "review", color: theme.textDim, glyph: glyph.dotOpen };
    default:
      return undefined;
  }
}

/** Linear's fixed priority scale, 0 = unset. */
export function priorityStyle(priority: number): (Style & { label: string }) | undefined {
  switch (priority) {
    case 1:
      return { label: "Urgent", color: theme.dangerBright, glyph: "▰" };
    case 2:
      return { label: "High", color: theme.orange, glyph: "▰" };
    case 3:
      return { label: "Medium", color: theme.warnBright, glyph: "▰" };
    case 4:
      return { label: "Low", color: theme.textDim, glyph: "▱" };
    default:
      return undefined;
  }
}

/**
 * Identifier colour by tree depth. A parent's id and a child's id must never be
 * the same hue: nesting is drawn with two columns of connector, which is easy to
 * lose down a long list, whereas hue is read before the eye lands on the row.
 * Blue is a top-level thing (a ticket), cyan is nested under one (a PR, a
 * sub-issue) — the same pairing everywhere a tree is drawn.
 */
export function idColor(depth: number, opts: { selected?: boolean; muted?: boolean } = {}): string {
  if (opts.muted) return theme.textDim;
  if (depth === 0) return opts.selected ? theme.accentBright : theme.accent;
  return opts.selected ? theme.cyanBright : theme.cyan;
}

/**
 * A stable colour per repo name. In a multi-repo tool the repo is the thing you
 * scan for, and a consistent hue makes "which project is this" pre-attentive —
 * the same repo is the same colour in the list, the tree and the detail view.
 */
const REPO_PALETTE = [
  theme.cyan,
  theme.pink,
  theme.lime,
  theme.orange,
  theme.indigo,
  theme.teal,
  theme.purple,
  theme.warnBright,
] as const;

export function repoColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return REPO_PALETTE[hash % REPO_PALETTE.length]!;
}

/** Labels are free text, so they get the same stable-hash treatment. */
export function labelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 37 + name.charCodeAt(i)) >>> 0;
  return REPO_PALETTE[(hash + 3) % REPO_PALETTE.length]!;
}
