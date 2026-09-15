export type AgentKind = "claude" | "codex" | "shell";

export type IssueProviderKind = "linear" | "jira";

export interface IssueTicket {
  /** Absent on legacy workspaces, which always came from Linear. */
  provider?: IssueProviderKind;
  /** Jira site origin; prevents querying another site after reconfiguration. */
  site?: string;
  id: string;
  identifier: string; // ENG-412
  title: string;
  url: string;
  branchName: string; // linear's own suggested branch, keeps GitHub<->Linear autolink working
  stateName: string;
  stateType: string;
  teamKey: string;
  assignee?: string;
}

export type LinearTicket = IssueTicket;

export interface WorkspaceRepo {
  /** Repo name, e.g. "backend-service" */
  name: string;
  /**
   * Git dir the worktree hangs off — maestro's bare clone
   * (<worktreeRoot>/.repos/<owner>/<repo>.git). Legacy entries point at the
   * project checkout they were created from; both work for removal.
   */
  repoPath: string;
  /** Absolute path to the worktree: ~/maestro/<name>/<slug> */
  worktreePath: string;
  /** True for the repo the agent session is launched from */
  isMain: boolean;
  /** GitHub owner/repo */
  owner?: string;
  repo?: string;
  /** Branch the worktree was created from, e.g. "main" */
  baseBranch?: string;
  /** Set when worktree creation failed, so the UI can surface it */
  error?: string;
}

/** A session maestro started, recorded so it can be re-focused rather than duplicated. */
export interface LaunchedSession {
  agent: AgentKind;
  /** Terminal the session was opened in */
  terminal: Exclude<TerminalKind, "auto">;
  /** Stable surface id (Ghostty terminal / iTerm session) */
  surfaceId?: string;
  /** Directory the session runs in — the main repo's worktree */
  cwd: string;
  launchedAt: string;
  /** Set when this launch resumed an existing agent session */
  resumedId?: string;
}

export interface Workspace {
  /** Root captured at creation so later settings changes do not move this workspace. */
  worktreeRoot?: string;
  id: string;
  ticket: IssueTicket;
  /** ENG-412-ticket-title-with-dashes — the worktree directory name */
  slug: string;
  /** Git branch checked out in every worktree */
  branch: string;
  repos: WorkspaceRepo[];
  createdAt: string;
  lastAgent?: AgentKind;
  session?: LaunchedSession;
  /**
   * Hidden from the default list without being deleted — the worktrees, the
   * branch and the entry all stay exactly where they are.
   */
  hidden?: boolean;
  /** When the ticket's workflow state was last re-read from its issue provider */
  ticketSyncedAt?: string;
}

/** Which workspaces the list shows. See FILTERS in views/WorkspaceList.tsx. */
export type ListFilter = "all" | "doing" | "todo" | "done" | "hidden";

/** How the list is ordered. See SORTS in views/WorkspaceList.tsx. */
export type ListSort = "recent" | "activity" | "status" | "ticket" | "title";

/** Terminals maestro can drive natively; "auto" follows $TERM_PROGRAM. */
export type TerminalKind = "auto" | "ghostty" | "iterm2" | "apple-terminal";

export interface Config {
  issueProvider?: IssueProviderKind;
  jiraUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  onboardingComplete?: boolean;
  reducedMotion?: boolean;
  repoCacheTtlMinutes?: number;
  repoOwner?: string;
  cloneConcurrency?: number;
  pollingPreset?: "responsive" | "balanced" | "quiet";
  claudeModel?: string;
  codexModel?: string;
  promptSuffix?: string;
  linearApiKey?: string;
  /** Which terminal app to open sessions in */
  terminal: TerminalKind;
  /** A new window/instance, or a tab in the existing window */
  launchTarget: "window" | "tab";
  /** "gh" borrows the token from the gh CLI; "token" uses githubToken */
  githubMode: "gh" | "token";
  githubToken?: string;
  /** Worktrees land in <worktreeRoot>/<repo>/<slug>; bare clones in <worktreeRoot>/.repos */
  worktreeRoot: string;
  defaultAgent: AgentKind;
  /** List view controls, remembered between runs */
  listFilter: ListFilter;
  listSort: ListSort;
  /** PR child rows start expanded in the workspace tree */
  listExpand: boolean;
}

export interface PullRequest {
  /** Set when the PR was fetched for the whole list rather than one workspace */
  workspaceId?: string;
  repoName: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  checks: "SUCCESS" | "FAILURE" | "PENDING" | "NONE";
  reviewDecision?: string;
  additions: number;
  deletions: number;
  updatedAt?: string;
}
