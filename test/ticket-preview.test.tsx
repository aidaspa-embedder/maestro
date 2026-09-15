import { afterAll, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fixtureWorkspaces, seedHome } from "./fixtures.ts";
import type { IssueDetail } from "../src/services/linear.ts";

/**
 * The full Linear ticket, read inside maestro: metadata, the description as
 * real markdown, sub-issues and the comment thread, scrolling by line.
 */

const DESCRIPTION = [
  "## Context",
  "",
  "Stripe retries webhooks with the **same** idempotency key, but our dedupe",
  "window is keyed on `event.id` only.",
  "",
  "## Plan",
  "",
  "- [x] Add a composite dedupe key",
  "- [ ] Backfill the last 30 days",
  "- See [the runbook](https://example.com/runbook) before deploying",
  "",
  "```sql",
  "select count(*) from webhook_events where dropped;",
  "```",
  "",
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph number ${i} that pushes the body past one screen.`),
].join("\n");

const DETAIL: IssueDetail = {
  description: DESCRIPTION,
  priority: 1,
  estimate: 3,
  labels: ["bug", "billing"],
  project: "Billing reliability",
  cycle: "Cycle 12",
  parent: { identifier: "ENG-400", title: "Billing hardening" },
  children: [
    { id: "a", identifier: "ENG-413", title: "Add dedupe key migration", stateName: "Done", stateType: "completed" },
    { id: "b", identifier: "ENG-414", title: "Backfill dropped events", stateName: "In Progress", stateType: "started" },
  ],
  comments: [
    {
      id: "c1",
      author: "Rasa",
      body: "Confirmed against the Stripe dashboard — **41** events dropped last week.",
      createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    },
  ],
  stateName: "In Review",
  stateType: "started",
  createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
};

const home = await seedHome({
  config: { linearApiKey: "lin_api_test" },
  workspaces: fixtureWorkspaces(),
});

const realLinear = await import("../src/services/linear.ts");
mock.module("../src/services/linear.ts", () => ({
  ...realLinear,
  verifyKey: async () => ({ name: "aidas", email: "a@example.com" }),
  issueStates: async () => new Map(),
  issueDetail: async () => DETAIL,
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

const r = await testRender(<App />, { width: 120, height: 44 });
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
const dump = (title: string) => {
  if (process.env.MAESTRO_PREVIEW) console.log(`\n${title}\n${frame()}`);
};

// t on the list jumps straight into the ticket tab of the workspace detail.
r.mockInput.pressKey("t");
await settle(700);

describe("full ticket preview", () => {
  test("t from the list opens the ticket tab, not the browser", () => {
    dump("ticket tab");
    expect(opened).toEqual([]);
    expect(body()).toContain("ticket");
    expect(body()).toContain("pull requests");
  });

  test("shows the ticket's identity and live state", () => {
    const f = body();
    expect(f).toContain("ENG-412");
    expect(f).toContain("In Review"); // the fetched state, not the stored one
    expect(f).toContain("Urgent"); // priority 1
  });

  test("shows the metadata Linear keeps beside the description", () => {
    const f = body();
    expect(f).toContain("ENG-400"); // parent
    expect(f).toContain("Aidas"); // assignee
    expect(f).toContain("Billing reliability");
    expect(f).toContain("Cycle 12");
    expect(f).toContain("bug");
    expect(f).toContain("billing");
    expect(f).toContain("dev/eng-412-fix-billing");
  });

  test("renders the description as markdown, not as raw source", () => {
    const f = body();
    expect(f).toContain("DESCRIPTION");
    expect(f).toContain("Context");
    expect(f).not.toContain("## Context");
    expect(f).toContain("Stripe retries webhooks with the same idempotency");
    expect(f).not.toContain("**same**");
    expect(f).toContain("✓ Add a composite dedupe key"); // checked task
    expect(f).toContain("☐ Backfill the last 30 days");
    expect(f).toContain("the runbook");
    expect(f).not.toContain("https://example.com/runbook");
  });

  test("a body longer than the screen says how much is left", () => {
    expect(body()).toMatch(/\d+ more lines/);
  });

  test("every arrow counts, even when several land in one tick", async () => {
    // Four presses from the top must scroll four lines, not one — the same
    // same-tick trap useListNav documents.
    for (let i = 0; i < 4; i++) r.mockInput.pressArrow("down");
    await settle(200);

    expect(body()).not.toContain("Parent    ENG-400");
    expect(body()).toContain("Assignee  Aidas");
  });

  test("end jumps to the bottom, where the sub-issues and comments live", async () => {
    r.mockInput.pressKey("END");
    await settle(200);
    dump("scrolled to the end");

    const f = body();
    expect(f).toContain("SUB-ISSUES (2)");
    expect(f).toContain("ENG-413");
    expect(f).toContain("COMMENTS (1)");
    expect(f).toContain("Rasa");
    expect(f).toContain("41 events dropped last week");
    expect(f).not.toMatch(/\d+ more lines/);
  });

  test("code blocks survive intact rather than being reflowed", async () => {
    r.mockInput.pressKey("HOME");
    await settle(250);
    expect(body()).toContain("select count(*) from webhook_events where dropped;");
  });

  test("b opens the ticket in the browser, from inside the preview", async () => {
    opened.length = 0;
    r.mockInput.pressKey("b");
    await settle(250);
    expect(opened).toEqual(["https://linear.app/example/issue/ENG-412"]);
  });

  test("tab cycles worktrees → ticket → pull requests", async () => {
    r.mockInput.pressTab();
    await settle(300);
    expect(body()).toContain("GitHub is not linked"); // the PR tab, unlinked

    r.mockInput.pressTab();
    await settle(300);
    expect(body()).toContain("HANDOFF PROMPT");

    r.mockInput.pressTab();
    await settle(400);
    expect(body()).toContain("DESCRIPTION");
  });
});
