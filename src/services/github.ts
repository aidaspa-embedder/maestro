import { cachedRepos, type RepoCacheOptions } from "./repository-cache.ts";
import { credentials } from "../state/config.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { exec } from "../lib/exec.ts";
import type { Config, PullRequest, WorkspaceRepo } from "../state/types.ts";

const ENDPOINT = "https://api.github.com/graphql";

class GitHubError extends Error {}

/** Borrows the gh CLI's token when in "gh" mode, else uses the stored PAT. */
export async function resolveToken(config: Config): Promise<string> {
  config = credentials(config);
  if (config.githubMode === "token") {
    if (!config.githubToken) throw new GitHubError("No GitHub token stored");
    return config.githubToken;
  }
  const res = await exec(["gh", "auth", "token", "--hostname", "github.com"], { timeoutMs: 10_000 });
  if (!res.ok || !res.stdout) {
    throw new GitHubError(
      res.stderr.includes("not found") || res.code === -1
        ? "gh CLI not found — install it or paste a token"
        : "gh CLI is not logged in — run `gh auth login`",
    );
  }
  return res.stdout;
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown> = {}, opts: { tolerant?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "maestro",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GitHubError(
      err instanceof Error && err.name === "TimeoutError" ? "GitHub request timed out" : "Cannot reach GitHub",
    );
  }

  if (res.status === 401) throw new GitHubError("GitHub rejected the token");
  if (res.status === 429 || res.status === 403) throw new GitHubError("GitHub access denied or rate limit reached (403/429)");
  if (!res.ok) throw new GitHubError(`GitHub returned HTTP ${res.status}`);

  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  // Partial errors are normal here: a repo you can't see nulls out but the rest
  // of the aliased query still resolves, so only fail when there's no data.
  if (body.errors?.length && !opts.tolerant) throw new GitHubError(body.errors[0]!.message);
  if (!body.data) throw new GitHubError(body.errors?.[0]?.message ?? "GitHub returned an empty response");
  return body.data;
}

export async function verifyToken(token: string): Promise<{ login: string }> {
  const data = await gql<{ viewer: { login: string } }>(token, `query { viewer { login } }`);
  return data.viewer;
}

export interface GitHubRepo {
  owner: string;
  /** Repo name — also the directory worktrees are grouped under */
  name: string;
  /** owner/name, the stable key the picker selects by */
  nameWithOwner: string;
  defaultBranch: string;
  /** Prefer main when present; otherwise use GitHub's default branch. */
  startingBranch?: string;
  isPrivate: boolean;
  pushedAt?: string;
}

const REPO_PAGE = 100;
/** Bound pagination while allowing large organizations to load every page. */
const REPO_PAGES = 100;

interface RawRepo {
  name: string;
  nameWithOwner: string;
  isArchived: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  owner: { login: string };
  defaultBranchRef: { name: string } | null;
  mainBranchRef: { name: string } | null;
}

/**
 * Every repo the token can see, most recently pushed first — the repo picker's
 * list. Comes from GitHub rather than a local directory scan, so a repo never
 * needs a project checkout to be part of a workspace.
 */
export function fetchRepos(token: string, options: RepoCacheOptions = {}): Promise<GitHubRepo[]> {
  return cachedRepos(token, () => fetchReposFromGitHub(token), options);
}

export async function fetchReposFromGitHub(token: string): Promise<GitHubRepo[]> {
  const out: GitHubRepo[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();

  for (let page = 0; page < REPO_PAGES; page++) {
    const data: {
      viewer: { repositories: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawRepo[] } };
    } = await gql(
      token,
      `query Repos($first: Int!, $after: String) {
        viewer {
          repositories(
            first: $first
            after: $after
            orderBy: { field: PUSHED_AT, direction: DESC }
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              nameWithOwner
              isArchived
              isPrivate
              pushedAt
              owner { login }
              defaultBranchRef { name }
              mainBranchRef: ref(qualifiedName: "refs/heads/main") { name }
            }
          }
        }
      }`,
      { first: REPO_PAGE, after },
    );

    const conn = data.viewer.repositories;
    for (const raw of conn.nodes) {
      if (raw.isArchived) continue;
      out.push({
        owner: raw.owner.login,
        name: raw.name,
        nameWithOwner: raw.nameWithOwner,
        defaultBranch: raw.defaultBranchRef?.name ?? "main",
        startingBranch: raw.mainBranchRef?.name ?? raw.defaultBranchRef?.name ?? "main",
        isPrivate: raw.isPrivate,
        pushedAt: raw.pushedAt ?? undefined,
      });
    }
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    if (page === REPO_PAGES - 1 || cursors.has(conn.pageInfo.endCursor)) throw new GitHubError("Repository pagination did not finish; retry to refresh the complete list");
    after = conn.pageInfo.endCursor;
    cursors.add(after);
  }

  return out;
}

/**
 * Branch names for one repo, for picking what a worktree branches from. The
 * default branch is pinned first; the rest come back most recently committed
 * first (TAG_COMMIT_DATE orders branch refs by their commit date too).
 */
export async function fetchBranches(token: string, owner: string, repo: string): Promise<string[]> {
  const data = await gql<{
    repository: {
      defaultBranchRef: { name: string } | null;
      refs: { nodes: Array<{ name: string }> } | null;
    } | null;
  }>(
    token,
    `query Branches($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
          nodes { name }
        }
      }
    }`,
    { owner, name: repo },
  );

  const def = data.repository?.defaultBranchRef?.name;
  const names = (data.repository?.refs?.nodes ?? []).map((n) => n.name);
  return def ? [def, ...names.filter((n) => n !== def)] : names;
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  state: "OPEN" | "CLOSED" | "MERGED";
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  updatedAt: string;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}

function rollupToChecks(raw: RawPr): PullRequest["checks"] {
  const state = raw.commits.nodes[0]?.commit.statusCheckRollup?.state;
  switch (state) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILURE":
    case "ERROR":
      return "FAILURE";
    case "PENDING":
    case "EXPECTED":
      return "PENDING";
    default:
      return "NONE";
  }
}

const PR_FIELDS = `
  number
  title
  url
  headRefName
  isDraft
  state
  additions
  deletions
  reviewDecision
  updatedAt
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

/** One repo + branch to look up, tagged with the workspace it belongs to. */
interface Probe {
  workspaceId: string;
  repoName: string;
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Aliases per request. GitHub's GraphQL cost model prices a query on the nodes
 * it can return, and 25 lookups × at most 30 PRs sits comfortably inside the
 * limit while keeping the whole list to one or two round trips.
 */
const ALIAS_BATCH = 25;

function probesFor(workspaceId: string, repos: WorkspaceRepo[], branch: string): Probe[] {
  return repos
    .filter((r): r is WorkspaceRepo & { owner: string; repo: string } => Boolean(r.owner && r.repo && !r.error))
    .map((r) => ({ workspaceId, repoName: r.name, owner: r.owner, repo: r.repo, branch }));
}

/**
 * Open first, then drafts, then merged, then closed — and newest first inside
 * each group. What still needs your attention is always at the top of the tree.
 */
const PR_ORDER: Record<string, number> = { OPEN: 0, MERGED: 2, CLOSED: 3 };

function comparePrs(a: PullRequest, b: PullRequest): number {
  const rank = (pr: PullRequest) => (pr.state === "OPEN" && pr.isDraft ? 1 : (PR_ORDER[pr.state] ?? 4));
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Recently-updated PRs scanned per unique repo. GitHub's headRefName filter is
 * an exact string match, but branch casing drifts (macOS git resolves refs
 * case-insensitively, people re-push with different casing) — so each repo's
 * recent PRs are also fetched and matched client-side, case-insensitively.
 */
const RECENT_PRS = 30;

/** One aliased field in the batched query: an exact branch probe, or a repo's recent-PR scan. */
type Part =
  | { kind: "exact"; probe: Probe }
  | { kind: "recent"; owner: string; repo: string };

const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

function partQuery(part: Part, i: number): string {
  const { owner, repo } = part.kind === "exact" ? part.probe : part;
  const filter =
    part.kind === "exact"
      ? `headRefName: ${JSON.stringify(part.probe.branch)}, first: 5`
      : `first: ${RECENT_PRS}`;
  return `
    r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      pullRequests(${filter}, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { ${PR_FIELDS} }
      }
    }`;
}

async function runProbes(token: string, probes: Probe[]): Promise<Map<string, PullRequest[]>> {
  const out = new Map<string, PullRequest[]>();
  if (probes.length === 0) return out;

  // One exact probe per workspace-repo pair, one recent scan per unique repo.
  const parts: Part[] = probes.map((probe) => ({ kind: "exact", probe }));
  const scanned = new Set<string>();
  for (const p of probes) {
    if (scanned.has(repoKey(p.owner, p.repo))) continue;
    scanned.add(repoKey(p.owner, p.repo));
    parts.push({ kind: "recent", owner: p.owner, repo: p.repo });
  }

  const chunks: Array<Array<{ part: Part; alias: number }>> = [];
  const indexed = parts.map((part, alias) => ({ part, alias }));
  for (let i = 0; i < indexed.length; i += ALIAS_BATCH) chunks.push(indexed.slice(i, i + ALIAS_BATCH));

  const exactByProbe = new Map<Probe, RawPr[]>();
  const recentByRepo = new Map<string, RawPr[]>();

  await mapLimit(chunks, 3, async (chunk) => {
      const data = await gql<Record<string, { pullRequests: { nodes: RawPr[] } } | null>>(
        token,
        `query Prs { ${chunk.map(({ part, alias }) => partQuery(part, alias)).join("\n")} }`,
        {}, { tolerant: true },
      );
      for (const { part, alias } of chunk) {
        const nodes = data[`r${alias}`]?.pullRequests.nodes ?? [];
        if (part.kind === "exact") exactByProbe.set(part.probe, nodes);
        else recentByRepo.set(repoKey(part.owner, part.repo), nodes);
      }
    });

  for (const probe of probes) {
    const branch = probe.branch.toLowerCase();
    const recent = (recentByRepo.get(repoKey(probe.owner, probe.repo)) ?? []).filter(
      (pr) => pr.headRefName.toLowerCase() === branch,
    );

    const seen = new Set<number>();
    for (const pr of [...(exactByProbe.get(probe) ?? []), ...recent]) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      const list = out.get(probe.workspaceId) ?? [];
      list.push({
        workspaceId: probe.workspaceId,
        repoName: probe.repoName,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft,
        checks: rollupToChecks(pr),
        reviewDecision: pr.reviewDecision ?? undefined,
        additions: pr.additions,
        deletions: pr.deletions,
        updatedAt: pr.updatedAt,
      });
      out.set(probe.workspaceId, list);
    }
  }

  for (const list of out.values()) list.sort(comparePrs);
  return out;
}

/**
 * Fetches PRs whose head branch is the workspace branch, across every repo in
 * the workspace — aliased into a single request so the PR tab loads in one
 * round trip regardless of repo count.
 */
export async function fetchWorkspacePrs(
  token: string,
  repos: WorkspaceRepo[],
  branch: string,
): Promise<PullRequest[]> {
  const byWorkspace = await runProbes(token, probesFor("ws", repos, branch));
  return byWorkspace.get("ws") ?? [];
}

/**
 * The same lookup for every workspace at once, keyed by workspace id. The
 * workspace list renders PRs as child rows, so this has to cost a fixed couple
 * of requests no matter how many workspaces × repos are on screen.
 */
export async function fetchAllPrs(
  token: string,
  workspaces: Array<{ id: string; repos: WorkspaceRepo[]; branch: string }>,
): Promise<Map<string, PullRequest[]>> {
  return runProbes(
    token,
    workspaces.flatMap((ws) => probesFor(ws.id, ws.repos, ws.branch)),
  );
}

export { GitHubError };
