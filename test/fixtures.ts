import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Workspace } from "../src/state/types.ts";

export const TICKETS = [
  { id: "1", identifier: "ENG-412", title: "Fix billing webhook retries dropping events", state: "In Progress", type: "started" },
  { id: "2", identifier: "ENG-455", title: "Admin: bulk re-index embeddings", state: "Todo", type: "unstarted" },
  { id: "3", identifier: "ENG-390", title: "Rate limit the public search endpoint", state: "In Review", type: "started" },
];

export function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  const slug = "ENG-412-fix-billing-webhook-retries-dropping";
  return {
    id: "ENG-412-abc123",
    ticket: {
      id: "1",
      identifier: "ENG-412",
      title: "Fix billing webhook retries dropping events",
      url: "https://linear.app/example/issue/ENG-412",
      branchName: "dev/eng-412-fix-billing-webhook-retries",
      stateName: "In Progress",
      stateType: "started",
      teamKey: "ENG",
      assignee: "Aidas",
    },
    slug,
    branch: "dev/eng-412-fix-billing-webhook-retries",
    repos: [
      {
        name: "backend-service",
        repoPath: "/Users/example/maestro/.repos/example/backend-service.git",
        worktreePath: `/Users/example/maestro/backend-service/${slug}`,
        isMain: true,
        owner: "example",
        repo: "backend-service",
        baseBranch: "main",
      },
      {
        name: "admin-frontend",
        repoPath: "/Users/example/maestro/.repos/example/admin-frontend.git",
        worktreePath: `/Users/example/maestro/admin-frontend/${slug}`,
        isMain: false,
        owner: "example",
        repo: "admin-frontend",
        baseBranch: "main",
      },
    ],
    // Newest of the fixture set: the list's default sort is newest-first, so
    // this is the one that lands under the cursor on mount.
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  };
}

/** The two-workspace fixture set shared by the preview and the TUI tests. */
export function fixtureWorkspaces(): Workspace[] {
  const slug = "ENG-455-admin-bulk-re-index-embeddings";
  return [
    makeWorkspace(),
    makeWorkspace({
      id: "ENG-455-def",
      slug,
      branch: "dev/eng-455-admin-bulk-re-index-embeddings",
      createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
      ticket: {
        id: "2",
        identifier: "ENG-455",
        title: "Admin: bulk re-index embeddings",
        url: "https://linear.app/example/issue/ENG-455",
        branchName: "dev/eng-455-admin-bulk-re-index-embeddings",
        stateName: "Todo",
        stateType: "unstarted",
        teamKey: "ENG",
      },
      repos: [
        {
          name: "admin-frontend",
          repoPath: "/Users/example/maestro/.repos/example/admin-frontend.git",
          worktreePath: `/Users/example/maestro/admin-frontend/${slug}`,
          isMain: true,
          owner: "example",
          repo: "admin-frontend",
          baseBranch: "main",
        },
      ],
    }),
  ];
}

/** Rewrites workspaces.json in an already-seeded home. */
export async function writeWorkspaces(home: string, workspaces: Workspace[]): Promise<void> {
  await writeFile(
    join(home, ".config", "maestro", "workspaces.json"),
    JSON.stringify(workspaces, null, 2),
  );
}

/**
 * Points HOME at a throwaway dir seeded with config + workspaces, so the app
 * boots against fixtures instead of the developer's real state.
 */
export async function seedHome(opts: { config?: Partial<Config>; workspaces?: Workspace[] } = {}) {
  const home = await mkdtemp(join(tmpdir(), "maestro-test-"));
  const configDir = join(home, ".config", "maestro");
  await mkdir(configDir, { recursive: true });

  const config: Config = {
    terminal: "ghostty",
    launchTarget: "window",
    githubMode: "gh",
    worktreeRoot: join(home, "maestro"),
    defaultAgent: "claude",
    listFilter: "all",
    listSort: "recent",
    listExpand: true,
    ...opts.config,
  };
  await writeFile(join(configDir, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(configDir, "workspaces.json"), JSON.stringify(opts.workspaces ?? [], null, 2));

  process.env.HOME = home;
  process.env.MAESTRO_CONFIG_DIR = configDir;
  return home;
}
