import type { ListFilter, ListSort, PullRequest, Workspace } from "../state/types.ts";
import { stateRank } from "../theme.ts";

/**
 * The workspace list's filter and sort vocabulary, kept out of the view so the
 * rules are testable on their own and the menus can be generated from the same
 * source that does the filtering.
 */

export interface FilterSpec {
  id: ListFilter;
  /** Shown in the control bar and the menu */
  label: string;
  desc: string;
  match: (ws: Workspace) => boolean;
}

const visible = (ws: Workspace) => !ws.hidden;

export const FILTERS: FilterSpec[] = [
  {
    id: "all",
    label: "all",
    desc: "every workspace except the ones you've hidden",
    match: visible,
  },
  {
    id: "doing",
    label: "in progress",
    desc: "issues currently in progress",
    match: (ws) => visible(ws) && ws.ticket.stateType === "started",
  },
  {
    id: "todo",
    label: "todo",
    desc: "backlog and not-yet-started tickets",
    match: (ws) => visible(ws) && (ws.ticket.stateType === "unstarted" || ws.ticket.stateType === "backlog"),
  },
  {
    id: "done",
    label: "done",
    desc: "completed and cancelled tickets",
    match: (ws) => visible(ws) && (ws.ticket.stateType === "completed" || ws.ticket.stateType === "canceled"),
  },
  {
    id: "hidden",
    label: "hidden",
    desc: "workspaces you hid with h — nothing was deleted",
    match: (ws) => Boolean(ws.hidden),
  },
];

export function filterSpec(id: ListFilter): FilterSpec {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0]!;
}

export interface SortSpec {
  id: ListSort;
  label: string;
  desc: string;
}

export const SORTS: SortSpec[] = [
  { id: "recent", label: "newest", desc: "most recently created workspace first" },
  { id: "activity", label: "activity", desc: "most recent agent session first" },
  { id: "status", label: "status", desc: "in progress, then todo, then backlog, then done" },
  { id: "ticket", label: "ticket", desc: "by ticket identifier, ENG-1 before ENG-20" },
  { id: "title", label: "title", desc: "alphabetical by ticket title" },
];

export function sortSpec(id: ListSort): SortSpec {
  return SORTS.find((s) => s.id === id) ?? SORTS[0]!;
}

/** ENG-90 sorts before ENG-412 — string order would put it after. */
export function compareIdentifier(a: string, b: string): number {
  const pa = /^([A-Za-z]*)-?(\d+)$/.exec(a);
  const pb = /^([A-Za-z]*)-?(\d+)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  const byTeam = pa[1]!.localeCompare(pb[1]!);
  return byTeam !== 0 ? byTeam : Number(pa[2]) - Number(pb[2]);
}

const createdAt = (ws: Workspace) => {
  const t = Date.parse(ws.createdAt);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Ordering is stable within a tie so the list never reshuffles under the cursor
 * on a poll: every comparator falls back to newest-first.
 */
export function sortWorkspaces(
  list: Workspace[],
  sort: ListSort,
  activityOf: (ws: Workspace) => number | undefined,
): Workspace[] {
  const byRecent = (a: Workspace, b: Workspace) => createdAt(b) - createdAt(a);
  const out = [...list];

  switch (sort) {
    case "activity":
      out.sort((a, b) => (activityOf(b) ?? createdAt(b)) - (activityOf(a) ?? createdAt(a)) || byRecent(a, b));
      break;
    case "status":
      out.sort(
        (a, b) => stateRank(a.ticket.stateType) - stateRank(b.ticket.stateType) || byRecent(a, b),
      );
      break;
    case "ticket":
      out.sort((a, b) => compareIdentifier(a.ticket.identifier, b.ticket.identifier) || byRecent(a, b));
      break;
    case "title":
      out.sort((a, b) => a.ticket.title.localeCompare(b.ticket.title) || byRecent(a, b));
      break;
    default:
      out.sort(byRecent);
  }
  return out;
}

/** Everything a search query is matched against, including the child PRs. */
export function haystack(ws: Workspace, prs: PullRequest[]): string {
  return [
    ws.ticket.identifier,
    ws.ticket.title,
    ws.ticket.stateName,
    ws.ticket.assignee ?? "",
    ws.branch,
    ws.slug,
    ...ws.repos.map((r) => r.name),
    ...prs.map((pr) => `#${pr.number} ${pr.title}`),
  ].join(" ");
}

/**
 * The worst thing happening across a workspace's open PRs, used to colour the
 * collapsed tree marker — a red twisty means "there's a failure folded up here".
 */
export function prRollup(prs: PullRequest[]): "failure" | "pending" | "open" | "merged" | "none" {
  const live = prs.filter((p) => p.state === "OPEN");
  if (live.some((p) => p.checks === "FAILURE")) return "failure";
  if (live.some((p) => p.checks === "PENDING")) return "pending";
  if (live.length > 0) return "open";
  if (prs.length > 0 && prs.every((p) => p.state === "MERGED")) return "merged";
  return "none";
}
