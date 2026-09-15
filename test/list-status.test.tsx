import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureWorkspaces, seedHome } from "./fixtures.ts";
import type { OpenSurface } from "../src/services/terminals.ts";

/**
 * The workspace list's live-session column. Terminal enumeration is mocked and
 * agent transcripts are seeded on disk, so this renders the real component tree
 * against controlled state.
 */

const home = await seedHome({ workspaces: [] });

// ENG-455's main worktree — sessions run in worktrees, so transcripts are
// keyed by the worktree path. A recorded one with no window means resumable.
const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
const adminDir = join(
  home,
  ".claude",
  "projects",
  encode("/Users/example/maestro/admin-frontend/ENG-455-admin-bulk-re-index-embeddings"),
);
await mkdir(adminDir, { recursive: true });
await writeFile(join(adminDir, "33333333-3333-3333-3333-333333333333.jsonl"), "{}\n");

// ENG-412's main repo is backend-service — it gets a live, working surface.
const LIVE_SURFACE = "SURFACE-LIVE-412";
const surfaces: OpenSurface[] = [{ id: LIVE_SURFACE, title: "⠙ Fixing the webhook dedupe", cwd: "" }];

const focusCalls: string[] = [];
const realTerminals = await import("../src/services/terminals.ts");
mock.module("../src/services/terminals.ts", () => ({
  ...realTerminals,
  listSurfaces: async () => surfaces,
  appRunning: async () => true,
  // Mocked too, or focusing would drive real AppleScript with a fake id.
  focusSurface: async (_kind: string, id: string) => {
    focusCalls.push(id);
    return true;
  },
}));

const [eng412, eng455] = fixtureWorkspaces();
const workspaces = [
  {
    ...eng412!,
    session: {
      agent: "claude" as const,
      terminal: "ghostty" as const,
      surfaceId: LIVE_SURFACE,
      cwd: "/Users/example/maestro/backend-service/ENG-412-fix-billing-webhook-retries-dropping",
      launchedAt: new Date().toISOString(),
    },
  },
  eng455!,
];
await writeFile(
  join(home, ".config", "maestro", "workspaces.json"),
  JSON.stringify(workspaces, null, 2),
);

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const r = await testRender(<App />, { width: 120, height: 20 });
const settle = async (ms = 400) => {
  await r.flush();
  await new Promise((res) => setTimeout(res, ms));
  await r.flush();
};
await settle(1200); // let the first status poll land

afterAll(async () => {
  r.renderer.destroy();
  await rm(home, { recursive: true, force: true });
});

const row = (id: string) => r.captureCharFrame().split("\n").find((l) => l.includes(id));

describe("workspace list session column", () => {
  test("a live surface with a braille title renders as working", async () => {
    if (process.env.MAESTRO_PREVIEW) console.log("\n" + r.captureCharFrame());

    const line = row("ENG-412");
    expect(line).toBeDefined();
    expect(line).toContain("working");
    // Braille spinner frame from the Spinner component.
    expect(/[⠀-⣿]/.test(line!)).toBe(true);
  });

  test("a recorded transcript with no window renders as resumable", () => {
    const line = row("ENG-455");
    expect(line).toBeDefined();
    expect(line).toContain("resumable");
    expect(line).not.toContain("working");
  });

  test("o is labelled by what it will do to the selected workspace", async () => {
    // ENG-412 (live) is selected first — enter is always details.
    let frame = r.captureCharFrame();
    expect(frame).toContain("⏎ details");
    expect(frame).toContain("o focus session");

    r.mockInput.pressArrow("down");
    await settle(300);

    // ENG-455 has a transcript but no window.
    frame = r.captureCharFrame();
    expect(frame).toContain("o resume session");
    expect(frame).not.toContain("focus session");

    r.mockInput.pressArrow("up");
    await settle(300);
  });

  test("o on a live workspace focuses its surface without navigating", async () => {
    focusCalls.length = 0;
    r.mockInput.pressKey("o");
    await settle(400);

    expect(focusCalls).toEqual([LIVE_SURFACE]);
    // Still on the list: focusing is not navigation.
    expect(r.captureCharFrame()).toContain("ENG-455");
  });

  test("enter opens details even when the session is live", async () => {
    // Let the focus toast expire so it isn't mistaken for the footer hints.
    await settle(3400);
    focusCalls.length = 0;

    r.mockInput.pressEnter();
    await settle(600);

    expect(focusCalls).toEqual([]);
    expect(r.captureCharFrame()).toContain("Fix billing webhook retries");
    expect(r.captureCharFrame()).toContain("copy prompt");
  });
});
