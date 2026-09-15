import type { Config } from "./types.ts";
export type SettingsSection = "issues" | "github" | "workspace" | "performance";
export interface SettingsField {
  id: keyof Config; label: string; help: string; kind: "text" | "secret" | "cycle";
  options?: Array<string | number | boolean>;
}
export function settingsFields(config: Config, section?: SettingsSection): SettingsField[] {
  const issues: SettingsField[] = [
    { id: "issueProvider", label: "Issue source", kind: "cycle", options: ["linear", "jira"], help: "Your issue tracker owns ticket content and workflow state." },
    ...(config.issueProvider === "jira" ? [
      { id: "jiraUrl" as const, label: "Jira site", kind: "text" as const, help: "Jira Cloud HTTPS origin, e.g. https://team.atlassian.net (or JIRA_URL)." },
      { id: "jiraEmail" as const, label: "Jira email", kind: "text" as const, help: "Atlassian account email (or JIRA_EMAIL)." },
      { id: "jiraApiToken" as const, label: "Jira API token", kind: "secret" as const, help: "Unscoped API token from id.atlassian.com/manage-profile/security/api-tokens; or JIRA_API_TOKEN." },
    ] : [{ id: "linearApiKey", label: "Linear API key", kind: "secret" as const, help: "Linear Settings → Security & access → Personal API keys; or LINEAR_API_KEY." } as SettingsField]),
  ];
  const github: SettingsField[] = [
    { id: "githubMode", label: "GitHub auth", kind: "cycle", options: ["gh", "token"], help: "gh uses GitHub CLI authentication. Run gh auth login --hostname github.com." },
    ...(config.githubMode === "token" ? [{ id: "githubToken", label: "GitHub token", kind: "secret" as const, help: "Repository read token, or GH_TOKEN/GITHUB_TOKEN. Stored privately; never put in Git URLs." } as SettingsField] : []),
    { id: "repoOwner", label: "Repository owner", kind: "text", help: "Optional GitHub user/organization filter. Leave blank to show all accessible repositories." },
  ];
  const workspace: SettingsField[] = [
    { id: "worktreeRoot", label: "Worktree root", kind: "text", help: "New worktrees: <root>/<owner>/<repo>/<ticket>. Existing workspace paths stay valid." },
    { id: "defaultAgent", label: "Default agent", kind: "cycle", options: ["claude", "codex", "shell"], help: "Claude: --dangerously-skip-permissions. Codex: --yolo. Agents run without permission prompts." },
    { id: "terminal", label: "Terminal", kind: "cycle", options: ["auto", "ghostty", "iterm2", "apple-terminal"], help: "macOS: auto follows TERM_PROGRAM; Ghostty, iTerm2 or Terminal.app." },
    { id: "launchTarget", label: "Launch into", kind: "cycle", options: ["window", "tab"], help: "New window or tab. Terminal.app always opens a window." },
    { id: "claudeModel", label: "Claude model", kind: "text", help: "Optional CLI model name. Blank uses Claude's own configuration." },
    { id: "codexModel", label: "Codex model", kind: "text", help: "Optional CLI model name. Blank uses Codex's own configuration." },
    { id: "promptSuffix", label: "Handoff instructions", kind: "text", help: "Optional instructions appended to the worktree map for new sessions." },
  ];
  const performance: SettingsField[] = [
    { id: "repoCacheTtlMinutes", label: "Repo cache (minutes)", kind: "cycle", options: [0, 5, 15, 60, 240], help: "0 disables caching. Ctrl+R in a repo picker forces refresh. C here clears the saved cache." },
    { id: "cloneConcurrency", label: "Concurrent Git jobs", kind: "cycle", options: [1, 2, 3, 4, 8], help: "Maximum simultaneous clone/worktree jobs. Lower this for slower disks or networks." },
    { id: "pollingPreset", label: "Refresh pace", kind: "cycle", options: ["responsive", "balanced", "quiet"], help: "Quiet checks sessions every 10s and remote state every 5m; balanced uses 3s / 90s / 2m." },
    { id: "reducedMotion", label: "Reduced motion", kind: "cycle", options: [false, true], help: "Static intro and spinners; also available via maestro --no-intro or MAESTRO_REDUCED_MOTION=1." },
  ];
  return section ? { issues, github, workspace, performance }[section] : [...issues, ...github, ...workspace, ...performance];
}
