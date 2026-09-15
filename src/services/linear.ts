import type { Team, TicketNode, SubIssue, IssueComment, IssueDetail, TicketState } from "../integrations/issues/types.ts";
export type { Team, TicketNode, SubIssue, IssueComment, IssueDetail, TicketState } from "../integrations/issues/types.ts";
import type { LinearTicket } from "../state/types.ts";

const ENDPOINT = "https://api.linear.app/graphql";

/**
 * Personal API keys (lin_api_…) go in Authorization raw; OAuth tokens need the
 * Bearer prefix. Supporting both means a pasted key works either way.
 */
function authHeader(apiKey: string): string {
  const key = apiKey.trim();
  return key.startsWith("lin_api_") ? key : `Bearer ${key}`;
}

class LinearError extends Error {}

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { tolerant?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: authHeader(apiKey) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new LinearError(
      err instanceof Error && err.name === "TimeoutError" ? "Linear request timed out" : "Cannot reach Linear",
    );
  }

  if (res.status === 401 || res.status === 403) throw new LinearError("Linear rejected the API key");
  if (res.status === 429) throw new LinearError("Linear rate limit hit — wait a moment");
  if (!res.ok) throw new LinearError(`Linear returned HTTP ${res.status}`);

  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  // Aliased batch queries null out the issues you can no longer see and report
  // them in `errors` while the rest resolves, so those callers opt out of the
  // strict check rather than losing the whole batch to one dead ticket.
  if (body.errors?.length && !opts.tolerant) throw new LinearError(body.errors[0]!.message);
  if (!body.data) throw new LinearError(body.errors?.[0]?.message ?? "Linear returned an empty response");
  return body.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  branchName
  state { name type }
  team { key }
  assignee { displayName }
`;

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  state?: { name?: string; type?: string } | null;
  team?: { key?: string } | null;
  assignee?: { displayName?: string } | null;
}

function toTicket(raw: RawIssue): LinearTicket {
  return {
    provider: "linear",
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    branchName: raw.branchName,
    stateName: raw.state?.name ?? "",
    stateType: raw.state?.type ?? "",
    teamKey: raw.team?.key ?? raw.identifier.split("-")[0] ?? "",
    assignee: raw.assignee?.displayName ?? undefined,
  };
}


/**
 * Teams the key can create issues in, plus the viewer's id so a new ticket can
 * be self-assigned — one request feeds the whole create-ticket form.
 */
export async function fetchTeams(apiKey: string): Promise<{ viewerId: string; teams: Team[] }> {
  const data = await gql<{ viewer: { id: string }; teams: { nodes: Team[] } }>(
    apiKey,
    `query { viewer { id } teams(first: 50) { nodes { id key name } } }`,
  );
  return { viewerId: data.viewer.id, teams: data.teams.nodes };
}

/**
 * Creates an issue and returns it as a full ticket — including Linear's own
 * suggested branch name — ready to build a workspace from.
 */
export async function createIssue(
  apiKey: string,
  input: { teamId: string; title: string; description?: string; assigneeId?: string },
): Promise<LinearTicket> {
  const data = await gql<{ issueCreate: { success: boolean; issue: RawIssue | null } }>(
    apiKey,
    `mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    { input },
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new LinearError("Linear did not create the issue");
  }
  return toTicket(data.issueCreate.issue);
}

/** Validates the key and returns the account name for the status pill. */
export async function verifyKey(apiKey: string): Promise<{ name: string; email: string }> {
  const data = await gql<{ viewer: { name: string; email: string } }>(
    apiKey,
    `query { viewer { name email } }`,
  );
  return data.viewer;
}

/**
 * A ticket and the sub-issues nested under it. The picker walks this as a tree,
 * and every node is a full ticket — picking a sub-issue builds a workspace from
 * the sub-issue, which is usually the one you actually want to branch from.
 */

/**
 * Sub-issues fetched per ticket. Deep enough to be useful, shallow enough that
 * 30 tickets × their children stays inside Linear's query complexity budget.
 */
const CHILD_LIMIT = 10;

interface RawIssueTree extends RawIssue {
  children?: { nodes: RawIssue[] } | null;
}

/** Sub-issues come back with the parent, so the tree costs no extra request. */
const WITH_CHILDREN = `
  ${ISSUE_FIELDS}
  children(first: ${CHILD_LIMIT}) { nodes { ${ISSUE_FIELDS} } }
`;

function toNode(raw: RawIssueTree): TicketNode {
  return {
    ticket: toTicket(raw),
    children: (raw.children?.nodes ?? []).map((child) => ({ ticket: toTicket(child), children: [] })),
  };
}

/**
 * Drops a ticket from the top level when it is already nested under another
 * result. A search for "billing" matches a parent and its sub-issue alike, and
 * the same ticket in two places reads as two different tickets.
 */
function nest(nodes: TicketNode[]): TicketNode[] {
  const nested = new Set(nodes.flatMap((n) => n.children.map((c) => c.ticket.id)));
  return nodes.filter((n) => !nested.has(n.ticket.id));
}

/**
 * Issues assigned to the key's owner, most-recently-updated first. This is the
 * zero-input state of the ticket picker — usually what you want is right here.
 */
export async function myIssues(apiKey: string, limit = 30): Promise<TicketNode[]> {
  const data = await gql<{ viewer: { assignedIssues: { nodes: RawIssueTree[] } } }>(
    apiKey,
    `query My($first: Int!) {
      viewer {
        assignedIssues(first: $first, orderBy: updatedAt) { nodes { ${WITH_CHILDREN} } }
      }
    }`,
    { first: limit },
  );
  // Filter client-side rather than via IssueFilter: fewer moving parts, and
  // done/cancelled tickets are rarely what you're starting work on. Sub-issues
  // are left alone — a finished one is context for the parent, shown struck
  // through rather than hidden.
  return nest(
    data.viewer.assignedIssues.nodes
      .map(toNode)
      .filter((n) => n.ticket.stateType !== "completed" && n.ticket.stateType !== "canceled"),
  );
}

/**
 * Full-text search across the workspace. Linear rate-limits this to 30/min, so
 * callers must debounce (see useDebounced).
 */
export async function searchIssues(apiKey: string, term: string, limit = 25): Promise<TicketNode[]> {
  const data = await gql<{ searchIssues: { nodes: RawIssueTree[] } }>(
    apiKey,
    `query Search($term: String!, $first: Int!) {
      searchIssues(term: $term, first: $first) { nodes { ${WITH_CHILDREN} } }
    }`,
    { term, first: limit },
  );
  return nest(data.searchIssues.nodes.map(toNode));
}

/** Every ticket in a tree, parents before their children — for counts. */
export function flattenTickets(nodes: TicketNode[]): LinearTicket[] {
  return nodes.flatMap((n) => [n.ticket, ...flattenTickets(n.children)]);
}




/** The subset of a ticket that goes stale on disk and is worth re-reading. */

/** Linear's alias limit is generous, but a request per 40 keeps URLs sane. */
const STATE_BATCH = 40;

/**
 * Current workflow state for a set of issues, by id. Tickets that no longer
 * resolve (deleted, or moved out of reach of the key) are simply absent from
 * the map rather than failing the batch.
 */
export async function issueStates(apiKey: string, ids: string[]): Promise<Map<string, TicketState>> {
  const out = new Map<string, TicketState>();
  const unique = [...new Set(ids)].filter(Boolean);

  for (let offset = 0; offset < unique.length; offset += STATE_BATCH) {
    const chunk = unique.slice(offset, offset + STATE_BATCH);
    const parts = chunk.map(
      (id, i) => `i${i}: issue(id: ${JSON.stringify(id)}) {
        id
        title
        state { name type }
        assignee { displayName }
      }`,
    );

    const data = await gql<Record<string, RawIssueState | null>>(
      apiKey,
      `query States { ${parts.join("\n")} }`,
      {},
      { tolerant: true },
    );

    chunk.forEach((id, i) => {
      const node = data[`i${i}`];
      if (!node) return;
      out.set(id, {
        id: node.id,
        title: node.title,
        stateName: node.state?.name ?? "",
        stateType: node.state?.type ?? "",
        assignee: node.assignee?.displayName ?? undefined,
      });
    });
  }

  return out;
}

interface RawIssueState {
  id: string;
  title: string;
  state?: { name?: string; type?: string } | null;
  assignee?: { displayName?: string } | null;
}

/** Linear's fixed priority scale; 0 means unset. */
export const PRIORITY_LABEL: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/**
 * Everything the repo-selection step shows about the chosen ticket, including
 * sub-issues. One request; fields are limited to ones that have been stable in
 * Linear's schema for a long time.
 */
export async function issueDetail(apiKey: string, id: string): Promise<IssueDetail> {
  const data = await gql<{
    issue: {
      description: string | null;
      priority: number | null;
      estimate: number | null;
      createdAt: string;
      updatedAt: string;
      labels: { nodes: Array<{ name: string }> };
      project: { name: string } | null;
      cycle: { number: number; name: string | null } | null;
      parent: { identifier: string; title: string } | null;
      state?: { name?: string; type?: string } | null;
      children: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          state?: { name?: string; type?: string } | null;
          assignee?: { displayName?: string } | null;
        }>;
      };
      comments: {
        nodes: Array<{
          id: string;
          body: string;
          createdAt: string;
          user?: { displayName?: string } | null;
        }>;
      };
    };
  }>(
    apiKey,
    `query Detail($id: String!) {
      issue(id: $id) {
        description
        priority
        estimate
        createdAt
        updatedAt
        state { name type }
        labels(first: 10) { nodes { name } }
        project { name }
        cycle { number name }
        parent { identifier title }
        children(first: 25) {
          nodes {
            id
            identifier
            title
            state { name type }
            assignee { displayName }
          }
        }
        comments(first: 20) {
          nodes {
            id
            body
            createdAt
            user { displayName }
          }
        }
      }
    }`,
    { id },
  );

  const issue = data.issue;
  return {
    description: issue.description ?? "",
    priority: issue.priority ?? 0,
    estimate: issue.estimate ?? undefined,
    labels: issue.labels.nodes.map((l) => l.name),
    project: issue.project?.name,
    cycle: issue.cycle ? (issue.cycle.name || `Cycle ${issue.cycle.number}`) : undefined,
    parent: issue.parent ?? undefined,
    children: issue.children.nodes.map((c) => ({
      id: c.id,
      identifier: c.identifier,
      title: c.title,
      stateName: c.state?.name ?? "",
      stateType: c.state?.type ?? "",
      assignee: c.assignee?.displayName ?? undefined,
    })),
    // Integrations post as a bot with no `user`, so they get a generic name
    // rather than being dropped from the thread.
    comments: issue.comments.nodes.map((c) => ({
      id: c.id,
      author: c.user?.displayName ?? "Linear",
      body: c.body ?? "",
      createdAt: c.createdAt,
    })),
    stateName: issue.state?.name ?? "",
    stateType: issue.state?.type ?? "",
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

export { LinearError };
