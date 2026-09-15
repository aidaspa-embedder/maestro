import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/lib/exec.ts";
import { agentArgs, agentCommand, shQuote } from "../src/services/launcher.ts";
import { mapLimit } from "../src/lib/concurrency.ts";
import { writePrivateJson } from "../src/lib/files.ts";
import { normalizeConfig, DEFAULT_CONFIG, credentials, jiraOrigin } from "../src/state/config.ts";
import { validateWorkspaces } from "../src/state/store.ts";
import { mergeRepositories, plannedRepositories } from "../src/services/workspaces.ts";
import { repoSegment, workspaceRepoPath } from "../src/services/git.ts";
import { makeWorkspace } from "./fixtures.ts";
import { acquireInstanceLock } from "../src/lib/instance-lock.ts";

const root = await mkdtemp(join(tmpdir(), "maestro-hardening-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("agent launch safety", () => {
  test("fresh and resumed commands always carry the supported bypass option", () => {
    expect(agentArgs("claude")).toEqual(["--dangerously-skip-permissions"]);
    expect(agentArgs("claude", ["--resume", "abc"])).toEqual(["--resume", "abc", "--dangerously-skip-permissions"]);
    expect(agentArgs("codex", ["resume", "abc"])).toEqual(["resume", "abc", "--yolo"]);
    expect(agentArgs("codex", ["--yolo"])).toEqual(["--yolo"]);
    expect(agentArgs("shell", ["--yolo"])).toEqual([]);
  });
  test("nested login shell preserves apostrophes, dollar syntax and backticks literally", async () => {
    const marker = join(root, "injected");
    const values = ["space here", "a'b", `$(touch ${marker})`, "`uname`", '"quotes"', "a\nb", "--yolo"];
    // printf is the test executable: no agent or external account is invoked.
    const res = await exec(["/bin/sh", "-c", agentCommand("/usr/bin/printf", ["%s\\0", ...values])!]);
    expect(res.ok).toBe(true);
    expect(res.stdout.split("\0").slice(0, -1)).toEqual(values);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await exec(["/bin/sh", "-c", `printf %s ${shQuote("x'y")}`])).stdout).toBe("x'y");
  });
});

test("private writes serialize, publish whole JSON, and preserve previous file on failure", async () => {
  const file = join(root, "private", "state.json");
  await Promise.all(Array.from({ length: 12 }, (_, i) => writePrivateJson(file, { index: i, body: "abc".repeat(1000) })));
  expect(JSON.parse(await readFile(file, "utf8")).index).toBe(11);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
});

test("config validates ranges, URLs and migration defaults without copying environment secrets", () => {
  expect(normalizeConfig({}).repoCacheTtlMinutes).toBe(15);
  expect(normalizeConfig({}).issueProvider).toBe("linear");
  expect(() => normalizeConfig({ cloneConcurrency: 999 })).toThrow();
  expect(() => normalizeConfig({ githubMode: "other" })).toThrow();
  expect(() => normalizeConfig({ worktreeRoot: "/" })).toThrow();
  expect(() => normalizeConfig({ reducedMotion: "true" })).toThrow();
  for (const url of ["http://team.atlassian.net", "https://user:pass@team.atlassian.net", "https://team.atlassian.net/path", "https://team.atlassian.net?token=secret"]) expect(() => jiraOrigin(url)).toThrow();
  expect(jiraOrigin("https://team.atlassian.net/")).toBe("https://team.atlassian.net");
  const previous = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "example-only";
  expect(credentials(DEFAULT_CONFIG).linearApiKey).toBe("example-only");
  expect(normalizeConfig(DEFAULT_CONFIG).linearApiKey).toBeUndefined();
  if (previous === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = previous;
});

test("unreadable workspace records and duplicate identities fail explicitly", () => {
  expect(() => validateWorkspaces({})).toThrow();
  expect(() => validateWorkspaces([{ ticket: {} }])).toThrow();
  expect(() => validateWorkspaces([makeWorkspace(), makeWorkspace()])).toThrow();
  expect(validateWorkspaces([makeWorkspace()])).toHaveLength(1);
});

test("repository segments reject traversal and same-name repositories have distinct paths", () => {
  for (const bad of ["..", "../escape", "a/b", "a\\b", "-option", "a\n"]) expect(() => repoSegment(bad)).toThrow();
  expect(workspaceRepoPath(root, "first", "app", "ENG-1")).not.toBe(workspaceRepoPath(root, "second", "app", "ENG-1"));
});

test("adding/retrying repositories preserves workspace metadata, main, and successful paths", () => {
  const ws = makeWorkspace({ hidden: true, lastAgent: "codex" });
  const planned = plannedRepositories(root, ws.slug, [{ owner: "another", name: "backend-service", baseBranch: "develop", isMain: true }]);
  const added = { ...planned[0]!, error: undefined };
  const merged = mergeRepositories(ws, [added]);
  expect(merged.id).toBe(ws.id);
  expect(merged.branch).toBe(ws.branch);
  expect(merged.hidden).toBe(true);
  expect(merged.lastAgent).toBe("codex");
  expect(merged.repos).toHaveLength(3);
  expect(merged.repos.filter(r => r.isMain)).toHaveLength(1);
  expect(merged.repos.find(r => r.isMain)?.worktreePath).toBe(ws.repos[0]!.worktreePath);
  expect(mergeRepositories(merged, [added]).repos).toHaveLength(3);
  const failed = { ...added, error: "failed" };
  expect(mergeRepositories({ ...ws, repos: [...ws.repos, failed] }, [added]).repos[2]?.error).toBeUndefined();
});

test("worker pool limits simultaneous jobs and preserves ordering", async () => {
  let live = 0, max = 0;
  const out = await mapLimit([0, 1, 2, 3, 4, 5], 2, async n => {
    live++; max = Math.max(max, live); await Bun.sleep(5); live--; return n * 2;
  });
  expect(max).toBe(2); expect(out).toEqual([0, 2, 4, 6, 8, 10]);
});

test("instance lock rejects a concurrent writer and releases cleanly", async () => {
  const directory = join(root, "lock");
  const release = await acquireInstanceLock(directory);
  await expect(acquireInstanceLock(directory)).rejects.toThrow("already running");
  await release();
  const releaseAgain = await acquireInstanceLock(directory);
  await releaseAgain();
});
