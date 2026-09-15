import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Only the interactive app takes a lock; help/doctor/build remain read-only. */
export async function acquireInstanceLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "instance.lock");
  const owner = join(lock, "pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(owner, String(process.pid), { mode: 0o600, flag: "wx" });
      return async () => {
        if (await readFile(owner, "utf8").catch(() => "") === String(process.pid)) await rm(lock, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(await readFile(owner, "utf8").catch(() => ""));
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      } else alive = Date.now() - (await stat(lock)).mtimeMs < 10_000;
      if (alive) throw new Error("Maestro is already running with this config directory. Close it before opening another instance.");
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw new Error("Could not acquire the Maestro state lock");
}
