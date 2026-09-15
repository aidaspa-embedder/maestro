import { issueProvider } from "../integrations/issues/index.ts";
import { useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Shell } from "../components/Chrome.tsx";
import { EmptyState } from "../components/primitives.tsx";
import { workspaceSlug } from "../lib/slug.ts";
import { useApp } from "../state/app-context.tsx";
import type { IssueTicket, Workspace } from "../state/types.ts";
import { CreateProgress } from "./create/CreateProgress.tsx";
import { RepoPicker, type RepoSelection } from "./create/RepoPicker.tsx";
import { TicketDetail } from "./create/TicketDetail.tsx";
import { TicketForm } from "./create/TicketForm.tsx";
import { TicketPicker, type PickerLevel } from "./create/TicketPicker.tsx";

/** Below this the two columns get too cramped, so the panel is dropped. */
const MIN_WIDTH_FOR_DETAIL = 96;

type Step = "ticket" | "new-ticket" | "repos" | "creating";

export function CreateWorkspace() {
  const app = useApp();
  const provider = useMemo(() => issueProvider(app.config), [app.config]);
  const { width, height } = useTerminalDimensions();
  const [step, setStep] = useState<Step>("ticket");
  const [ticket, setTicket] = useState<IssueTicket | null>(null);
  const [selection, setSelection] = useState<RepoSelection | null>(null);
  // The picker owns a tree; the shell owns the footer, so the level travels up.
  const [level, setLevel] = useState<PickerLevel>({ label: "tickets", empty: true });
  /** Repo whose base branch is being picked, reported up for the footer */
  const [branchRepo, setBranchRepo] = useState<string | null>(null);

  const showDetail = width >= MIN_WIDTH_FOR_DETAIL;
  const detailW = Math.min(56, Math.max(40, Math.floor(width * 0.42)));

  const slug = ticket ? workspaceSlug(ticket.identifier, ticket.title) : "";
  // Linear's own branch name keeps its GitHub integration auto-linking PRs
  // back to the ticket, so it wins over a locally derived name.
  const branch = ticket?.branchName || slug.toLowerCase();

  async function complete(ws: Workspace) {
    await app.upsertWorkspace(ws);
    const failed = ws.repos.filter((r) => r.error).length;
    app.showToast(
      failed ? `${ws.ticket.identifier} created with ${failed} failed repo${failed === 1 ? "" : "s"}` : `${ws.ticket.identifier} ready`,
      failed ? "error" : "success",
    );
    app.replace({ view: "detail", id: ws.id });
  }

  const crumbs = ["workspaces", "new"];
  if (step === "new-ticket") crumbs.push("new ticket");
  if (step !== "ticket" && step !== "new-ticket" && ticket) crumbs.push(ticket.identifier);
  // Descending into a ticket's sub-issues is navigation, so it reads as such.
  if (step === "ticket" && level.inside) crumbs.push(level.inside, level.label);
  if (step === "repos" && branchRepo) crumbs.push(branchRepo, "starting branch");

  const hints =
    step === "ticket"
      ? [
          { key: "↑↓", label: level.label, disabled: level.empty },
          { key: "⏎", label: "select ticket", disabled: level.empty },
          ...(level.parent ? [{ key: "←", label: level.parent }] : []),
          ...(level.child ? [{ key: "→", label: level.child }] : []),
          { key: "^n", label: "new ticket" },
          { key: "esc", label: "cancel" },
        ]
      : step === "new-ticket"
        ? [
            { key: "↑↓", label: "fields" },
            { key: "←→", label: "team" },
            { key: "⏎", label: "create ticket" },
            { key: "esc", label: "back" },
          ]
        : step === "repos"
          ? branchRepo
            ? [
                { key: "↑↓", label: "branches" },
                { key: "⏎", label: "use branch" },
                { key: "^r", label: "refresh branches" },
                { key: "esc", label: "back" },
              ]
            : [
                { key: "↑↓", label: "move" },
                { key: "space", label: "toggle" },
                { key: "tab", label: "set main repo" },
                { key: "→", label: "starting branch" },
                { key: "^a", label: "all" },
                { key: "^r", label: "refresh repos" },
                { key: "⏎", label: "create worktrees" },
                { key: "esc", label: "back" },
              ]
          : [{ key: "…", label: "creating worktrees", disabled: true }];

  return (
    <Shell crumbs={crumbs} hints={hints}>
      {step === "ticket" ? (
        !provider.configured ? (
          <EmptyState title={`${provider.label} is not linked`} hint="Press esc, then s to add your API key" />
        ) : (
          <TicketPicker
            provider={provider}
            onPick={(t) => {
              setTicket(t);
              setStep("repos");
            }}
            onNew={() => setStep("new-ticket")}
            onCancel={app.back}
            onLevel={setLevel}
          />
        )
      ) : step === "new-ticket" && provider.configured ? (
        <TicketForm
          provider={provider}
          onCreated={(t) => {
            setTicket(t);
            app.showToast(`${t.identifier} created`, "success");
            setStep("repos");
          }}
          onCancel={() => setStep("ticket")}
          onError={(m) => app.showToast(m, "error")}
        />
      ) : step === "repos" && ticket ? (
        <box flexDirection="row" flexGrow={1}>
          <box flexDirection="column" width={showDetail ? width - detailW : width}>
            <RepoPicker
              token={app.githubToken}
              cacheTtlMinutes={app.config.repoCacheTtlMinutes}
              owner={app.config.repoOwner}
              slug={slug}
              worktreeRoot={app.config.worktreeRoot}
              width={showDetail ? width - detailW : width}
              onDone={(sel) => {
                setSelection(sel);
                setStep("creating");
              }}
              onBack={() => setStep("ticket")}
              onError={(m) => app.showToast(m, "error")}
              onBranchMode={setBranchRepo}
            />
          </box>
          {showDetail && provider.configured ? (
            <TicketDetail
              provider={provider}
              ticket={ticket}
              width={detailW}
              height={height - 4}
            />
          ) : null}
        </box>
      ) : step === "creating" && ticket && selection ? (
        <CreateProgress
          ticket={ticket}
          repos={selection.repos}
          slug={slug}
          branch={branch}
          worktreeRoot={app.config.worktreeRoot}
          token={app.config.githubMode === "token" ? app.githubToken : undefined}
          concurrency={app.config.cloneConcurrency}
          onCheckpoint={app.upsertWorkspace}
          onComplete={complete}
        />
      ) : null}
    </Shell>
  );
}
