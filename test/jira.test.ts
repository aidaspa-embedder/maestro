import { expect, test } from "bun:test";
import { jiraProvider, adfText } from "../src/integrations/issues/jira.ts";
import { issueProvider, issueKey } from "../src/integrations/issues/index.ts";
import { DEFAULT_CONFIG } from "../src/state/config.ts";
import { makeWorkspace } from "./fixtures.ts";
const config = { ...DEFAULT_CONFIG, issueProvider: "jira" as const, jiraUrl: "https://example.atlassian.net", jiraEmail: "test@example.com", jiraApiToken: "fixture-token" };
const raw = { id: "100", key: "ENG-1", fields: { summary: "A Jira issue", status: { name: "Doing", statusCategory: { key: "indeterminate" } }, project: { key: "ENG", name: "Engineering" }, assignee: { displayName: "Test" }, subtasks: [{ id: "101", key: "ENG-2", fields: { summary: "Child", status: { name: "Done", statusCategory: { key: "done" } } } }] } };

test("Jira authenticates over HTTPS and maps search, nested issues and live state", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toStartWith("https://example.atlassian.net/rest/api/3/");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("test@example.com:fixture-token").toString("base64")}`);
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith("myself")) return Response.json({ displayName: "Test" });
    return Response.json({ issues: [raw], isLast: true });
  }) as typeof fetch;
  try {
    const p = jiraProvider(config);
    expect(await p.verify()).toEqual({ name: "Test" });
    const issues = await p.myIssues();
    expect(issues[0]?.ticket.provider).toBe("jira");
    expect(issues[0]?.ticket.stateType).toBe("started");
    expect(issues[0]?.children[0]?.ticket.stateType).toBe("completed");
    expect(calls[1]?.body?.jql).toContain("currentUser()");
    await p.searchIssues('hello" OR project = SECRET');
    expect(calls[2]?.body?.jql).toStartWith("text ~ ");
    await p.searchIssues("ENG-1");
    expect(calls[3]?.body?.jql).toBe('key = "ENG-1" ORDER BY updated DESC');
    expect((await p.issueStates(["ENG-1"])).get("ENG-1")?.title).toBe("A Jira issue");
  } finally { globalThis.fetch = original; }
});

test("existing Linear workspaces keep their provider after switching; Jira sites cannot cross", () => {
  const ticket = makeWorkspace().ticket;
  expect(issueProvider(config, ticket).kind).toBe("linear");
  expect(issueProvider(config).kind).toBe("jira");
  expect(issueKey(ticket)).not.toBe(issueKey({ ...ticket, provider: "jira" }));
  expect(issueProvider(config, { ...ticket, provider: "jira", site: "https://other.atlassian.net" }).configured).toBe(false);
});

test("ADF descriptions, lists and code render as plain text/Markdown", () => {
  expect(adfText({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] }, { type: "paragraph", content: [{ type: "text", text: "Body" }] }] })).toBe("## Title\n\nBody\n");
  expect(adfText(null)).toBe("");
});

test("Jira creation returns successful identity without a failing follow-up read", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url));
    if (String(url).endsWith("issuetypes")) return Response.json({ issueTypes: [{ id: "1", name: "Task", subtask: false }] });
    const body = JSON.parse(String(init?.body));
    expect(body.fields.description.type).toBe("doc");
    expect(body.fields.project.id).toBe("ENG");
    return Response.json({ id: "100", key: "ENG-1" }, { status: 201 });
  }) as typeof fetch;
  try {
    const t = await jiraProvider(config).createIssue({ teamId: "ENG", title: "A Jira issue", description: "Details" });
    expect(t.identifier).toBe("ENG-1"); expect(t.branchName).toStartWith("eng-1-"); expect(requests).toHaveLength(2);
  } finally { globalThis.fetch = original; }
});
