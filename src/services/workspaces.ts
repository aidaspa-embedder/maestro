import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { Workspace, WorkspaceRepo } from "../state/types.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { bareRepoPath, createWorktree, ensureRepo, workspaceRepoPath } from "./git.ts";

export interface RepositoryChoice { owner: string; name: string; baseBranch: string; isMain: boolean }
export type ProvisionStatus = "queued" | "cloning" | "running" | "done" | "reused" | "failed";
export interface ProvisionUpdate { index: number; status: ProvisionStatus; detail: string; repo?: WorkspaceRepo }
const identity = (r: WorkspaceRepo) => `${r.owner ?? ""}/${r.repo ?? r.name}`.toLowerCase();

/** Existing identity, main repository, session and issue stay attached to the workspace. */
export function mergeRepositories(ws: Workspace, additions: WorkspaceRepo[]): Workspace {
  const next = [...ws.repos];
  for (const repo of additions) {
    const index = next.findIndex(r => identity(r) === identity(repo));
    if (index === -1) next.push({ ...repo, isMain: false });
    else if (next[index]!.error) next[index] = { ...repo, isMain: next[index]!.isMain };
  }
  const main = next.find(r => r.isMain && !r.error) ?? next.find(r => !r.error) ?? next[0];
  return { ...ws, repos: next.map(r => ({ ...r, isMain: r === main })) };
}

export function plannedRepositories(root: string, slug: string, choices: RepositoryChoice[], existing?: Workspace): WorkspaceRepo[] {
  return choices.map(repo => {
    const previous = existing?.repos.find(r => identity(r) === `${repo.owner}/${repo.name}`.toLowerCase());
    return { name: repo.name, owner: repo.owner, repo: repo.name, isMain: repo.isMain, baseBranch: repo.baseBranch,
      repoPath: previous?.repoPath ?? bareRepoPath(root, repo.owner, repo.name),
      worktreePath: previous?.worktreePath ?? workspaceRepoPath(root, repo.owner, repo.name, slug),
      error: "Creation pending or interrupted; add this repository again to retry" };
  });
}
export async function provisionRepositories(opts: {
  root: string; branch: string; repos: WorkspaceRepo[]; concurrency: number; token?: string;
  onUpdate: (update: ProvisionUpdate) => void;
  onRepo?: (repo: WorkspaceRepo, index: number) => Promise<void>;
}): Promise<WorkspaceRepo[]> {
  return mapLimit(opts.repos, opts.concurrency, async (repo, index) => {
    let result: WorkspaceRepo;
    try {
      opts.onUpdate({ index, status: "cloning", detail: `preparing ${repo.owner}/${repo.repo}` });
      const cloneExists = await Bun.file(join(repo.repoPath, "HEAD")).exists() || await Bun.file(join(repo.repoPath, ".git")).exists();
      if (!cloneExists) {
        const expected = bareRepoPath(opts.root, repo.owner!, repo.repo!);
        if (expected !== repo.repoPath) throw new Error("Original clone is missing; restore it before retrying this repository");
        const ensured = await ensureRepo({ worktreeRoot: opts.root, owner: repo.owner!, repo: repo.repo!, token: opts.token });
        if (!ensured.ok) throw new Error(ensured.error ?? "Clone failed");
      }
      await mkdir(dirname(repo.worktreePath), { recursive: true });
      const [root, parent] = await Promise.all([realpath(opts.root), realpath(dirname(repo.worktreePath))]);
      const child = relative(root, parent);
      if (child.startsWith("..") || isAbsolute(child)) throw new Error("Worktree parent is outside its configured root; check symbolic links");
      opts.onUpdate({ index, status: "running", detail: `fetching + branching from ${repo.baseBranch}` });
      const created = await createWorktree({ repoPath: repo.repoPath, worktreePath: repo.worktreePath,
        branch: opts.branch, baseBranch: repo.baseBranch!, token: opts.token });
      if (!created.ok) throw new Error(created.error ?? "Worktree creation failed");
      result = { ...repo, error: undefined };
      opts.onUpdate({ index, status: created.reused ? "reused" : "done", detail: created.reused ? "already existed" : repo.worktreePath, repo: result });
    } catch (e) {
      result = { ...repo, error: e instanceof Error ? e.message : String(e) };
      opts.onUpdate({ index, status: "failed", detail: result.error!, repo: result });
    }
    await opts.onRepo?.(result, index);
    return result;
  });
}
