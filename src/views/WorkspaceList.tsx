import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { EmptyState, SectionLabel, Spinner, type KeyHint } from "../components/primitives.tsx";
import { useQuit } from "../hooks/useQuit.ts";
import { useSessionActions } from "../hooks/useSessionActions.ts";
import { useTreeNav, type TreeNode, type TreeRow } from "../hooks/useTreeNav.ts";
import { openUrl } from "../lib/clipboard.ts";
import { searchInputBindings } from "../lib/keybindings.ts";
import {
  FILTERS,
  SORTS,
  filterSpec,
  haystack,
  prRollup,
  sortSpec,
  sortWorkspaces,
} from "../lib/list.ts";
import { matchesTokens, pad, padStart, relativeTime, truncate } from "../lib/text.ts";
import type { WorkspaceStatus } from "../services/status.ts";
import { removeWorktree } from "../services/git.ts";
import { useApp } from "../state/app-context.tsx";
import type { ListFilter, ListSort, PullRequest, Workspace } from "../state/types.ts";
import {
  attrs,
  checksStyle,
  glyph,
  idColor,
  prStyle,
  repoColor,
  reviewStyle,
  theme,
  ticketStyle,
  transparent,
} from "../theme.ts";

const CURSOR_W = 2;
const TWISTY_W = 3;
const ID_W = 10;
const SESSION_W = 12;
const STATE_W = 15;
const META_W = 20;
const TIME_W = 8;
/** header + 2 rules + footer + list padding + control bar + its spacer */
const CHROME_ROWS = 8;
/** Below this the repo column goes; below the second, the session column too. */
const META_MIN_WIDTH = 100;
const SESSION_MIN_WIDTH = 78;

type Mode = "list" | "search" | "filter" | "sort" | "help" | "confirm-delete" | "deleting";

/**
 * What a row is. A workspace owns its pull requests as children, so ↑↓ at the
 * top level step over a whole ticket and `→` drops into its PRs — see
 * useTreeNav for the navigation model.
 */
type Item =
  | { kind: "ws"; ws: Workspace; prs: PullRequest[] }
  | { kind: "pr"; ws: Workspace; pr: PullRequest };

interface Cols {
  showMeta: boolean;
  showSession: boolean;
  title: number;
}

function columns(width: number): Cols {
  const showMeta = width >= META_MIN_WIDTH;
  const showSession = width >= SESSION_MIN_WIDTH;
  const fixed =
    CURSOR_W + TWISTY_W + ID_W + STATE_W + TIME_W + (showSession ? SESSION_W : 0) + (showMeta ? META_W : 0);
  return { showMeta, showSession, title: Math.max(12, width - 4 - fixed) };
}

const ROLLUP_COLOR: Record<ReturnType<typeof prRollup>, string> = {
  failure: theme.danger,
  pending: theme.warn,
  open: theme.successBright,
  merged: theme.purpleBright,
  none: theme.textDim,
};

/** Diff sizes are decoration, so they get 3 characters and no more. */
function compactCount(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.min(99, Math.round(n / 1000))}k`;
}

export function WorkspaceList() {
  const app = useApp();
  const { height, width } = useTerminalDimensions();
  const [mode, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  // Per-workspace overrides on top of the persisted default, so folding one
  // branch open doesn't change what every other workspace does.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const quit = useQuit();

  const all = app.workspaces;
  const filter = filterSpec(app.config.listFilter);
  const sort = sortSpec(app.config.listSort);
  const { prsOf, statusOf } = app;

  const items = useMemo(() => {
    const matched = all
      .filter(filter.match)
      .filter((ws) => !query.trim() || matchesTokens(query, haystack(ws, prsOf(ws.id))));
    return sortWorkspaces(matched, sort.id, (ws) => statusOf(ws.id).lastActivity);
  }, [all, filter, sort, query, prsOf, statusOf]);

  const expandedFor = (ws: Workspace) => folds[ws.id] ?? app.config.listExpand;

  const tree = useMemo<TreeNode<Item>[]>(
    () =>
      items.map((ws) => {
        const prs = prsOf(ws.id);
        return {
          id: ws.id,
          value: { kind: "ws", ws, prs },
          collapsed: !expandedFor(ws),
          childLabel: "pull requests",
          children: prs.map((pr) => ({
            id: `${ws.id}:${pr.repoName}:${pr.number}`,
            value: { kind: "pr", ws, pr } as Item,
            children: [],
          })),
        };
      }),
    [items, prsOf, folds, app.config.listExpand],
  );

  const searching = mode === "search";
  const filtered = query.trim().length > 0;
  const inMenu = mode === "filter" || mode === "sort" || mode === "help";
  // The search row occupies two rows (input + blank) when visible.
  const viewport = Math.max(1, height - CHROME_ROWS - (searching || filtered ? 2 : 0));
  // While typing, j/k must reach the input rather than move the cursor.
  const nav = useTreeNav<Item>(tree, viewport, { rootLabel: "tickets", vimKeys: !searching });
  const focusedWs = nav.focused?.value.ws;
  const focusedIsPr = nav.focused?.value.kind === "pr";
  /** Key handlers read the live path; `nav.focused` is for rendering only. */
  const liveWs = () => nav.liveFocused()?.value.ws;

  // Re-narrowing the list should put the cursor back on the first match, at the
  // top level — the ticket it was pointing into may not even be here any more.
  useEffect(() => {
    nav.setPath([0]);
  }, [query, filter.id, sort.id]);

  const linked = app.issues.status === "ok";
  const sessions = useSessionActions();
  const focusedStatus = focusedWs ? statusOf(focusedWs.id) : undefined;
  const focusedLive = Boolean(focusedStatus?.attached);
  const focusedResumable = Boolean(focusedStatus?.resumable.claude || focusedStatus?.resumable.codex);
  const hiddenCount = all.filter((ws) => ws.hidden).length;

  async function doDelete(withWorktrees: boolean) {
    const ws = liveWs();
    if (!ws) return;
    setMode("deleting");
    try {
    if (withWorktrees) {
      for (const repo of ws.repos) {
        if (repo.error) continue;
        await removeWorktree(repo.repoPath, repo.worktreePath);
      }
    }
    await app.deleteWorkspace(ws.id);
    } catch (e) {
      setMode("list");
      app.showToast(e instanceof Error ? e.message : String(e), "error");
      return;
    }
    setMode("list");
    app.showToast(
      withWorktrees ? `Removed ${ws.ticket.identifier} and its worktrees` : `Forgot ${ws.ticket.identifier}`,
      "success",
    );
  }

  function setFold(ws: Workspace, open: boolean) {
    setFolds((f) => ({ ...f, [ws.id]: open }));
  }

  async function toggleHidden() {
    const ws = liveWs();
    if (!ws) return;
    const next = !ws.hidden;
    await app.setHidden(ws.id, next);
    app.showToast(
      next
        ? `Hid ${ws.ticket.identifier} — press f, then hidden, to find it`
        : `${ws.ticket.identifier} is back in the list`,
      "success",
    );
  }

  const menuOptions =
    mode === "filter"
      ? FILTERS.map((f) => ({
          label: f.label,
          desc: f.desc,
          count: all.filter(f.match).length,
          active: f.id === filter.id,
        }))
      : mode === "sort"
        ? SORTS.map((s) => ({ label: s.label, desc: s.desc, count: undefined, active: s.id === sort.id }))
        : [];

  async function applyMenu() {
    if (mode === "filter") {
      const picked = FILTERS[menuIndex];
      if (picked) {
        await app.patchConfig({ listFilter: picked.id as ListFilter });
        app.showToast(`Showing ${picked.label}`);
      }
    } else if (mode === "sort") {
      const picked = SORTS[menuIndex];
      if (picked) {
        await app.patchConfig({ listSort: picked.id as ListSort });
        app.showToast(`Sorted by ${picked.label}`);
      }
    }
    setMode("list");
  }

  useKeyboard((key) => {
    if (mode === "deleting") return;

    if (mode === "help") {
      if (key.name === "escape" || key.name === "q" || key.name === "?") setMode("list");
      return;
    }

    if (inMenu) {
      const len = menuOptions.length;
      if (key.name === "escape") setMode("list");
      else if (key.name === "up" || key.name === "k") setMenuIndex((i) => (i - 1 + len) % len);
      else if (key.name === "down" || key.name === "j") setMenuIndex((i) => (i + 1) % len);
      else if (key.name === "return") void applyMenu();
      return;
    }

    if (mode === "confirm-delete") {
      if (key.name === "w") void doDelete(true);
      else if (key.name === "e") void doDelete(false);
      else if (key.name === "escape" || key.name === "n") setMode("list");
      return;
    }

    if (searching) {
      // The search input is focused, so keys we act on must be claimed or it
      // receives them as text too. Only non-printable keys are claimed.
      if (key.name === "escape") {
        key.preventDefault();
        setQuery("");
        setMode("list");
        return;
      }
      if (key.name === "return") {
        // Accept the filter and hand the keyboard back to the list.
        key.preventDefault();
        setMode("list");
        return;
      }
      if (nav.handleKey(key)) key.preventDefault();
      return;
    }

    // ←→ only reach the switch below when the tree had nowhere to go: there is
    // no level to descend into, or none to come back to.
    if (nav.handleKey(key)) return;

    switch (key.name) {
      case "return": {
        const row = nav.liveFocused();
        if (!row) break;
        if (row.value.kind === "pr") {
          openUrl(row.value.pr.url);
          app.showToast(`Opened ${row.value.pr.repoName} #${row.value.pr.number}`);
        } else {
          app.navigate({ view: "detail", id: row.value.ws.id });
        }
        break;
      }
      case "right": {
        // Nothing to descend into means the branch is folded — open it, and the
        // next → steps inside.
        const row = nav.liveFocused();
        if (row?.value.kind === "ws" && row.value.prs.length) setFold(row.value.ws, true);
        break;
      }
      case "left": {
        // Already at the top level, so ← folds the branch instead.
        const row = nav.liveFocused();
        if (row?.value.kind === "ws") setFold(row.value.ws, false);
        break;
      }
      case "space": {
        const row = nav.liveFocused();
        if (!row) break;
        if (row.value.kind === "ws") setFold(row.value.ws, !expandedFor(row.value.ws));
        else {
          // Folding from inside a branch leaves the cursor on the branch.
          setFold(row.value.ws, false);
          nav.setPath(nav.getPath().slice(0, -1));
        }
        break;
      }
      case "z": {
        // Flip the default and drop every per-row override, so one keystroke
        // always lands on a consistent state.
        void app.patchConfig({ listExpand: !app.config.listExpand }).catch(e => app.showToast(String(e), "error"));
        setFolds({});
        break;
      }
      case "/":
        setMode("search");
        break;
      case "f":
        setMenuIndex(Math.max(0, FILTERS.findIndex((f) => f.id === filter.id)));
        setMode("filter");
        break;
      case "?":
        setMode("help");
        break;
      case "h":
        void toggleHidden().catch(e => app.showToast(String(e), "error"));
        break;
      case "escape":
        if (filtered) {
          setQuery("");
          app.showToast("Search cleared");
        } else if (filter.id !== "all") {
          void app.patchConfig({ listFilter: "all" }).catch(e => app.showToast(String(e), "error"));
          app.showToast("Filter cleared");
        }
        break;
      case "o": {
        // Open the session itself: focus a running one, else resume the newest
        // transcript, else launch fresh. Never opens a duplicate window.
        const ws = liveWs();
        if (ws) void sessions.attach(ws);
        break;
      }
      case "t": {
        const ws = liveWs();
        if (ws) app.navigate({ view: "detail", id: ws.id, tab: "ticket" });
        break;
      }
      case "n":
        if (!linked) {
          app.showToast("Link your issue source — press s for settings", "error");
          return;
        }
        app.navigate({ view: "create" });
        break;
      case "d":
        if (liveWs()) setMode("confirm-delete");
        break;
      case "s":
        // Shift picks the sort order; the terminal reports S as shift+s.
        if (key.shift) {
          setMenuIndex(Math.max(0, SORTS.findIndex((s) => s.id === sort.id)));
          setMode("sort");
        } else {
          app.navigate({ view: "settings" });
        }
        break;
      case "r":
        app.checkConnections();
        app.refreshStatuses();
        app.refreshPrs();
        app.refreshTickets();
        app.showToast("Rechecking…");
        break;
      case "q":
        quit();
    }
  });

  const hints = buildHints({
    mode,
    empty: nav.rows.length === 0,
    filtered,
    focusedIsPr,
    levelLabel: nav.levelLabel,
    childLabel: nav.childLabel,
    parentLabel: nav.parentLabel,
    sessionVerb: focusedLive ? "focus session" : focusedResumable ? "resume session" : "launch session",
    hideVerb: focusedWs?.hidden ? "unhide" : "hide",
  });

  const cols = columns(width);
  const crumbs = ["workspaces"];
  if (filter.id !== "all") crumbs.push(filter.label);
  if (filtered) crumbs.push(`"${truncate(query.trim(), 24)}"`);
  // Descending is navigation, so it shows up in the breadcrumb like navigation.
  if (nav.depth > 0 && focusedWs) crumbs.push(focusedWs.ticket.identifier, nav.levelLabel);

  return (
    <Shell crumbs={crumbs} hints={hints}>
      {all.length === 0 ? (
        <EmptyState
          title={linked ? "No workspaces yet" : `Link ${app.config.issueProvider === "jira" ? "Jira" : "Linear"} to get started`}
          hint={linked ? "Press n to create one from an issue" : "Press s to open settings"}
        />
      ) : mode === "help" ? (
        <HelpPanel />
      ) : inMenu ? (
        <MenuPanel
          title={mode === "filter" ? "SHOW" : "ORDER BY"}
          options={menuOptions}
          index={menuIndex}
        />
      ) : (
        <box flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
          <ControlBar
            filter={filter}
            sort={sort}
            shown={items.length}
            total={all.length}
            hiddenCount={hiddenCount}
          />
          <box height={1} />

          {searching || filtered ? (
            <SearchRow query={query} editing={searching} onInput={setQuery} />
          ) : null}

          {nav.rows.length === 0 ? (
            <EmptyState
              title={
                filtered
                  ? `No workspaces matching "${query.trim()}"`
                  : `Nothing in "${filter.label}" right now`
              }
              hint={
                filtered
                  ? searching
                    ? "Keep typing, or esc to clear"
                    : "Press esc to clear the search"
                  : "Press f to change the filter"
              }
            />
          ) : null}

          {nav.rows.slice(nav.start, nav.start + viewport).map((row, i) => {
            const marks = {
              focused: nav.start + i === nav.index,
              selected: nav.selected(row),
              scoped: nav.inScope(row),
            };
            return row.value.kind === "ws" ? (
              <WorkspaceRow
                key={row.node.id}
                ws={row.value.ws}
                prs={row.value.prs}
                expanded={!row.node.collapsed}
                marks={marks}
                status={statusOf(row.value.ws.id)}
                cols={cols}
              />
            ) : (
              <PrRow key={row.node.id} pr={row.value.pr} last={row.last} marks={marks} cols={cols} />
            );
          })}

          {mode === "confirm-delete" && focusedWs ? (
            <box paddingTop={1}>
              <text fg={theme.warn}>
                {`Delete ${focusedWs.ticket.identifier}? Worktrees in ${focusedWs.repos.length} repo${focusedWs.repos.length === 1 ? "" : "s"} will be removed.`}
              </text>
            </box>
          ) : null}
          {mode === "deleting" ? (
            <box paddingTop={1}>
              <text>
                <Spinner />
                <span fg={theme.textDim}>{" Removing worktrees…"}</span>
              </text>
            </box>
          ) : null}
        </box>
      )}
    </Shell>
  );
}

/**
 * How a row relates to the cursor. `selected` is the whole focused subtree —
 * at the top level that's a ticket *and* its PRs, which is the point: one ↓ is
 * one ticket. `scoped` is the level you've descended into.
 */
interface Marks {
  focused: boolean;
  selected: boolean;
  scoped: boolean;
}

function Cursor({ marks }: { marks: Marks }) {
  if (marks.selected) return <span fg={theme.accent}>{glyph.box}</span>;
  if (marks.scoped) return <span fg={theme.accentDim}>{glyph.rail}</span>;
  return <span>{" "}</span>;
}

const rowBg = (marks: Marks) => (marks.selected ? theme.selBg : undefined);

function buildHints(opts: {
  mode: Mode;
  empty: boolean;
  filtered: boolean;
  focusedIsPr: boolean;
  levelLabel: string;
  childLabel: string | undefined;
  parentLabel: string | undefined;
  sessionVerb: string;
  hideVerb: string;
}): KeyHint[] {
  const { mode, empty, filtered, focusedIsPr, levelLabel, childLabel, parentLabel, sessionVerb, hideVerb } = opts;

  if (mode === "confirm-delete") {
    return [
      { key: "w", label: "delete worktrees + entry" },
      { key: "e", label: "forget entry only" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (mode === "help") return [{ key: "esc", label: "back to the list" }];
  if (mode === "filter" || mode === "sort") {
    return [
      { key: "↑↓", label: "move" },
      { key: "⏎", label: "apply" },
      { key: "esc", label: "cancel" },
    ];
  }
  if (mode === "search") {
    return [
      { key: "↑↓", label: levelLabel, disabled: empty },
      { key: "⏎", label: "accept" },
      { key: "esc", label: "clear" },
    ];
  }

  // Priority order — the footer drops from the right when the terminal narrows.
  // ↑↓ and ←→ are named after the level they move through, which is the only
  // place the two-axis model is ever explained.
  return [
    { key: "↑↓", label: levelLabel, disabled: empty },
    { key: "⏎", label: focusedIsPr ? "open PR" : "details", disabled: empty },
    ...(parentLabel ? [{ key: "←", label: parentLabel }] : []),
    ...(childLabel ? [{ key: "→", label: childLabel }] : []),
    { key: "o", label: sessionVerb, disabled: empty },
    { key: "/", label: filtered ? "edit search" : "search" },
    { key: "n", label: "new workspace" },
    { key: "f", label: "filter" },
    { key: "S", label: "sort" },
    { key: "h", label: hideVerb, disabled: empty },
    { key: "d", label: "delete", disabled: empty },
    { key: "t", label: "ticket", disabled: empty },
    { key: "s", label: "settings" },
    { key: "r", label: "refresh" },
    { key: "q", label: "quit" },
  ];
}

/**
 * Always-on summary of what the list is currently showing. Filter and sort read
 * loud the moment either is off its default, so a narrowed list can never be
 * mistaken for the whole list.
 */
function ControlBar({
  filter,
  sort,
  shown,
  total,
  hiddenCount,
}: {
  filter: { id: ListFilter; label: string };
  sort: { id: ListSort; label: string };
  shown: number;
  total: number;
  hiddenCount: number;
}) {
  const filterOn = filter.id !== "all";
  const sortOn = sort.id !== "recent";

  return (
    <box flexDirection="row" height={1}>
      <text>
        <span fg={filterOn ? theme.warnBright : theme.textFaint}>{glyph.filter + " "}</span>
        <span fg={filterOn ? theme.warnBright : theme.textDim} attributes={attrs.bold}>
          {filter.label}
        </span>
        <span fg={theme.textFaint}>{"    " + glyph.sort + " "}</span>
        <span fg={sortOn ? theme.cyanBright : theme.textDim} attributes={sortOn ? attrs.bold : undefined}>
          {sort.label}
        </span>
      </text>
      <box flexGrow={1} />
      <text>
        <span fg={theme.textDim}>
          {shown === total ? `${total} workspace${total === 1 ? "" : "s"}` : `${shown} of ${total}`}
        </span>
        {hiddenCount > 0 && filter.id !== "hidden" ? (
          <span fg={theme.textFaint}>{`    ${glyph.hidden} ${hiddenCount} hidden`}</span>
        ) : null}
      </text>
    </box>
  );
}

function WorkspaceRow({
  ws,
  prs,
  expanded,
  marks,
  status,
  cols,
}: {
  ws: Workspace;
  prs: PullRequest[];
  expanded: boolean;
  marks: Marks;
  status: WorkspaceStatus;
  cols: Cols;
}) {
  const titleColor = ws.hidden ? theme.textDim : marks.focused ? theme.white : theme.heading;

  return (
    <box flexDirection="row" height={1} backgroundColor={rowBg(marks)}>
      <text>
        <Cursor marks={marks} />
        <span>{" "}</span>
        <TwistyCell prs={prs} expanded={expanded} />
        <span fg={idColor(0, { selected: marks.selected })} attributes={attrs.bold}>
          {pad(truncate(ws.ticket.identifier, ID_W - 1), ID_W)}
        </span>
        <span fg={titleColor} attributes={marks.focused ? attrs.bold : undefined}>
          {pad(truncate(ws.ticket.title, cols.title - 1), cols.title)}
        </span>
        {cols.showSession ? <SessionCell status={status} /> : null}
        <TicketStateCell stateName={ws.ticket.stateName} stateType={ws.ticket.stateType} />
        {cols.showMeta ? <ReposCell ws={ws} /> : null}
        <span fg={theme.textFaint}>{padStart(relativeTime(ws.createdAt), TIME_W)}</span>
      </text>
    </box>
  );
}

/**
 * The fold marker doubles as the collapsed summary: closed, it shows how many
 * PRs are folded away and takes its colour from the worst of them, so a red
 * arrow means there's a failing check hidden under this row.
 */
function TwistyCell({ prs, expanded }: { prs: PullRequest[]; expanded: boolean }) {
  if (prs.length === 0) return <span>{" ".repeat(TWISTY_W)}</span>;
  const color = ROLLUP_COLOR[prRollup(prs)];
  if (expanded) {
    return <span fg={color} attributes={attrs.bold}>{glyph.twistyOpen + "  "}</span>;
  }
  return (
    <span>
      <span fg={color} attributes={attrs.bold}>{glyph.twistyClosed}</span>
      <span fg={theme.textDim}>{(prs.length > 9 ? "+" : String(prs.length)) + " "}</span>
    </span>
  );
}

/** The whole ticket's status — the thing feature-parity with Linear is about. */
function TicketStateCell({ stateName, stateType }: { stateName: string; stateType: string }) {
  const style = ticketStyle(stateType);
  return (
    <span>
      <span fg={style.color} attributes={attrs.bold}>{style.glyph}</span>
      <span fg={style.color}>{pad(" " + truncate(stateName || "unknown", STATE_W - 3), STATE_W - 1)}</span>
    </span>
  );
}

function ReposCell({ ws }: { ws: Workspace }) {
  const created = ws.repos.filter((r) => !r.error);
  const failed = ws.repos.length - created.length;
  const first = created[0]?.name ?? "no repos";
  const extra = created.length > 1 ? ` +${created.length - 1}` : "";
  const tail = failed ? ` · ${failed} failed` : "";
  const name = truncate(first, Math.max(4, META_W - 1 - extra.length - tail.length));
  const slack = Math.max(0, META_W - name.length - extra.length - tail.length);

  return (
    <span>
      <span fg={created.length ? repoColor(first) : theme.textFaint}>{name}</span>
      <span fg={theme.textDim}>{extra}</span>
      <span fg={theme.danger}>{tail}</span>
      <span>{" ".repeat(slack)}</span>
    </span>
  );
}

/** Live session state: spinner while the agent works, dot when it's idle. */
function SessionCell({ status }: { status: WorkspaceStatus }) {
  if (status.working) {
    return (
      <span>
        <Spinner color={theme.cyanBright} />
        <span fg={theme.cyanBright} attributes={attrs.bold}>{pad(" working", SESSION_W - 1)}</span>
      </span>
    );
  }
  if (status.attached) {
    return (
      <span>
        <span fg={theme.successBright} attributes={attrs.bold}>{glyph.dot}</span>
        <span fg={theme.success}>{pad(` ${status.agent ?? "session"}`, SESSION_W - 1)}</span>
      </span>
    );
  }
  const resumable = status.resumable.claude ?? status.resumable.codex;
  if (resumable) {
    return (
      <span>
        <span fg={theme.textDim}>{glyph.dotOpen}</span>
        <span fg={theme.textDim}>{pad(" resumable", SESSION_W - 1)}</span>
      </span>
    );
  }
  return <span>{pad("", SESSION_W)}</span>;
}

/**
 * A pull request, indented under its workspace. Columns line up with the parent
 * row on purpose: the PR number sits under the ticket id and the PR's repo sits
 * under the workspace's repo summary.
 */
function PrRow({
  pr,
  last,
  marks,
  cols,
}: {
  pr: PullRequest;
  last: boolean;
  marks: Marks;
  cols: Cols;
}) {
  const state = prStyle(pr.state, pr.isDraft);
  const review = reviewStyle(pr.reviewDecision);
  const checks = checksStyle(pr.checks);
  const stale = pr.state !== "OPEN";
  // Without a repo column the repo has to ride along with the title, or the
  // row stops saying which checkout it belongs to.
  const title = cols.showMeta ? pr.title : `${pr.repoName} · ${pr.title}`;

  const stateWidth = 1 + 1 + state.label.length + (review ? 2 : 0);

  return (
    <box flexDirection="row" height={1} backgroundColor={rowBg(marks)}>
      <text>
        <Cursor marks={marks} />
        <span>{" "}</span>
        <span fg={theme.textFaint}>{(last ? glyph.treeEnd : glyph.treeMid) + glyph.treeBar + " "}</span>
        <span fg={idColor(1, { selected: marks.selected, muted: stale })} attributes={attrs.bold}>
          {pad(truncate(`#${pr.number}`, ID_W - 1), ID_W)}
        </span>
        <span
          fg={stale ? theme.textDim : marks.focused ? theme.white : theme.text}
          attributes={marks.focused ? attrs.bold : undefined}
        >
          {pad(truncate(title, cols.title - 1), cols.title)}
        </span>
        {cols.showSession ? (
          checks ? (
            <span>
              <span fg={checks.color} attributes={attrs.bold}>{checks.glyph}</span>
              <span fg={checks.color}>{pad(" " + checks.label, SESSION_W - 1)}</span>
            </span>
          ) : (
            <span>{pad("", SESSION_W)}</span>
          )
        ) : null}
        <span>
          <span fg={state.color} attributes={attrs.bold}>{state.glyph}</span>
          <span fg={state.color}>{" " + state.label}</span>
          {review ? <span fg={review.color} attributes={attrs.bold}>{" " + review.glyph}</span> : null}
          <span>{" ".repeat(Math.max(0, STATE_W - stateWidth))}</span>
        </span>
        {cols.showMeta ? (
          <span fg={repoColor(pr.repoName)}>{pad(truncate(pr.repoName, META_W - 1), META_W)}</span>
        ) : null}
        <span>
          <span fg={theme.success}>{padStart(`+${compactCount(pr.additions)}`, TIME_W - 4)}</span>
          <span fg={theme.danger}>{padStart(`−${compactCount(pr.deletions)}`, 4)}</span>
        </span>
      </text>
    </box>
  );
}

/**
 * The filter row. Stays visible (read-only) after you accept a query, so a
 * narrowed list never looks like the whole list. Counts live in the control bar
 * above it rather than being repeated here.
 */
function SearchRow({
  query,
  editing,
  onInput,
}: {
  query: string;
  editing: boolean;
  onInput: (value: string) => void;
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1}>
        <text>
          <span fg={editing ? theme.accentBright : theme.textFaint} attributes={attrs.bold}>
            {glyph.chevron + " "}
          </span>
        </text>
        {editing ? (
          <input
            focused
            value={query}
            onInput={onInput}
            keyBindings={searchInputBindings}
            flexGrow={1}
            backgroundColor={transparent}
            focusedBackgroundColor={transparent}
            textColor={theme.white}
            cursorColor={theme.accent}
            placeholderColor={theme.textFaint}
            placeholder="filter by ticket, title, branch or repo"
          />
        ) : (
          <box flexGrow={1}>
            <text fg={theme.textDim}>{query}</text>
          </box>
        )}
      </box>
      <box height={1} />
    </box>
  );
}

interface MenuOption {
  label: string;
  desc: string;
  count?: number;
  active: boolean;
}

/** Shared body for the filter and sort pickers. */
function MenuPanel({ title, options, index }: { title: string; options: MenuOption[]; index: number }) {
  return (
    <box flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
      <SectionLabel>{title}</SectionLabel>
      <box height={1} />
      {options.map((opt, i) => {
        const selected = i === index;
        return (
          <box
            key={opt.label}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? theme.selBg : undefined}
          >
            <text>
              <span fg={theme.accent}>{selected ? glyph.box : " "}</span>
              <span>{" "}</span>
              <span fg={opt.active ? theme.successBright : theme.textFaint} attributes={attrs.bold}>
                {opt.active ? glyph.check : " "}
              </span>
              <span
                fg={selected ? theme.white : opt.active ? theme.heading : theme.text}
                attributes={selected || opt.active ? attrs.bold : undefined}
              >
                {" " + pad(opt.label, 14)}
              </span>
              {opt.count !== undefined ? (
                <span fg={theme.textDim}>{padStart(String(opt.count), 4) + "  "}</span>
              ) : (
                <span>{"      "}</span>
              )}
              <span fg={theme.textFaint}>{opt.desc}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

const HELP: Array<[string, string]> = [
  ["↑ ↓ · j k", "move through whatever level you're on — tickets, then their PRs"],
  ["→", "step down a level: into this ticket's pull requests"],
  ["←", "step back up a level, or fold the ticket when you're already at the top"],
  ["space · z", "fold this ticket's pull requests · fold every ticket at once"],
  ["⏎", "open the ticket's workspace — or the pull request, in your browser"],
  ["o", "open the session: focus it, resume it, or launch it"],
  ["t", "read the full issue"],
  ["/", "search tickets, states, branches, repos and PR titles"],
  ["f", "filter by ticket status"],
  ["S", "change the sort order"],
  ["h", "hide the ticket, or bring a hidden one back"],
  ["n", "new workspace from an issue"],
  ["d", "delete — worktrees and entry, or just the entry"],
  ["s", "settings"],
  ["r", "refresh sessions, pull requests and ticket states"],
  ["esc", "clear the search, then the filter"],
  ["q", "quit"],
];

const HELP_KEY_W = 14;

function HelpPanel() {
  return (
    <box flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
      <SectionLabel>{"KEYS"}</SectionLabel>
      <box height={1} />
      {HELP.map(([key, what]) => (
        <box key={key} flexDirection="row" height={1}>
          <text>
            <span fg={theme.accentBright} attributes={attrs.bold}>{pad(key, HELP_KEY_W)}</span>
            <span fg={theme.textDim}>{what}</span>
          </text>
        </box>
      ))}
      <box height={1} />
      <text fg={theme.textFaint}>
        {"↑↓ never leave the level you're on, and the footer names it. Hiding is not deleting."}
      </text>
    </box>
  );
}
