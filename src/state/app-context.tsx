import { MotionContext } from "../components/Motion.tsx";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as github from "../services/github.ts";
import { issueProvider, issueKey, type TicketState } from "../integrations/issues/index.ts";
import { normalizeConfig, pollIntervals } from "./config.ts";
import { resolveTerminal } from "../services/launcher.ts";
import { emptyStatus, pollStatuses, type WorkspaceStatus } from "../services/status.ts";
import { DEFAULT_CONFIG, loadConfig, loadWorkspaces, saveConfig, saveWorkspaces } from "./store.ts";
import type { Config, PullRequest, Workspace } from "./types.ts";

export type DetailTab = "overview" | "ticket" | "prs";

export type Route =
  | { view: "workspaces" }
  | { view: "create" }
  | { view: "detail"; id: string; tab?: DetailTab }
  | { view: "settings" }
  | { view: "onboarding" }
  | { view: "add-repos"; id: string };

export type ConnectionStatus = "unlinked" | "checking" | "ok" | "error";

export interface Connection {
  status: ConnectionStatus;
  /** Account name shown next to the pill when linked */
  label?: string;
  error?: string;
}

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

interface AppState {
  ready: boolean;
  bootError?: string;
  config: Config;
  patchConfig: (patch: Partial<Config>) => Promise<void>;

  workspaces: Workspace[];
  upsertWorkspace: (ws: Workspace) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  /** Hide a workspace from the default list without touching anything on disk */
  setHidden: (id: string, hidden: boolean) => Promise<void>;

  /** Live session state per workspace id, refreshed on a poll */
  statusOf: (workspaceId: string) => WorkspaceStatus;
  refreshStatuses: () => void;

  /** Pull requests on each workspace's branch, refreshed on a slower poll */
  prsOf: (workspaceId: string) => PullRequest[];
  /** True once a PR fetch has landed, so the tree can tell "none" from "not yet" */
  prsLoaded: boolean;
  refreshPrs: () => void;

  /** Re-read every workspace ticket's workflow state from Linear */
  refreshTickets: () => void;

  issues: Connection;
  linear: Connection;
  github: Connection;
  /** Cached GitHub token so the PR view doesn't shell out to gh on every load */
  githubToken: string | undefined;
  checkConnections: () => void;

  route: Route;
  navigate: (route: Route) => void;
  /** Swaps the current route without growing the back stack */
  replace: (route: Route) => void;
  back: () => void;

  toast: Toast | undefined;
  showToast: (text: string, kind?: ToastKind) => void;
}

/** Fast enough that a spinner reads as live, slow enough to stay cheap. */
const STATUS_POLL_MS = 3_000;
/** PRs move on human timescales, and each poll is a real API request. */
const PR_POLL_MS = 90_000;
/** Ticket state changes when someone drags a card; minutes-fresh is plenty. */
const TICKET_POLL_MS = 120_000;

// Shared instances so the accessors return stable references for unknown ids.
const EMPTY_STATUS = emptyStatus();
const EMPTY_PRS: PullRequest[] = [];

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string>();
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [linearConn, setLinearConn] = useState<Connection>({ status: "unlinked" });
  const [githubConn, setGithubConn] = useState<Connection>({ status: "unlinked" });
  const [githubToken, setGithubToken] = useState<string | undefined>();
  const [statuses, setStatuses] = useState<Map<string, WorkspaceStatus>>(new Map());
  const [statusNonce, setStatusNonce] = useState(0);
  const [prs, setPrs] = useState<Map<string, PullRequest[]>>(new Map());
  const [prsLoaded, setPrsLoaded] = useState(false);
  const [prNonce, setPrNonce] = useState(0);
  const [ticketNonce, setTicketNonce] = useState(0);
  const [stack, setStack] = useState<Route[]>([{ view: "workspaces" }]);
  const [toast, setToast] = useState<Toast | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastId = useRef(0);
  const configRef = useRef(config);
  const verifyId = useRef(0);

  // Pollers read the live list through this rather than closing over it, so a
  // ticket-state write can't restart a PR poll that has nothing to do with it.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const commit = useCallback(async (next: Workspace[]) => {
    const previous = workspacesRef.current;
    workspacesRef.current = next;
    setWorkspaces(next);
    try { await saveWorkspaces(next); }
    catch (error) {
      if (workspacesRef.current === next) { workspacesRef.current = previous; setWorkspaces(previous); }
      setBootError("Workspace state could not be saved. The last saved file is preserved. Check disk space and file permissions, then restart.");
      throw error;
    }
  }, []);

  // Boot: read disk, then verify both integrations in the background.
  useEffect(() => {
    void (async () => {
      const [cfg, ws] = await Promise.all([loadConfig(), loadWorkspaces()]);
      configRef.current = cfg;
      setConfig(cfg);
      workspacesRef.current = ws;
      setWorkspaces(ws);
      setReady(true);
    })().catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
  }, []);

  const verify = useCallback((cfg: Config) => {
    const id = ++verifyId.current;
    const provider = issueProvider(cfg);
    if (provider.configured) {
      setLinearConn({ status: "checking" });
      provider.verify().then(
        v => { if (id === verifyId.current) setLinearConn({ status: "ok", label: v.name }); },
        (e: unknown) => { if (id === verifyId.current) setLinearConn({ status: "error", error: e instanceof Error ? e.message : String(e) }); },
      );
    } else setLinearConn({ status: "unlinked" });
    setGithubToken(undefined);
    setGithubConn({ status: "checking" });
    github.resolveToken(cfg).then(async token => {
      const v = await github.verifyToken(token);
      if (id !== verifyId.current) return;
      setGithubToken(token);
      setGithubConn({ status: "ok", label: v.login });
    }).catch((e: unknown) => {
      if (id !== verifyId.current) return;
      setGithubToken(undefined);
      setGithubConn({ status: "error", error: e instanceof Error ? e.message : String(e) });
    });
  }, []);

  useEffect(() => {
    if (ready) verify(config);
  }, [ready]);

  const patchConfig = useCallback(async (patch: Partial<Config>) => {
    const previous = configRef.current;
    const next = normalizeConfig({ ...previous, ...patch });
    configRef.current = next;
    try { await saveConfig(next); }
    catch (error) { if (configRef.current === next) { configRef.current = previous; setConfig(previous); } throw error; }
    // A later queued save wins even if this write finished first.
    setConfig(configRef.current);
    const keys = ["linearApiKey", "githubMode", "githubToken", "issueProvider", "jiraUrl", "jiraEmail", "jiraApiToken"];
    if (keys.some(k => k in patch)) verify(configRef.current);
  }, [verify]);

  const upsertWorkspace = useCallback(
    async (ws: Workspace) => {
      const current = workspacesRef.current;
      await commit(
        current.some((w) => w.id === ws.id)
          ? current.map((w) => {
              if (w.id !== ws.id) return w;
              const newerTicket = (w.ticketSyncedAt ?? "") > (ws.ticketSyncedAt ?? "");
              const newerSession = (w.session?.launchedAt ?? "") > (ws.session?.launchedAt ?? "");
              return { ...ws,
                ...(newerTicket ? { ticket: w.ticket, ticketSyncedAt: w.ticketSyncedAt } : {}),
                ...(newerSession ? { session: w.session, lastAgent: w.lastAgent } : {}),
              };
            })
          : [ws, ...current],
      );
    },
    [commit],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      await commit(workspacesRef.current.filter((w) => w.id !== id));
    },
    [commit],
  );

  const setHidden = useCallback(
    async (id: string, hidden: boolean) => {
      await commit(workspacesRef.current.map((w) => (w.id === id ? { ...w, hidden } : w)));
    },
    [commit],
  );

  // Live session polling. Self-chaining rather than setInterval so a slow tick
  // can never overlap the next one.
  useEffect(() => {
    if (!ready || workspaces.length === 0) {
      setStatuses(new Map());
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminal = resolveTerminal(config.terminal);

    const tick = async () => {
      try {
        const next = await pollStatuses(workspacesRef.current, terminal);
        if (!cancelled) setStatuses(next);
      } catch {
        // Transient (terminal quitting mid-call); retry on the next tick.
      }
      if (!cancelled) timer = setTimeout(tick, pollIntervals(config).session);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ready, workspaces.map(w => `${w.id}:${w.repos.map(r => r.worktreePath).join(",")}:${w.session?.surfaceId ?? ""}`).join("|"), config.terminal, config.pollingPreset, statusNonce]);

  // Pull requests for every workspace at once. Keyed on the id+branch set, not
  // the workspace objects, so unrelated writes don't trigger an API round trip.
  const prKey = workspaces.map((w) => `${w.id}@${w.branch}:${w.repos.map(r => `${r.owner}/${r.repo}:${r.error ?? ""}`).join(",")}`).join("|");
  useEffect(() => {
    if (!ready || !githubToken || prKey === "") {
      setPrs((p) => (p.size === 0 ? p : new Map()));
      setPrsLoaded(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await github.fetchAllPrs(githubToken, workspacesRef.current);
        if (!cancelled) {
          setPrs(next);
          setPrsLoaded(true);
        }
      } catch {
        // Rate limit or a dropped connection; the next tick retries.
      }
      if (!cancelled) timer = setTimeout(tick, pollIntervals(config).prs);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [ready, githubToken, prKey, prNonce, config.pollingPreset]);

  /**
   * Workflow state is captured when the workspace is created and goes stale the
   * moment anyone moves the card, so it is re-read from Linear and written back
   * to disk — the list then shows the last known state even while offline.
   */
  const applyTicketStates = useCallback((states: Map<string, TicketState>) => {
    const current = workspacesRef.current;
    let changed = false;
    const now = new Date().toISOString();

    const next = current.map((ws) => {
      const live = states.get(issueKey(ws.ticket));
      if (!live) return ws;
      const same =
        live.stateName === ws.ticket.stateName &&
        live.stateType === ws.ticket.stateType &&
        live.title === ws.ticket.title &&
        live.assignee === ws.ticket.assignee;
      if (same) return ws;
      changed = true;
      return {
        ...ws,
        ticket: {
          ...ws.ticket,
          title: live.title,
          stateName: live.stateName,
          stateType: live.stateType,
          assignee: live.assignee,
        },
        ticketSyncedAt: now,
      };
    });

    if (changed) void commit(next).catch(() => {});
  }, [commit]);

  const ticketKey = workspaces.map(w => issueKey(w.ticket)).sort().join(",");
  useEffect(() => {
    if (!ready || ticketKey === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const groups = new Map<string, Workspace[]>();
      for (const ws of workspacesRef.current) {
        const key = `${ws.ticket.provider ?? "linear"}:${ws.ticket.site ?? ""}`;
        groups.set(key, [...(groups.get(key) ?? []), ws]);
      }
      const states = new Map<string, TicketState>();
      await Promise.all([...groups.values()].map(async group => {
        try {
          const provider = issueProvider(config, group[0]!.ticket);
          if (!provider.configured) return;
          const live = await provider.issueStates(group.map(w => w.ticket.id));
          for (const ws of group) {
            const state = live.get(ws.ticket.id);
            if (state) states.set(issueKey(ws.ticket), state);
          }
        } catch { /* Keep last known state while offline. */ }
      }));
      if (!cancelled) {
        applyTicketStates(states);
        timer = setTimeout(tick, pollIntervals(config).issues);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [ready, config.linearApiKey, config.jiraUrl, config.jiraEmail, config.jiraApiToken, config.pollingPreset, ticketKey, ticketNonce]);

  const statusOf = useCallback(
    (workspaceId: string) => statuses.get(workspaceId) ?? EMPTY_STATUS,
    [statuses],
  );
  const refreshStatuses = useCallback(() => setStatusNonce((n) => n + 1), []);
  const prsOf = useCallback((workspaceId: string) => prs.get(workspaceId) ?? EMPTY_PRS, [prs]);
  const refreshPrs = useCallback(() => setPrNonce((n) => n + 1), []);
  const refreshTickets = useCallback(() => setTicketNonce((n) => n + 1), []);

  const navigate = useCallback((route: Route) => setStack((s) => [...s, route]), []);
  const replace = useCallback((route: Route) => setStack((s) => [...s.slice(0, -1), route]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

  const showToast = useCallback((text: string, kind: ToastKind = "info") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = ++toastId.current;
    setToast({ id, text, kind });
    toastTimer.current = setTimeout(() => {
      // Only clear if a newer toast hasn't replaced this one.
      setToast((t) => (t?.id === id ? undefined : t));
    }, 3200);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      bootError,
      config,
      patchConfig,
      workspaces,
      upsertWorkspace,
      deleteWorkspace,
      setHidden,
      statusOf,
      refreshStatuses,
      prsOf,
      prsLoaded,
      refreshPrs,
      refreshTickets,
      issues: linearConn,
      linear: linearConn,
      github: githubConn,
      githubToken,
      checkConnections: () => verify(config),
      route: stack[stack.length - 1]!,
      navigate,
      replace,
      back,
      toast,
      showToast,
    }),
    [
      ready, bootError, config, patchConfig, workspaces, upsertWorkspace, deleteWorkspace, setHidden,
      statusOf, refreshStatuses, prsOf, prsLoaded, refreshPrs, refreshTickets,
      linearConn, githubConn, githubToken, verify,
      stack, navigate, replace, back, toast, showToast,
    ],
  );

  return <Ctx.Provider value={value}><MotionContext.Provider value={Boolean(config.reducedMotion)}>{children}</MotionContext.Provider></Ctx.Provider>;
}
