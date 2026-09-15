import { issueProvider } from "../integrations/issues/index.ts";
import { useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { EmptyState, SectionLabel, Spinner } from "../components/primitives.tsx";
import { useAsync } from "../hooks/useAsync.ts";
import { useListNav } from "../hooks/useListNav.ts";
import { copyToClipboard, openUrl } from "../lib/clipboard.ts";
import { contract } from "../lib/paths.ts";
import { mappingOnly, mappingPrompt } from "../lib/prompt.ts";
import { pad, padStart, relativeTime, truncate } from "../lib/text.ts";
import { useSessionActions } from "../hooks/useSessionActions.ts";
import type { WorkspaceStatus } from "../services/status.ts";
import { fetchWorkspacePrs } from "../services/github.ts";
import { worktreeStatus } from "../services/git.ts";
import { launchSession, resolveTerminal, TERMINAL_LABEL } from "../services/launcher.ts";
import { useApp, type DetailTab } from "../state/app-context.tsx";
import type { AgentKind, PullRequest, Workspace, WorkspaceRepo } from "../state/types.ts";
import {
  attrs,
  checksStyle,
  glyph,
  prStyle,
  repoColor,
  reviewStyle,
  theme,
  ticketStyle,
} from "../theme.ts";
import { TicketBody, useScroll, useTicketPreview } from "./TicketPreview.tsx";

type Tab = DetailTab;
type Mode = "browse" | "launch" | "launching";

const TAB_ORDER: Tab[] = ["overview", "ticket", "prs"];

interface SessionChoice {
  kind: "focus" | "resume" | "new";
  agent: AgentKind;
  /** Transcript id to resume */
  sessionId?: string;
  /** Directory the transcript belongs to — a resume must launch there */
  sessionCwd?: string;
  label: string;
  desc: string;
}

function sessionCount(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

/**
 * The attach/launch menu, built from live state: focusing a running session and
 * resuming a recorded one come first, so the default action never spawns a
 * duplicate window.
 */
function buildChoices(ws: Workspace, status: WorkspaceStatus): SessionChoice[] {
  const out: SessionChoice[] = [];

  if (status.attached) {
    const agent = status.agent ?? ws.session?.agent ?? "claude";
    out.push({
      kind: "focus",
      agent,
      label: "focus session",
      desc: status.working
        ? `${agent} · working right now`
        : `${agent} · open and idle${status.title ? ` · ${truncate(status.title, 30)}` : ""}`,
    });
  }

  const { claude, codex, claudeCount, codexCount } = status.resumable;

  if (claude) {
    out.push({
      kind: "resume",
      agent: "claude",
      sessionId: claude.id,
      sessionCwd: claude.cwd,
      label: "resume claude",
      desc: `${sessionCount(claudeCount)} · last ${relativeTime(new Date(claude.updatedAt).toISOString())}`,
    });
  }
  out.push({ kind: "new", agent: "claude", label: "new claude", desc: "fresh session, worktree map handed over" });

  if (codex) {
    out.push({
      kind: "resume",
      agent: "codex",
      sessionId: codex.id,
      sessionCwd: codex.cwd,
      label: "resume codex",
      desc: `${sessionCount(codexCount)} · last ${relativeTime(new Date(codex.updatedAt).toISOString())}`,
    });
  }
  out.push({ kind: "new", agent: "codex", label: "new codex", desc: "fresh session, worktree map handed over" });

  out.push({ kind: "new", agent: "shell", label: "shell", desc: "plain shell, no agent" });
  return out;
}

export function WorkspaceDetail({ id, tab: initialTab }: { id: string; tab?: Tab }) {
  const app = useApp();
  const ws = app.workspaces.find((w) => w.id === id);
  const [tab, setTab] = useState<Tab>(initialTab ?? "overview");
  const [mode, setMode] = useState<Mode>("browse");

  if (!ws) {
    return (
      <Shell crumbs={["workspaces", "?"]} hints={[{ key: "esc", label: "back" }]}>
        <EmptyState title="This workspace no longer exists" />
      </Shell>
    );
  }

  return (
    <DetailBody
      ws={ws}
      tab={tab}
      setTab={setTab}
      mode={mode}
      setMode={setMode}
      key={ws.id}
    />
  );
}

function DetailBody({
  ws,
  tab,
  setTab,
  mode,
  setMode,
}: {
  ws: Workspace;
  tab: Tab;
  setTab: (t: Tab) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
}) {
  const app = useApp();
  const { width, height } = useTerminalDimensions();
  const sessions = useSessionActions();
  const status = app.statusOf(ws.id);
  const [agentIndex, setAgentIndexRaw] = useState(0);

  const live = ws.repos.filter((r) => !r.error);
  const main = live.find((r) => r.isMain) ?? live[0];

  const choices = buildChoices(ws, status);
  // The menu grows and shrinks as sessions come and go, so clamp rather than
  // letting the cursor point past the end.
  const clampedIndex = Math.min(agentIndex, choices.length - 1);
  const setAgentIndex = (fn: (i: number) => number) => setAgentIndexRaw(fn(clampedIndex));

  const statuses = useAsync(
    async () => {
      const entries = await Promise.all(
        live.map(async (r) => [r.worktreePath, await worktreeStatus(r.worktreePath)] as const),
      );
      return Object.fromEntries(entries);
    },
    [ws.id, live.length],
  );

  const prs = useAsync<PullRequest[]>(
    () => fetchWorkspacePrs(app.githubToken!, ws.repos, ws.branch),
    [ws.id, ws.branch, app.githubToken],
    { enabled: tab === "prs" && Boolean(app.githubToken) },
  );

  const ticketW = Math.max(24, width - 4);
  const provider = useMemo(() => issueProvider(app.config, ws.ticket), [app.config, ws.ticket.provider, ws.ticket.site]);
  const ticket = useTicketPreview(undefined, ws.ticket, ticketW, provider);
  const ticketViewport = Math.max(3, height - 11);
  const scroll = useScroll(ticket.lines.length, ticketViewport);

  const rowCount = tab === "overview" ? live.length : tab === "prs" ? (prs.data?.length ?? 0) : 0;
  const viewport = Math.max(1, height - 14);
  const nav = useListNav(rowCount, viewport);

  async function run(choice: SessionChoice) {
    setMode("launching");
    if (choice.kind === "focus") await sessions.focus(ws);
    else await sessions.start(ws, choice.agent, choice.sessionId, choice.sessionCwd);
    setMode("browse");
  }

  useKeyboard((key) => {
    if (mode === "launching") return;

    if (mode === "launch") {
      if (key.name === "escape") setMode("browse");
      else if (key.name === "up" || key.name === "k") setAgentIndex((i) => (i - 1 + choices.length) % choices.length);
      else if (key.name === "down" || key.name === "j") setAgentIndex((i) => (i + 1) % choices.length);
      else if (key.name === "return") {
        const choice = choices[clampedIndex];
        if (choice) void run(choice);
      }
      return;
    }

    // The ticket tab is prose, not a list, so movement scrolls it instead.
    if (tab === "ticket" ? scroll.handleKey(key) : nav.handleKey(key)) return;

    switch (key.name) {
      case "escape":
      case "q":
        app.back();
        break;
      case "tab":
      case "right":
        setTab(TAB_ORDER[(TAB_ORDER.indexOf(tab) + 1) % TAB_ORDER.length]!);
        break;
      case "left":
        setTab(TAB_ORDER[(TAB_ORDER.indexOf(tab) + TAB_ORDER.length - 1) % TAB_ORDER.length]!);
        break;
      case "p":
        setTab("prs");
        break;
      case "t":
        setTab("ticket");
        break;
      case "a":
        app.navigate({ view: "add-repos", id: ws.id });
        break;
      case "b":
        openUrl(ws.ticket.url);
        app.showToast(`Opened ${ws.ticket.identifier} in your browser`);
        break;
      case "l":
        setMode("launch");
        break;
      case "o":
        // Same meaning as in the list: focus if live, else resume, else launch.
        void sessions.attach(ws);
        break;
      case "y":
        // Shift+y is reported as y with shift set, so it is read here rather
        // than as its own case — which would never match.
        if (key.shift) {
          void copyToClipboard(mappingOnly(ws)).then((ok) =>
            app.showToast(ok ? "Paths copied" : "Could not reach the clipboard", ok ? "success" : "error"),
          );
        } else {
          void copyToClipboard(mappingPrompt(ws)).then((ok) =>
            app.showToast(ok ? "Mapping prompt copied" : "Could not reach the clipboard", ok ? "success" : "error"),
          );
        }
        break;
      case "c": {
        const repo = live[nav.getIndex()];
        if (tab === "overview" && repo) {
          void copyToClipboard(repo.worktreePath).then(() => app.showToast(`Copied ${repo.name} path`, "success"));
        }
        break;
      }
      case "return":
        if (tab === "prs") {
          const pr = prs.data?.[nav.getIndex()];
          if (pr) {
            openUrl(pr.url);
            app.showToast(`Opened ${pr.repoName} #${pr.number}`);
          }
        } else if (tab === "ticket") {
          openUrl(ws.ticket.url);
          app.showToast(`Opened ${ws.ticket.identifier} in your browser`);
        }
        break;
      case "r":
        if (tab === "prs") prs.reload();
        else if (tab === "ticket") ticket.reload();
        else statuses.reload();
        app.refreshStatuses();
        app.showToast("Refreshing…");
        break;
    }
  });

  const hints =
    mode === "launch"
      ? [
          { key: "↑↓", label: "pick" },
          { key: "⏎", label: choices[clampedIndex]?.label ?? "run" },
          { key: "esc", label: "cancel" },
        ]
      : tab === "overview"
        ? [
            {
              key: "o",
              label: status.attached
                ? "focus session"
                : status.resumable.claude || status.resumable.codex
                  ? "resume session"
                  : "launch session",
            },
            { key: "a", label: "add repos" },
            { key: "l", label: "session menu" },
            { key: "y", label: "copy prompt" },
            { key: "c", label: "copy path" },
            { key: "t", label: "ticket" },
            { key: "p", label: "PRs" },
            { key: "esc", label: "back" },
          ]
        : tab === "ticket"
          ? [
              { key: "↑↓", label: "scroll", disabled: scroll.max === 0 },
              { key: "b", label: "open in browser" },
              { key: "o", label: status.attached ? "focus session" : "launch session" },
              { key: "r", label: "refresh" },
              { key: "tab", label: "PRs" },
              { key: "esc", label: "back" },
            ]
          : [
              { key: "⏎", label: "open PR in browser", disabled: !prs.data?.length },
              { key: "o", label: status.attached ? "focus session" : "launch session" },
              { key: "r", label: "refresh" },
              { key: "tab", label: "worktrees" },
              { key: "esc", label: "back" },
            ];

  // The ticket fetch is the freshest thing we have, so the header follows it
  // rather than the snapshot stored when the workspace was created.
  const stateName = ticket.detail?.stateName || ws.ticket.stateName;
  const state = ticketStyle(ticket.detail?.stateType || ws.ticket.stateType);

  return (
    <Shell crumbs={["workspaces", ws.ticket.identifier]} hints={hints}>
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text>
          <span fg={theme.white} attributes={attrs.bold}>{truncate(ws.ticket.title, width - 28)}</span>
          <span>{"  "}</span>
          <span fg={state.color} attributes={attrs.bold}>{state.glyph}</span>
          <span fg={state.color}>{" " + stateName}</span>
        </text>
        <text>
          <span fg={theme.cyan}>{ws.branch}</span>
          <span fg={theme.textFaint}>{`  ${glyph.dash}  `}</span>
          <span fg={theme.textFaint} attributes={attrs.underline}>{ws.ticket.url}</span>
        </text>

        <box height={1} />
        <TabBar tab={tab} prCount={prs.data?.length} repoCount={live.length} />
        <box height={1} />

        {mode === "launch" || mode === "launching" ? (
          <LaunchPicker
            choices={choices}
            index={clampedIndex}
            launching={mode === "launching"}
            mainRepo={main?.name ?? "?"}
            terminal={TERMINAL_LABEL[resolveTerminal(app.config.terminal)]}
            target={app.config.launchTarget}
          />
        ) : tab === "overview" ? (
          <Overview ws={ws} nav={nav} statuses={statuses.data} width={width} />
        ) : tab === "ticket" ? (
          <TicketBody
            lines={ticket.lines}
            offset={scroll.offset}
            viewport={ticketViewport}
            loading={ticket.loading}
            more={Math.max(0, ticket.lines.length - scroll.offset - ticketViewport)}
          />
        ) : (
          <Prs prs={prs} nav={nav} viewport={viewport} width={width} hasToken={Boolean(app.githubToken)} />
        )}
      </box>
    </Shell>
  );
}

function TabBar({
  tab,
  prCount,
  repoCount,
}: {
  tab: Tab;
  prCount: number | undefined;
  repoCount: number;
}) {
  const tabs: Array<[Tab, string]> = [
    ["overview", `worktrees (${repoCount})`],
    ["ticket", "ticket"],
    ["prs", prCount === undefined ? "pull requests" : `pull requests (${prCount})`],
  ];
  return (
    <box flexDirection="row" height={1}>
      <text>
        {tabs.map(([id, label], i) => (
          <span key={id}>
            {i > 0 ? <span fg={theme.textFaint}>{"    "}</span> : null}
            <span fg={theme.accent}>{tab === id ? glyph.box : " "}</span>
            <span
              fg={tab === id ? theme.white : theme.textDim}
              attributes={tab === id ? attrs.bold : undefined}
            >
              {" " + label}
            </span>
          </span>
        ))}
      </text>
    </box>
  );
}

function Overview({
  ws,
  nav,
  statuses,
  width,
}: {
  ws: Workspace;
  nav: { index: number };
  statuses: Record<string, { exists: boolean; dirty: number; ahead: number }> | undefined;
  width: number;
}) {
  const live = ws.repos.filter((r) => !r.error);
  const failed = ws.repos.filter((r) => r.error);
  const nameW = Math.min(24, Math.max(...live.map((r) => r.name.length), 8) + 2);
  const pathW = Math.max(20, width - 4 - 2 - nameW - 18);

  return (
    <box flexDirection="column">
      {live.map((repo, i) => {
        const selected = i === nav.index;
        const st = statuses?.[repo.worktreePath];
        return (
          <box
            key={repo.worktreePath}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? theme.selBg : undefined}
          >
            <text>
              <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
              <span>{" "}</span>
              <span fg={repoColor(repo.name)} attributes={repo.isMain ? attrs.bold : undefined}>
                {pad(truncate(repo.name, nameW - 1), nameW)}
              </span>
              <span fg={theme.textDim}>{pad(truncate(contract(repo.worktreePath), pathW), pathW)}</span>
              <RepoBadges repo={repo} status={st} />
            </text>
          </box>
        );
      })}

      {failed.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          {failed.map((r) => (
            <text key={r.worktreePath} fg={theme.danger}>
              {`${glyph.cross} ${pad(r.name, nameW)}${truncate(r.error ?? "failed", width - nameW - 8)}`}
            </text>
          ))}
        </box>
      ) : null}

      <box flexGrow={1} />
      <box flexDirection="column" paddingTop={1}>
        <SectionLabel>{"handoff prompt"}</SectionLabel>
        <text fg={theme.textDim}>
          {truncate(`y copies the full prompt · Y copies just the ${live.length} repo - dir line${live.length === 1 ? "" : "s"}`, width - 4)}
        </text>
      </box>
    </box>
  );
}

function RepoBadges({
  repo,
  status,
}: {
  repo: WorkspaceRepo;
  status: { exists: boolean; dirty: number; ahead: number } | undefined;
}) {
  if (!status) return <span fg={theme.textFaint}>{"  …"}</span>;
  if (!status.exists) return <span fg={theme.danger}>{"  missing"}</span>;

  const bits: Array<[string, string]> = [];
  if (repo.isMain) bits.push(["main", theme.purpleBright]);
  if (status.dirty) bits.push([`${status.dirty} dirty`, theme.warnBright]);
  if (status.ahead) bits.push([`↑${status.ahead}`, theme.cyanBright]);
  if (bits.length === 0) bits.push(["clean", theme.textFaint]);

  return (
    <span>
      {bits.map(([label, color], i) => (
        <span key={label}>
          <span fg={theme.textFaint}>{i === 0 ? "  " : " · "}</span>
          <span fg={color}>{label}</span>
        </span>
      ))}
    </span>
  );
}

function Prs({
  prs,
  nav,
  viewport,
  width,
  hasToken,
}: {
  prs: { data: PullRequest[] | undefined; loading: boolean; error: string | undefined };
  nav: { index: number; start: number };
  viewport: number;
  width: number;
  hasToken: boolean;
}) {
  if (!hasToken) {
    return <EmptyState title="GitHub is not linked" hint="Press esc, then s to set it up" />;
  }
  if (prs.loading) {
    return (
      <box flexDirection="row" paddingTop={1}>
        <text>
          <Spinner />
          <span fg={theme.textDim}>{" Looking for pull requests on this branch…"}</span>
        </text>
      </box>
    );
  }
  if (prs.error) return <EmptyState title={prs.error} hint="Press r to retry" />;

  const items = prs.data ?? [];
  if (items.length === 0) {
    return <EmptyState title="No pull requests on this branch yet" hint="Push a branch and open one — then press r" />;
  }

  const repoW = 22;
  const titleW = Math.max(16, width - 4 - 2 - repoW - 8 - 12 - 10 - 14);

  return (
    <box flexDirection="column">
      {items.slice(nav.start, nav.start + viewport).map((pr, i) => {
        const selected = nav.start + i === nav.index;
        const state = prStyle(pr.state, pr.isDraft);
        const review = reviewStyle(pr.reviewDecision);
        return (
          <box
            key={pr.repoName + pr.number}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? theme.selBg : undefined}
          >
            <text>
              <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
              <span>{" "}</span>
              <span fg={repoColor(pr.repoName)}>{pad(truncate(pr.repoName, repoW - 1), repoW)}</span>
              <span fg={theme.cyanBright} attributes={attrs.bold}>{pad(`#${pr.number}`, 8)}</span>
              <span fg={selected ? theme.white : theme.text} attributes={selected ? attrs.bold : undefined}>
                {pad(truncate(pr.title, titleW), titleW)}
              </span>
              <span fg={state.color} attributes={attrs.bold}>{state.glyph}</span>
              <span fg={state.color}>{pad(" " + state.label, 9)}</span>
              <ChecksBadge checks={pr.checks} />
              <span fg={review?.color ?? theme.textFaint}>
                {pad(review ? `${review.glyph} ${review.label}` : "", 12)}
              </span>
              <span fg={theme.success}>{padStart(`+${pr.additions}`, 7)}</span>
              <span fg={theme.danger}>{padStart(`−${pr.deletions}`, 7)}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

function ChecksBadge({ checks }: { checks: PullRequest["checks"] }) {
  const style = checksStyle(checks);
  if (!style) return <span fg={theme.textFaint}>{pad("", 12)}</span>;
  return (
    <span>
      <span fg={style.color} attributes={attrs.bold}>{style.glyph}</span>
      <span fg={style.color}>{pad(" " + style.label, 11)}</span>
    </span>
  );
}

function LaunchPicker({
  choices,
  index,
  launching,
  mainRepo,
  terminal,
  target,
}: {
  choices: SessionChoice[];
  index: number;
  launching: boolean;
  mainRepo: string;
  terminal: string;
  target: "window" | "tab";
}) {
  const current = choices[index];

  return (
    <box flexDirection="column">
      <SectionLabel>{`session in ${mainRepo}`}</SectionLabel>
      <box height={1} />
      {choices.map((choice, i) => {
        const selected = i === index;
        const accent =
          choice.kind === "focus" ? theme.successBright : choice.kind === "resume" ? theme.cyanBright : theme.text;
        return (
          <box
            key={`${choice.kind}-${choice.agent}-${choice.sessionId ?? ""}`}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? theme.selBg : undefined}
          >
            <text>
              <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
              <span>{" "}</span>
              <span fg={selected ? theme.white : accent} attributes={selected ? attrs.bold : undefined}>
                {pad(choice.label, 16)}
              </span>
              <span fg={theme.textFaint}>{choice.desc}</span>
            </text>
          </box>
        );
      })}
      <box paddingTop={1}>
        {launching ? (
          <text>
            <Spinner />
            <span fg={theme.textDim}>
              {current?.kind === "focus" ? " Bringing the session forward…" : ` Opening ${terminal}…`}
            </span>
          </text>
        ) : (
          <text fg={theme.textFaint}>
            {current?.kind === "focus"
              ? `Brings the running session's ${terminal} window to the front — no second window.`
              : current?.kind === "resume"
                ? `Reopens that transcript in a new ${terminal} ${target}; it already knows the worktrees.`
                : `Opens a new ${terminal} ${target} in the main worktree, prompt pre-typed but not sent.`}
          </text>
        )}
      </box>
    </box>
  );
}
