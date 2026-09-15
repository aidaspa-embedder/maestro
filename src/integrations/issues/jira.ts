import type { Config, IssueTicket } from "../../state/types.ts";
import { jiraOrigin } from "../../state/config.ts";
import { workspaceSlug } from "../../lib/slug.ts";
import type { IssueProvider, IssueDetail, TicketNode, TicketState } from "./types.ts";

type Adf = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Adf[] };
/** Atlassian Document Format -> readable text/Markdown; never evaluates embedded HTML. */
export function adfText(node: Adf | string | null | undefined): string {
  if (typeof node === "string") return node;
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return String(node.attrs?.text ?? "");
  const children = (node.content ?? []).map(adfText).join("");
  if (node.type === "listItem") return `- ${children.trim()}\n`;
  if (node.type === "heading") return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${children}\n\n`;
  if (node.type === "codeBlock") return `\n\`\`\`\n${children}\n\`\`\`\n`;
  if (["paragraph", "blockquote", "bulletList", "orderedList"].includes(node.type ?? "")) return children + "\n";
  return children;
}

interface RawIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: Adf | string | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { key?: string; name?: string };
    assignee?: { displayName?: string } | null;
    priority?: { name?: string };
    labels?: string[];
    parent?: RawIssue;
    subtasks?: RawIssue[];
    comment?: { comments?: Array<{ id: string; author?: { displayName?: string }; body?: Adf; created?: string }> };
    created?: string;
    updated?: string;
  };
}
const FIELDS = ["summary", "status", "project", "assignee", "subtasks"];
export function jqlString(value: string): string { return JSON.stringify(value); }

export function jiraProvider(config: Config): IssueProvider {
  const configured = Boolean(config.jiraUrl && config.jiraEmail && config.jiraApiToken);
  const origin = () => jiraOrigin(config.jiraUrl ?? "");
  async function request<T>(path: string, body?: unknown): Promise<T> {
    if (!configured) throw new Error("Add Jira site URL, email and API token in settings");
    let res: Response;
    try {
      res = await fetch(`${origin()}/rest/api/3/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString("base64")}` },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error("Cannot reach Jira (HTTPS request timed out, redirected or failed)"); }
    if (res.status === 401 || res.status === 403) throw new Error("Jira rejected the credentials or access to this project");
    if (res.status === 429) throw new Error("Jira rate limit reached; try again shortly");
    if (!res.ok) throw new Error(`Jira returned HTTP ${res.status}${res.status === 400 ? ". Check project permissions and required fields in Jira." : ""}`);
    return await res.json() as T;
  }
  function ticket(raw: RawIssue): IssueTicket {
    const f = raw.fields;
    const category = f.status?.statusCategory?.key;
    return {
      provider: "jira", site: origin(), id: raw.key, identifier: raw.key,
      title: f.summary ?? raw.key, url: `${origin()}/browse/${encodeURIComponent(raw.key)}`,
      branchName: workspaceSlug(raw.key, f.summary ?? raw.key).toLowerCase(),
      stateName: f.status?.name ?? "", stateType: category === "done" ? "completed" : category === "indeterminate" ? "started" : "unstarted",
      teamKey: f.project?.key ?? raw.key.split("-")[0] ?? "", assignee: f.assignee?.displayName,
    };
  }
  function node(raw: RawIssue): TicketNode {
    return { ticket: ticket(raw), children: (raw.fields.subtasks ?? []).map(s => ({ ticket: ticket(s), children: [] })) };
  }
  async function search(jql: string, limit = 50): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    const seen = new Set<string>();
    do {
      const data = await request<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>("search/jql", {
        jql, fields: FIELDS, maxResults: Math.min(100, limit - out.length), ...(nextPageToken ? { nextPageToken } : {}),
      });
      out.push(...data.issues);
      nextPageToken = data.isLast ? undefined : data.nextPageToken;
      if (nextPageToken && seen.has(nextPageToken)) break;
      if (nextPageToken) seen.add(nextPageToken);
    } while (nextPageToken && out.length < limit);
    return out;
  }
  const tree = (raw: RawIssue[]) => {
    const nodes = raw.map(node);
    const nested = new Set(nodes.flatMap(n => n.children.map(c => c.ticket.id)));
    return nodes.filter(n => !nested.has(n.ticket.id));
  };
  return {
    kind: "jira", label: "Jira", configured,
    async verify() {
      const v = await request<{ displayName: string }>("myself");
      return { name: v.displayName };
    },
    async myIssues() { return tree(await search("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC")); },
    async searchIssues(term) {
      // Quote JQL separately from Lucene's query syntax so search remains literal.
      const escaped = term.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, "\\$&");
      const predicate = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(term) ? `key = ${jqlString(term)}` : `text ~ ${jqlString(`"${escaped}"`)}`;
      return tree(await search(`${predicate} ORDER BY updated DESC`));
    },
    async issueDetail(id): Promise<IssueDetail> {
      const raw = await request<RawIssue>(`issue/${encodeURIComponent(id)}?fields=summary,status,description,priority,labels,project,parent,subtasks,comment,created,updated`);
      const f = raw.fields, t = ticket(raw);
      const priority = ({ highest: 1, high: 2, medium: 3, low: 4, lowest: 4 } as Record<string, number>)[f.priority?.name?.toLowerCase() ?? ""] ?? 0;
      return { description: adfText(f.description).trim(), priority, labels: f.labels ?? [], project: f.project?.name,
        parent: f.parent ? { identifier: f.parent.key, title: f.parent.fields.summary ?? f.parent.key } : undefined,
        children: (f.subtasks ?? []).map(s => ticket(s)),
        comments: (f.comment?.comments ?? []).map(c => ({ id: c.id, author: c.author?.displayName ?? "Jira", body: adfText(c.body).trim(), createdAt: c.created ?? "" })),
        stateName: t.stateName, stateType: t.stateType, createdAt: f.created ?? "", updatedAt: f.updated ?? "" };
    },
    async issueStates(ids) {
      const out = new Map<string, TicketState>();
      const unique = [...new Set(ids)].filter(Boolean);
      for (let i = 0; i < unique.length; i += 50) {
        const raw = await search(`key in (${unique.slice(i, i + 50).map(jqlString).join(",")})`, 50);
        for (const r of raw) { const t = ticket(r); out.set(t.id, t); }
      }
      return out;
    },
    async fetchTeams() {
      const viewer = await request<{ accountId: string }>("myself");
      const teams: Array<{ id: string; key: string; name: string }> = [];
      for (let startAt = 0; ; startAt += 50) {
        const page = await request<{ values: typeof teams; isLast: boolean }>(`project/search?maxResults=50&startAt=${startAt}&action=create`);
        teams.push(...page.values);
        if (page.isLast || page.values.length === 0) break;
      }
      return { viewerId: viewer.accountId, teams };
    },
    async createIssue(input) {
      const meta = await request<{ issueTypes: Array<{ id: string; name: string; subtask: boolean }> }>(`issue/createmeta/${encodeURIComponent(input.teamId)}/issuetypes`);
      const type = meta.issueTypes.find(t => !t.subtask && t.name.toLowerCase() === "task") ?? meta.issueTypes.find(t => !t.subtask);
      if (!type) throw new Error("No creatable Jira issue type in this project");
      const fields = { project: { id: input.teamId }, issuetype: { id: type.id }, summary: input.title,
        ...(input.assigneeId ? { assignee: { accountId: input.assigneeId } } : {}),
        ...(input.description ? { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: input.description }] }] } } : {}) };
      const created = await request<{ id: string; key: string }>("issue", { fields });
      // Creation already succeeded. Never make a follow-up fetch a reason to retry the mutation.
      return ticket({ ...created, fields: { summary: input.title } });
    },
  };
}
