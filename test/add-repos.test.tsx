import { afterAll, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedHome, makeWorkspace, writeWorkspaces } from "./fixtures.ts";
const home = await seedHome({ config: { onboardingComplete: true }, workspaces: [] });
const root = join(home, "maestro");
await mkdir(root, { recursive: true });
const { exec } = await import("../src/lib/exec.ts");
const { bareRepoPath, createWorktree, workspaceRepoPath } = await import("../src/services/git.ts");
const { mergeRepositories, provisionRepositories, plannedRepositories } = await import("../src/services/workspaces.ts");
const branch = "eng-412-shared";
const slug = "ENG-412-work";
for (const name of ["main-repo", "extra-repo"]) {
  const source = join(home, "sources", name);
  const bare = bareRepoPath(root, "example", name);
  await exec(["git", "init", "-q", "-b", "main", source]);
  await exec(["git", "-C", source, "config", "user.email", "test@example.com"]);
  await exec(["git", "-C", source, "config", "user.name", "Test"]);
  await writeFile(join(source, "README.md"), `# ${name}\n`);
  await exec(["git", "-C", source, "add", "."]);
  await exec(["git", "-C", source, "commit", "-qm", "initial"]);
  if (name === "extra-repo") {
    await exec(["git", "-C", source, "checkout", "-qb", "develop"]);
    await writeFile(join(source, "develop-only.txt"), "from develop\n");
    await exec(["git", "-C", source, "add", "."]);
    await exec(["git", "-C", source, "commit", "-qm", "develop work"]);
    await exec(["git", "-C", source, "checkout", "-q", "main"]);
  }
  await exec(["git", "clone", "--bare", "-q", source, bare]);
}
const mainPath = workspaceRepoPath(root, "example", "main-repo", slug);
await createWorktree({ repoPath: bareRepoPath(root, "example", "main-repo"), worktreePath: mainPath, branch, baseBranch: "main", fetch: false });
const ws = makeWorkspace({ worktreeRoot: root, branch, slug, repos: [{ name: "main-repo", owner: "example", repo: "main-repo", repoPath: bareRepoPath(root, "example", "main-repo"), worktreePath: mainPath, isMain: true, baseBranch: "main" }] });
await writeWorkspaces(home, [ws]);
const github = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({ ...github,
  resolveToken: async () => "fixture", verifyToken: async () => ({ login: "example" }),
  fetchAllPrs: async () => new Map(), fetchWorkspacePrs: async () => [],
  fetchBranches: async () => ["main", "develop"],
  fetchRepos: async () => ["main-repo", "extra-repo"].map(name => ({ owner: "example", name, nameWithOwner: `example/${name}`, defaultBranch: "main", isPrivate: false })),
}));
const status = await import("../src/services/status.ts");
mock.module("../src/services/status.ts", () => ({ ...status, pollStatuses: async () => new Map() }));
const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
afterAll(() => rm(home, { recursive: true, force: true }));
const settle = async (r: Awaited<ReturnType<typeof testRender>>, ms = 150) => { await r.flush(); await Bun.sleep(ms); await r.flush(); };

test("adding a repository uses its chosen starting branch and keeps the workspace and main repository", async () => {
  const r = await testRender(<App />, { width: 110, height: 28 });
  try {
    await settle(r); await settle(r);
    r.mockInput.pressEnter(); await settle(r);
    expect(r.captureCharFrame()).toContain("add repos");
    r.mockInput.pressKey("a"); await settle(r);
    const frame = r.captureCharFrame();
    expect(frame).toContain("extra-repo");
    expect(frame).not.toContain("main-repo");
    expect(frame).toContain("Starting branch  main");
    r.mockInput.pressArrow("right"); await settle(r);
    expect(r.captureCharFrame()).toContain("use branch");
    r.mockInput.pressArrow("down");
    r.mockInput.pressEnter(); await settle(r);
    expect(r.captureCharFrame()).toContain("Starting branch  develop");
    r.mockInput.pressEnter();
    let stored = [ws];
    for (let i = 0; i < 30; i++) {
      await settle(r, 100);
      stored = await Bun.file(join(home, ".config/maestro/workspaces.json")).json();
      if (stored[0]?.repos.length === 2 && !stored[0].repos[1]?.error) break;
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(ws.id);
    expect(stored[0]?.branch).toBe(branch);
    expect(stored[0]?.repos.filter(repo => repo.isMain)).toHaveLength(1);
    expect(stored[0]?.repos.find(repo => repo.isMain)?.worktreePath).toBe(mainPath);
    const extra = stored[0]?.repos.find(repo => repo.name === "extra-repo");
    expect(extra?.error).toBeUndefined();
    expect(extra).toBeDefined();
    expect(extra?.baseBranch).toBe("develop");
    expect(await Bun.file(join(extra!.worktreePath, "develop-only.txt")).text()).toBe("from develop\n");
    const head = await exec(["git", "-C", extra!.worktreePath, "symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout).toBe(branch);
  } finally { r.renderer.destroy(); }
});

test("failed repositories are checkpointed and can be retried without duplicating entries", async () => {
  const repos = plannedRepositories(root, "ENG-500-retry", [{ owner: "example", name: "extra-repo", baseBranch: "missing", isMain: true }]);
  const checkpoints: string[] = [];
  const failed = await provisionRepositories({ root, branch: "retry-branch", repos, concurrency: 1, onUpdate: () => {}, onRepo: async repo => { checkpoints.push(repo.error ?? "ok"); } });
  expect(failed[0]?.error).toContain("unavailable");
  expect(checkpoints).toHaveLength(1);
  const retry = await provisionRepositories({ root, branch: "retry-branch", repos: [{ ...failed[0]!, baseBranch: "main" }], concurrency: 1, onUpdate: () => {} });
  expect(retry[0]?.error).toBeUndefined();
  const merged = mergeRepositories({ ...ws, repos: failed }, retry);
  expect(merged.repos).toHaveLength(1);
  expect(merged.repos[0]?.error).toBeUndefined();
});
