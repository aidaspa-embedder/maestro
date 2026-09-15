import { afterAll, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fixtureWorkspaces, makeWorkspace, seedHome } from "./fixtures.ts";
import type { TicketState } from "../src/services/linear.ts";
import type { PullRequest, Workspace } from "../src/state/types.ts";

/**
 * The workspace list as a tree: ticket status per row, pull requests as child
 * rows, and the filter / sort / hide controls. GitHub and Linear are mocked so
 * this renders the real component tree against fixed data.
 */

const done: Workspace = makeWorkspace({
  id: "ENG-390-ghi",
  slug: "ENG-390-rate-limit-the-public-search-endpoint",
  branch: "dev/eng-390-rate-limit-public-search",
  createdAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
  ticket: {
    id: "3",
    identifier: "ENG-390",
    title: "Rate limit the public search endpoint",
    url: "https://linear.app/example/issue/ENG-390",
    branchName: "dev/eng-390-rate-limit-public-search",
    stateName: "Done",
    stateType: "completed",
    teamKey: "ENG",
  },
  repos: [
    {
      name: "example",
      repoPath: "/Users/example/Projects/example",
      worktreePath: "/Users/example/maestro/example/ENG-390-rate-limit-the-public-search-endpoint",
      isMain: true,
      owner: "example",
      repo: "example",
    },
  ],
});

const [eng412, eng455] = fixtureWorkspaces();
const workspaces = [eng412!, eng455!, done];

const home = await seedHome({ config: { linearApiKey: "lin_api_test" }, workspaces });

const pr = (over: Partial<PullRequest>): PullRequest => ({
  repoName: "backend-service",
  number: 1284,
  title: "Dedupe webhook events on idempotency key",
  url: "https://github.com/example/backend-service/pull/1284",
  state: "OPEN",
  isDraft: false,
  checks: "SUCCESS",
  additions: 212,
  deletions: 41,
  updatedAt: new Date().toISOString(),
  ...over,
});

const PRS = new Map<string, PullRequest[]>([
  [
    eng412!.id,
    [
      pr({}),
      pr({
        repoName: "admin-frontend",
        number: 88,
        title: "Surface retry counts in the admin",
        url: "https://github.com/example/admin-frontend/pull/88",
        isDraft: true,
        checks: "FAILURE",
        additions: 30,
        deletions: 2,
      }),
    ],
  ],
  [
    done.id,
    [pr({ repoName: "example", number: 41, title: "Token bucket for /search", state: "MERGED", checks: "NONE" })],
  ],
]);

const realGithub = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({
  ...realGithub,
  resolveToken: async () => "gh-token",
  verifyToken: async () => ({ login: "aidaspa-example" }),
  fetchAllPrs: async () => PRS,
  fetchWorkspacePrs: async () => PRS.get(eng412!.id) ?? [],
}));

// What Linear currently says about each ticket. Empty means "no change", so the
// sync poll is a no-op until a test deliberately moves one.
let liveStates = new Map<string, TicketState>();

const realLinear = await import("../src/services/linear.ts");
mock.module("../src/services/linear.ts", () => ({
  ...realLinear,
  verifyKey: async () => ({ name: "aidas", email: "a@example.com" }),
  issueStates: async () => liveStates,
}));

const realTerminals = await import("../src/services/terminals.ts");
mock.module("../src/services/terminals.ts", () => ({
  ...realTerminals,
  listSurfaces: async () => [],
  appRunning: async () => true,
}));

const opened: string[] = [];
const realClipboard = await import("../src/lib/clipboard.ts");
mock.module("../src/lib/clipboard.ts", () => ({
  ...realClipboard,
  openUrl: (url: string) => opened.push(url),
}));

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const r = await testRender(<App />, { width: 130, height: 32 });
const settle = async (ms = 350) => {
  await r.flush();
  await new Promise((res) => setTimeout(res, ms));
  await r.flush();
};
await settle(1000);

afterAll(async () => {
  r.renderer.destroy();
  await rm(home, { recursive: true, force: true });
});

const frame = () => r.captureCharFrame();
/**
 * Just the rows: the header carries the breadcrumb and the footer carries the
 * toast, and both mention workspaces the list itself is no longer showing.
 */
const body = () => frame().split("\n").slice(2, -2).join("\n");
const row = (needle: string) => body().split("\n").find((l) => l.includes(needle));
const dump = (title: string) => {
  if (process.env.MAESTRO_PREVIEW) console.log(`\n${title}\n${frame()}`);
};

describe("ticket status in the list", () => {
  test("each row carries its ticket's own workflow state, not just a dot", () => {
    dump("tree");
    expect(row("ENG-412")).toContain("In Progress");
    expect(row("ENG-455")).toContain("Todo");
    expect(row("ENG-390")).toContain("Done");
  });
});

describe("pull requests as child rows", () => {
  test("PRs render under their workspace with number, state and checks", () => {
    const line = row("#1284");
    expect(line).toBeDefined();
    expect(line).toContain("Dedupe webhook events");
    expect(line).toContain("open");
    expect(line).toContain("checks");
    expect(line).toContain("+212");
    expect(line).toContain("backend-service");
  });

  test("a draft with failing checks reads as a draft, not as open", () => {
    const line = row("#88");
    expect(line).toContain("draft");
    expect(line).not.toContain("open");
  });

  test("the tree connects children to their parent, last child included", () => {
    expect(row("#1284")).toContain("├─ #1284");
    expect(row("#88")).toContain("└─ #88");
  });

  test("a workspace with no PRs has no children", () => {
    const lines = body().split("\n");
    const at = lines.findIndex((l) => l.includes("ENG-455"));
    expect(lines[at + 1]).toContain("ENG-390");
  });
});

/**
 * ↑↓ never leave the level they're on; ←→ change level. So one ↓ is one ticket
 * no matter how many PRs hang off it, and after → the same ↓ walks only that
 * ticket's PRs.
 */
describe("two-axis navigation", () => {
  const cursorOn = (needle: string) => row(needle)!.trimStart().startsWith("▌");
  const railOn = (needle: string) => row(needle)!.trimStart().startsWith("▏");
  // The breadcrumb, unlike the footer, is never taken over by a toast.
  const insidePrs = () => frame().split("\n")[0]!.includes("› pull requests");

  test("a ticket and its PRs are selected as one row", () => {
    // ENG-412 is the newest, so it is under the cursor on mount.
    expect(frame()).toContain("↑↓ tickets");
    expect(cursorOn("ENG-412")).toBe(true);
    expect(cursorOn("#1284")).toBe(true);
    expect(cursorOn("#88")).toBe(true);
    expect(cursorOn("ENG-455")).toBe(false);
  });

  test("↓ steps over a whole ticket, PRs and all", async () => {
    r.mockInput.pressArrow("down");
    await settle(200);

    expect(cursorOn("ENG-455")).toBe(true);
    expect(cursorOn("#1284")).toBe(false);

    r.mockInput.pressArrow("up");
    await settle(200);
    expect(cursorOn("ENG-412")).toBe(true);
  });

  test("→ drops a level, and says so in the breadcrumb and the footer", async () => {
    r.mockInput.pressArrow("right");
    await settle(200);
    dump("inside a ticket");

    expect(insidePrs()).toBe(true);
    expect(frame()).toContain("↑↓ pull requests");
    expect(frame()).toContain("← tickets");

    // Only the focused PR is solid; the level it lives in keeps a thin rail.
    expect(cursorOn("#1284")).toBe(true);
    expect(railOn("ENG-412")).toBe(true);
    expect(railOn("#88")).toBe(true);
  });

  test("↑↓ now walk this ticket's PRs, and stop at its edges", async () => {
    r.mockInput.pressArrow("down");
    await settle(200);
    expect(cursorOn("#88")).toBe(true);
    expect(railOn("#1284")).toBe(true);
    // The next ticket is not one ↓ away any more.
    expect(cursorOn("ENG-455")).toBe(false);

    r.mockInput.pressArrow("down"); // past the last PR — wraps inside the level
    await settle(200);
    expect(cursorOn("#1284")).toBe(true);
  });

  test("⏎ down here opens the pull request, not the workspace", async () => {
    opened.length = 0;
    r.mockInput.pressEnter();
    await settle(250);

    expect(opened).toEqual(["https://github.com/example/backend-service/pull/1284"]);
    // Still on the list — opening a PR is not navigation.
    expect(body()).toContain("ENG-455");
  });

  test("← climbs back, and the whole ticket is one row again", async () => {
    r.mockInput.pressArrow("left");
    await settle(200);

    expect(insidePrs()).toBe(false);
    expect(cursorOn("ENG-412")).toBe(true);
    expect(cursorOn("#1284")).toBe(true);
  });

  test("← at the top level folds instead, and the marker counts what's hidden", async () => {
    r.mockInput.pressArrow("left");
    await settle(200);

    expect(body()).not.toContain("#1284");
    expect(row("ENG-412")!.trimStart().startsWith("▌ ▸2")).toBe(true);

    r.mockInput.pressArrow("right"); // folded, so → unfolds rather than descends
    await settle(200);
    expect(body()).toContain("#1284");
    expect(insidePrs()).toBe(false);

    r.mockInput.pressKey(" "); // space toggles the same fold
    await settle(200);
    expect(body()).not.toContain("#1284");
    r.mockInput.pressKey(" ");
    await settle(200);
    expect(body()).toContain("#1284");
  });

  test("z folds everything at once, and remembers the choice", async () => {
    r.mockInput.pressKey("z");
    await settle(300);
    expect(body()).not.toContain("#1284");
    expect(body()).not.toContain("#41"); // ENG-390's PR too, untouched until now

    const saved = (await Bun.file(join(home, ".config", "maestro", "config.json")).json()) as {
      listExpand: boolean;
    };
    expect(saved.listExpand).toBe(false);

    r.mockInput.pressKey("z");
    await settle(300);
    expect(body()).toContain("#1284");
    expect(body()).toContain("#41");
  });

  test("folding the level you are standing in puts you back on the ticket", async () => {
    r.mockInput.pressArrow("right"); // into the PRs
    await settle(200);
    expect(insidePrs()).toBe(true);

    r.mockInput.pressKey("z"); // everything folds under us
    await settle(300);

    // The path had nowhere to point, so it came back up rather than dangling.
    expect(insidePrs()).toBe(false);
    expect(cursorOn("ENG-412")).toBe(true);

    r.mockInput.pressKey("z");
    await settle(300);
  });
});

describe("filter, sort and hide", () => {
  test("the control bar always says what the list is showing", () => {
    expect(body()).toContain("all");
    expect(body()).toContain("newest");
    expect(body()).toContain("3 workspaces");
  });

  test("f offers each status with a live count", async () => {
    r.mockInput.pressKey("f");
    await settle(250);
    dump("filter menu");

    const f = body();
    expect(f).toContain("SHOW");
    expect(f).toContain("in progress");
    expect(f).toContain("todo");
    expect(f).toContain("done");
    expect(f).toContain("hidden");
    expect(row("done")).toContain("1"); // ENG-390
  });

  test("picking a status narrows the list and says so in the breadcrumb", async () => {
    for (let i = 0; i < 3; i++) r.mockInput.pressArrow("down"); // all → doing → todo → done
    await settle(150);
    r.mockInput.pressEnter();
    await settle(350);
    dump("filtered to done");

    expect(body()).toContain("ENG-390");
    expect(body()).not.toContain("ENG-412");
    expect(body()).toContain("1 of 3");
    expect(frame()).toContain("\u203a done"); // breadcrumb
  });

  test("esc clears the filter when there is no search to clear first", async () => {
    r.mockInput.pressEscape();
    await settle(350);
    expect(body()).toContain("ENG-412");
    expect(body()).toContain("3 workspaces");
  });

  test("S re-orders the list, and the bar calls out a non-default sort", async () => {
    r.mockInput.pressKey("S");
    await settle(250);
    dump("sort menu");
    expect(body()).toContain("ORDER BY");

    for (let i = 0; i < 3; i++) r.mockInput.pressArrow("down"); // newest → activity → status → ticket
    await settle(150);
    r.mockInput.pressEnter();
    await settle(350);

    const lines = body().split("\n");
    const order = ["ENG-390", "ENG-412", "ENG-455"].map((id) => lines.findIndex((l) => l.includes(id)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(body()).toContain("ticket");
  });

  test("h hides a workspace without deleting it, and the bar keeps count", async () => {
    // Sorted by ticket now: ENG-390, ENG-412, ENG-455. Cursor is on the first.
    r.mockInput.pressKey("h");
    await settle(400);
    dump("after hiding");

    expect(frame()).toContain("Hid ENG-390");
    expect(body()).not.toContain("ENG-390");
    expect(body()).toContain("2 of 3");
    expect(body()).toContain("1 hidden");
  });

  test("hidden workspaces are still there, under their own filter", async () => {
    r.mockInput.pressKey("f");
    await settle(250);
    for (let i = 0; i < 4; i++) r.mockInput.pressArrow("down"); // → hidden
    await settle(150);
    r.mockInput.pressEnter();
    await settle(350);

    expect(body()).toContain("ENG-390");
    expect(body()).toContain("1 of 3");

    // And h brings it back.
    r.mockInput.pressKey("h");
    await settle(400);
    expect(body()).not.toContain("1 hidden");
  });

  test("? lists every key, including the ones the footer had to drop", async () => {
    r.mockInput.pressEscape(); // back to the default filter
    await settle(300);
    r.mockInput.pressKey("?");
    await settle(250);
    dump("help");

    const f = body();
    expect(f).toContain("KEYS");
    expect(f).toContain("hide the ticket");
    expect(f).toContain("step down a level");
    expect(f).toContain("never leave the level");

    r.mockInput.pressEscape();
    await settle(250);
    expect(body()).toContain("ENG-412");
  });
});

describe("ticket state is read back from Linear", () => {
  test("a ticket someone moved updates its row and is written back to disk", async () => {
    liveStates = new Map([
      [
        eng455!.ticket.id,
        {
          id: eng455!.ticket.id,
          title: eng455!.ticket.title,
          stateName: "In Review",
          stateType: "started",
          assignee: "Aidas",
        },
      ],
    ]);

    expect(row("ENG-455")).toContain("Todo");
    r.mockInput.pressKey("r");
    await settle(700);

    expect(row("ENG-455")).toContain("In Review");

    // Persisted, so a restart shows the last known state even offline.
    const saved = (await Bun.file(join(home, ".config", "maestro", "workspaces.json")).json()) as Workspace[];
    const stored = saved.find((w) => w.id === eng455!.id)!;
    expect(stored.ticket.stateName).toBe("In Review");
    expect(stored.ticket.assignee).toBe("Aidas");
    expect(stored.ticketSyncedAt).toBeTruthy();
  });

  test("the new state is a real status, so the filters follow it", async () => {
    await settle(3400);
    r.mockInput.pressKey("f");
    await settle(250);
    r.mockInput.pressArrow("down"); // → in progress
    await settle(150);
    r.mockInput.pressEnter();
    await settle(350);

    expect(body()).toContain("ENG-455");
    expect(body()).toContain("ENG-412");
    expect(body()).not.toContain("ENG-390");
  });
});
