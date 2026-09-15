import { useSpinnerFrame } from "./Motion.tsx";
import { useEffect, useState } from "react";
import type { Line } from "../lib/markdown.ts";
import { attrs, glyph, theme } from "../theme.ts";

/** Braille spinner; 80ms/frame reads as smooth without being busy. */
export function Spinner({ color = theme.accent }: { color?: string }) {
  const frame = useSpinnerFrame();
  return <span fg={color}>{glyph.spinner[frame]}</span>;
}

export interface KeyHint {
  key: string;
  label: string;
  /** Dims the hint when the action isn't currently available */
  disabled?: boolean;
}

const HINT_GAP = 3;
const MORE_HINT: KeyHint = { key: "?", label: "keys" };

const hintWidth = (h: KeyHint) => h.key.length + 1 + h.label.length;

/**
 * Drops hints that don't fit the footer and appends `? keys` in their place, so
 * a narrow terminal degrades to the important shortcuts instead of clipping
 * mid-word. Hints must therefore be passed in priority order.
 */
export function fitHints(hints: KeyHint[], width: number): KeyHint[] {
  const total = hints.reduce((n, h, i) => n + (i ? HINT_GAP : 0) + hintWidth(h), 0);
  if (total <= width) return hints;

  const budget = width - HINT_GAP - hintWidth(MORE_HINT);
  const out: KeyHint[] = [];
  let used = 0;
  for (const hint of hints) {
    const next = used + (out.length ? HINT_GAP : 0) + hintWidth(hint);
    if (next > budget) break;
    used = next;
    out.push(hint);
  }
  return [...out, MORE_HINT];
}

/** Contextual keybinding strip rendered in the footer. */
export function KeyHints({ hints, width }: { hints: KeyHint[]; width?: number }) {
  const shown = width === undefined ? hints : fitHints(hints, width);
  return (
    <text>
      {shown.map((h, i) => (
        <span key={h.key + i}>
          {i > 0 ? <span fg={theme.textFaint}>{" ".repeat(HINT_GAP)}</span> : null}
          <span fg={h.disabled ? theme.textFaint : theme.accentBright} attributes={attrs.bold}>
            {h.key}
          </span>
          <span fg={h.disabled ? theme.textFaint : theme.textDim}>{" " + h.label}</span>
        </span>
      ))}
    </text>
  );
}

/** A dot + label, coloured by connection state. */
export function StatusPill({
  label,
  color,
  dim = false,
}: {
  label: string;
  color: string;
  dim?: boolean;
}) {
  return (
    <span>
      <span fg={color}>{glyph.dot}</span>
      <span fg={dim ? theme.textFaint : theme.textDim}>{" " + label}</span>
    </span>
  );
}

/**
 * Mark + label in one colour — the shared shape for every status in the app
 * (ticket state, PR state, checks, review). The mark is what carries the
 * meaning when colour isn't available.
 */
export function Badge({
  mark,
  label,
  color,
  bold = false,
}: {
  mark: string;
  label?: string;
  color: string;
  bold?: boolean;
}) {
  return (
    <span>
      <span fg={color} attributes={attrs.bold}>{mark}</span>
      {label ? (
        <span fg={color} attributes={bold ? attrs.bold : undefined}>{" " + label}</span>
      ) : null}
    </span>
  );
}

/** Centered empty state for lists with nothing in them. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={theme.textDim}>{title}</text>
      {hint ? <text fg={theme.textFaint}>{hint}</text> : null}
    </box>
  );
}

/** Section label above a group of rows. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <text fg={theme.textFaint} attributes={attrs.bold}>
      {children.toUpperCase()}
    </text>
  );
}

/** Thin horizontal rule that fills its container. */
export function Divider() {
  return <box height={1} borderStyle="single" border={["top"]} borderColor={theme.border} />;
}

/**
 * Renders pre-wrapped styled lines (see lib/markdown.ts). Rendering to a line
 * array rather than a wrapping <text> is what lets long ticket bodies scroll by
 * exactly one row at a time.
 */
export function Lines({ lines }: { lines: Line[] }) {
  return (
    <box flexDirection="column">
      {lines.map((line, i) =>
        line.length === 0 ? (
          <box key={i} height={1} />
        ) : (
          <box key={i} height={1} flexDirection="row">
            <text>
              {line.map((seg, j) => (
                <span key={j} fg={seg.fg} attributes={seg.attrs}>
                  {seg.text}
                </span>
              ))}
            </text>
          </box>
        ),
      )}
    </box>
  );
}
