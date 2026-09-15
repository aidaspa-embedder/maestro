import type { IssueTicket, IssueProviderKind } from "../../state/types.ts";

export interface Team {
  id: string;
  key: string; // ENG
  name: string;
}

export interface TicketNode {
  ticket: IssueTicket;
  children: TicketNode[];
}

export interface SubIssue {
  id: string;
  identifier: string;
  title: string;
  stateName: string;
  stateType: string;
  assignee?: string;
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDetail {
  description: string;
  priority: number;
  estimate?: number;
  labels: string[];
  project?: string;
  cycle?: string;
  parent?: { identifier: string; title: string };
  children: SubIssue[];
  comments: IssueComment[];
  /** Live state at fetch time — the stored ticket can be months stale. */
  stateName: string;
  stateType: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketState {
  id: string;
  title: string;
  stateName: string;
  stateType: string;
  assignee?: string;
}

export interface CreateIssueInput { teamId: string; title: string; description?: string; assigneeId?: string }

/** Issue systems own ticket identity, content and workflow. GitHub owns Git/PR state. */
export interface IssueProvider {
  kind: IssueProviderKind;
  label: string;
  configured: boolean;
  verify(): Promise<{ name: string }>;
  myIssues(): Promise<TicketNode[]>;
  searchIssues(term: string): Promise<TicketNode[]>;
  issueDetail(id: string): Promise<IssueDetail>;
  issueStates(ids: string[]): Promise<Map<string, TicketState>>;
  fetchTeams(): Promise<{ viewerId: string; teams: Team[] }>;
  createIssue(input: CreateIssueInput): Promise<IssueTicket>;
}
