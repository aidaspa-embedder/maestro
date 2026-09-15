import { indentLines, markdownLines, wrapPlain, type Line, type Seg } from "./markdown.ts";
import { relativeTime, truncate } from "./text.ts";
import type { IssueDetail, SubIssue } from "../services/linear.ts";
import type { IssueTicket } from "../state/types.ts";
import { attrs, glyph, idColor, labelColor, priorityStyle, theme, ticketStyle } from "../theme.ts";

/**
 * Renders a Linear issue to styled terminal lines: the whole ticket, not a
 * summary of it — description, metadata, sub-issues and the comment thread —
 * so reading a ticket never means leaving the terminal for the browser.
 *
 * Producing lines rather than components is what makes it scrollable: the view
 * slices this array, and one keypress is exactly one row.
 */

const FIELD_W = 10;

function field(label: string, value: Seg[], width: number): Line[] {
  const head: Seg = { text: label.padEnd(FIELD_W), fg: theme.textFaint };
  const body = wrapValue(value, Math.max(8, width - FIELD_W));
  return body.map((line, i) => [i === 0 ? head : { text: " ".repeat(FIELD_W) }, ...line]);
}

/** Values are short, so they wrap only when they genuinely overflow. */
function wrapValue(value: Seg[], width: number): Line[] {
  const flat = value.map((s) => s.text).join("");
  if (flat.length <= width) return [value];
  return [[{ text: truncate(flat, width), fg: value[0]?.fg, attrs: value[0]?.attrs }]];
}

function heading(text: string): Line {
  return [{ text, fg: theme.textFaint, attrs: attrs.bold }];
}

function subIssueLine(sub: SubIssue, width: number, last: boolean): Line {
  const style = ticketStyle(sub.stateType);
  const done = sub.stateType === "completed" || sub.stateType === "canceled";
  const room = Math.max(6, width - sub.identifier.length - 7);
  return [
    { text: (last ? glyph.treeEnd : glyph.treeMid) + glyph.treeBar + " ", fg: theme.textFaint },
    { text: style.glyph, fg: style.color, attrs: attrs.bold },
    { text: " " + sub.identifier + " ", fg: idColor(1, { muted: done }), attrs: attrs.bold },
    {
      text: truncate(sub.title, room),
      fg: done ? theme.textFaint : theme.text,
      attrs: done ? attrs.strike : undefined,
    },
  ];
}

export interface TicketLineOpts {
  /** Set while the detail request is still in flight */
  loading?: boolean;
  error?: string;
}

export function buildTicketLines(
  ticket: IssueTicket,
  detail: IssueDetail | undefined,
  width: number,
  opts: TicketLineOpts = {},
): Line[] {
  const cols = Math.max(24, width);
  const out: Line[] = [];

  // The fetched state wins: the stored copy is a snapshot from creation time.
  const stateName = detail?.stateName || ticket.stateName;
  const stateType = detail?.stateType || ticket.stateType;
  const state = ticketStyle(stateType);

  const head: Line = [
    { text: ticket.identifier, fg: theme.accentBright, attrs: attrs.bold },
    { text: "  " },
    { text: state.glyph, fg: state.color, attrs: attrs.bold },
    { text: " " + (stateName || "unknown"), fg: state.color, attrs: attrs.bold },
  ];
  const priority = detail ? priorityStyle(detail.priority) : undefined;
  if (priority) {
    head.push({ text: "   " }, { text: `${priority.glyph} ${priority.label}`, fg: priority.color, attrs: attrs.bold });
  }
  out.push(head);
  out.push(...wrapPlain(ticket.title, cols, { fg: theme.white, attrs: attrs.bold }));
  out.push([]);

  if (detail?.parent) {
    out.push(
      ...field(
        "Parent",
        [
          { text: detail.parent.identifier + " ", fg: theme.accent, attrs: attrs.bold },
          { text: detail.parent.title, fg: theme.textDim },
        ],
        cols,
      ),
    );
  }
  out.push(
    ...field(
      "Assignee",
      [
        ticket.assignee
          ? { text: ticket.assignee, fg: theme.text }
          : { text: "Unassigned", fg: theme.textFaint, attrs: attrs.italic },
      ],
      cols,
    ),
  );

  if (detail) {
    if (detail.estimate !== undefined) {
      out.push(...field("Estimate", [{ text: `${detail.estimate} points`, fg: theme.text }], cols));
    }
    if (detail.project) out.push(...field("Project", [{ text: detail.project, fg: theme.purpleBright }], cols));
    if (detail.cycle) out.push(...field("Cycle", [{ text: detail.cycle, fg: theme.cyan }], cols));
    if (detail.labels.length) {
      const labels: Seg[] = [];
      detail.labels.forEach((name, i) => {
        if (i > 0) labels.push({ text: "  ", fg: theme.textFaint });
        labels.push({ text: name, fg: labelColor(name) });
      });
      out.push(...field("Labels", labels, cols));
    }
  }

  out.push(...field("Branch", [{ text: ticket.branchName, fg: theme.cyanBright }], cols));
  out.push(...field("Link", [{ text: ticket.url, fg: theme.accentBright, attrs: attrs.underline }], cols));
  if (detail) {
    out.push(
      ...field(
        "Updated",
        [
          { text: relativeTime(detail.updatedAt), fg: theme.textDim },
          { text: `   created ${relativeTime(detail.createdAt)}`, fg: theme.textFaint },
        ],
        cols,
      ),
    );
  }

  if (opts.error) {
    out.push([], [{ text: `${glyph.cross} ${opts.error}`, fg: theme.danger }]);
    return out;
  }
  if (!detail) {
    if (opts.loading) out.push([], [{ text: "loading the rest of the ticket…", fg: theme.textFaint, attrs: attrs.italic }]);
    return out;
  }

  const body = detail.description.trim();
  if (body) {
    out.push([], [{ text: glyph.rule.repeat(cols), fg: theme.border }], heading("DESCRIPTION"), []);
    out.push(...markdownLines(body, cols));
  }

  if (detail.children.length) {
    out.push([], [{ text: glyph.rule.repeat(cols), fg: theme.border }], heading(`SUB-ISSUES (${detail.children.length})`), []);
    detail.children.forEach((sub, i) =>
      out.push(subIssueLine(sub, cols, i === detail.children.length - 1)),
    );
  }

  if (detail.comments.length) {
    out.push([], [{ text: glyph.rule.repeat(cols), fg: theme.border }], heading(`COMMENTS (${detail.comments.length})`), []);
    detail.comments.forEach((comment, i) => {
      if (i > 0) out.push([]);
      out.push([
        { text: comment.author, fg: theme.heading, attrs: attrs.bold },
        { text: "  " + relativeTime(comment.createdAt), fg: theme.textFaint },
      ]);
      const text = comment.body.trim();
      out.push(
        ...indentLines(
          text ? markdownLines(text, cols - 2) : [[{ text: "(empty)", fg: theme.textFaint, attrs: attrs.italic }]],
          2,
        ),
      );
    });
  }

  return out;
}
