# Working on Maestro

Use Bun. Run `bun install --frozen-lockfile`, then `bun run check`.

- Issue content and workflow belong to Jira/Linear. Provider-neutral contracts
  live in `src/integrations/issues`. Legacy tickets without a provider are Linear.
- GitHub owns repository discovery and pull-request state. Git owns local
  worktrees. Views orchestrate neither HTTP schemas nor shell command strings.
- Keep persisted data compatible. Validate before writing; use the private,
  atomic writer. Never reset corrupt user state or recursively remove a path
  because a Git command failed.
- Launch flags are intentional product policy: Claude always uses
  `--dangerously-skip-permissions`; Codex always uses `--yolo`, including resumes.
  Shell arguments must be quoted at every shell boundary. Never log credentials.
- Repository identity includes the owner. Preserve a workspace's identity,
  main repository and session when adding repositories or retrying failures.
- UI colors belong in `src/theme.ts`. Keep the page transparent, shortcuts
  consistent, text fields typeable, and reduced-motion support functional.
- Tests using module mocks or changing HOME/config roots run in separate Bun
  processes. Use the `test:*` scripts; don't combine all suites in one process.
- Use headless OpenTUI tests for meaningful keyboard flows and filesystem
  fixtures for Git changes. Never run tests against a developer's real state.
