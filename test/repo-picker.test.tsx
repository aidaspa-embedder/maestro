import { afterAll, describe, expect, mock, test } from "bun:test";
import type { GitHubRepo } from "../src/services/github.ts";

/**
 * The repo picker keeps a text filter focused while single keys drive
 * selection. These cover the two ways that combination breaks: shortcut keys
 * leaking into the filter, and two keys landing in one tick — plus the branch
 * mode behind `→`. Repos come from GitHub, so the service is mocked.
 */

const REPOS: GitHubRepo[] = ["admin-frontend", "backend-service", "example"].map((name) => ({
  owner: "example",
  name,
  nameWithOwner: `example/${name}`,
  defaultBranch: "main",
  isPrivate: true,
  pushedAt: new Date().toISOString(),
}));

// Spread the real module so only the fetchers are swapped — a partial mock
// would leak missing exports into any other suite sharing this process.
const realGithub = await import("../src/services/github.ts");
const loadBranches = mock(async () => ["main", "develop", "release/2.4"]);
let repoFixtures = REPOS;
mock.module("../src/services/github.ts", () => ({
  ...realGithub,
  fetchRepos: async () => repoFixtures,
  fetchBranches: loadBranches,
}));

const { testRender } = await import("@opentui/react/test-utils");
const { RepoPicker } = await import("../src/views/create/RepoPicker.tsx");
type RepoSelection = import("../src/views/create/RepoPicker.tsx").RepoSelection;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const open: Array<() => void> = [];
afterAll(() => {
  for (const close of open) close();
});

async function mount(width = 100, repos = REPOS) {
  repoFixtures = repos;
  let done: RepoSelection | undefined;
  const errors: string[] = [];

  const r = await testRender(
    <RepoPicker
      token="gh_test_token"
      slug="ENG-412-fix-billing-webhook-retries"
      worktreeRoot="/Users/example/maestro"
      width={width}
      onDone={(sel) => {
        done = sel;
      }}
      onBack={() => {}}
      onError={(m) => errors.push(m)}
    />,
    { width, height: 24 },
  );
  open.push(() => r.renderer.destroy());

  const settle = async (ms = 200) => {
    await r.flush();
    await new Promise((res) => setTimeout(res, ms));
    await r.flush();
  };
  await settle(500);

  return {
    ...r,
    settle,
    errors,
    selection: () => done,
    /** The rendered row for a repo, or undefined when filtered out. */
    row: (name: string) => r.captureCharFrame().split("\n").find((l) => l.includes(name)),
  };
}

describe("repo picker keyboard", () => {
  test("letters type into the filter instead of triggering shortcuts", async () => {
    const h = await mount();

    await h.mockInput.typeText("back");
    await h.settle();

    expect(h.row("backend-service")).toBeDefined();
    expect(h.row("admin-frontend")).toBeUndefined();
    // Typing must not have selected anything.
    expect(h.captureCharFrame()).toContain("0 selected");
  });

  test("space toggles without leaking a space into the filter", async () => {
    const h = await mount();

    h.mockInput.pressKey(" ");
    await h.settle();

    expect(h.captureCharFrame()).toContain("1 selected");
    // A leaked space would filter everything out.
    expect(h.row("admin-frontend")).toContain("✓");
    expect(h.row("backend-service")).toBeDefined();
  });

  test("an arrow and a space in the same tick act on the row moved to", async () => {
    const h = await mount();

    // No await between them — this is what key repeat and fast typing produce.
    h.mockInput.pressArrow("down");
    h.mockInput.pressKey(" ");
    await h.settle();

    expect(h.captureCharFrame()).toContain("1 selected");
    expect(h.row("backend-service")).toContain("✓");
    expect(h.row("admin-frontend")).toContain("○");
  });

  test("tab assigns main to the highlighted selected repo", async () => {
    const h = await mount();

    h.mockInput.pressKey(" "); // select admin-frontend, becomes main by default
    await h.settle(150);
    h.mockInput.pressArrow("down");
    h.mockInput.pressKey(" "); // select backend-service
    await h.settle(150);
    h.mockInput.pressTab();
    await h.settle(150);

    expect(h.captureCharFrame()).toContain("2 selected");
    expect(h.row("backend-service")).toContain("main");
    expect(h.row("admin-frontend")).not.toContain("main");
  });

  test("tab on an unselected repo explains itself rather than silently failing", async () => {
    const h = await mount();

    h.mockInput.pressTab();
    await h.settle(150);

    expect(h.errors[0]).toContain("Select admin-frontend first");
  });

  test("enter returns the picks in selection order with the main repo", async () => {
    const h = await mount();

    h.mockInput.pressArrow("down");
    h.mockInput.pressKey(" "); // backend-service first
    await h.settle(150);
    h.mockInput.pressArrow("up");
    h.mockInput.pressKey(" "); // then admin-frontend
    await h.settle(150);
    h.mockInput.pressEnter();
    await h.settle(200);

    const sel = h.selection();
    expect(sel).toBeDefined();
    expect(sel!.repos.map((r) => r.name)).toEqual(["backend-service", "admin-frontend"]);
    expect(sel!.repos.find((r) => r.isMain)?.name).toBe("backend-service");
    // Untouched repos branch from their default branch.
    expect(sel!.repos.map((r) => r.baseBranch)).toEqual(["main", "main"]);
  });

  test("enter with nothing selected refuses and says why", async () => {
    const h = await mount();

    h.mockInput.pressEnter();
    await h.settle(150);

    expect(h.selection()).toBeUndefined();
    expect(h.errors[0]).toContain("Pick at least one repo");
  });
});

describe("base branch mode", () => {
  test("main is initially selected even when GitHub uses another default branch", async () => {
    const h = await mount(100, [{ ...REPOS[0]!, defaultBranch: "develop", startingBranch: "main" }]);
    h.mockInput.pressArrow("right"); await h.settle(150);
    expect(h.row("main")).toContain("▌ ✓");
    h.mockInput.pressEnter(); await h.settle(150);
    h.mockInput.pressEnter(); await h.settle(150);
    expect(h.selection()!.repos[0]).toMatchObject({ defaultBranch: "develop", baseBranch: "main" });
  });

  test("main is visible by default even when a long worktree path is truncated", async () => {
    const h = await mount(52);
    expect(h.captureCharFrame()).toContain("Starting branch  main");
    expect(h.captureCharFrame()).toContain("→ change starting branch");
  });

  test("→ lists the repo's branches, ⏎ picks one and selects the repo", async () => {
    const h = await mount();

    h.mockInput.pressArrow("right");
    await h.settle(300);

    const inBranchMode = h.captureCharFrame();
    expect(inBranchMode).toContain("develop");
    expect(inBranchMode).toContain("release/2.4");
    expect(inBranchMode).toContain("default"); // main is labelled

    h.mockInput.pressArrow("down"); // develop
    h.mockInput.pressEnter();
    await h.settle(200);

    // Back in the repo list, with the override shown on the row.
    expect(h.row("admin-frontend")).toContain("develop");
    expect(h.row("admin-frontend")).toContain("✓"); // picking a base selects the repo
    expect(h.captureCharFrame()).toContain("1 selected");

    h.mockInput.pressEnter();
    await h.settle(200);
    expect(h.selection()!.repos[0]).toMatchObject({
      name: "admin-frontend",
      baseBranch: "develop",
      isMain: true,
    });
  });

  test("esc leaves branch mode without changing anything", async () => {
    const h = await mount();

    h.mockInput.pressArrow("right");
    await h.settle(300);
    h.mockInput.pressEscape();
    await h.settle(150);

    expect(h.captureCharFrame()).toContain("0 selected");
    expect(h.row("admin-frontend")).not.toContain("develop");
  });

  test("reopening a branch choice focuses the selection and refresh reloads branches", async () => {
    const h = await mount();
    h.mockInput.pressArrow("right"); await h.settle(150);
    h.mockInput.pressArrow("down"); h.mockInput.pressEnter(); await h.settle(150);
    h.mockInput.pressArrow("right"); await h.settle(150);
    expect(h.row("develop")).toContain("▌ ✓");
    const calls = loadBranches.mock.calls.length;
    h.mockInput.pressKey("r", { ctrl: true }); await h.settle(150);
    expect(loadBranches.mock.calls.length).toBe(calls + 1);
    // Switch back to main; the user can undo a previous override.
    h.mockInput.pressArrow("up"); h.mockInput.pressEnter(); await h.settle(150);
    expect(h.captureCharFrame()).toContain("Starting branch  main");
    h.mockInput.pressEnter(); await h.settle(150);
    expect(h.selection()!.repos[0]?.baseBranch).toBe("main");
  });
});
