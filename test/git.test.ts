import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/lib/exec.ts";
import { bareRepoPath, createWorktree, removeWorktree, worktreeStatus } from "../src/services/git.ts";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function makeRepo(name: string): Promise<{ root: string; repoPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "maestro-git-"));
  roots.push(root);
  const repoPath = join(root, name);

  await exec(["git", "init", "-q", "-b", "main", repoPath]);
  await exec(["git", "-C", repoPath, "config", "user.email", "test@example.com"]);
  await exec(["git", "-C", repoPath, "config", "user.name", "Test"]);
  await writeFile(join(repoPath, "README.md"), "# test\n");
  await exec(["git", "-C", repoPath, "add", "."]);
  await exec(["git", "-C", repoPath, "commit", "-qm", "init"]);
  await exec(["git", "-C", repoPath, "remote", "add", "origin", `git@github.com:example/${name}.git`]);

  return { root, repoPath };
}

/**
 * A bare clone shaped exactly like ensureRepo produces (clone --bare + the
 * standard fetch refspec), but from a local source so no network is involved.
 */
async function makeBareClone(root: string, sourcePath: string, name: string): Promise<string> {
  const bare = bareRepoPath(join(root, "maestro"), "example", name);
  await exec(["git", "clone", "--bare", "-q", sourcePath, bare]);
  await exec(["git", "-C", bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await exec(["git", "-C", bare, "fetch", "-q", "origin"]);
  return bare;
}

describe("worktree lifecycle", () => {
  test("creates a worktree on a new branch, then removes it", async () => {
    const { root, repoPath } = await makeRepo("backend-service");
    const worktreePath = join(root, "worktrees", "ENG-412-fix-billing-webhook");

    const res = await createWorktree({
      repoPath,
      worktreePath,
      branch: "dev/eng-412-fix-billing-webhook",
      baseBranch: "main",
      fetch: false, // no remote to fetch from in the fixture
    });

    expect(res.ok).toBe(true);
    expect(res.reused).toBe(false);
    expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(true);

    const branch = await exec(["git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout).toBe("dev/eng-412-fix-billing-webhook");

    const status = await worktreeStatus(worktreePath);
    expect(status.exists).toBe(true);
    expect(status.dirty).toBe(0);

    await removeWorktree(repoPath, worktreePath);
    expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(false);
  });

  test("is idempotent — a second create reuses the existing worktree", async () => {
    const { root, repoPath } = await makeRepo("admin-frontend");
    const worktreePath = join(root, "worktrees", "ENG-455-reindex");
    const opts = { repoPath, worktreePath, branch: "dev/eng-455-reindex", baseBranch: "main", fetch: false };

    expect((await createWorktree(opts)).ok).toBe(true);
    const second = await createWorktree(opts);

    expect(second.ok).toBe(true);
    expect(second.reused).toBe(true);
  });

  test("checks out an existing branch instead of failing", async () => {
    const { root, repoPath } = await makeRepo("example");
    await exec(["git", "-C", repoPath, "branch", "dev/eng-500-existing"]);

    const worktreePath = join(root, "worktrees", "ENG-500-existing");
    const res = await createWorktree({
      repoPath,
      worktreePath,
      branch: "dev/eng-500-existing",
      baseBranch: "main",
      fetch: false,
    });

    expect(res.ok).toBe(true);
    const branch = await exec(["git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout).toBe("dev/eng-500-existing");
  });

  test("reports the git error rather than throwing", async () => {
    const { root, repoPath } = await makeRepo("sauron");
    // A path under a file (not a dir) is guaranteed to fail in git.
    const blocker = join(root, "blocker");
    await writeFile(blocker, "not a directory");

    const res = await createWorktree({
      repoPath,
      worktreePath: join(blocker, "nested"),
      branch: "dev/eng-1-nope",
      baseBranch: "main",
      fetch: false,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  test("dirty worktrees are reported", async () => {
    const { root, repoPath } = await makeRepo("mental");
    const worktreePath = join(root, "worktrees", "ENG-1-dirty");
    await createWorktree({ repoPath, worktreePath, branch: "wip", baseBranch: "main", fetch: false });

    await writeFile(join(worktreePath, "new-file.txt"), "hello");
    expect((await worktreeStatus(worktreePath)).dirty).toBe(1);
  });

  test("missing worktrees report exists:false", async () => {
    expect(await worktreeStatus("/nope/does/not/exist")).toEqual({ exists: false, dirty: 0, ahead: 0 });
  });
});

describe("worktrees from maestro's bare clones", () => {
  test("a bare clone hosts worktrees exactly like a checkout does", async () => {
    const { root, repoPath } = await makeRepo("backend-service");
    const bare = await makeBareClone(root, repoPath, "backend-service");

    const worktreePath = join(root, "maestro", "backend-service", "ENG-412-fix");
    const res = await createWorktree({
      repoPath: bare,
      worktreePath,
      branch: "dev/eng-412-fix",
      baseBranch: "main",
    });

    expect(res.ok).toBe(true);
    expect(await Bun.file(join(worktreePath, "README.md")).exists()).toBe(true);
    const branch = await exec(["git", "-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout).toBe("dev/eng-412-fix");
  });

  test("a per-repo base branch decides what the worktree branches from", async () => {
    const { root, repoPath } = await makeRepo("admin-frontend");
    // develop carries a file main doesn't have — proof of which base was used.
    await exec(["git", "-C", repoPath, "checkout", "-q", "-b", "develop"]);
    await writeFile(join(repoPath, "develop-only.txt"), "here\n");
    await exec(["git", "-C", repoPath, "add", "."]);
    await exec(["git", "-C", repoPath, "commit", "-qm", "develop work"]);
    await exec(["git", "-C", repoPath, "checkout", "-q", "main"]);

    const bare = await makeBareClone(root, repoPath, "admin-frontend");
    const worktreePath = join(root, "maestro", "admin-frontend", "ENG-455-reindex");
    const res = await createWorktree({
      repoPath: bare,
      worktreePath,
      branch: "dev/eng-455-reindex",
      baseBranch: "develop",
    });

    expect(res.ok).toBe(true);
    expect(await Bun.file(join(worktreePath, "develop-only.txt")).exists()).toBe(true);
  });

  test("bareRepoPath nests clones by owner under .repos", () => {
    expect(bareRepoPath("/Users/example/maestro", "example", "backend-service")).toBe(
      "/Users/example/maestro/.repos/example/backend-service.git",
    );
  });
});

describe("filesystem protection", () => {
  test("dirty worktrees are preserved when removal is requested", async () => {
    const { root, repoPath } = await makeRepo("dirty-protected");
    const worktreePath = join(root, "dirty");
    await createWorktree({ repoPath, worktreePath, branch: "dirty", baseBranch: "main", fetch: false });
    await writeFile(join(worktreePath, "important.txt"), "keep me");
    await expect(removeWorktree(repoPath, worktreePath)).rejects.toThrow("Git refused");
    expect(await Bun.file(join(worktreePath, "important.txt")).text()).toBe("keep me");
  });
  test("removal refuses arbitrary directories and the main checkout", async () => {
    const { root, repoPath } = await makeRepo("owner");
    await expect(removeWorktree(repoPath, root)).rejects.toThrow("registered");
    await expect(removeWorktree(repoPath, repoPath)).rejects.toThrow("registered");
    expect(await Bun.file(join(repoPath, "README.md")).exists()).toBe(true);
  });
  test("a conflicting branch/path is not reused and nonexistent bases are not replaced by HEAD", async () => {
    const { root, repoPath } = await makeRepo("collision");
    const worktreePath = join(root, "workspace");
    await createWorktree({ repoPath, worktreePath, branch: "first", baseBranch: "main", fetch: false });
    expect((await createWorktree({ repoPath, worktreePath, branch: "second", baseBranch: "main", fetch: false })).ok).toBe(false);
    const result = await createWorktree({ repoPath, worktreePath: join(root, "other"), branch: "other", baseBranch: "missing", fetch: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });
});
