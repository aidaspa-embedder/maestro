import { describe, expect, test } from "bun:test";
import { fuzzyMatch, pad, relativeTime, truncate } from "../src/lib/text.ts";
import { mappingOnly, mappingPrompt } from "../src/lib/prompt.ts";
import { slugifyTitle, workspaceSlug } from "../src/lib/slug.ts";
import { lineText, markdownLines, wrapPlain } from "../src/lib/markdown.ts";
import { compareIdentifier, filterSpec, haystack, prRollup, sortWorkspaces } from "../src/lib/list.ts";
import { buildTicketLines } from "../src/lib/ticket.ts";
import { fitHints } from "../src/components/primitives.tsx";
import { attrs, idColor, theme } from "../src/theme.ts";
import type { IssueDetail } from "../src/services/linear.ts";
import type { PullRequest, Workspace } from "../src/state/types.ts";
import { makeWorkspace } from "./fixtures.ts";

describe("workspaceSlug", () => {
  test("builds ENG-412-title-with-dashes", () => {
    expect(workspaceSlug("ENG-412", "Fix billing webhook retries")).toBe("ENG-412-fix-billing-webhook-retries");
  });

  test("strips punctuation and collapses separators", () => {
    expect(slugifyTitle("Admin: bulk re-index  embeddings!")).toBe("admin-bulk-re-index-embeddings");
  });

  test("does not leave a dash where an apostrophe was", () => {
    expect(slugifyTitle("Don't drop events")).toBe("dont-drop-events");
  });

  test("truncates on a word boundary and never trails a dash", () => {
    const slug = slugifyTitle(
      "A very long ticket title that keeps going well past any reasonable directory name limit",
    );
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("a-very-long-ticket-title")).toBe(true);
  });

  test("falls back to the identifier when the title has nothing usable", () => {
    expect(workspaceSlug("ENG-9", "!!!")).toBe("ENG-9");
  });
});

describe("text helpers", () => {
  test("truncate keeps width exact", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("abcdefgh", 5).length).toBe(5);
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abc", 0)).toBe("");
  });

  test("pad never shrinks a long value", () => {
    expect(pad("abc", 5)).toBe("abc  ");
    expect(pad("abcdef", 3)).toBe("abcdef");
  });

  test("fuzzyMatch is a subsequence match", () => {
    expect(fuzzyMatch("bes", "backend-service")).toBe(true);
    expect(fuzzyMatch("admin", "admin-frontend")).toBe(true);
    expect(fuzzyMatch("zzz", "backend-service")).toBe(false);
    expect(fuzzyMatch("", "anything")).toBe(true);
  });

  test("relativeTime buckets sensibly", () => {
    expect(relativeTime(new Date().toISOString())).toBe("just now");
    expect(relativeTime(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe("3d ago");
    expect(relativeTime("nonsense")).toBe("");
  });
});

describe("handoff prompt", () => {
  const ws = makeWorkspace();

  test("lists every worktree as `repo - dir`", () => {
    const text = mappingPrompt(ws);
    for (const repo of ws.repos) {
      expect(text).toContain(`${repo.name} - ${repo.worktreePath}`);
    }
    expect(text).toContain("ENG-412");
    expect(text).toContain(ws.branch);
    expect(text).toContain("Main repo: backend-service");
  });

  test("compact form is only the mapping lines", () => {
    expect(mappingOnly(ws).split("\n")).toEqual([
      `backend-service - ${ws.repos[0]!.worktreePath}`,
      `admin-frontend - ${ws.repos[1]!.worktreePath}`,
    ]);
  });

  test("repos that failed to create are left out of the handoff", () => {
    const broken = makeWorkspace({
      repos: [{ ...makeWorkspace().repos[0]!, error: "fatal: branch exists" }, makeWorkspace().repos[1]!],
    });
    expect(mappingOnly(broken)).not.toContain("backend-service");
    expect(mappingOnly(broken)).toContain("admin-frontend");
  });
});

describe("markdown rendering", () => {
  const render = (src: string, width = 40) => markdownLines(src, width).map(lineText);

  test("wraps paragraphs at the column and joins soft line breaks", () => {
    const lines = render("one two three four five six seven eight nine ten", 20);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
    expect(lines.join(" ")).toContain("one two three");
  });

  test("a word wider than the column is broken, not overflowed", () => {
    const lines = render("x".repeat(25), 10);
    expect(lines[0]!.length).toBe(10);
    expect(lines.join("")).toBe("x".repeat(25));
  });

  test("headings, bullets and checkboxes get their own marks", () => {
    const lines = render("# Plan\n\n- first\n- [x] done\n- [ ] later");
    expect(lines).toContain("Plan");
    expect(lines.some((l) => l.startsWith("• first"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ done"))).toBe(true);
    expect(lines.some((l) => l.startsWith("☐ later"))).toBe(true);
  });

  test("inline emphasis is styled, and its markers are gone from the text", () => {
    const [line] = markdownLines("a **bold** and `code` bit", 60);
    expect(lineText(line!)).toBe("a bold and code bit");
    expect(line!.find((s) => s.text === "bold")!.attrs! & attrs.bold).toBeTruthy();
    expect(line!.find((s) => s.text === "code")!.fg).toBe(theme.cyanBright);
  });

  test("links keep their text and drop the target", () => {
    expect(render("see [the doc](https://example.com/x) now", 60)[0]).toBe("see the doc now");
  });

  test("fenced code is not reflowed", () => {
    const lines = render("```ts\nconst x = 1\n```", 40);
    expect(lines.some((l) => l.includes("const x = 1"))).toBe(true);
  });

  test("snake_case survives the italic rule", () => {
    expect(render("call some_helper_name here", 60)[0]).toBe("call some_helper_name here");
  });

  test("runs of blank lines collapse to one", () => {
    expect(render("a\n\n\n\nb", 40)).toEqual(["a", "", "b"]);
  });

  test("wrapPlain never emits a leading space on a wrapped line", () => {
    const lines = wrapPlain("alpha beta gamma delta", 11).map(lineText);
    expect(lines.every((l) => !l.startsWith(" "))).toBe(true);
  });
});

describe("list filtering and sorting", () => {
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();
  const ws = (over: Partial<Workspace>, state: string, identifier: string): Workspace =>
    makeWorkspace({
      id: identifier,
      ...over,
      ticket: { ...makeWorkspace().ticket, identifier, stateName: state, stateType: state },
    });

  const doing = ws({ createdAt: at(1) }, "started", "ENG-90");
  const todo = ws({ createdAt: at(5) }, "unstarted", "ENG-412");
  const done = ws({ createdAt: at(50) }, "completed", "ENG-8");
  const gone = ws({ createdAt: at(2), hidden: true }, "started", "ENG-700");
  const all = [doing, todo, done, gone];

  test("the default filter shows everything except hidden workspaces", () => {
    expect(all.filter(filterSpec("all").match).map((w) => w.id)).toEqual(["ENG-90", "ENG-412", "ENG-8"]);
  });

  test("status filters follow Linear's workflow categories", () => {
    expect(all.filter(filterSpec("doing").match).map((w) => w.id)).toEqual(["ENG-90"]);
    expect(all.filter(filterSpec("todo").match).map((w) => w.id)).toEqual(["ENG-412"]);
    expect(all.filter(filterSpec("done").match).map((w) => w.id)).toEqual(["ENG-8"]);
  });

  test("hidden is its own view, and nothing else shows it", () => {
    expect(all.filter(filterSpec("hidden").match).map((w) => w.id)).toEqual(["ENG-700"]);
  });

  test("an unknown filter id falls back to all rather than showing nothing", () => {
    expect(filterSpec("nope" as never).id).toBe("all");
  });

  const none = () => undefined;

  test("newest first is the default order", () => {
    expect(sortWorkspaces(all, "recent", none).map((w) => w.id)).toEqual([
      "ENG-90", "ENG-700", "ENG-412", "ENG-8",
    ]);
  });

  test("status order floats what you're working on and sinks what's finished", () => {
    const ids = sortWorkspaces([done, todo, doing], "status", none).map((w) => w.id);
    expect(ids).toEqual(["ENG-90", "ENG-412", "ENG-8"]);
  });

  test("ticket order is numeric, not lexicographic", () => {
    expect(sortWorkspaces(all, "ticket", none).map((w) => w.id)).toEqual([
      "ENG-8", "ENG-90", "ENG-412", "ENG-700",
    ]);
    expect(compareIdentifier("ENG-90", "ENG-412")).toBeLessThan(0);
    expect(compareIdentifier("ABC-1", "ENG-1")).toBeLessThan(0);
  });

  test("activity order uses the session clock, falling back to creation time", () => {
    const recent = new Map([[todo.id, Date.now()]]);
    const ids = sortWorkspaces([doing, todo, done], "activity", (w) => recent.get(w.id)).map((w) => w.id);
    expect(ids[0]).toBe("ENG-412");
  });

  test("sorting never mutates the input", () => {
    const input = [done, doing];
    sortWorkspaces(input, "ticket", none);
    expect(input.map((w) => w.id)).toEqual(["ENG-8", "ENG-90"]);
  });
});

describe("pull request rollup", () => {
  const pr = (over: Partial<PullRequest>): PullRequest => ({
    repoName: "backend-service",
    number: 1,
    title: "t",
    url: "u",
    state: "OPEN",
    isDraft: false,
    checks: "NONE",
    additions: 1,
    deletions: 1,
    ...over,
  });

  test("a failing open PR outranks everything else", () => {
    expect(prRollup([pr({ checks: "SUCCESS" }), pr({ checks: "FAILURE" })])).toBe("failure");
  });

  test("pending beats plain open, and closed PRs don't count", () => {
    expect(prRollup([pr({ checks: "PENDING" }), pr({ checks: "SUCCESS" })])).toBe("pending");
    expect(prRollup([pr({ state: "CLOSED", checks: "FAILURE" })])).toBe("none");
  });

  test("all merged reads as merged, and no PRs as none", () => {
    expect(prRollup([pr({ state: "MERGED" })])).toBe("merged");
    expect(prRollup([])).toBe("none");
  });

  test("search matches PR numbers and titles as well as the ticket", () => {
    const w = makeWorkspace();
    const hay = haystack(w, [pr({ number: 1284, title: "Dedupe webhook events" })]);
    expect(hay).toContain("#1284");
    expect(hay).toContain("Dedupe webhook events");
    expect(hay).toContain("backend-service");
  });
});

describe("footer hint fitting", () => {
  const hints = [
    { key: "↑↓", label: "move" },
    { key: "⏎", label: "details" },
    { key: "o", label: "launch session" },
    { key: "n", label: "new workspace" },
  ];

  test("everything stays when it fits", () => {
    expect(fitHints(hints, 200)).toHaveLength(4);
  });

  test("overflow is replaced by a pointer to the full key list", () => {
    const shown = fitHints(hints, 30);
    expect(shown.at(-1)).toEqual({ key: "?", label: "keys" });
    const width = shown.reduce((n, h, i) => n + (i ? 3 : 0) + h.key.length + 1 + h.label.length, 0);
    expect(width).toBeLessThanOrEqual(30);
  });

  test("hints are dropped from the right, so the first ones always survive", () => {
    expect(fitHints(hints, 30)[0]).toEqual(hints[0]);
  });
});

describe("full ticket rendering", () => {
  const detail: IssueDetail = {
    description: "## Context\n\nStripe retries with the **same** key.\n\n- dedupe on id\n- [x] migration",
    priority: 1,
    estimate: 3,
    labels: ["bug", "billing"],
    project: "Billing reliability",
    cycle: "Cycle 12",
    parent: { identifier: "ENG-400", title: "Billing hardening" },
    children: [
      { id: "a", identifier: "ENG-413", title: "Migration", stateName: "Done", stateType: "completed" },
    ],
    comments: [{ id: "c1", author: "Aidas", body: "Confirmed in prod.", createdAt: new Date().toISOString() }],
    stateName: "In Review",
    stateType: "started",
    createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
  };

  const text = (width = 70) =>
    buildTicketLines(makeWorkspace().ticket, detail, width).map(lineText).join("\n");

  test("carries the whole ticket: metadata, body, sub-issues and comments", () => {
    const out = text();
    expect(out).toContain("ENG-412");
    expect(out).toContain("In Review");
    expect(out).toContain("Urgent");
    expect(out).toContain("Billing reliability");
    expect(out).toContain("Cycle 12");
    expect(out).toContain("ENG-400");
    expect(out).toContain("DESCRIPTION");
    expect(out).toContain("Stripe retries with the same key.");
    expect(out).toContain("SUB-ISSUES (1)");
    expect(out).toContain("ENG-413");
    expect(out).toContain("COMMENTS (1)");
    expect(out).toContain("Confirmed in prod.");
  });

  test("the fetched state wins over the snapshot stored on the workspace", () => {
    // The fixture ticket is stored as "In Progress"; Linear now says In Review.
    expect(text()).not.toContain("In Progress");
  });

  test("no line is wider than the column it was rendered for", () => {
    const lines = buildTicketLines(makeWorkspace().ticket, detail, 48).map(lineText);
    expect(lines.every((l) => l.length <= 48)).toBe(true);
  });

  test("without detail it still renders the header instead of failing", () => {
    const out = buildTicketLines(makeWorkspace().ticket, undefined, 60, { loading: true }).map(lineText).join("\n");
    expect(out).toContain("ENG-412");
    expect(out).toContain("loading the rest of the ticket");
  });

  test("an error is surfaced in place of the body", () => {
    const out = buildTicketLines(makeWorkspace().ticket, undefined, 60, { error: "Linear rejected the API key" })
      .map(lineText)
      .join("\n");
    expect(out).toContain("Linear rejected the API key");
  });
});

describe("identifier colour by depth", () => {
  test("a nested id is never the same hue as a top-level one", () => {
    expect(idColor(0)).not.toBe(idColor(1));
    expect(idColor(0, { selected: true })).not.toBe(idColor(1, { selected: true }));
  });

  test("selection brightens, at either depth", () => {
    expect(idColor(0, { selected: true })).toBe(theme.accentBright);
    expect(idColor(0)).toBe(theme.accent);
    expect(idColor(1, { selected: true })).toBe(theme.cyanBright);
    expect(idColor(1)).toBe(theme.cyan);
  });

  test("muted wins over everything — a merged PR or a done sub-issue recedes", () => {
    expect(idColor(0, { muted: true, selected: true })).toBe(theme.textDim);
    expect(idColor(1, { muted: true })).toBe(theme.textDim);
  });

  test("depth past the second tier keeps the nested hue rather than inventing one", () => {
    expect(idColor(2)).toBe(idColor(1));
  });
});
