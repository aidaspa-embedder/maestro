import { join } from "node:path";
import { HOME, expand } from "../lib/paths.ts";
import type { Config } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  terminal: "auto", launchTarget: "window", githubMode: "gh",
  worktreeRoot: join(HOME, "maestro"), defaultAgent: "claude",
  listFilter: "all", listSort: "recent", listExpand: true,
  issueProvider: "linear", onboardingComplete: false, reducedMotion: false,
  repoCacheTtlMinutes: 15, cloneConcurrency: 3, pollingPreset: "balanced",
};

export function jiraOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Jira URL must be an HTTPS site, e.g. https://team.atlassian.net"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Use the Jira HTTPS site origin without a path, port, query or credentials");
  }
  return url.origin;
}

/** Explicit allowlist: unknown keys cannot become execution or network options. */
export function normalizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Config must be a JSON object");
  const input = raw as Record<string, unknown>;
  const out = { ...DEFAULT_CONFIG };
  const enums = {
    terminal: ["auto", "ghostty", "iterm2", "apple-terminal"], launchTarget: ["window", "tab"],
    githubMode: ["gh", "token"], defaultAgent: ["claude", "codex", "shell"],
    listFilter: ["all", "doing", "todo", "done", "hidden"], listSort: ["recent", "activity", "status", "ticket", "title"],
    issueProvider: ["linear", "jira"], pollingPreset: ["responsive", "balanced", "quiet"],
  };
  for (const [key, choices] of Object.entries(enums)) {
    if (!(key in input)) continue;
    if (typeof input[key] !== "string" || !choices.includes(input[key] as string)) throw new Error(`Invalid config setting: ${key}`);
    Object.assign(out, { [key]: input[key] });
  }
  for (const key of ["linearApiKey", "githubToken", "jiraUrl", "jiraEmail", "jiraApiToken", "repoOwner", "claudeModel", "codexModel", "promptSuffix", "worktreeRoot"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string" || /[\x00-\x08\x0b-\x1f\x7f]/.test(input[key] as string)) throw new Error(`Invalid config setting: ${key}`);
    const val = (input[key] as string).trim();
    Object.assign(out, { [key]: val || undefined });
  }
  for (const key of ["listExpand", "onboardingComplete", "reducedMotion"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw new Error(`Invalid config setting: ${key}`);
    out[key] = input[key];
  }
  for (const [key, min, max] of [["repoCacheTtlMinutes", 0, 1440], ["cloneConcurrency", 1, 8]] as const) {
    if (input[key] === undefined) continue;
    const n = input[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be ${min}–${max}`);
    out[key] = n;
  }
  if (!out.worktreeRoot) throw new Error("Worktree root cannot be empty");
  out.worktreeRoot = expand(out.worktreeRoot);
  if (out.worktreeRoot === "/" || out.worktreeRoot === HOME) throw new Error("Choose a dedicated worktree directory");
  if (out.jiraUrl) out.jiraUrl = jiraOrigin(out.jiraUrl);
  if (out.repoOwner && !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(out.repoOwner)) throw new Error("Repository owner must be a GitHub user or organization name");
  return out;
}

/** Environment secrets are resolved at use time and never copied to config.json. */
export function credentials(config: Config): Config {
  return { ...config,
    linearApiKey: process.env.LINEAR_API_KEY || config.linearApiKey,
    githubToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || config.githubToken,
    jiraUrl: process.env.JIRA_URL || config.jiraUrl,
    jiraEmail: process.env.JIRA_EMAIL || config.jiraEmail,
    jiraApiToken: process.env.JIRA_API_TOKEN || config.jiraApiToken,
  };
}

export function pollIntervals(config: Config) {
  switch (config.pollingPreset) {
    case "quiet": return { session: 10_000, prs: 300_000, issues: 300_000 };
    case "responsive": return { session: 3_000, prs: 30_000, issues: 60_000 };
    default: return { session: 3_000, prs: 90_000, issues: 120_000 };
  }
}
