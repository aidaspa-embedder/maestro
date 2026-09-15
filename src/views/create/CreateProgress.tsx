import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { Spinner } from "../../components/primitives.tsx";
import { pad, truncate } from "../../lib/text.ts";
import { mergeRepositories, plannedRepositories, provisionRepositories, type ProvisionStatus } from "../../services/workspaces.ts";
import type { IssueTicket, Workspace } from "../../state/types.ts";
import { glyph, theme } from "../../theme.ts";
import type { PickedRepo } from "./RepoPicker.tsx";

export function CreateProgress({ ticket, repos, slug, branch, worktreeRoot, onComplete, existing, token, concurrency = 3, onCheckpoint }: {
  ticket: IssueTicket; repos: PickedRepo[]; slug: string; branch: string; worktreeRoot: string;
  onComplete: (ws: Workspace) => void | Promise<void>; existing?: Workspace; token?: string; concurrency?: number;
  onCheckpoint?: (ws: Workspace) => Promise<void>;
}) {
  const { width, height } = useTerminalDimensions();
  const [steps, setSteps] = useState(() => repos.map(repo => ({ repo, status: "queued" as ProvisionStatus, detail: "queued" })));
  const [error, setError] = useState("");
  const [finished, setFinished] = useState<Workspace>();
  const started = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      void (async () => {
        const planned = plannedRepositories(worktreeRoot, slug, repos, existing);
        let draft: Workspace = existing ? mergeRepositories(existing, planned) : {
          id: `${ticket.identifier}-${crypto.randomUUID()}`, worktreeRoot, ticket, slug, branch, repos: planned, createdAt: new Date().toISOString(),
        };
        // Persist the manifest before touching Git, then checkpoint each finished repository.
        await onCheckpoint?.(draft);
        const results = await provisionRepositories({ root: worktreeRoot, branch, repos: planned, token, concurrency,
          onUpdate: update => { if (mounted.current) setSteps(s => s.map((st, i) => i === update.index ? { ...st, status: update.status, detail: update.detail } : st)); },
          onRepo: async repo => {
            draft = mergeRepositories(draft, [repo]);
            await onCheckpoint?.(draft);
          },
        });
        const ws = existing ? mergeRepositories(draft, results) : { ...draft, repos: results };
        if (mounted.current) { setFinished(ws); await onComplete(ws); }
      })().catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); });
    }
    return () => { mounted.current = false; };
  }, []);
  useKeyboard(key => {
    if (error && finished && key.name === "return") {
      key.preventDefault(); setError("");
      void Promise.resolve(onComplete(finished)).catch(e => setError(String(e)));
    }
  });
  const active = Math.max(0, steps.findIndex(s => s.status === "cloning" || s.status === "running"));
  const count = Math.max(1, height - 10);
  const start = Math.max(0, active - count + 1);
  return <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
    <text fg={theme.heading}>{`${ticket.identifier} — ${truncate(ticket.title, Math.max(10, width - 20))}`}</text>
    <text fg={theme.textFaint}>{truncate(`branch ${branch}`, width - 4)}</text>
    <text fg={theme.textDim}>{`${steps.filter(s => ["done", "reused", "failed"].includes(s.status)).length}/${steps.length} repositories · ${concurrency} jobs at a time`}</text>
    <box height={1} />
    {steps.slice(start, start + count).map(step => <text key={step.repo.owner + "/" + step.repo.name}>
      {step.status === "cloning" || step.status === "running" ? <Spinner /> : <span fg={step.status === "failed" ? theme.danger : theme.success}>{step.status === "queued" ? glyph.dotOpen : step.status === "failed" ? glyph.cross : glyph.check}</span>}
      <span fg={theme.text}>{" " + pad(truncate(step.repo.name, 24), 25)}</span>
      <span fg={step.status === "failed" ? theme.danger : theme.textFaint}>{truncate(step.detail, Math.max(10, width - 32))}</span>
    </text>)}
    {error ? <text fg={theme.danger}>{`${error}${finished ? " — Enter retries saving." : " — Restart and add the pending repositories to retry."}`}</text> : null}
  </box>;
}
