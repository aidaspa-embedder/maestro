import { isAbsolute } from "node:path";
import { CONFIG_FILE, WORKSPACES_FILE } from "../lib/paths.ts";
import { readJson, writePrivateJson } from "../lib/files.ts";
import { normalizeConfig } from "./config.ts";
import type { Config, Workspace } from "./types.ts";
export { DEFAULT_CONFIG } from "./config.ts";

export async function loadConfig(): Promise<Config> {
  return normalizeConfig(await readJson(CONFIG_FILE, {}));
}
export async function saveConfig(config: Config): Promise<void> {
  await writePrivateJson(CONFIG_FILE, normalizeConfig(config));
}
export function validateWorkspaces(raw: unknown): Workspace[] {
  if (!Array.isArray(raw)) throw new Error("workspaces.json must contain an array. Original file preserved.");
  const ids = new Set<string>();
  for (const ws of raw) {
    if (!ws || typeof ws.id !== "string" || ids.has(ws.id) || typeof ws.slug !== "string" ||
        typeof ws.branch !== "string" || typeof ws.createdAt !== "string" || !ws.ticket ||
        !["id", "identifier", "title", "url", "stateName", "stateType"].every(k => typeof ws.ticket[k] === "string") ||
        (ws.ticket.provider !== undefined && !["linear", "jira"].includes(ws.ticket.provider)) ||
        !Array.isArray(ws.repos) || !ws.repos.every((r: Workspace["repos"][number]) => r &&
          typeof r.name === "string" && typeof r.repoPath === "string" && isAbsolute(r.repoPath) &&
          typeof r.worktreePath === "string" && isAbsolute(r.worktreePath) && typeof r.isMain === "boolean")) {
      throw new Error("Invalid workspace record. Original file preserved; restore workspaces.json from a backup.");
    }
    ids.add(ws.id);
  }
  return raw as Workspace[];
}
export async function loadWorkspaces(): Promise<Workspace[]> {
  return validateWorkspaces(await readJson(WORKSPACES_FILE, []));
}
export async function saveWorkspaces(workspaces: Workspace[]): Promise<void> {
  await writePrivateJson(WORKSPACES_FILE, validateWorkspaces(workspaces));
}
