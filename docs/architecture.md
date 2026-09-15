# Architecture

## Sources of truth

```text
Linear / Jira ── IssueProvider ─┐
                              ├── workspace application state ── terminal views
GitHub ── repos + PR service ──┘               │
                                             ├── Git worktrees
                                             └── Claude / Codex / shell
```

The issue provider owns identifiers, descriptions, assignees and workflow state.
GitHub owns accessible repositories, default branches, pull requests, reviews and
checks. Local JSON records the workspace's issue reference, worktree locations,
branch, terminal session and last known remote state. It is a recoverable local
snapshot, not another issue tracker. Creating a workspace does not change an
issue's workflow or push branches.

`src/integrations/issues/types.ts` is the shared issue contract. The Linear
adapter wraps `src/services/linear.ts`; Jira Cloud uses REST v3, enhanced JQL
search and Atlassian Document Format conversion. Tickets carry their provider
and Jira site. Legacy records without a provider remain Linear; switching the
selected provider affects new workspaces, while existing workspaces continue to
refresh through their original integration. Configure the original Jira site to
read workspaces from that site; multiple simultaneous Jira sites are not supported.

## Modules

| Location | Responsibility |
| --- | --- |
| `src/state/config.ts` | Defaults, validation, environment credential resolution, polling profiles |
| `src/state/store.ts`, `src/lib/files.ts` | Schema checks and private atomic persistence |
| `src/state/app-context.tsx` | Navigation, state updates, connection checks and background refresh |
| `src/services/github.ts` | GitHub API and paginated discovery/PR batching |
| `src/services/repository-cache.ts` | Credential-scoped disk cache and shared refresh requests |
| `src/services/git.ts` | Validated clone/worktree lifecycle and ephemeral Git authentication |
| `src/services/workspaces.ts` | Bounded provisioning, retry plans and non-destructive repo merging |
| `src/services/launcher.ts` | Terminal adapters, argument escaping and mandatory launch flags |
| `src/services/session.ts`, `status.ts` | Existing session discovery and activity |
| `src/views/Onboarding.tsx` | First-run workflow and integration verification |
| `src/components/ConfigEditor.tsx` | Shared, scrollable settings editor with masked secrets |
| `src/components/Motion.tsx` | Shared animation clock and reduced-motion behavior |

## Performance and recovery

Repository discovery paginates up to 10,000 records; exceeding that limit fails
explicitly instead of silently caching an incomplete result. Fresh cache reads
skip HTTP. Concurrent requests share a promise, force refresh bypasses the TTL,
and temporary failures can use stale data. Authentication failures do not fall
back to stale cache. Branch selection fetches the most recent 100 branches.

Git provisioning uses a configurable worker pool (default 3), persists a manifest
before work starts, then checkpoints each completed repository. Failed/pending
entries can be selected again through **add repositories**. New paths include
owner/repo, while existing paths remain unchanged. A stored base branch is used
when offline; a missing base fails explicitly instead of silently using HEAD.

PR refresh keys include repository identities, so adding repositories immediately
refreshes their PRs. Poll loops do not overlap and unrelated ticket updates do not
restart session polls. One shared clock drives visible spinners and stops when
none remain. `useAsync` invalidates stale results on dependency change/unmount.

## External API references

- [GitHub GraphQL reference](https://docs.github.com/en/graphql/reference)
- [Linear GraphQL API](https://linear.app/developers/graphql)
- [Jira enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Claude CLI flags](https://code.claude.com/docs/en/cli-reference)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
