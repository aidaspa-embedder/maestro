import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const writes = new Map<string, Promise<void>>();

/** Serialize writes per file; create private files, flush, then atomically rename. */
export function writePrivateJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + "\n";
  const next = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(tmp, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(tmp, path);
    } finally { await rm(tmp, { force: true }); }
  });
  writes.set(path, next);
  void next.finally(() => { if (writes.get(path) === next) writes.delete(path); }).catch(() => {});
  return next;
}

/** Corrupt/unreadable state must never be silently overwritten. */
export async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try { return JSON.parse(await Bun.file(path).text()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${path}. Restore or move this file, then restart. Original file preserved.`);
  }
}
