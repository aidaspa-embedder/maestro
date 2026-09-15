import { detectTools } from "./setup.ts";
import { loadConfig, loadWorkspaces } from "../state/store.ts";
import { issueProvider } from "../integrations/issues/index.ts";
import { resolveToken, verifyToken } from "./github.ts";

/** Diagnostic output deliberately excludes credentials, environment values and transcripts. */
export async function doctor(checkConnections = false): Promise<number> {
  const config = await loadConfig();
  const workspaces = await loadWorkspaces();
  const tools = await detectTools();
  console.log(`maestro doctor · ${process.platform}/${process.arch}`);
  console.log(`State: readable · ${workspaces.length} workspace(s)`);
  for (const tool of tools) console.log(`${tool.path ? "ok" : "missing"} ${tool.name}${tool.version ? ` · ${tool.version}` : ""}`);
  console.log(`Issue source: ${issueProvider(config).label}`);
  console.log(`Git source: GitHub · ${config.githubMode} auth`);
  console.log("Agent permissions: Claude bypass / Codex --yolo (always)");
  if (process.platform !== "darwin") console.log("Native terminal launching currently requires macOS.");
  let failed = tools.some(t => t.name === "git" && !t.path);
  if (checkConnections) {
    const checks = await Promise.allSettled([issueProvider(config).verify(), resolveToken(config).then(verifyToken)]);
    for (const [i, result] of checks.entries()) {
      console.log(`${i === 0 ? "Issues" : "GitHub"}: ${result.status === "fulfilled" ? "connected" : "failed; check credentials and network"}`);
      if (result.status === "rejected") failed = true;
    }
  }
  return failed ? 1 : 0;
}
