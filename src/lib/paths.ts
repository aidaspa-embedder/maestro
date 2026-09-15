import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Prefer $HOME over the passwd entry: Bun's os.homedir() reads passwd directly,
 * which ignores a caller-set $HOME (and breaks tests + sandboxed runs).
 */
export const HOME = process.env.HOME || homedir();

/** MAESTRO_CONFIG_DIR > XDG_CONFIG_HOME > ~/.config */
export const CONFIG_DIR =
  process.env.MAESTRO_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "maestro");

export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const WORKSPACES_FILE = join(CONFIG_DIR, "workspaces.json");

/** Expand a leading ~ and make the path absolute. */
export function expand(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return resolve(p);
}

/** Inverse of expand — shortens $HOME to ~ for display. */
export function contract(p: string): string {
  return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
