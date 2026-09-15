import { mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { seedHome } from "./fixtures.ts";
const home = await seedHome({ workspaces: [] });
mock.module("../src/services/setup.ts", () => ({ detectTools: async () => [
  { name: "git", path: "/usr/bin/git", version: "installed" },
  { name: "gh", path: "/usr/bin/gh", version: "installed" },
  { name: "claude", path: "/usr/bin/claude", version: "installed" },
  { name: "codex", path: "/usr/bin/codex", version: "installed" },
] }));
const github = await import("../src/services/github.ts");
mock.module("../src/services/github.ts", () => ({ ...github, resolveToken: async () => "fixture", verifyToken: async () => ({ login: "example" }) }));
const { testRender } = await import("@opentui/react/test-utils");
const { LogoReveal } = await import("../src/views/onboarding/Intro.tsx");
const { App } = await import("../src/app.tsx");
await mkdir("docs/previews", { recursive: true });
const stages: string[] = [];
for (const elapsedMs of [0, 300, 700, 1100, 1250, 1500]) {
  const intro = await testRender(<LogoReveal elapsedMs={elapsedMs} />, { width: 80, height: 24 });
  await intro.flush();
  stages.push(`${elapsedMs}ms\n${intro.captureCharFrame().split("\n").filter(row => row.trim()).join("\n")}`);
  if (elapsedMs === 1500) await Bun.write("docs/previews/intro.txt", intro.captureCharFrame());
  intro.renderer.destroy();
}
await Bun.write("docs/previews/intro-reveal.txt", stages.join("\n\n") + "\n");
const narrowIntro = await testRender(<LogoReveal elapsedMs={1500} />, { width: 40, height: 16 });
await narrowIntro.flush();
await Bun.write("docs/previews/intro-narrow.txt", narrowIntro.captureCharFrame());
narrowIntro.renderer.destroy();
process.env.MAESTRO_REDUCED_MOTION = "1";
for (const [name, width, height] of [["wide", 100, 28], ["narrow", 60, 20]] as const) {
  const r = await testRender(<App setup />, { width, height });
  const settle = async () => { await r.flush(); await Bun.sleep(200); await r.flush(); };
  await settle();
  await Bun.write(`docs/previews/onboarding-${name}.txt`, r.captureCharFrame());
  r.mockInput.pressEnter(); await settle();
  await Bun.write(`docs/previews/setup-github-${name}.txt`, r.captureCharFrame());
  r.renderer.destroy();
}
await rm(home, { recursive: true, force: true });
console.log("Wrote headless preview frames to docs/previews/");
