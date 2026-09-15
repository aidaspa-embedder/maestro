import { attrs, glyph, theme } from "../theme.ts";
import { truncate } from "./text.ts";

/**
 * A tiny markdown renderer that produces *styled terminal lines* rather than a
 * string, so the ticket preview can scroll by line, wrap at the panel width and
 * still show headings, code and emphasis.
 *
 * Deliberately not a full CommonMark implementation: Linear descriptions are
 * headings, lists, links, code and the occasional table, and everything else
 * degrades to plain text rather than being mangled.
 */

export interface Seg {
  text: string;
  fg?: string;
  attrs?: number;
}

/** One rendered terminal row. An empty array is a blank line. */
export type Line = Seg[];

interface Sty {
  fg?: string;
  attrs?: number;
}

export function lineText(line: Line): string {
  return line.map((s) => s.text).join("");
}

/**
 * Inline spans. Scanned in one pass with alternation so the first match wins —
 * `**bold**` can never be read as two `*em*`s.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])|\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(https?:\/\/\S+)/g;

function parseInline(text: string, base: Sty): Seg[] {
  const out: Seg[] = [];
  const push = (t: string, s: Sty) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.fg === s.fg && last.attrs === s.attrs) last.text += t;
    else out.push({ text: t, fg: s.fg, attrs: s.attrs });
  };
  const withAttr = (a: number): Sty => ({ fg: base.fg, attrs: (base.attrs ?? 0) | a });

  INLINE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index), base);

    if (m[1] !== undefined) push(m[1], { fg: theme.cyanBright, attrs: base.attrs });
    else if (m[2] !== undefined) push(m[2], { fg: theme.white, attrs: (base.attrs ?? 0) | attrs.bold });
    else if (m[3] !== undefined) push(m[3], { fg: theme.white, attrs: (base.attrs ?? 0) | attrs.bold });
    else if (m[4] !== undefined) push(m[4], { fg: theme.textFaint, attrs: (base.attrs ?? 0) | attrs.strike });
    else if (m[5] !== undefined) push(m[5], withAttr(attrs.italic));
    else if (m[6] !== undefined) push(m[6], withAttr(attrs.italic));
    else if (m[7] !== undefined) push(m[7] || m[8]!, { fg: theme.accentBright, attrs: attrs.underline });
    else if (m[9] !== undefined) push(m[9], { fg: theme.accentBright, attrs: attrs.underline });

    last = INLINE.lastIndex;
  }
  if (last < text.length) push(text.slice(last), base);
  return out;
}

/**
 * Greedy word wrap across styled segments. Words survive the boundary with
 * their styling intact, and a word wider than the column is hard-broken rather
 * than allowed to overflow the panel.
 */
function wrap(segs: Seg[], width: number): Line[] {
  const cols = Math.max(1, width);
  const lines: Line[] = [];
  let cur: Line = [];
  let len = 0;

  const flush = () => {
    lines.push(cur);
    cur = [];
    len = 0;
  };
  const add = (text: string, s: Sty) => {
    const last = cur[cur.length - 1];
    if (last && last.fg === s.fg && last.attrs === s.attrs) last.text += text;
    else cur.push({ text, fg: s.fg, attrs: s.attrs });
    len += text.length;
  };

  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        // A wrapped line never starts with the space that caused the wrap.
        if (len === 0 || len + 1 > cols) continue;
        add(" ", seg);
        continue;
      }
      let word = part;
      while (word.length > cols) {
        if (len > 0) flush();
        add(word.slice(0, cols), seg);
        word = word.slice(cols);
        flush();
      }
      if (len > 0 && len + word.length > cols) flush();
      add(word, seg);
    }
  }
  if (cur.length) flush();
  return lines;
}

/** Word-wraps plain text in one style — for titles and other non-markdown prose. */
export function wrapPlain(text: string, width: number, style: Sty = {}): Line[] {
  return wrap([{ text, ...style }], width);
}

/** Shifts rendered lines right, e.g. to nest a comment body under its author. */
export function indentLines(lines: Line[], by: number): Line[] {
  const pad = " ".repeat(Math.max(0, by));
  return lines.map((line) => (line.length === 0 ? line : [{ text: pad }, ...line]));
}

/** Wraps with a hanging indent: `first` on line one, `rest` on every other. */
function wrapWithPrefix(segs: Seg[], width: number, first: Seg[], rest: Seg[]): Line[] {
  const firstW = first.reduce((n, s) => n + s.text.length, 0);
  const restW = rest.reduce((n, s) => n + s.text.length, 0);
  const body = wrap(segs, Math.max(1, width - Math.max(firstW, restW)));
  if (body.length === 0) return [[...first]];
  return body.map((line, i) => [...(i === 0 ? first : rest), ...line]);
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(\1\s*){2,}$/;
const FENCE = /^\s*(```|~~~)(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

/**
 * Renders markdown to wrapped, styled lines at `width` columns.
 * Blank lines are collapsed to at most one, so a description that was written
 * with generous spacing doesn't waste half the panel.
 */
export function markdownLines(src: string, width: number): Line[] {
  const cols = Math.max(8, width);
  const raw = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Line[] = [];
  let pendingBlank = false;

  const emit = (lines: Line[]) => {
    if (lines.length === 0) return;
    if (pendingBlank && out.length > 0) out.push([]);
    pendingBlank = false;
    out.push(...lines);
  };
  const blank = () => {
    if (out.length > 0) pendingBlank = true;
  };

  let i = 0;
  while (i < raw.length) {
    const line = raw[i]!;

    if (!line.trim()) {
      blank();
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[2]!.trim();
      const block: Line[] = [];
      if (lang) block.push([{ text: `${glyph.quote} `, fg: theme.accentDim }, { text: lang, fg: theme.textFaint, attrs: attrs.italic }]);
      i++;
      while (i < raw.length && !FENCE.test(raw[i]!)) {
        block.push([
          { text: `${glyph.quote} `, fg: theme.accentDim },
          { text: truncate(raw[i]!.replace(/\t/g, "  "), cols - 2), fg: theme.cyanBright },
        ]);
        i++;
      }
      i++; // closing fence, if there is one
      emit(block);
      blank();
      continue;
    }

    if (RULE.test(line)) {
      emit([[{ text: glyph.rule.repeat(cols), fg: theme.border }]]);
      blank();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const sty: Sty =
        level <= 2
          ? { fg: theme.white, attrs: attrs.bold }
          : { fg: theme.heading, attrs: attrs.bold };
      blank();
      emit(wrap(parseInline(heading[2]!, sty), cols));
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [];
      while (i < raw.length) {
        const q = QUOTE.exec(raw[i]!);
        if (!q) break;
        body.push(q[1]!);
        i++;
      }
      const bar: Seg[] = [{ text: `${glyph.quote} `, fg: theme.textFaint }];
      emit(
        wrapWithPrefix(
          parseInline(body.join(" ").trim(), { fg: theme.textDim, attrs: attrs.italic }),
          cols,
          bar,
          bar,
        ),
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const depth = Math.min(3, Math.floor(bullet[1]!.length / 2));
      const marker = bullet[2]!;
      const ordered = /\d/.test(marker);
      let content = bullet[3]!;

      const task = TASK.exec(content);
      let mark: Seg;
      if (task) {
        const checked = task[1]!.toLowerCase() === "x";
        content = task[2]!;
        mark = checked
          ? { text: `${glyph.check} `, fg: theme.success }
          : { text: "☐ ", fg: theme.textDim };
      } else {
        mark = ordered
          ? { text: `${marker} `, fg: theme.accent, attrs: attrs.bold }
          : { text: `${glyph.bullet} `, fg: theme.accent };
      }

      const pad: Seg = { text: "  ".repeat(depth) };
      const rest: Seg = { text: " ".repeat(mark.text.length) };
      const struck = Boolean(task && task[1]!.toLowerCase() === "x");
      emit(
        wrapWithPrefix(
          parseInline(content, struck ? { fg: theme.textFaint } : { fg: theme.text }),
          cols,
          depth ? [pad, mark] : [mark],
          depth ? [pad, rest] : [rest],
        ),
      );
      i++;
      continue;
    }

    // Tables aren't reflowed — a wrapped table is worse than a clipped one.
    if (/^\s*\|/.test(line)) {
      const divider = /^[\s|:-]+$/.test(line);
      emit([
        [
          {
            text: truncate(line.trim(), cols),
            fg: divider ? theme.border : theme.textDim,
          },
        ],
      ]);
      i++;
      continue;
    }

    // Paragraph: consume until something structural shows up.
    const para: string[] = [];
    while (i < raw.length) {
      const l = raw[i]!;
      if (
        !l.trim() ||
        FENCE.test(l) ||
        RULE.test(l) ||
        HEADING.test(l) ||
        QUOTE.test(l) ||
        BULLET.test(l) ||
        /^\s*\|/.test(l)
      ) {
        break;
      }
      para.push(l.trim());
      i++;
    }
    emit(wrap(parseInline(para.join(" "), { fg: theme.text }), cols));
  }

  return out;
}
