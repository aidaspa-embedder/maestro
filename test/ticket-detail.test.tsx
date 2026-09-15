import { afterAll, describe, expect, mock, test } from "bun:test";
import type { LinearTicket } from "../src/state/types.ts";

/**
 * The repo-selection step shows the full ticket beside the picker. Linear and
 * GitHub are both mocked so this stays hermetic.
 */

const DETAIL = {
  description:
    "Stripe retries webhooks with the same idempotency key, but our dedupe " +
    "window is keyed on event id only, so a retried event inside the window is " +
    "silently dropped instead of reprocessed.",
  priority: 2,
  estimate: 3,
  labels: ["bug", "backend"],
  project: "Billing reliability",
  cycle: "Cycle 12",
  parent: undefined,
  stateName: "In Progress",
  stateType: "started",
  comments: [
    {
      id: "c1",
      author: "Aidas",
      body: "Confirmed against the Stripe dashboard — 41 events dropped last week.",
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
    },
  ],
  children: [
    { id: "a", identifier: "ENG-413", title: "Add dedupe key migration", stateName: "Done", stateType: "completed" },
    { id: "b", identifier: "ENG-414", title: "Backfill dropped events", stateName: "In Progress", stateType: "started" },
    { id: "c", identifier: "ENG-415", title: "Alert on webhook drop rate", stateName: "Todo", stateType: "unstarted" },
  ],
  createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
  updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
};

// Spread the real modules so only the fetchers are swapped — a partial mock
// would leak missing exports into any other suite sharing this process.
const realLinear = await import("../src/services/linear.ts");
mock.module("../src/services/linear.ts", () => ({
  ...realLinear,
  issueDetail: async () => DETAIL,
}));

const realGithub = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({
  ...realGithub,
  fetchRepos: async () =>
    ["admin-frontend", "backend-service", "example"].map((name) => ({
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
const { TicketDetail } = await import("../src/views/create/TicketDetail.tsx");
const { RepoPicker } = await import("../src/views/create/RepoPicker.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const ticket: LinearTicket = {
  id: "issue-1",
  identifier: "ENG-412",
  title: "Fix billing webhook retries dropping events",
  url: "https://linear.app/example/issue/ENG-412",
  branchName: "dev/eng-412-fix-billing-webhook-retries",
  stateName: "In Progress",
  stateType: "started",
  teamKey: "ENG",
  assignee: "Aidas",
};

const WIDTH = 118;
const HEIGHT = 28;
const DETAIL_W = 49;

const open: Array<() => void> = [];
afterAll(() => {
  for (const close of open) close();
});

async function mountStep() {
  const r = await testRender(
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" width={WIDTH - DETAIL_W}>
        <RepoPicker
          token="gh_test_token"
          slug="ENG-412-fix-billing-webhook-retries"
          worktreeRoot="/Users/example/maestro"
          width={WIDTH - DETAIL_W}
          onDone={() => {}}
          onBack={() => {}}
          onError={() => {}}
        />
      </box>
      <TicketDetail apiKey="lin_api_test" ticket={ticket} width={DETAIL_W} height={HEIGHT - 4} />
    </box>,
    { width: WIDTH, height: HEIGHT },
  );
  open.push(() => r.renderer.destroy());

  await r.flush();
  await new Promise((res) => setTimeout(res, 500));
  await r.flush();
  return r;
}

describe("ticket detail beside the repo picker", () => {
  test("shows the ticket's fields, description and sub-issues", async () => {
    const r = await mountStep();
    const f = r.captureCharFrame();

    // MAESTRO_PREVIEW=1 bun test … dumps the composed step for eyeballing.
    if (process.env.MAESTRO_PREVIEW) console.log("\n" + f);

    // Ticket identity and workflow state
    expect(f).toContain("ENG-412");
    expect(f).toContain("In Progress");
    expect(f).toContain("Fix billing webhook retries");

    // Metadata fields
    expect(f).toContain("Assignee");
    expect(f).toContain("Aidas");
    expect(f).toContain("High"); // priority 2
    expect(f).toContain("Billing reliability");
    expect(f).toContain("Cycle 12");
    expect(f).toContain("bug · backend");
    expect(f).toContain("dev/eng-412-fix-billing");

    // Description
    expect(f).toContain("DESCRIPTION");
    expect(f).toContain("Stripe retries webhooks");

    // Sub-issues, with the completed one checked
    expect(f).toContain("SUB-ISSUES (3)");
    expect(f).toContain("ENG-413");
    expect(f).toContain("ENG-414");
    expect(f).toContain("ENG-415");
    expect(f.split("\n").find((l) => l.includes("ENG-413"))).toContain("✓");

    // The repo picker still owns its column
    expect(f).toContain("filter repos");
    expect(f).toContain("admin-frontend");
    expect(f).toContain("backend-service");
  });

  test("the picker stays interactive with the panel alongside", async () => {
    const r = await mountStep();

    r.mockInput.pressKey(" ");
    await r.flush();
    await new Promise((res) => setTimeout(res, 200));
    await r.flush();

    const f = r.captureCharFrame();
    expect(f).toContain("1 selected");
    expect(f.split("\n").find((l) => l.includes("admin-frontend"))).toContain("✓");
    // Panel is unaffected by picker input.
    expect(f).toContain("SUB-ISSUES (3)");
  });
});
