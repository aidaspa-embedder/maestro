import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fixtureWorkspaces, makeWorkspace, seedHome, writeWorkspaces } from "./fixtures.ts";
import { matchesTokens } from "../src/lib/text.ts";

/** Search in the workspace list: `/` to filter, esc to clear. */

const extra = [
  ...fixtureWorkspaces(),
  makeWorkspace({
    id: "ENG-390-ghi",
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
];

const home = await seedHome({ workspaces: [] });
await writeWorkspaces(home, extra);

const { testRender } = await import("@opentui/react/test-utils");
const { App } = await import("../src/app.tsx");
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

const r = await testRender(<App />, { width: 118, height: 22 });
const settle = async (ms = 250) => {
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
const has = (id: string) => frame().includes(id);

describe("matchesTokens", () => {
  test("every token must appear, in any order", () => {
    expect(matchesTokens("412 back", "ENG-412 Fix billing backend-service")).toBe(true);
    expect(matchesTokens("back 412", "ENG-412 Fix billing backend-service")).toBe(true);
    expect(matchesTokens("412 nope", "ENG-412 Fix billing backend-service")).toBe(false);
  });

  test("matching is case-insensitive and an empty query matches everything", () => {
    expect(matchesTokens("ENG", "eng-412 whatever")).toBe(true);
    expect(matchesTokens("", "anything at all")).toBe(true);
    expect(matchesTokens("   ", "anything at all")).toBe(true);
  });
});

describe("workspace search", () => {
  test("all three workspaces are listed to begin with, and no search row", () => {
    expect(has("ENG-412")).toBe(true);
    expect(has("ENG-455")).toBe(true);
    expect(has("ENG-390")).toBe(true);
    expect(frame()).not.toContain("of 3");
    expect(frame()).toContain("/ search");
  });

  test("/ opens the filter and typing narrows by title", async () => {
    r.mockInput.pressKey("/");
    await settle(200);
    expect(frame()).toContain("filter by ticket, title, branch or repo");

    await r.mockInput.typeText("billing");
    await settle(300);

    expect(has("ENG-412")).toBe(true);
    expect(has("ENG-455")).toBe(false);
    expect(has("ENG-390")).toBe(false);
    expect(frame()).toContain("1 of 3");
  });

  test("matching is across fields — repo name finds a workspace", async () => {
    for (let i = 0; i < "billing".length; i++) r.mockInput.pressBackspace();
    await settle(200);
    await r.mockInput.typeText("example");
    await settle(300);

    expect(has("ENG-390")).toBe(true);
    expect(has("ENG-412")).toBe(false);
    expect(frame()).toContain("1 of 3");
  });

  test("multiple tokens narrow further, in any order", async () => {
    for (let i = 0; i < "example".length; i++) r.mockInput.pressBackspace();
    await settle(200);
    await r.mockInput.typeText("eng re-index");
    await settle(300);

    expect(has("ENG-455")).toBe(true);
    expect(has("ENG-412")).toBe(false);
    expect(frame()).toContain("1 of 3");
  });

  test("no matches explains itself instead of showing an empty list", async () => {
    for (let i = 0; i < "eng re-index".length; i++) r.mockInput.pressBackspace();
    await settle(200);
    await r.mockInput.typeText("zzzznope");
    await settle(300);

    expect(frame()).toContain('No workspaces matching "zzzznope"');
    expect(frame()).toContain("0 of 3");
  });

  test("enter accepts the filter and hands the keyboard back to the list", async () => {
    for (let i = 0; i < "zzzznope".length; i++) r.mockInput.pressBackspace();
    await settle(200);
    await r.mockInput.typeText("billing");
    await settle(250);

    r.mockInput.pressEnter();
    await settle(300);

    // Filter still applied, row still shown, but the list owns the keys again.
    expect(has("ENG-412")).toBe(true);
    expect(has("ENG-455")).toBe(false);
    expect(frame()).toContain("1 of 3");
    expect(frame()).toContain("o launch session"); // list-mode hints are back
    expect(frame()).toContain("edit search");
    // The query survives in the breadcrumb so a narrowed list is obvious.
    expect(frame()).toContain('"billing"');
  });

  test("d after accepting a filter targets the filtered row, not the first workspace", async () => {
    r.mockInput.pressKey("d");
    await settle(250);

    expect(frame()).toContain("Delete ENG-412?");
    r.mockInput.pressEscape();
    await settle(200);
  });

  test("esc clears the search and restores every workspace", async () => {
    r.mockInput.pressEscape();
    await settle(300);

    expect(has("ENG-412")).toBe(true);
    expect(has("ENG-455")).toBe(true);
    expect(has("ENG-390")).toBe(true);
    expect(frame()).not.toContain("of 3");
  });

  test("letters do not trigger shortcuts while the filter is focused", async () => {
    r.mockInput.pressKey("/");
    await settle(200);
    // "n" would normally open the create flow, "s" settings, "q" would quit.
    await r.mockInput.typeText("nsq");
    await settle(300);

    expect(frame()).toContain("workspaces");
    expect(frame()).not.toContain("Linear API key"); // settings never opened
    expect(frame()).toContain("0 of 3"); // it was treated as a query

    r.mockInput.pressEscape();
    await settle(200);
  });
});
