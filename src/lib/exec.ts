export interface ExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command and capture output. Never throws on a non-zero exit — callers
 * branch on `ok`, which keeps error handling uniform across the service layer.
 */
export async function exec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = opts.timeoutMs
      ? setTimeout(() => proc.kill(), opts.timeoutMs)
      : undefined;

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timeout) clearTimeout(timeout);

    return { ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** Fire-and-forget; used for `open <url>` where we don't care about output. */
export function execDetached(cmd: string[]): void {
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // best effort
  }
}
