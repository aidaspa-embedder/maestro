import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { useApp } from "../state/app-context.tsx";
import { RepoPicker, type RepoSelection } from "./create/RepoPicker.tsx";
import { CreateProgress } from "./create/CreateProgress.tsx";
import { theme } from "../theme.ts";

export function AddRepositories({ id }: { id: string }) {
  const app = useApp();
  const { width } = useTerminalDimensions();
  const [selection, setSelection] = useState<RepoSelection>();
  const [branchRepo, setBranchRepo] = useState<string | null>(null);
  const ws = app.workspaces.find(w => w.id === id);
  useKeyboard(key => { if (!ws && key.name === "escape") app.back(); });
  if (!ws) return <text fg={theme.danger}>{"Workspace no longer exists. Esc to go back."}</text>;
  return <Shell crumbs={["workspaces", ws.ticket.identifier, "add repositories", ...(branchRepo ? [branchRepo, "starting branch"] : [])]} hints={selection ? [{ key: "…", label: "adding repositories" }] : branchRepo ? [
    { key: "↑↓", label: "branches" }, { key: "⏎", label: "use branch" }, { key: "^r", label: "refresh branches" }, { key: "esc", label: "back" },
  ] : [
    { key: "space", label: "toggle" }, { key: "→", label: "starting branch" }, { key: "^r", label: "refresh" }, { key: "⏎", label: "add repos" }, { key: "esc", label: "cancel" },
  ]}>
    {selection ? <CreateProgress ticket={ws.ticket} slug={ws.slug} branch={ws.branch} repos={selection.repos} existing={ws}
      worktreeRoot={ws.worktreeRoot ?? app.config.worktreeRoot} token={app.config.githubMode === "token" ? app.githubToken : undefined} concurrency={app.config.cloneConcurrency}
      onCheckpoint={app.upsertWorkspace}
      onComplete={async updated => {
        await app.upsertWorkspace(updated); app.refreshPrs(); app.refreshStatuses();
        app.showToast(updated.repos.some(r => r.error) ? "Some repositories failed; add them again to retry" : "Repositories added — y copies the updated worktree map", updated.repos.some(r => r.error) ? "error" : "success");
        app.back();
      }} /> : <RepoPicker token={app.githubToken} slug={ws.slug} worktreeRoot={ws.worktreeRoot ?? app.config.worktreeRoot} width={width}
      cacheTtlMinutes={app.config.repoCacheTtlMinutes} owner={app.config.repoOwner}
      exclude={ws.repos.filter(r => !r.error).map(r => `${r.owner}/${r.repo ?? r.name}`)} preserveMain
      onDone={setSelection} onBack={app.back} onError={m => app.showToast(m, "error")} onBranchMode={setBranchRepo} />}
  </Shell>;
}
