#!/usr/bin/env bun
import { mkdir, copyFile, cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { version } from "../package.json";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const name = `maestro-v${version}-${process.platform}-${process.arch}`;
const staging = join(dist, name);
await mkdir(staging, { recursive: true });
try {
  const build = await Bun.$`bun run build`.cwd(root).quiet().nothrow();
  if (build.exitCode !== 0) throw new Error(build.stderr.toString() || "Build failed");
  const binary = join(dist, "maestro");
  const smoke = await Bun.$`${binary} --version`.quiet().nothrow();
  if (smoke.exitCode !== 0 || smoke.stdout.toString().trim() !== version) throw new Error("Compiled binary failed version smoke test");
  for (const file of ["README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", "install.sh"]) await copyFile(join(root, file), join(staging, file));
  await cp(join(root, "docs"), join(staging, "docs"), { recursive: true });
  await copyFile(binary, join(staging, "maestro"));
  // Retain dependency notices in binary distributions, including nested dependencies.
  const notices: string[] = ["Third-party dependency notices\nBun runtime: https://github.com/oven-sh/bun/blob/main/LICENSE.md\n"];
  async function collect(directory: string, depth: number) {
    if (depth > 5) return;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory() && !["test", "tests", "docs", "examples", ".bin"].includes(item.name)) await collect(path, depth + 1);
      else if (item.isFile() && /^licen[cs]e(?:\.(?:md|txt))?$/i.test(item.name)) notices.push(`\n--- ${path.slice(root.length + 1)} ---\n${await Bun.file(path).text()}`);
    }
  }
  await collect(join(root, "node_modules"), 0);
  await Bun.write(join(staging, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
  const archive = `${name}.tar.gz`;
  const packed = await Bun.$`tar -czf ${join(dist, archive)} -C ${dist} ${name}`.quiet().nothrow();
  if (packed.exitCode !== 0) throw new Error("Archive creation failed");
  const hash = createHash("sha256").update(new Uint8Array(await Bun.file(join(dist, archive)).arrayBuffer())).digest("hex");
  await Bun.write(join(dist, `${archive}.sha256`), `${hash}  ${archive}\n`);
  console.log(`Created dist/${archive} and SHA-256 checksum`);
} finally { await rm(staging, { recursive: true, force: true }); }
