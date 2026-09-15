import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "maestro-cache-"));
process.env.MAESTRO_CONFIG_DIR = root;
const { cachedRepos, clearRepositoryCache, repoCacheKey } = await import("../src/services/repository-cache.ts");
const { fetchReposFromGitHub } = await import("../src/services/github.ts");
const repo = { owner: "example", name: "app", nameWithOwner: "example/app", defaultBranch: "main", isPrivate: true };
afterAll(() => rm(root, { recursive: true, force: true }));

test("cache coalesces requests, survives new processes, isolates credentials and refreshes", async () => {
  let calls = 0;
  const loader = async () => { calls++; await Bun.sleep(10); return [repo]; };
  await Promise.all([cachedRepos("credential-a", loader), cachedRepos("credential-a", loader)]);
  expect(calls).toBe(1);
  await cachedRepos("credential-a", loader); expect(calls).toBe(1);
  await cachedRepos("credential-b", loader); expect(calls).toBe(2);
  await cachedRepos("credential-a", loader, { force: true }); expect(calls).toBe(3);
  const files = await readdir(join(root, "cache"));
  expect(files).toHaveLength(2);
  const path = join(root, "cache", files[0]!);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await Bun.file(path).text()).not.toContain("credential");
  const child = Bun.spawn([process.execPath, "-e", `const {cachedRepos}=await import('./src/services/repository-cache.ts'); console.log((await cachedRepos('credential-a',()=>{throw Error('network should not run')})).length)`], { cwd: process.cwd(), env: { ...process.env, MAESTRO_CONFIG_DIR: root }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("1");
});

test("offline uses known stale data but authentication errors and disabled caching do not", async () => {
  const key = repoCacheKey("stale");
  await writeFile(join(root, "cache", `repos-${key}.json`), JSON.stringify({ version: 1, savedAt: Date.now() - 3600_000, repos: [repo] }));
  let status = "";
  expect(await cachedRepos("stale", async () => { throw new Error("Cannot reach GitHub"); }, { onStatus: s => { status = s; } })).toHaveLength(1);
  expect(status).toBe("offline");
  await expect(cachedRepos("stale", async () => { throw new Error("GitHub rejected the token"); })).rejects.toThrow("rejected");
  await expect(cachedRepos("stale", async () => { throw new Error("offline"); }, { ttlMinutes: 0 })).rejects.toThrow("offline");
  await clearRepositoryCache();
  expect(await readdir(join(root, "cache"))).toHaveLength(0);
});

test("GitHub repository pagination continues beyond the old three-page cutoff", async () => {
  const original = globalThis.fetch;
  let page = 0;
  globalThis.fetch = (async () => {
    page++;
    return Response.json({ data: { viewer: { repositories: { nodes: [{ name: `app-${page}`, nameWithOwner: `example/app-${page}`, isArchived: false, isPrivate: true, owner: { login: "example" }, defaultBranchRef: { name: "main" } }], pageInfo: { hasNextPage: page < 5, endCursor: String(page) } } } } });
  }) as unknown as typeof fetch;
  try { expect(await fetchReposFromGitHub("fixture")).toHaveLength(5); expect(page).toBe(5); }
  finally { globalThis.fetch = original; }
});

test("repository discovery prefers main and falls back to GitHub's default when main is absent", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls++;
    expect(JSON.parse(String(init?.body)).query).toContain('ref(qualifiedName: "refs/heads/main")');
    return Response.json({ data: { viewer: { repositories: {
      nodes: [
        { name: "has-main", nameWithOwner: "example/has-main", owner: { login: "example" }, isPrivate: true, defaultBranchRef: { name: "develop" }, mainBranchRef: { name: "main" } },
        { name: "legacy", nameWithOwner: "example/legacy", owner: { login: "example" }, isPrivate: true, defaultBranchRef: { name: "master" }, mainBranchRef: null },
      ], pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
  }) as typeof fetch;
  try {
    const repos = await fetchReposFromGitHub("fixture");
    expect(repos.map(r => r.startingBranch)).toEqual(["main", "master"]);
    expect(repos[0]?.defaultBranch).toBe("develop");
    expect(calls).toBe(1); // Choosing main does not require one request per repo.
  } finally { globalThis.fetch = original; }
});
