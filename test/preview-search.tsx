/**
 * Renders the workspace-list search states as ASCII.
 *
 *   bun run test/preview-search.tsx
 */
import { rm } from "node:fs/promises";
import { fixtureWorkspaces, makeWorkspace, seedHome, writeWorkspaces } from "./fixtures.ts";

const home = await seedHome({ workspaces: [] });
await writeWorkspaces(home, [
  ...fixtureWorkspaces(),
  makeWorkspace({
    id: "ENG-390-x",
    slug: "ENG-390-rate-limit-the-public-search-endpoint",
    branch: "dev/eng-390-rate-limit-public-search",
    ticket: {
      id: "3",
      identifier: "ENG-390",
      title: "Rate limit the public search endpoint",
      url: "https://linear.app/example/issue/ENG-390",
      branchName: "dev/eng-390-rate-limit-public-search",
      stateName: "In Review",
      stateType: "started",
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
  }),
]);

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const WIDTH = 118;
const r = await testRender(<App />, { width: WIDTH, height: 16 });

const settle = async (ms = 250) => {
  await r.flush();
  await new Promise((res) => setTimeout(res, ms));
  await r.flush();
};

function show(title: string) {
  const bar = "─".repeat(WIDTH);
  const lines = r.captureCharFrame().split("\n");
  if (lines.at(-1) === "") lines.pop();
  console.log(`\n\x1b[1m${title}\x1b[0m\n┌${bar}┐`);
  for (const line of lines) console.log(`│${line}│`);
  console.log(`└${bar}┘`);
}

await settle(900);
show("1. Unfiltered — no search row at all");

r.mockInput.pressKey("/");
await settle(200);
show("2. / opens the filter");

await r.mockInput.typeText("search");
await settle(300);
show("3. Typing narrows — matches title and slug");

r.mockInput.pressEnter();
await settle(250);
show("4. Enter accepts — row persists read-only, list owns the keys again");

r.mockInput.pressEscape();
await settle(250);
show("5. Esc clears");

r.renderer.destroy();
await rm(home, { recursive: true, force: true });
process.exit(0);
