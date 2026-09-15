# Maestro

**One issue. Multiple repositories. One workspace.**

A terminal workspace manager for GitHub, Linear/Jira, Claude and Codex.

## Install

macOS (Apple Silicon or Intel), with Git installed. Once the first release is published:

```sh
curl -fsSL https://raw.githubusercontent.com/aidaspa-embedder/maestro/main/install.sh | sh
~/.local/bin/maestro
```

Downloads the latest release, verifies its checksum, and installs to `~/.local/bin`.
First launch walks you through setup. No Bun required.

From a checkout: `bun install --frozen-lockfile && bun run install:local`.

## Features

- Jira/Linear issues → Git worktrees across multiple GitHub repositories.
- Cached repository discovery, PR status, and selectable starting branches.
- Claude/Codex sessions, adding repos to existing workspaces, and customizable settings.

Claude uses `--dangerously-skip-permissions`; Codex uses `--yolo`. [Security](SECURITY.md).

## TODO: Workspace archiving

- [ ] Archive and restore workspaces while keeping issue, repo and session links.
- [ ] Browse and search archived workspaces separately.
- [ ] Optionally remove clean worktrees when archiving; preserve uncommitted work.
- [ ] Optional auto-archive after issue completion or PR merge.

[Guide](docs/guide.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
