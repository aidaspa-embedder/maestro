import { afterAll, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "maestro-installer-test-"));
const installer = resolve(import.meta.dir, "../install.sh");
afterAll(() => rm(root, { recursive: true, force: true }));

async function command(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

async function fixture(options: { arch?: string; version?: string; symlinkBinary?: boolean } = {}) {
  const home = await mkdtemp(join(root, "home-"));
  const tools = join(home, "tools");
  const assets = join(home, "assets");
  const staging = join(home, "staging");
  const bin = join(home, ".local/bin");
  const arch = options.arch ?? "arm64";
  const name = `maestro-v0.2.0-darwin-${arch}`;
  const archive = `${name}.tar.gz`;
  await Promise.all([mkdir(tools), mkdir(assets), mkdir(join(staging, name), { recursive: true }), mkdir(bin, { recursive: true })]);
  const binary = join(staging, name, "maestro");
  if (options.symlinkBinary) await symlink("../../outside", binary);
  else {
    await writeFile(binary, `#!/bin/sh\nprintf 'executed\\n' > "$INSTALL_TEST_EXECUTED"\nprintf '%s\\n' '${options.version ?? "0.2.0"}'\n`);
    await chmod(binary, 0o755);
  }
  const tar = await command(["tar", "-czf", join(assets, archive), "-C", staging, name]);
  expect(tar.code).toBe(0);
  const hash = createHash("sha256").update(await readFile(join(assets, archive))).digest("hex");
  await writeFile(join(assets, `${archive}.sha256`), `${hash}  ${archive}\n`);
  await writeFile(join(bin, "maestro"), "previous installation\n");
  await writeFile(join(home, ".zshrc"), "# existing profile\n");
  await writeFile(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$INSTALL_TEST_OS";; -m) printf "%s\\n" "$INSTALL_TEST_ARCH";; *) exit 1;; esac\n');
  // Downloads use local fixtures; an unexpected URL fails instead of networking.
  await writeFile(join(tools, "curl"), `#!${process.execPath}
import { appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const url = args.at(-1);
appendFileSync(process.env.INSTALL_TEST_REQUESTS, JSON.stringify({ url, args }) + "\\n");
const base = "https://github.com/" + process.env.MAESTRO_REPO;
if (url === base + "/releases/latest" && args.includes("--head")) {
  if (process.env.INSTALL_TEST_NO_RELEASE) process.exit(22);
  process.stdout.write(base + "/releases/tag/v0.2.0");
} else if (url.startsWith(base + "/releases/download/v0.2.0/")) {
  const file = url.slice(url.lastIndexOf("/") + 1);
  if (process.env.INSTALL_TEST_FAIL === file) process.exit(22);
  const out = args[args.indexOf("--output") + 1];
  try { copyFileSync(join(process.env.INSTALL_TEST_ASSETS, file), out); }
  catch { process.exit(22); }
} else process.exit(22);
`);
  await Promise.all([chmod(join(tools, "curl"), 0o755), chmod(join(tools, "uname"), 0o755)]);
  const env: Record<string, string> = {
    HOME: home, PATH: `${tools}:/usr/bin:/bin`, TMPDIR: home, LANG: "C",
    MAESTRO_REPO: "example/maestro", INSTALL_TEST_OS: "Darwin",
    INSTALL_TEST_ARCH: arch === "x64" ? "x86_64" : arch,
    INSTALL_TEST_ASSETS: assets, INSTALL_TEST_REQUESTS: join(home, "requests"),
    INSTALL_TEST_EXECUTED: join(home, "executed"),
  };
  return {
    home, assets, archive, bin, env,
    run: (overrides: Record<string, string> = {}) => command(["/bin/sh", installer], { ...env, ...overrides }),
    requests: async () => (await Bun.file(env.INSTALL_TEST_REQUESTS!).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { url: string; args: string[] }),
  };
}

test("latest release installs atomically to the default path without changing shell profiles", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`Installed: ${f.bin}/maestro`);
  expect((await stat(join(f.bin, "maestro"))).mode & 0o777).toBe(0o755);
  expect((await command([join(f.bin, "maestro"), "--version"], f.env)).stdout.trim()).toBe("0.2.0");
  expect(await Bun.file(join(f.home, ".zshrc")).text()).toBe("# existing profile\n");
  expect(await readdir(f.bin)).toEqual(["maestro"]);
  expect((await readdir(f.home)).some(name => name.startsWith("maestro-install."))).toBe(false);
  const requests = await f.requests();
  expect(requests.map(r => r.url)).toEqual([
    "https://github.com/example/maestro/releases/latest",
    `https://github.com/example/maestro/releases/download/v0.2.0/${f.archive}`,
    `https://github.com/example/maestro/releases/download/v0.2.0/${f.archive}.sha256`,
  ]);
  for (const { args } of requests) {
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(args[args.indexOf("--proto-redir") + 1]).toBe("=https");
  }
});

test("pinned Intel releases support paths with spaces and shell punctuation", async () => {
  const f = await fixture({ arch: "x64" });
  const destination = join(f.home, "bin space ' $(not-a-command)");
  const result = await f.run({ MAESTRO_VERSION: "v0.2.0", MAESTRO_BIN_DIR: destination });
  expect(result.code).toBe(0);
  expect(await Bun.file(join(destination, "maestro")).exists()).toBe(true);
  expect((await f.requests()).some(r => r.url.endsWith("/latest"))).toBe(false);
});

test("bad checksums preserve the installed binary and never execute the download", async () => {
  const f = await fixture();
  await appendFile(join(f.assets, f.archive), "corruption");
  const result = await f.run();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Checksum mismatch");
  expect(await Bun.file(join(f.bin, "maestro")).text()).toBe("previous installation\n");
  expect(await Bun.file(f.env.INSTALL_TEST_EXECUTED!).exists()).toBe(false);
});

test("missing releases and failed asset downloads leave the installed binary intact", async () => {
  for (const problem of ["release", "checksum"]) {
    const f = await fixture();
    const result = await f.run(problem === "release" ? { INSTALL_TEST_NO_RELEASE: "1" } : { INSTALL_TEST_FAIL: `${f.archive}.sha256` });
    expect(result.code).not.toBe(0);
    expect(await Bun.file(join(f.bin, "maestro")).text()).toBe("previous installation\n");
    expect(await Bun.file(f.env.INSTALL_TEST_EXECUTED!).exists()).toBe(false);
  }
});

test("a wrong version or symlink archive member cannot replace the installation", async () => {
  for (const options of [{ version: "0.0.1" }, { symlinkBinary: true }]) {
    const f = await fixture(options);
    const result = await f.run();
    expect(result.code).not.toBe(0);
    expect(await Bun.file(join(f.bin, "maestro")).text()).toBe("previous installation\n");
    expect(await Bun.file(join(f.home, "outside")).exists()).toBe(false);
  }
});

test("unsupported platforms and unsafe arguments fail before making download requests", async () => {
  const cases: Array<Record<string, string>> = [
    { INSTALL_TEST_OS: "Linux" }, { MAESTRO_VERSION: "../../bad" },
    { MAESTRO_REPO: "example/maestro/../../bad" }, { MAESTRO_BIN_DIR: "relative/path" },
  ];
  for (const overrides of cases) {
    const f = await fixture();
    const result = await f.run({ MAESTRO_VERSION: "v0.2.0", ...overrides });
    expect(result.code).not.toBe(0);
    expect(await Bun.file(f.env.INSTALL_TEST_REQUESTS!).exists()).toBe(false);
  }
});
