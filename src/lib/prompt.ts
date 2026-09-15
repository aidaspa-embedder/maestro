import type { Workspace } from "../state/types.ts";

/**
 * The handoff text: what the agent session needs to know about where this
 * workspace's code actually lives. Kept plain so it reads well pasted into
 * claude, codex, or a commit message.
 */
export function mappingPrompt(ws: Workspace): string {
  const created = ws.repos.filter((r) => !r.error);
  const main = created.find((r) => r.isMain) ?? created[0];

  const lines: string[] = [
    `${ws.ticket.identifier} — ${ws.ticket.title}`,
    ws.ticket.url,
    "",
    "Worktrees:",
    ...created.map((r) => `  ${r.name} - ${r.worktreePath}`),
    "",
    `Branch: ${ws.branch}`,
  ];
  // The session already runs inside the main worktree; naming it tells the
  // agent which of the paths above it is standing in.
  if (main) lines.push(`Main repo: ${main.name} (this session runs in its worktree)`);

  return lines.join("\n");
}

/** The compact form used for the one-line copy: just `repo - dir` pairs. */
export function mappingOnly(ws: Workspace): string {
  return ws.repos
    .filter((r) => !r.error)
    .map((r) => `${r.name} - ${r.worktreePath}`)
    .join("\n");
}
