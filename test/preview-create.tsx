/**
 * Previews the create-workspace steps: the GitHub-backed repo picker (GraphQL
 * answered by a local stub) and the worktree progress view against real
 * throwaway git repos — worktree creation is exercised end to end through the
 * UI, from bare clones shaped exactly like ensureRepo produces.
 *
 *   bun run test/preview-create.tsx
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/lib/exec.ts";
import type { LinearTicket } from "../src/state/types.ts";

const root = await mkdtemp(join(tmpdir(), "maestro-preview-"));
process.env.MAESTRO_CONFIG_DIR = join(root, "config");
const projects = join(root, "Projects");
const worktreeRoot = join(root, "maestro");

const NAMES = ["backend-service", "admin-frontend", "example", "sauron", "prod-infra"];

for (const name of NAMES) {
  const repoPath = join(projects, name);
  await exec(["git", "init", "-q", "-b", "main", repoPath]);
  await exec(["git", "-C", repoPath, "config", "user.email", "dev@example.com"]);
  await exec(["git", "-C", repoPath, "config", "user.name", "Dev"]);
  await writeFile(join(repoPath, "README.md"), `# ${name}\n`);
  await exec(["git", "-C", repoPath, "add", "."]);
  await exec(["git", "-C", repoPath, "commit", "-qm", "init"]);
}

// Bare clones where ensureRepo would put them, with origin pointing at the
// local source — CreateProgress then runs the real clone-reuse + worktree path
// with no network at all.
for (const name of NAMES.slice(0, 3)) {
  const bare = join(worktreeRoot, ".repos", "example", `${name}.git`);
  await exec(["git", "clone", "--bare", "-q", join(projects, name), bare]);
  await exec(["git", "-C", bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  await exec(["git", "-C", bare, "fetch", "-q", "origin"]);
}

// The picker talks to GitHub's GraphQL endpoint; answer it locally instead.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("api.github.com")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
  if (body.query?.includes("repositories")) {
    return Response.json({
      data: {
        viewer: {
          repositories: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: NAMES.map((name) => ({
              name,
              nameWithOwner: `example/${name}`,
              isArchived: false,
              isPrivate: true,
              pushedAt: new Date().toISOString(),
              owner: { login: "example" },
              defaultBranchRef: { name: "main" },
              mainBranchRef: { name: "main" },
            })),
          },
        },
      },
    });
  }
  return Response.json({
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        refs: { nodes: ["main", "develop", "release/2.4"].map((name) => ({ name })) },
      },
    },
  });
}) as typeof fetch;

const { testRender } = await import("@opentui/react/test-utils");
const { RepoPicker } = await import("../src/views/create/RepoPicker.tsx");
const { CreateProgress } = await import("../src/views/create/CreateProgress.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const WIDTH = 118;
const HEIGHT = 26;
const SLUG = "ENG-412-fix-billing-webhook-retries";
const BRANCH = "dev/eng-412-fix-billing-webhook-retries";

const ticket: LinearTicket = {
  id: "1",
  identifier: "ENG-412",
  title: "Fix billing webhook retries dropping events",
  url: "https://linear.app/example/issue/ENG-412",
  branchName: BRANCH,
  stateName: "In Progress",
  stateType: "started",
  teamKey: "ENG",
};

function frame(capture: () => string, title: string) {
  const bar = "─".repeat(WIDTH);
  const lines = capture().split("\n");
  if (lines.at(-1) === "") lines.pop();
  console.log(`\n\x1b[1m${title}\x1b[0m\n┌${bar}┐`);
  for (const line of lines) console.log(`│${line}│`);
  console.log(`└${bar}┘`);
}

// ── Step 2: repo picker ──────────────────────────────────────────────────────
{
  const r = await testRender(
    <RepoPicker
      token="gh_preview_token"
      slug={SLUG}
      worktreeRoot={worktreeRoot}
      width={WIDTH}
      onDone={() => {}}
      onBack={() => {}}
      onError={() => {}}
    />,
    { width: WIDTH, height: HEIGHT },
  );
  const settle = async (ms = 250) => {
    await r.flush();
    await new Promise((res) => setTimeout(res, ms));
    await r.flush();
  };

  await settle(500);
  frame(r.captureCharFrame, "Repo picker — repos straight from GitHub, nothing selected yet");

  await r.mockInput.typeText("back");
  await settle(200);
  frame(r.captureCharFrame, "Repo picker — filter typed (letters reach the input)");

  r.mockInput.pressBackspace();
  r.mockInput.pressBackspace();
  r.mockInput.pressBackspace();
  r.mockInput.pressBackspace();
  await settle(150);
  r.mockInput.pressKey(" ");
  r.mockInput.pressArrow("down");
  await settle(120);
  r.mockInput.pressKey(" ");
  await settle(200);
  frame(r.captureCharFrame, "Repo picker — two selected, first is main, filter still empty");

  r.mockInput.pressArrow("right");
  await settle(300);
  frame(r.captureCharFrame, "Starting branch — → lists branches, ⏎ chooses where to start");

  r.mockInput.pressArrow("down");
  r.mockInput.pressEnter();
  await settle(200);
  frame(r.captureCharFrame, "Repo picker — admin-frontend now branches from develop");

  await r.renderer.destroy();
}

// ── Step 3: worktree creation (real git, from the bare clones) ───────────────
{
  const repos = NAMES.slice(0, 3).map((name, i) => ({
    owner: "example",
    name,
    defaultBranch: "main",
    baseBranch: "main",
    isMain: i === 0,
  }));
  const r = await testRender(
    <CreateProgress
      ticket={ticket}
      repos={repos}
      slug={SLUG}
      branch={BRANCH}
      worktreeRoot={worktreeRoot}
      onComplete={() => {}}
    />,
    { width: WIDTH, height: HEIGHT },
  );
  const settle = async (ms = 250) => {
    await r.flush();
    await new Promise((res) => setTimeout(res, ms));
    await r.flush();
  };

  await settle(60);
  frame(r.captureCharFrame, "Creating worktrees — in flight");

  await settle(4000);
  frame(r.captureCharFrame, "Creating worktrees — done");

  await r.renderer.destroy();
}

console.log("\nWorktrees actually written:");
const ls = await exec(["find", worktreeRoot, "-maxdepth", "2", "-mindepth", "2", "-not", "-path", "*/.repos/*"]);
console.log(ls.stdout || "(none)");
for (const name of NAMES.slice(0, 3)) {
  const wt = join(worktreeRoot, "example", name, SLUG);
  const branch = await exec(["git", "-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  console.log(`  ${name}: ${branch.ok ? branch.stdout : "MISSING"}`);
}

await rm(root, { recursive: true, force: true });
process.exit(0);
