import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorkspace } from "./fixtures.ts";
import type { OpenSurface } from "../src/services/terminals.ts";

/**
 * Session tracking: reading agent transcripts off disk, deciding whether a
 * workspace is attached/working, and building the attach menu. The terminal
 * enumeration is mocked so nothing here touches AppleScript.
 */

const home = await mkdtemp(join(tmpdir(), "maestro-status-"));
process.env.HOME = home;

// The main repo's *worktree* — sessions run there, so transcripts and surface
// cwds are matched against it. Matches makeWorkspace().
const MAIN_REPO = "/Users/example/maestro/backend-service/ENG-412-fix-billing-webhook-retries-dropping";

// ── Claude transcripts: ~/.claude/projects/<non-alnum -> dash>/<uuid>.jsonl ──
const claudeDir = join(home, ".claude", "projects", MAIN_REPO.replace(/[^a-zA-Z0-9]/g, "-"));
await mkdir(claudeDir, { recursive: true });
const CLAUDE_OLD = "11111111-1111-1111-1111-111111111111";
const CLAUDE_NEW = "22222222-2222-2222-2222-222222222222";
await writeFile(join(claudeDir, `${CLAUDE_OLD}.jsonl`), "{}\n");
await writeFile(join(claudeDir, `${CLAUDE_NEW}.jsonl`), "{}\n");
// Make the "new" one unambiguously newer.
const old = new Date(Date.now() - 3 * 3600_000);
await utimes(join(claudeDir, `${CLAUDE_OLD}.jsonl`), old, old);

// ── Codex rollout: cwd lives in the session_meta first line, not the path ────
const codexDir = join(home, ".codex", "sessions", "2026", "07", "24");
await mkdir(codexDir, { recursive: true });
const CODEX_ID = "019f8c13-f859-7502-89d3-f4d0f63e729c";
const meta = {
  timestamp: new Date().toISOString(),
  type: "session_meta",
  payload: { id: CODEX_ID, cwd: MAIN_REPO, originator: "codex_cli", cli_version: "0.130.0" },
};
await writeFile(join(codexDir, `rollout-2026-07-24T10-00-00-${CODEX_ID}.jsonl`), JSON.stringify(meta) + "\n{}\n");
// A rollout for a different cwd must not leak into this workspace.
const otherId = "019f0000-0000-7000-8000-000000000000";
await writeFile(
  join(codexDir, `rollout-2026-07-24T09-00-00-${otherId}.jsonl`),
  JSON.stringify({ type: "session_meta", payload: { id: otherId, cwd: "/somewhere/else" } }) + "\n",
);

// Capture the real module before registering the mock — resolving it inside the
// factory would resolve to the mock itself.
const realTerminals = await import("../src/services/terminals.ts");
const parseTitle = realTerminals.parseTitle;

let surfaces: OpenSurface[] | null = [];
mock.module("../src/services/terminals.ts", () => ({
  ...realTerminals,
  listSurfaces: async () => surfaces,
  appRunning: async () => true,
}));

const { claudeSessions, buildCodexIndex, resumableSessions, resumeArgs } = await import("../src/services/session.ts");
const { pollStatuses } = await import("../src/services/status.ts");

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("terminal title parsing", () => {
  test("a braille frame means claude is mid-turn", () => {
    expect(parseTitle("⠂ Build TUI app with React and Bun")).toEqual({ agent: "claude", working: true });
    expect(parseTitle("⠋ Fixing the webhook")).toEqual({ agent: "claude", working: true });
  });

  test("✳ means claude is running but idle", () => {
    expect(parseTitle("✳ Claude Code")).toEqual({ agent: "claude", working: false });
    expect(parseTitle("✳ Fix duplicate emb_ prefix")).toEqual({ agent: "claude", working: false });
  });

  test("anything else is not a recognised agent", () => {
    expect(parseTitle("bun dev")).toEqual({ working: false });
    expect(parseTitle("aidas@host:~/Projects")).toEqual({ working: false });
    expect(parseTitle("👻")).toEqual({ working: false });
  });
});

describe("transcript discovery", () => {
  test("claude sessions come back newest first", async () => {
    const found = await claudeSessions(MAIN_REPO);
    expect(found.map((s) => s.id)).toEqual([CLAUDE_NEW, CLAUDE_OLD]);
    expect(found[0]!.agent).toBe("claude");
  });

  test("an unknown cwd has no sessions", async () => {
    expect(await claudeSessions("/no/such/repo")).toEqual([]);
  });

  test("codex sessions are grouped by the cwd inside the file", async () => {
    const index = await buildCodexIndex();
    expect(index.get(MAIN_REPO)?.map((s) => s.id)).toEqual([CODEX_ID]);
    expect(index.get("/somewhere/else")?.map((s) => s.id)).toEqual([otherId]);
  });

  test("resumableSessions picks the newest of each agent", async () => {
    const r = await resumableSessions(MAIN_REPO);
    expect(r.claude?.id).toBe(CLAUDE_NEW);
    expect(r.claudeCount).toBe(2);
    expect(r.codex?.id).toBe(CODEX_ID);
    expect(r.codexCount).toBe(1);
  });

  test("resume arguments differ per agent", () => {
    expect(resumeArgs("claude", "abc")).toEqual(["--resume", "abc"]);
    expect(resumeArgs("codex", "abc")).toEqual(["resume", "abc"]);
  });
});

describe("pollStatuses", () => {
  const ws = makeWorkspace();

  test("no open surface means detached, but still resumable", async () => {
    surfaces = [];
    const map = await pollStatuses([ws], "ghostty");
    const s = map.get(ws.id)!;

    expect(s.attached).toBe(false);
    expect(s.working).toBe(false);
    expect(s.resumable.claude?.id).toBe(CLAUDE_NEW);
    expect(s.resumable.codex?.id).toBe(CODEX_ID);
  });

  test("a tracked surface id marks the workspace attached", async () => {
    surfaces = [{ id: "SURFACE-1", title: "✳ Claude Code", cwd: "" }];
    const tracked = {
      ...ws,
      session: {
        agent: "claude" as const,
        terminal: "ghostty" as const,
        surfaceId: "SURFACE-1",
        cwd: MAIN_REPO,
        launchedAt: new Date().toISOString(),
      },
    };

    const s = (await pollStatuses([tracked], "ghostty")).get(ws.id)!;
    expect(s.attached).toBe(true);
    expect(s.surfaceId).toBe("SURFACE-1");
    expect(s.agent).toBe("claude");
    expect(s.working).toBe(false);
  });

  test("a braille title marks the agent as working", async () => {
    surfaces = [{ id: "SURFACE-1", title: "⠙ Reindexing embeddings", cwd: "" }];
    const tracked = {
      ...ws,
      session: {
        agent: "claude" as const,
        terminal: "ghostty" as const,
        surfaceId: "SURFACE-1",
        cwd: MAIN_REPO,
        launchedAt: new Date().toISOString(),
      },
    };

    const s = (await pollStatuses([tracked], "ghostty")).get(ws.id)!;
    expect(s.working).toBe(true);
    expect(s.agent).toBe("claude");
  });

  test("a surface is also matched by cwd, for sessions started by hand", async () => {
    // maestro's own launches report no cwd, but a shell-integrated one does.
    surfaces = [{ id: "SURFACE-2", title: "✳ Claude Code", cwd: MAIN_REPO }];
    const s = (await pollStatuses([ws], "ghostty")).get(ws.id)!;

    expect(s.attached).toBe(true);
    expect(s.surfaceId).toBe("SURFACE-2");
  });

  test("an unrelated surface leaves the workspace detached", async () => {
    surfaces = [{ id: "SURFACE-3", title: "✳ Claude Code", cwd: "/some/other/repo" }];
    expect((await pollStatuses([ws], "ghostty")).get(ws.id)!.attached).toBe(false);
  });

  test("codex activity falls back to transcript freshness", async () => {
    // Codex sets no title, so a fresh mtime is the only "working" signal.
    surfaces = [{ id: "SURFACE-4", title: "👻", cwd: "" }];
    const tracked = {
      ...ws,
      session: {
        agent: "codex" as const,
        terminal: "ghostty" as const,
        surfaceId: "SURFACE-4",
        cwd: MAIN_REPO,
        launchedAt: new Date().toISOString(),
      },
    };

    const s = (await pollStatuses([tracked], "ghostty")).get(ws.id)!;
    expect(s.agent).toBe("codex");
    expect(s.working).toBe(true); // rollout was written moments ago
  });

  test("an unenumerable terminal reports tracking as unsupported", async () => {
    surfaces = null;
    const s = (await pollStatuses([ws], "apple-terminal")).get(ws.id)!;
    expect(s.trackingUnsupported).toBe(true);
    expect(s.attached).toBe(false);
  });

  test("legacy sessions recorded before worktree cwds stay resumable", async () => {
    // A workspace from before sessions moved into worktrees: its last launch
    // ran in the project checkout, and that's where the transcript lives.
    const LEGACY_CWD = "/Users/example/Projects/backend-service";
    const LEGACY_ID = "44444444-4444-4444-4444-444444444444";
    const legacyDir = join(home, ".claude", "projects", LEGACY_CWD.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, `${LEGACY_ID}.jsonl`), "{}\n");

    const legacy = makeWorkspace({
      id: "ENG-100-legacy",
      repos: [
        {
          name: "backend-service",
          repoPath: LEGACY_CWD, // old entries point at the checkout, not a bare clone
          worktreePath: "/Users/example/maestro/backend-service/ENG-100-no-transcripts-here",
          isMain: true,
        },
      ],
      session: {
        agent: "claude",
        terminal: "ghostty",
        cwd: LEGACY_CWD,
        launchedAt: new Date().toISOString(),
      },
    });

    surfaces = [];
    const s = (await pollStatuses([legacy], "ghostty")).get("ENG-100-legacy")!;

    expect(s.resumable.claude?.id).toBe(LEGACY_ID);
    // The resume must launch where the transcript lives, so the cwd rides along.
    expect(s.resumable.claude?.cwd).toBe(LEGACY_CWD);
  });

  test("workspaces with no repos degrade gracefully", async () => {
    surfaces = [];
    const empty = makeWorkspace({ id: "no-repos", repos: [] });
    const s = (await pollStatuses([empty], "ghostty")).get("no-repos")!;
    expect(s.attached).toBe(false);
    expect(s.resumable.claudeCount).toBe(0);
  });
});
