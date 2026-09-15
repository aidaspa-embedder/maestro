import { afterAll, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { seedHome } from "./fixtures.ts";
import type { TicketNode } from "../src/services/linear.ts";
import type { LinearTicket } from "../src/state/types.ts";
import { theme } from "../src/theme.ts";

// Service imports capture the config paths, so seed before loading any of them.
const home = await seedHome({ config: { linearApiKey: "lin_api_test", onboardingComplete: true }, workspaces: [] });

/**
 * The create flow's ticket list is a tree: sub-issues hang off their parent and
 * are navigated — and picked — exactly like the parent is. Linear is mocked, so
 * this drives the real component tree against fixed data.
 */

const ticket = (over: Partial<LinearTicket> & { identifier: string; title: string }): LinearTicket => ({
  id: over.identifier,
  url: `https://linear.app/example/issue/${over.identifier}`,
  branchName: `dev/${over.identifier.toLowerCase()}`,
  stateName: "Todo",
  stateType: "unstarted",
  teamKey: "ENG",
  ...over,
});

const ASSIGNED: TicketNode[] = [
  {
    ticket: ticket({
      identifier: "ENG-412",
      title: "Fix billing webhook retries dropping events",
      stateName: "In Progress",
      stateType: "started",
    }),
    children: [
      {
        ticket: ticket({
          identifier: "ENG-413",
          title: "Add dedupe key migration",
          stateName: "Done",
          stateType: "completed",
        }),
        children: [],
      },
      {
        ticket: ticket({ identifier: "ENG-414", title: "Backfill dropped events" }),
        children: [],
      },
    ],
  },
  {
    ticket: ticket({ identifier: "ENG-455", title: "Admin: bulk re-index embeddings" }),
    children: [],
  },
];

// A search that matches a parent and one of its sub-issues — the sub-issue must
// not also appear at the top level.
const SEARCHED: TicketNode[] = [
  {
    ticket: ticket({ identifier: "ENG-390", title: "Rate limit the public search endpoint" }),
    children: [{ ticket: ticket({ identifier: "ENG-391", title: "Search token bucket" }), children: [] }],
  },
];

const realLinear = await import("../src/services/linear.ts");
mock.module("../src/services/linear.ts", () => ({
  ...realLinear,
  verifyKey: async () => ({ name: "aidas", email: "a@example.com" }),
  issueStates: async () => new Map(),
  myIssues: async () => ASSIGNED,
  searchIssues: async () => SEARCHED,
}));

const realTerminals = await import("../src/services/terminals.ts");
mock.module("../src/services/terminals.ts", () => ({
  ...realTerminals,
  listSurfaces: async () => [],
  appRunning: async () => true,
}));

// Picking a ticket lands on the repo step, which lists repos from GitHub.
const realGithub = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({
  ...realGithub,
  resolveToken: async () => "gh_test_token",
  verifyToken: async () => ({ login: "aidas" }),
  fetchAllPrs: async () => new Map(),
  fetchRepos: async () =>
    ["admin-frontend", "backend-service"].map((name) => ({
      owner: "example",
      name,
      nameWithOwner: `example/${name}`,
      defaultBranch: "main",
      isPrivate: true,
      pushedAt: new Date().toISOString(),
    })),
  fetchBranches: async () => ["main", "develop"],
}));

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
const { CONFIG_DIR } = await import("../src/lib/paths.ts");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const r = await testRender(<App />, { width: 118, height: 26 });
const settle = async (ms = 300) => {
  await r.flush();
  await new Promise((res) => setTimeout(res, ms));
  await r.flush();
};
await settle(900);

afterAll(async () => {
  r.renderer.destroy();
  await rm(home, { recursive: true, force: true });
});

const frame = () => r.captureCharFrame();
const body = () => frame().split("\n").slice(2, -2).join("\n");
const row = (needle: string) => body().split("\n").find((l) => l.includes(needle));
const cursorOn = (needle: string) => row(needle)!.trimStart().startsWith("▌");
const railOn = (needle: string) => row(needle)!.trimStart().startsWith("▏");
const crumbs = () => frame().split("\n")[0]!;
/** The fg of the first character of `needle`, as an r,g,b string. */
const colorOf = (needle: string): string => {
  for (const line of r.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return Array.from(span.fg.buffer).slice(0, 3).join(",");
    }
  }
  throw new Error(`no span containing ${needle}`);
};
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
const dump = (title: string) => {
  if (process.env.MAESTRO_PREVIEW) console.log(`\n${title}\n${frame()}`);
};

// n from the empty list opens the create flow on the ticket step.
r.mockInput.pressKey("n");
await settle(700);

describe("sub-issues as tree items", () => {
  test("config resolves to the isolated fixture before services are loaded", () => {
    expect(CONFIG_DIR).toBe(join(home, ".config", "maestro"));
  });

  test("sub-issues render nested under their parent", () => {
    dump("ticket picker");
    expect(body()).toContain("ENG-412");
    expect(row("ENG-413")).toContain("├─ ENG-413");
    expect(row("ENG-414")).toContain("└─ ENG-414");
    // A parent with none stays flat.
    expect(row("ENG-455")).not.toContain("├");
  });

  test("a finished sub-issue is dimmed rather than hidden", () => {
    expect(row("ENG-413")).toContain("Done");
    expect(colorOf("ENG-413")).toBe(rgb(theme.textDim));
  });

  test("a sub-issue id is a different hue from its parent's", () => {
    // Blue is top level, cyan is nested — the same pairing as ticket → PR in
    // the workspace list, so a child never reads as another root.
    expect(colorOf("ENG-412")).toBe(rgb(theme.accentBright)); // selected parent
    expect(colorOf("ENG-414")).toBe(rgb(theme.cyanBright)); // selected child
    expect(colorOf("ENG-455")).toBe(rgb(theme.accent)); // unselected parent
    expect(colorOf("ENG-412")).not.toBe(colorOf("ENG-414"));
  });

  test("a parent and its sub-issues are selected as one row", () => {
    expect(frame()).toContain("↑↓ tickets");
    expect(cursorOn("ENG-412")).toBe(true);
    expect(cursorOn("ENG-413")).toBe(true);
    expect(cursorOn("ENG-414")).toBe(true);
    expect(cursorOn("ENG-455")).toBe(false);
  });

  test("↓ steps over a whole ticket, sub-issues and all", async () => {
    r.mockInput.pressArrow("down");
    await settle(200);
    expect(cursorOn("ENG-455")).toBe(true);
    expect(cursorOn("ENG-413")).toBe(false);

    r.mockInput.pressArrow("up");
    await settle(200);
    expect(cursorOn("ENG-412")).toBe(true);
  });

  test("→ drops into the sub-issues, and both bars name the level", async () => {
    r.mockInput.pressArrow("right");
    await settle(250);
    dump("inside a ticket");

    expect(crumbs()).toContain("› ENG-412");
    expect(crumbs()).toContain("› sub-issues");
    expect(frame()).toContain("↑↓ sub-issues");
    expect(frame()).toContain("← tickets");

    expect(cursorOn("ENG-413")).toBe(true);
    expect(railOn("ENG-412")).toBe(true);
    expect(railOn("ENG-414")).toBe(true);
  });

  test("↑↓ now walk this ticket's sub-issues and stop at its edges", async () => {
    r.mockInput.pressArrow("down");
    await settle(200);
    expect(cursorOn("ENG-414")).toBe(true);
    expect(cursorOn("ENG-455")).toBe(false);

    r.mockInput.pressArrow("down"); // wraps inside the level
    await settle(200);
    expect(cursorOn("ENG-413")).toBe(true);
  });

  test("← climbs back out and the parent is one row again", async () => {
    r.mockInput.pressArrow("left");
    await settle(250);

    expect(crumbs()).not.toContain("sub-issues");
    expect(frame()).toContain("↑↓ tickets");
    expect(cursorOn("ENG-412")).toBe(true);
    expect(cursorOn("ENG-413")).toBe(true);
  });

  test("letters still reach the search box, and searching rebuilds the tree", async () => {
    await r.mockInput.typeText("rate");
    await settle(700);
    dump("searched");

    expect(body()).toContain("ENG-390");
    expect(row("ENG-391")).toContain("└─ ENG-391");
    // The sub-issue matched the search too, but it is nested, not duplicated.
    expect(body().split("\n").filter((l) => l.includes("ENG-391"))).toHaveLength(1);
    expect(body()).not.toContain("ENG-412");
  });

  test("the cursor comes back to the top level when the tree is replaced", () => {
    expect(frame()).toContain("↑↓ tickets");
    expect(cursorOn("ENG-390")).toBe(true);
  });
});

describe("picking from the tree", () => {
  test("⏎ on a sub-issue builds the workspace from the sub-issue", async () => {
    r.mockInput.pressArrow("right"); // into ENG-390's sub-issues
    await settle(250);
    expect(cursorOn("ENG-391")).toBe(true);

    r.mockInput.pressEnter();
    await settle(600);
    dump("picked a sub-issue");

    // Step two, and it is the sub-issue that is being branched from.
    expect(crumbs()).toContain("ENG-391");
    expect(body()).toContain("filter repos");
    expect(body()).toContain("Search token bucket");
    expect(body()).toContain("dev/eng-391");
  });
});
