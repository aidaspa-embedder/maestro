import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { CONFIG_DIR } from "../lib/paths.ts";
import { writePrivateJson } from "../lib/files.ts";
import type { GitHubRepo } from "./github.ts";

const directory = join(CONFIG_DIR, "cache");
interface Entry { version: 1; savedAt: number; repos: GitHubRepo[] }
export interface RepoCacheOptions {
  ttlMinutes?: number;
  force?: boolean;
  onStatus?: (status: "cached" | "live" | "offline") => void;
}
const memory = new Map<string, Entry>();
const pending = new Map<string, Promise<GitHubRepo[]>>();
let generation = 0;
export const repoCacheKey = (token: string) => createHash("sha256").update(`github.com\0${token}`).digest("hex");
const file = (key: string) => join(directory, `repos-${key}.json`);
function valid(raw: unknown): raw is Entry {
  const e = raw as Entry;
  return Boolean(e && e.version === 1 && Number.isFinite(e.savedAt) && e.savedAt <= Date.now() &&
    Array.isArray(e.repos) && e.repos.every(r => r && [r.owner, r.name, r.nameWithOwner, r.defaultBranch].every(v => typeof v === "string") &&
      (r.startingBranch === undefined || typeof r.startingBranch === "string") && typeof r.isPrivate === "boolean"));
}

/** Credential-scoped cache, single flight refresh, bounded offline fallback. */
export async function cachedRepos(token: string, fetcher: () => Promise<GitHubRepo[]>, options: RepoCacheOptions = {}): Promise<GitHubRepo[]> {
  const key = repoCacheKey(token);
  const ttl = (options.ttlMinutes ?? 15) * 60_000;
  let entry = memory.get(key);
  if (!entry && ttl > 0) {
    try { const raw: unknown = await Bun.file(file(key)).json(); if (valid(raw)) { entry = raw; memory.set(key, raw); } } catch { /* disposable cache */ }
  }
  if (ttl > 0 && entry && !options.force && Date.now() - entry.savedAt < ttl) {
    options.onStatus?.("cached"); return entry.repos;
  }
  let job = pending.get(key);
  if (!job) {
    const epoch = generation;
    job = (async () => {
      const repos = await fetcher();
      const next: Entry = { version: 1, savedAt: Date.now(), repos };
      if (generation === epoch && ttl > 0) {
        memory.set(key, next);
        if (memory.size > 8) memory.delete(memory.keys().next().value!);
        await writePrivateJson(file(key), next).catch(() => {});
      }
      return repos;
    })();
    pending.set(key, job);
    void job.finally(() => { if (pending.get(key) === job) pending.delete(key); }).catch(() => {});
  }
  try { const repos = await job; options.onStatus?.("live"); return repos; }
  catch (error) {
    // Revoked credentials must not silently display cached private repositories.
    const authError = /rejected|401|403|credential|token/i.test(error instanceof Error ? error.message : String(error));
    if (authError) { memory.delete(key); await rm(file(key), { force: true }).catch(() => {}); }
    if (entry && ttl > 0 && !authError && Date.now() - entry.savedAt < 7 * 86400_000) {
      options.onStatus?.("offline"); return entry.repos;
    }
    throw error;
  }
}

export async function clearRepositoryCache(): Promise<void> {
  generation++;
  memory.clear();
  await Promise.allSettled([...pending.values()]);
  pending.clear();
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) if (/^repos-[a-f0-9]{64}\.json$/.test(name)) await rm(join(directory, name), { force: true });
}
