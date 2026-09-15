import * as linear from "../../services/linear.ts";
import { credentials, jiraOrigin } from "../../state/config.ts";
import type { Config, IssueTicket } from "../../state/types.ts";
import type { IssueProvider } from "./types.ts";
import { jiraProvider } from "./jira.ts";
export type * from "./types.ts";

export function linearProvider(apiKey?: string): IssueProvider {
  const key = apiKey ?? "";
  return { kind: "linear", label: "Linear", configured: Boolean(key),
    verify: () => linear.verifyKey(key), myIssues: () => linear.myIssues(key),
    searchIssues: term => linear.searchIssues(key, term), issueDetail: id => linear.issueDetail(key, id),
    issueStates: ids => linear.issueStates(key, ids), fetchTeams: () => linear.fetchTeams(key),
    createIssue: input => linear.createIssue(key, input) };
}

export function issueProvider(raw: Config, ticket?: IssueTicket): IssueProvider {
  const config = credentials(raw);
  const kind = ticket ? ticket.provider ?? "linear" : config.issueProvider ?? "linear";
  if (kind === "linear") return linearProvider(config.linearApiKey);
  if (ticket?.site && config.jiraUrl && jiraOrigin(config.jiraUrl) !== ticket.site) {
    return jiraProvider({ ...config, jiraApiToken: undefined });
  }
  return jiraProvider(config);
}

export function issueKey(ticket: IssueTicket): string {
  return `${ticket.provider ?? "linear"}:${ticket.site ?? ""}:${ticket.id}`;
}
