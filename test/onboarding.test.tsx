import { afterAll, expect, mock, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedHome } from "./fixtures.ts";
import { useState } from "react";
import { RGBA } from "@opentui/core";
const home = await seedHome({ workspaces: [] });
process.env.MAESTRO_REDUCED_MOTION = "1";
mock.module("../src/services/setup.ts", () => ({ detectTools: async () => [
  { name: "git", path: "/usr/bin/git", version: "git fixture" },
  { name: "gh", path: "/bin/gh", version: "gh fixture" },
  { name: "claude", path: null }, { name: "codex", path: "/bin/codex", version: "codex fixture" },
] }));
const github = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({ ...github, resolveToken: async () => "fixture", verifyToken: async () => ({ login: "example" }) }));
const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
const { ConfigEditor } = await import("../src/components/ConfigEditor.tsx");
const { DEFAULT_CONFIG } = await import("../src/state/config.ts");
const { Intro, LogoReveal, INTRO_DURATION_MS } = await import("../src/views/onboarding/Intro.tsx");
const { theme } = await import("../src/theme.ts");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
afterAll(() => rm(home, { recursive: true, force: true }));
const settle = async (r: Awaited<ReturnType<typeof testRender>>) => { await r.flush(); await Bun.sleep(100); await r.flush(); };

test("welcome detects agents, guides setup, supports deferral and persists completion", async () => {
  const r = await testRender(<App />, { width: 100, height: 28 });
  try {
    await settle(r); await settle(r);
    expect(r.captureCharFrame()).toContain("WELCOME");
    expect(r.captureCharFrame()).toContain("codex fixture");
    r.mockInput.pressEnter(); await settle(r);
    expect(r.captureCharFrame()).toContain("GitHub auth");
    r.mockInput.pressKey("n", { ctrl: true }); await settle(r);
    expect(r.captureCharFrame()).toContain("Issue source");
    r.mockInput.pressArrow("right"); await settle(r);
    expect(r.captureCharFrame()).toContain("Jira site");
    r.mockInput.pressKey("n", { ctrl: true }); await settle(r);
    expect(r.captureCharFrame()).toContain("Add Jira credentials");
    r.mockInput.pressKey("s", { ctrl: true }); await settle(r);
    expect(r.captureCharFrame()).toContain("Worktree root");
    const stored = await Bun.file(join(home, ".config/maestro/config.json")).json();
    expect(stored.defaultAgent).toBe("codex");
    r.mockInput.pressKey("n", { ctrl: true }); await settle(r);
    expect(r.captureCharFrame()).toContain("--dangerously-skip-permissions");
    expect(r.captureCharFrame()).toContain("--yolo");
    r.mockInput.pressEnter(); await settle(r);
    expect(r.captureCharFrame()).toContain("workspaces");
    expect((await Bun.file(join(home, ".config/maestro/config.json")).json()).onboardingComplete).toBe(true);
  } finally { r.renderer.destroy(); }
  const remount = await testRender(<App />, { width: 80, height: 24 });
  try { await settle(remount); expect(remount.captureCharFrame()).not.toContain("WELCOME"); }
  finally { remount.renderer.destroy(); }
});

test("secret editing never places pasted or stored credentials in rendered cells", async () => {
  let saved = "";
  function Form() {
    const [config, setConfig] = useState<import("../src/state/types.ts").Config>({ ...DEFAULT_CONFIG, githubMode: "token" as const, githubToken: "previous-secret" });
    return <ConfigEditor config={config} section="github" onSave={async patch => {
      saved = String(patch.githubToken ?? ""); setConfig(c => ({ ...c, ...patch }));
    }} />;
  }
  const r = await testRender(<Form />, { width: 64, height: 18 });
  try {
    await settle(r);
    expect(r.captureCharFrame()).not.toContain("previous-secret");
    r.mockInput.pressArrow("down"); r.mockInput.pressEnter(); await settle(r);
    await r.mockInput.pasteBracketedText("new-secret-fixture-123"); await settle(r);
    expect(r.captureCharFrame()).not.toContain("new-secret-fixture-123");
    expect(r.captureCharFrame()).toContain("••••");
    r.mockInput.pressEnter(); await settle(r);
    expect(saved).toBe("new-secret-fixture-123");
    expect(r.captureCharFrame()).not.toContain("new-secret-fixture-123");
  } finally { r.renderer.destroy(); }
});

test("settings stay navigable in a small terminal", async () => {
  const r = await testRender(<ConfigEditor config={DEFAULT_CONFIG} onSave={async () => {}} />, { width: 52, height: 16 });
  try {
    await settle(r);
    for (let i = 0; i < 14; i++) { r.mockInput.pressArrow("down"); await settle(r); }
    expect(r.captureCharFrame()).toContain("Reduced motion");
  } finally { r.renderer.destroy(); }
});

test("intro wipes across a large ASCII wordmark and adapts to narrow terminals using only blue and white", async () => {
  for (const [width, logoHeight] of [[80, 6], [32, 5], [20, 1]] as const) {
    let previousCaret = -1;
    for (const elapsedMs of [0, 300, 700, 1100, 1500]) {
      const r = await testRender(<LogoReveal elapsedMs={elapsedMs} />, { width, height: 16 });
      try {
        await r.flush();
        const frame = r.captureCharFrame();
        const rows = frame.split("\n").filter(row => row.trim());
        expect(rows).toHaveLength(logoHeight!);
        if (elapsedMs < 1350) {
          const caret = rows[0]!.lastIndexOf("|");
          expect(caret).toBeGreaterThanOrEqual(previousCaret);
          if (elapsedMs >= 700) expect(caret).toBeGreaterThan(previousCaret);
          // The reveal edge is one continuous vertical caret across every row.
          expect(rows.every(row => row.lastIndexOf("|") === caret)).toBe(true);
          previousCaret = caret;
        } else {
          if (width === 80) {
            expect(frame).toContain("|_| |_| |_|");
            expect(frame).toContain("/####\\");
            const occupied = rows.map(row => row.trimEnd().length);
            expect(Math.max(...occupied) - Math.min(...rows.map(row => row.search(/\S/)))).toBeGreaterThan(50);
          }
          if (width === 20) expect(rows[0]!.trim()).toBe("◆ maestro");
          const firstRow = frame.split("\n").findIndex(row => row.trim());
          expect(firstRow).toBeGreaterThanOrEqual(Math.floor((16 - logoHeight!) / 2));
          expect(firstRow).toBeLessThanOrEqual(Math.ceil((16 - logoHeight!) / 2));
        }
        const colors = new Set<string>();
        for (const span of r.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.trim())) {
          const color = span.fg.toInts().join(",");
          colors.add(color);
          expect([theme.white, theme.accent].map(color => RGBA.fromHex(color).toInts().join(","))).toContain(color);
          if (width! >= 32) expect(span.text).toMatch(/^[\x20-\x7e]*$/);
        }
        if (elapsedMs === 1500) expect(colors.size).toBe(2);
      } finally { r.renderer.destroy(); }
    }
  }
});

test("intro skip completes once and reduced motion goes straight to setup", async () => {
  let completed = 0;
  const r = await testRender(<Intro reduced={false} onDone={() => { completed++; }} />, { width: 60, height: 20 });
  try {
    await r.flush();
    r.mockInput.pressEnter();
    r.mockInput.pressEscape();
    await settle(r);
    expect(completed).toBe(1);
    await Bun.sleep(INTRO_DURATION_MS);
    expect(completed).toBe(1);
  } finally { r.renderer.destroy(); }
  const reduced = await testRender(<Intro reduced onDone={() => { completed++; }} />, { width: 60, height: 20 });
  try { await reduced.flush(); expect(completed).toBe(2); }
  finally { reduced.renderer.destroy(); }
});

test("corrupt state is shown as a recovery error and its bytes are preserved", async () => {
  const path = join(home, ".config/maestro/workspaces.json");
  await writeFile(path, "{broken");
  const r = await testRender(<App />, { width: 100, height: 24 });
  try {
    await settle(r);
    expect(r.captureCharFrame()).toContain("Original file preserved");
    expect(await Bun.file(path).text()).toBe("{broken");
  } finally { r.renderer.destroy(); }
});
