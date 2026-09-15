import type { AgentKind, Workspace } from "../state/types.ts";
import type { ResolvedTerminal } from "./launcher.ts";
import { buildCodexIndex, resumableAcross, type Resumable } from "./session.ts";
import { listSurfaces, parseTitle, type OpenSurface } from "./terminals.ts";

/** A codex transcript written this recently means it's mid-turn. */
const ACTIVE_MS = 15_000;

export interface WorkspaceStatus {
  /** The launched surface is still open */
  attached: boolean;
  /** The agent is working right now */
  working: boolean;
  /** Surface to focus when attaching */
  surfaceId?: string;
  /** Title of the live surface, if any — used as the status line */
  title?: string;
  agent?: AgentKind;
  /** Newest transcript write across both agents, ms epoch */
  lastActivity?: number;
  resumable: Resumable;
  /** The configured terminal has no trackable surface identity (Terminal.app) */
  trackingUnsupported: boolean;
}

export function emptyStatus(): WorkspaceStatus {
  return {
    attached: false,
    working: false,
    resumable: { claudeCount: 0, codexCount: 0 },
    trackingUnsupported: false,
  };
}

/**
 * Everywhere this workspace's session could live. The main worktree is where
 * sessions run now; the recorded launch cwd and a legacy project checkout
 * cover workspaces from before sessions moved into worktrees — their
 * transcripts and windows must keep being found.
 */
function candidateCwds(ws: Workspace): string[] {
  const live = ws.repos.filter((r) => !r.error);
  const main = live.find((r) => r.isMain) ?? live[0];
  if (!main) return [];

  const out = [main.worktreePath];
  if (ws.session?.cwd && !out.includes(ws.session.cwd)) out.push(ws.session.cwd);
  // A bare clone (…/.repos/…/<repo>.git) never hosts a session; a legacy
  // repoPath is the checkout old launches ran in, so it stays a candidate.
  if (!main.repoPath.endsWith(".git") && !out.includes(main.repoPath)) out.push(main.repoPath);
  return out;
}

/**
 * Resolves live state for every workspace: is a session open, is the agent busy,
 * and what can be resumed.
 *
 * Costs one AppleScript call and one codex index walk for the whole set, not per
 * workspace. Surfaces are matched by the stable id captured at launch, falling
 * back to working-directory match so sessions started by hand are picked up too
 * (maestro's own launches report no cwd — a `command` surface never runs the
 * shell integration that publishes one).
 */
export async function pollStatuses(
  workspaces: Workspace[],
  terminal: ResolvedTerminal,
): Promise<Map<string, WorkspaceStatus>> {
  const out = new Map<string, WorkspaceStatus>();
  if (workspaces.length === 0) return out;

  const [surfaces, codexIndex] = await Promise.all([listSurfaces(terminal), buildCodexIndex()]);

  const byId = new Map<string, OpenSurface>();
  for (const s of surfaces ?? []) byId.set(s.id, s);

  await Promise.all(
    workspaces.map(async (ws) => {
      const status = emptyStatus();
      status.trackingUnsupported = surfaces === null;

      const cwds = candidateCwds(ws);
      if (cwds.length === 0) {
        out.set(ws.id, status);
        return;
      }

      status.resumable = await resumableAcross(cwds, codexIndex);
      status.lastActivity = Math.max(
        status.resumable.claude?.updatedAt ?? 0,
        status.resumable.codex?.updatedAt ?? 0,
      ) || undefined;

      const surface =
        (ws.session?.surfaceId ? byId.get(ws.session.surfaceId) : undefined) ??
        (surfaces ?? []).find((s) => s.cwd && cwds.includes(s.cwd));

      if (surface) {
        const titleState = parseTitle(surface.title);
        status.attached = true;
        status.surfaceId = surface.id;
        status.title = surface.title;
        status.agent = titleState.agent ?? ws.session?.agent;
        // Claude publishes its state in the title. Codex publishes nothing, so
        // fall back to how recently its transcript was written.
        status.working =
          titleState.working ||
          (status.agent === "codex" &&
            status.lastActivity !== undefined &&
            Date.now() - status.lastActivity < ACTIVE_MS);
      }

      out.set(ws.id, status);
    }),
  );

  return out;
}
