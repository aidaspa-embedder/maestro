import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved per call rather than cached at import: the agent state directories
 * are read long after startup, and a cached value would freeze whatever $HOME
 * happened to be set when this module first loaded.
 */
function agentHome(): string {
  return process.env.HOME || homedir();
}

export interface AgentSession {
  agent: "claude" | "codex";
  /** Passed to `claude --resume <id>` / `codex resume <id>` */
  id: string;
  /** Last write to the session transcript, ms epoch */
  updatedAt: number;
  /**
   * Directory the transcript belongs to. Resuming must launch here — both
   * agents scope their session lookup to the working directory, so a resume
   * started anywhere else finds nothing.
   */
  cwd: string;
}

export interface Resumable {
  claude?: AgentSession;
  codex?: AgentSession;
  /** How many sessions exist per agent, for "3 sessions" style hints */
  claudeCount: number;
  codexCount: number;
}

/**
 * Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/, where
 * the encoding replaces every non-alphanumeric character with a dash. Verified
 * against all 65 project dirs on a real machine.
 */
export function claudeProjectDir(cwd: string): string {
  return join(agentHome(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Sessions Claude Code has recorded for this working directory. */
export async function claudeSessions(cwd: string): Promise<AgentSession[]> {
  const dir = claudeProjectDir(cwd);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no sessions for this cwd yet
  }

  const out: AgentSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const info = await stat(join(dir, name));
      out.push({ agent: "claude", id: name.slice(0, -".jsonl".length), updatedAt: info.mtimeMs, cwd });
    } catch {
      // raced with a delete; skip
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Codex writes rollouts to ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// with no cwd in the path, so the cwd has to come from the session_meta line —
// ~22KB each. Cached by path+mtime so a full read happens once per file, not
// once per poll.
const codexRoot = () => join(agentHome(), ".codex", "sessions");
const CODEX_SCAN_DAYS = 21;
const META_READ_BYTES = 256 * 1024;

interface CodexMeta {
  mtimeMs: number;
  id: string;
  cwd: string;
}

const codexMetaCache = new Map<string, CodexMeta>();

async function readCodexMeta(path: string, mtimeMs: number): Promise<CodexMeta | null> {
  const cached = codexMetaCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  try {
    const head = await Bun.file(path).slice(0, META_READ_BYTES).text();
    const newline = head.indexOf("\n");
    if (newline < 0) return null; // first line longer than the read window
    const meta = JSON.parse(head.slice(0, newline)) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
    if (meta.type !== "session_meta" || !meta.payload?.id || !meta.payload.cwd) return null;

    const entry: CodexMeta = { mtimeMs, id: meta.payload.id, cwd: meta.payload.cwd };
    codexMetaCache.set(path, entry);
    return entry;
  } catch {
    return null;
  }
}

export type CodexIndex = Map<string, AgentSession[]>;

/**
 * Every recent codex session grouped by cwd, from a single directory walk.
 * Polling many workspaces must share one index — walking per workspace would
 * re-stat hundreds of files each tick.
 */
export async function buildCodexIndex(): Promise<CodexIndex> {
  const cutoff = Date.now() - CODEX_SCAN_DAYS * 86_400_000;
  const index: CodexIndex = new Map();

  // sessions/YYYY/MM/DD/*.jsonl — walk three levels of date dirs.
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await walk(path, depth - 1);
        continue;
      }
      if (depth !== 0 || !entry.name.endsWith(".jsonl")) continue;

      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.mtimeMs < cutoff) continue;

      const meta = await readCodexMeta(path, info.mtimeMs);
      if (!meta) continue;

      const list = index.get(meta.cwd);
      const session: AgentSession = { agent: "codex", id: meta.id, updatedAt: info.mtimeMs, cwd: meta.cwd };
      if (list) list.push(session);
      else index.set(meta.cwd, [session]);
    }
  }

  await walk(codexRoot(), 3);
  for (const list of index.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return index;
}

/** Codex sessions for one cwd, newest first. Convenience over buildCodexIndex. */
export async function codexSessions(cwd: string): Promise<AgentSession[]> {
  return (await buildCodexIndex()).get(cwd) ?? [];
}

/**
 * The newest resumable session per agent for a working directory. Pass a
 * pre-built codex index when resolving several workspaces at once.
 */
export async function resumableSessions(cwd: string, index?: CodexIndex): Promise<Resumable> {
  const [claude, codex] = await Promise.all([
    claudeSessions(cwd),
    index ? Promise.resolve(index.get(cwd) ?? []) : codexSessions(cwd),
  ]);
  return {
    claude: claude[0],
    codex: codex[0],
    claudeCount: claude.length,
    codexCount: codex.length,
  };
}

/**
 * Resumables looked up across several directories, newest-per-agent winning.
 * A workspace's session can legitimately live in more than one place: the main
 * worktree now, but also wherever a pre-worktree launch recorded its cwd — the
 * old sessions must stay resumable after the migration.
 */
export async function resumableAcross(cwds: string[], index?: CodexIndex): Promise<Resumable> {
  const parts = await Promise.all(cwds.map((cwd) => resumableSessions(cwd, index)));

  const newest = (a?: AgentSession, b?: AgentSession) =>
    a && b ? (a.updatedAt >= b.updatedAt ? a : b) : (a ?? b);

  return parts.reduce(
    (acc, part) => ({
      claude: newest(acc.claude, part.claude),
      codex: newest(acc.codex, part.codex),
      claudeCount: acc.claudeCount + part.claudeCount,
      codexCount: acc.codexCount + part.codexCount,
    }),
    { claudeCount: 0, codexCount: 0 } as Resumable,
  );
}

/** Resume arguments for an agent, given a session id. */
export function resumeArgs(agent: "claude" | "codex", id: string): string[] {
  // claude takes a flag; codex takes a subcommand.
  return agent === "claude" ? ["--resume", id] : ["resume", id];
}
