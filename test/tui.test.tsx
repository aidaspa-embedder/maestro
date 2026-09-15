process.env.MAESTRO_REDUCED_MOTION = "1";
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fixtureWorkspaces, seedHome, writeWorkspaces } from "./fixtures.ts";

/**
 * Drives the real component tree through the OpenTUI test renderer and asserts
 * on captured character frames. Hermetic: no Linear key is configured, and the
 * throwaway HOME makes the gh CLI lookup fail fast instead of hitting the network.
 *
 * paths.ts resolves the config dir once at import, so every mount shares one
 * HOME; state is varied by rewriting workspaces.json and remounting.
 */

// HOME must be set before src/ is imported, hence top-level await.
const home = await seedHome({ workspaces: [] });
const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

type Harness = {
  frame: () => string;
  spans: () => ReturnType<Awaited<ReturnType<typeof testRender>>["captureSpans"]>;
  keys: Awaited<ReturnType<typeof testRender>>["mockInput"];
  settle: (ms?: number) => Promise<void>;
  destroy: () => void;
};

async function mount(): Promise<Harness> {
  const r = await testRender(<App />, { width: 110, height: 28 });
  const settle = async (ms = 250) => {
    await r.flush();
    await new Promise((res) => setTimeout(res, ms));
    await r.flush();
  };
  await settle(600);
  return {
    frame: r.captureCharFrame,
    spans: r.captureSpans,
    keys: r.mockInput,
    settle,
    destroy: () => r.renderer.destroy(),
  };
}

const open: Harness[] = [];
afterAll(async () => {
  for (const h of open) h.destroy();
  await rm(home, { recursive: true, force: true });
});

describe("first run", () => {
  test("with nothing configured, starts guided onboarding", async () => {
    const h = await mount();
    open.push(h);

    const f = h.frame();
    expect(f).toContain("maestro");
    expect(f).toContain("setup");
    expect(f).toContain("A workspace starts with an issue");
    expect(f).toContain("linear not linked");
    expect(f).toContain("DETECTED ON THIS MACHINE");

    h.destroy();
    open.pop();
  });
});

describe("with workspaces", () => {
  test("full flow: list → navigate → detail → launch picker → PRs → back", async () => {
    await writeWorkspaces(home, fixtureWorkspaces());
    const h = await mount();
    open.push(h);

    // Existing workspaces mean no first-run redirect.
    let f = h.frame();
    expect(f).toContain("workspaces");
    expect(f).toContain("ENG-412");
    expect(f).toContain("ENG-455");
    expect(f).toContain("Fix billing webhook retries");
    expect(f).toContain("backend-service +1");
    expect(f).toContain("n new workspace");

    // The selection bar starts on the first row.
    const row412 = () => h.frame().split("\n").find((l) => l.includes("ENG-412"))!;
    const row455 = () => h.frame().split("\n").find((l) => l.includes("ENG-455"))!;
    expect(row412().trimStart().startsWith("▌")).toBe(true);
    expect(row455().trimStart().startsWith("▌")).toBe(false);

    h.keys.pressArrow("down");
    await h.settle(150);
    expect(row412().trimStart().startsWith("▌")).toBe(false);
    expect(row455().trimStart().startsWith("▌")).toBe(true);

    // Delete is confirmed, never immediate, and offers both outcomes.
    h.keys.pressKey("d");
    await h.settle(150);
    f = h.frame();
    expect(f).toContain("Delete ENG-455?");
    expect(f).toContain("w delete worktrees + entry");
    expect(f).toContain("e forget entry only");

    h.keys.pressEscape();
    await h.settle(150);
    expect(h.frame()).not.toContain("Delete ENG-455?");

    // Detail view for the highlighted workspace.
    h.keys.pressEnter();
    await h.settle(400);
    f = h.frame();
    expect(f).toContain("Admin: bulk re-index embeddings");
    expect(f).toContain("dev/eng-455-admin-bulk-re-index-embeddings");
    expect(f).toContain("admin-frontend");
    expect(f).toContain("worktrees");
    expect(f).toContain("y copy prompt");

    // Session menu names the main repo it will open a window in. With no live
    // or recorded sessions it offers only fresh ones.
    h.keys.pressKey("l");
    await h.settle(200);
    f = h.frame();
    expect(f).toContain("SESSION IN ADMIN-FRONTEND");
    expect(f).toContain("new claude");
    expect(f).toContain("new codex");
    expect(f).toContain("shell");
    expect(f).not.toContain("focus session");
    expect(f).not.toContain("resume claude");

    h.keys.pressEscape();
    await h.settle(200);
    expect(h.frame()).not.toContain("SESSION IN");

    // PR tab degrades gracefully without a GitHub token.
    h.keys.pressKey("p");
    await h.settle(400);
    f = h.frame();
    expect(f).toContain("pull requests");
    expect(f).toContain("GitHub is not linked");

    // Escape unwinds back to the list.
    h.keys.pressEscape();
    await h.settle(300);
    expect(h.frame()).toContain("n new workspace");
  });

  test("nothing paints a page background — only the selection is opaque", async () => {
    await writeWorkspaces(home, fixtureWorkspaces());
    const h = await mount();
    open.push(h);

    const spans = h.spans();
    const opaque = new Map<string, number>();
    for (const line of spans.lines) {
      for (const span of line.spans) {
        const rgba = Array.from(span.bg.buffer);
        if (rgba[3] === 0) continue; // alpha 0 = terminal default shows through
        const key = rgba.join(",");
        opaque.set(key, (opaque.get(key) ?? 0) + span.text.length);
      }
    }

    // #1f2733 — theme.selBg, the highlighted row. Any other opaque colour means
    // someone reintroduced a background wash.
    expect([...opaque.keys()]).toEqual(["31,39,51,255"]);
  });

  test("an empty workspace list explains what to do next", async () => {
    await writeWorkspaces(home, []);
    const h = await mount();
    open.push(h);

    // No Linear key configured, so the redirect fires and settings wins;
    // escape reveals the empty list beneath it.
    h.keys.pressEscape();
    await h.settle(250);

    const f = h.frame();
    expect(f).toContain("Link Linear to get started");
    expect(f).toContain("Press s to open settings");
  });
});
