/**
 * Renders the app headlessly and prints ASCII frames, so layout can be reviewed
 * without a TTY.  bun run test/preview.tsx
 */
import { fixtureWorkspaces, seedHome } from "./fixtures.ts";

await seedHome({ workspaces: fixtureWorkspaces() });

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");

// We drive updates via real timers/keys rather than act(), so silence the
// warning React emits for unwrapped updates in a test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const WIDTH = 118;
const HEIGHT = 30;

const { renderer, mockInput, captureCharFrame, flush } = await testRender(<App />, {
  width: WIDTH,
  height: HEIGHT,
});

async function settle(ms = 350) {
  await flush();
  await new Promise((r) => setTimeout(r, ms));
  await flush();
}

function show(title: string) {
  const bar = "─".repeat(WIDTH);
  console.log(`\n\x1b[1m${title}\x1b[0m\n┌${bar}┐`);
  const lines = captureCharFrame().split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) console.log(`│${line}│`);
  console.log(`└${bar}┘`);
}

await settle(600);
show("1. Workspace list");

mockInput.pressKey("f");
await settle(150);
show("2. Filter by ticket status");

mockInput.pressEscape();
await settle(100);
mockInput.pressKey("S");
await settle(150);
show("3. Sort order");

mockInput.pressEscape();
await settle(100);
mockInput.pressKey("?");
await settle(150);
show("4. Every key");

mockInput.pressEscape();
await settle(100);
mockInput.pressKey("s");
await settle();
show("5. Settings");

mockInput.pressEscape();
await settle();
mockInput.pressArrow("down");
await settle(150);
show("6. Workspace list — second row selected");

mockInput.pressEnter();
await settle(400);
show("7. Workspace detail — worktrees");

mockInput.pressKey("l");
await settle(150);
show("8. Launch picker");

mockInput.pressEscape();
await settle(100);
mockInput.pressKey("p");
await settle(500);
show("9. Pull requests tab");

mockInput.pressEscape();
await settle(150);
mockInput.pressKey("d");
await settle(150);
show("10. Delete confirmation");

renderer.destroy();
process.exit(0);
