import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { exec } from "../lib/exec.ts";

export function repoSegment(value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(value) || value === "." || value === "..") throw new Error("Invalid repository owner/name");
  return value;
}
export function bareRepoPath(root: string, owner: string, repo: string): string {
  return join(root, ".repos", repoSegment(owner), `${repoSegment(repo)}.git`);
}
export function workspaceRepoPath(root: string, owner: string, repo: string, slug: string): string {
  return join(root, repoSegment(owner), repoSegment(repo), repoSegment(slug));
}
/** Never persist credentials in Git config, URLs or command-line arguments. */
export function gitAuthEnv(token?: string): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: "0", ...(token ? {
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  } : {}) };
}
export interface EnsureRepoResult { ok: boolean; path: string; cloned: boolean; error?: string }
const cloning = new Map<string, Promise<EnsureRepoResult>>();

export async function ensureRepo(opts: { worktreeRoot: string; owner: string; repo: string; token?: string }): Promise<EnsureRepoResult> {
  const path = bareRepoPath(opts.worktreeRoot, opts.owner, opts.repo);
  let task = cloning.get(path);
  if (task) return task;
  task = ensureClone(path, opts);
  cloning.set(path, task);
  try { return await task; } finally { if (cloning.get(path) === task) cloning.delete(path); }
}
async function ensureClone(path: string, opts: { owner: string; repo: string; token?: string }): Promise<EnsureRepoResult> {
  const info = await lstat(path).catch(() => undefined);
  if (info) {
    if (info.isSymbolicLink()) return { ok: false, path, cloned: false, error: "Clone path is a symbolic link" };
    const check = await exec(["git", "-C", path, "rev-parse", "--is-bare-repository"]);
    return check.ok && check.stdout === "true" ? { ok: true, path, cloned: false } : { ok: false, path, cloned: false, error: "Clone path exists but is not a bare repository; original directory preserved" };
  }
  await mkdir(dirname(path), { recursive: true });
  const cloneRoot = await realpath(resolve(path, "../../.."));
  const parent = await realpath(dirname(path));
  const child = relative(cloneRoot, parent);
  if (child.startsWith("..") || isAbsolute(child)) return { ok: false, path, cloned: false, error: "Clone parent escapes the worktree root through a symbolic link" };
  const tmp = `${path}.${randomUUID()}.clone`;
  const slug = `${opts.owner}/${opts.repo}`;
  const gh = !opts.token && Bun.which("gh");
  const env = { ...gitAuthEnv(opts.token), GH_HOST: "github.com" };
  try {
    const res = await exec(gh ? [gh, "repo", "clone", slug, tmp, "--", "--bare"] :
      ["git", "clone", "--bare", "--", opts.token ? `https://github.com/${slug}.git` : `git@github.com:${slug}.git`, tmp],
      { timeoutMs: 600_000, env });
    if (!res.ok) return { ok: false, path, cloned: false, error: "Clone failed. Check GitHub access, Git credentials and network connection." };
    const setup = await exec(["git", "-C", tmp, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { timeoutMs: 10_000 });
    if (!setup.ok) return { ok: false, path, cloned: false, error: "Cannot configure clone fetch references" };
    await rename(tmp, path);
    return { ok: true, path, cloned: true };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const res = await exec(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { timeoutMs: 5_000 });
  return res.ok && res.stdout.length > 0;
}
async function validBranch(branch: string): Promise<boolean> {
  if (!branch || branch.startsWith("-") || branch.includes("@{") || /[\x00-\x20\x7f]/.test(branch)) return false;
  return (await exec(["git", "check-ref-format", "--branch", branch], { timeoutMs: 5_000 })).ok;
}
async function sameRepo(repoPath: string, worktreePath: string): Promise<boolean> {
  const getCommon = async (path: string) => {
    const res = await exec(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return res.ok ? realpath(res.stdout).catch(() => "") : "";
  };
  const [a, b] = await Promise.all([getCommon(repoPath), getCommon(worktreePath)]);
  return Boolean(a && a === b);
}
export interface CreateWorktreeResult { ok: boolean; reused: boolean; error?: string }
export async function createWorktree(opts: { repoPath: string; worktreePath: string; branch: string; baseBranch: string; fetch?: boolean; token?: string }): Promise<CreateWorktreeResult> {
  const { repoPath, worktreePath, branch, baseBranch } = opts;
  if (!(await validBranch(branch)) || !(await validBranch(baseBranch))) return { ok: false, reused: false, error: "Invalid workspace or base branch" };
  if (await Bun.file(join(worktreePath, ".git")).exists()) {
    const head = await exec(["git", "-C", worktreePath, "symbolic-ref", "--short", "HEAD"]);
    const top = await exec(["git", "-C", worktreePath, "rev-parse", "--show-toplevel"]);
    const exactPath = top.ok && await realpath(top.stdout).catch(() => "") === await realpath(worktreePath).catch(() => "?");
    return exactPath && await sameRepo(repoPath, worktreePath) && head.stdout === branch
      ? { ok: true, reused: true }
      : { ok: false, reused: false, error: "Existing directory belongs to a different repository or branch; preserved" };
  }
  if (opts.fetch !== false) {
    await exec(["git", "-C", repoPath, "fetch", "--quiet", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], { timeoutMs: 60_000, env: gitAuthEnv(opts.token) });
  }
  const hasBranch = await refExists(repoPath, `refs/heads/${branch}`);
  const base = await refExists(repoPath, `refs/remotes/origin/${baseBranch}`) ? `refs/remotes/origin/${baseBranch}` : `refs/heads/${baseBranch}`;
  if (!hasBranch && !(await refExists(repoPath, base))) return { ok: false, reused: false, error: `Base branch ${baseBranch} is unavailable. Fetch or choose an existing branch.` };
  const args = hasBranch
    ? ["git", "-C", repoPath, "worktree", "add", "--", worktreePath, branch]
    : ["git", "-C", repoPath, "worktree", "add", "-b", branch, "--", worktreePath, base];
  const res = await exec(args, { timeoutMs: 120_000 });
  return res.ok ? { ok: true, reused: false } : { ok: false, reused: false, error: res.stderr.split("\n").slice(0, 2).join(" ").trim() || "git worktree add failed" };
}

/** Git owns removal. Refuse dirty/unregistered paths; never recursively delete as fallback. */
export async function removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
  const paths = await exec(["git", "-C", repoPath, "worktree", "list", "--porcelain", "-z"], { timeoutMs: 10_000 });
  if (!paths.ok) throw new Error("Cannot verify worktree ownership; nothing removed");
  const entries = paths.stdout.split("\0\0").map(e => e.split("\0"));
  const canonical = (p: string) => realpath(p).catch(() => resolve(p));
  const target = await canonical(worktreePath);
  let registered = false;
  for (let i = 0; i < entries.length; i++) {
    const path = entries[i]?.find(l => l.startsWith("worktree "))?.slice(9);
    if (i > 0 && path && await canonical(path) === target) registered = true;
  }
  if (!registered) {
    if (!(await lstat(worktreePath).catch(() => undefined))) return;
    throw new Error("Path is not a registered linked worktree; nothing removed");
  }
  if (!(await lstat(worktreePath).catch(() => undefined))) {
    await exec(["git", "-C", repoPath, "worktree", "prune"], { timeoutMs: 10_000 }); return;
  }
  if (!(await sameRepo(repoPath, worktreePath))) throw new Error("Worktree ownership changed; nothing removed");
  const res = await exec(["git", "-C", repoPath, "worktree", "remove", ...(force ? ["--force"] : []), "--", worktreePath], { timeoutMs: 30_000 });
  if (!res.ok) throw new Error("Git refused removal. Commit/stash changes first, or forget the entry to keep files.");
}
export async function worktreeStatus(worktreePath: string): Promise<{ exists: boolean; dirty: number; ahead: number }> {
  if (!(await Bun.file(join(worktreePath, ".git")).exists())) return { exists: false, dirty: 0, ahead: 0 };
  const [status, ahead] = await Promise.all([
    exec(["git", "-C", worktreePath, "status", "--porcelain"], { timeoutMs: 10_000 }),
    exec(["git", "-C", worktreePath, "rev-list", "--count", "@{u}..HEAD"], { timeoutMs: 10_000 }),
  ]);
  return { exists: true, dirty: status.ok && status.stdout ? status.stdout.split("\n").filter(Boolean).length : 0, ahead: ahead.ok ? Number(ahead.stdout) || 0 : 0 };
}
