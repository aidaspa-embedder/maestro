import { linearProvider, type IssueProvider } from "../../integrations/issues/index.ts";
import { Lines, Spinner } from "../../components/primitives.tsx";
import { useAsync } from "../../hooks/useAsync.ts";
import { markdownLines } from "../../lib/markdown.ts";
import { relativeTime, truncate } from "../../lib/text.ts";
import { PRIORITY_LABEL, type IssueDetail, type SubIssue } from "../../services/linear.ts";
import type { IssueTicket } from "../../state/types.ts";
import { attrs, glyph, idColor, labelColor, priorityStyle, theme, ticketStyle } from "../../theme.ts";

const LABEL_W = 10;

/**
 * Everything about the selected ticket, shown alongside the repo picker so the
 * choice of repos is made with the full ticket — including its sub-issues — in
 * view rather than from a one-line title.
 */
export function TicketDetail({
  apiKey,
  provider,
  ticket,
  width,
  height,
}: {
  apiKey?: string;
  provider?: IssueProvider;
  ticket: IssueTicket;
  width: number;
  height: number;
}) {
  const { data, loading, error } = useAsync<IssueDetail>(
    () => (provider ?? linearProvider(apiKey)).issueDetail(ticket.id),
    [ticket.id, apiKey, provider],
  );

  const inner = width - 3; // border + padding
  const state = ticketStyle(ticket.stateType);
  const priority = data ? priorityStyle(data.priority) : undefined;

  return (
    <box
      flexDirection="column"
      width={width}
      border={["left"]}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={2}
      paddingRight={1}
    >
      <text>
        <span fg={theme.accentBright} attributes={attrs.bold}>{ticket.identifier}</span>
        <span>{"  "}</span>
        <span fg={state.color} attributes={attrs.bold}>{state.glyph}</span>
        <span fg={state.color}>{" " + ticket.stateName}</span>
      </text>
      <text fg={theme.white} attributes={attrs.bold} wrapMode="word" maxHeight={3}>
        {ticket.title}
      </text>

      <box height={1} />

      {data?.parent ? (
        <Field label="Parent" value={`${data.parent.identifier} ${data.parent.title}`} width={inner} />
      ) : null}
      <Field label="Assignee" value={ticket.assignee ?? "Unassigned"} width={inner} />
      {data ? (
        <>
          <box flexDirection="row" height={1}>
            <text>
              <span fg={theme.textFaint}>{"Priority".padEnd(LABEL_W)}</span>
              <span fg={priority?.color ?? theme.textFaint}>
                {(priority ? `${priority.glyph} ` : "") + (PRIORITY_LABEL[data.priority] ?? "None")}
              </span>
            </text>
          </box>
          {data.estimate !== undefined ? (
            <Field label="Estimate" value={String(data.estimate)} width={inner} />
          ) : null}
          {data.project ? (
            <Field label="Project" value={data.project} width={inner} color={theme.purpleBright} />
          ) : null}
          {data.cycle ? <Field label="Cycle" value={data.cycle} width={inner} color={theme.cyan} /> : null}
          {data.labels.length ? <Labels labels={data.labels} width={inner} /> : null}
          <Field label="Updated" value={relativeTime(data.updatedAt)} width={inner} />
        </>
      ) : null}

      <Field label="Branch" value={ticket.branchName} width={inner} color={theme.cyanBright} />

      {loading ? (
        <box paddingTop={1}>
          <text>
            <Spinner />
            <span fg={theme.textFaint}>{" loading ticket…"}</span>
          </text>
        </box>
      ) : error ? (
        <box paddingTop={1}>
          <text fg={theme.danger} wrapMode="word" maxHeight={2}>
            {error}
          </text>
        </box>
      ) : data ? (
        <Body detail={data} width={inner} height={height} />
      ) : null}
    </box>
  );
}

/** Sub-issues past this are summarised, so a big epic can't eat the panel. */
const MAX_SUBS = 10;

function Body({ detail, width, height }: { detail: IssueDetail; width: number; height: number }) {
  const subs = detail.children;
  const shown = subs.slice(0, Math.max(1, Math.min(MAX_SUBS, height - 14)));
  const hidden = subs.length - shown.length;

  // Both blocks stay top-aligned with slack at the bottom; the description is
  // capped so a wall of text can't push the sub-issues out of view.
  const descCap = Math.max(3, Math.min(10, height - 12 - shown.length));
  const body = detail.description.trim();
  const desc = body ? markdownLines(body, width).slice(0, descCap) : [];

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {desc.length ? (
        <box flexDirection="column" paddingTop={1} flexShrink={1} overflow="hidden">
          <text fg={theme.textFaint} attributes={attrs.bold}>{"DESCRIPTION"}</text>
          <Lines lines={desc} />
        </box>
      ) : null}

      {subs.length ? (
        <box flexDirection="column" paddingTop={1} flexShrink={0}>
          <text fg={theme.textFaint} attributes={attrs.bold}>{`SUB-ISSUES (${subs.length})`}</text>
          {shown.map((sub, i) => (
            <SubRow
              key={sub.id}
              sub={sub}
              width={width}
              // Only the true last row closes the branch — a "+n more" line
              // below it means the list carries on.
              last={i === shown.length - 1 && hidden === 0}
            />
          ))}
          {hidden > 0 ? (
            <text fg={theme.textFaint}>{`${glyph.treeEnd}${glyph.treeBar} +${hidden} more`}</text>
          ) : null}
        </box>
      ) : null}

      <box flexGrow={1} />
    </box>
  );
}

/** Same connectors as the pickers and the workspace list — a sub-issue is a
 *  child row wherever it appears. */
function SubRow({ sub, width, last }: { sub: SubIssue; width: number; last: boolean }) {
  const style = ticketStyle(sub.stateType);
  const done = sub.stateType === "completed" || sub.stateType === "canceled";
  const used = 3 + sub.identifier.length + 3;
  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={theme.textFaint}>{(last ? glyph.treeEnd : glyph.treeMid) + glyph.treeBar + " "}</span>
        <span fg={style.color} attributes={attrs.bold}>{style.glyph}</span>
        <span fg={idColor(1, { muted: done })} attributes={attrs.bold}>
          {" " + sub.identifier + " "}
        </span>
        <span fg={done ? theme.textFaint : theme.text} attributes={done ? attrs.strike : undefined}>
          {truncate(sub.title, Math.max(6, width - used))}
        </span>
      </text>
    </box>
  );
}

/** Labels get one hue each so the same label reads the same everywhere. */
function Labels({ labels, width }: { labels: string[]; width: number }) {
  const room = Math.max(4, width - LABEL_W);
  const shown: string[] = [];
  let used = 0;
  for (const name of labels) {
    const cost = name.length + (shown.length ? 3 : 0);
    if (used + cost > room) break;
    shown.push(name);
    used += cost;
  }

  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={theme.textFaint}>{"Labels".padEnd(LABEL_W)}</span>
        {shown.map((name, i) => (
          <span key={name}>
            {i > 0 ? <span fg={theme.textFaint}>{" · "}</span> : null}
            <span fg={labelColor(name)}>{name}</span>
          </span>
        ))}
        {shown.length < labels.length ? (
          <span fg={theme.textFaint}>{` +${labels.length - shown.length}`}</span>
        ) : null}
      </text>
    </box>
  );
}

function Field({
  label,
  value,
  width,
  color = theme.textDim,
}: {
  label: string;
  value: string;
  width: number;
  color?: string;
}) {
  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={theme.textFaint}>{label.padEnd(LABEL_W)}</span>
        <span fg={color}>{truncate(value, Math.max(4, width - LABEL_W))}</span>
      </text>
    </box>
  );
}
