import { useCallback } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { mappingPrompt } from "../lib/prompt.ts";
import { launchSession, resolveTerminal } from "../services/launcher.ts";
import { resumeArgs } from "../services/session.ts";
import { focusSurface } from "../services/terminals.ts";
import { useApp } from "../state/app-context.tsx";
import type { AgentKind, Workspace } from "../state/types.ts";

export interface SessionActions {
  /** Bring an already-running session's window to the front. */
  focus: (ws: Workspace) => Promise<boolean>;
  /**
   * Start a session, optionally resuming an existing transcript. A resume
   * carries the directory its transcript belongs to — the agents scope their
   * session lookup by cwd, so resuming anywhere else finds nothing.
   */
  start: (ws: Workspace, agent: AgentKind, resumeId?: string, resumeCwd?: string) => Promise<void>;
  /**
   * What "open" should do: focus a live session, else resume the newest
   * transcript, else start fresh. Never opens a duplicate window.
   */
  attach: (ws: Workspace) => Promise<void>;
}

export function useSessionActions(): SessionActions {
  const app = useApp();

  const focus = useCallback(
    async (ws: Workspace) => {
      const status = app.statusOf(ws.id);
      if (!status.attached || !status.surfaceId) return false;

      const terminal = resolveTerminal(app.config.terminal);
      const ok = await focusSurface(terminal, status.surfaceId);
      app.showToast(
        ok ? `Focused ${ws.ticket.identifier} session` : "Could not focus that window",
        ok ? "success" : "error",
      );
      return ok;
    },
    [app],
  );

  const start = useCallback(
    async (ws: Workspace, agent: AgentKind, resumeId?: string, resumeCwd?: string) => {
      const live = ws.repos.filter((r) => !r.error);
      const main = live.find((r) => r.isMain) ?? live[0];
      if (!main) {
        app.showToast("No repo to launch from", "error");
        return;
      }

      // A resumed session already knows the worktree layout, so the handoff
      // prompt is only typed into a fresh one.
      const prompt = agent === "shell" || resumeId ? undefined : [mappingPrompt(ws), app.config.promptSuffix].filter(Boolean).join("\n\n");

      // Fresh sessions live in the worktree the workspace was built for — the
      // parent clone is bookkeeping, not a place to work. A resume follows its
      // transcript, which may predate sessions moving into worktrees.
      const cwd = (resumeId && resumeCwd) || main.worktreePath;
      const res = await launchSession({
        cwd,
        agent,
        args: [
          ...(resumeId && agent !== "shell" ? resumeArgs(agent, resumeId) : []),
          ...((agent === "claude" ? app.config.claudeModel : agent === "codex" ? app.config.codexModel : undefined) ? ["--model", (agent === "claude" ? app.config.claudeModel : app.config.codexModel)!] : []),
        ],
        initialText: prompt,
        terminal: app.config.terminal,
        target: app.config.launchTarget,
      });

      if (!res.ok) {
        await copyToClipboard(res.fallbackCommand);
        app.showToast(`${res.error} — command copied to clipboard`, "error");
        return;
      }

      await app.upsertWorkspace({
        ...ws,
        lastAgent: agent,
        session: {
          agent,
          terminal: res.terminal,
          surfaceId: res.surfaceId,
          cwd,
          launchedAt: new Date().toISOString(),
          resumedId: resumeId,
        },
      });
      if (agent !== "shell") await app.patchConfig({ defaultAgent: agent });
      app.refreshStatuses();

      if (res.promptNotTyped && prompt) {
        await copyToClipboard(prompt);
        app.showToast(`${resumeId ? "Resumed" : "Launched"} ${agent} — prompt copied`, "success");
      } else {
        app.showToast(
          `${resumeId ? "Resumed" : "Launched"} ${agent} in ${main.name}`,
          "success",
        );
      }
    },
    [app],
  );

  const attach = useCallback(
    async (ws: Workspace) => {
      const status = app.statusOf(ws.id);
      if (status.attached && status.surfaceId) {
        await focus(ws);
        return;
      }

      const { claude, codex } = status.resumable;
      const newest =
        claude && codex ? (claude.updatedAt >= codex.updatedAt ? claude : codex) : (claude ?? codex);

      if (newest) await start(ws, newest.agent, newest.id, newest.cwd);
      else await start(ws, ws.lastAgent ?? app.config.defaultAgent);
    },
    [app, focus, start],
  );

  const report = async (task: () => Promise<void>) => {
    try { await task(); }
    catch (error) { app.showToast(error instanceof Error ? error.message : String(error), "error"); }
  };
  return { focus, start: (...args) => report(() => start(...args)), attach: ws => report(() => attach(ws)) };
}
