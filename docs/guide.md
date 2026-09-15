# Maestro guide

**One issue. Multiple repositories. One workspace.**

Maestro is a terminal UI that turns a Jira or Linear issue into Git worktrees
across GitHub repositories, then opens Claude, Codex or a shell with the worktree
map ready to use.

- **Issues are the source of truth:** Jira or Linear owns content and workflow.
- **GitHub is the Git source of truth:** repositories, branches, PRs and checks.
- **Maestro connects them:** local worktrees, session discovery and a keyboard UI.

Built with Bun, React and [OpenTUI](https://opentui.com). MIT licensed.
Native session launching currently supports **macOS**, with Ghostty, iTerm2 and
Terminal.app. Other platforms can run the TUI and diagnostics, but native
terminal launching is not implemented there.

## Quick start

For the compiled release installer, see the [short README](../README.md).
`MAESTRO_VERSION=v0.2.0` pins a release and `MAESTRO_BIN_DIR=/absolute/path`
changes its destination. The download installer adds the directory to your shell PATH (zsh, bash or fish).
Open a new terminal afterward. Use `sh install.sh --no-path` to skip this, or
`MAESTRO_PROFILE=/absolute/path` to choose the profile.

From a checkout, with Bun 1.3.14+ and Git installed:

```sh
bun install --frozen-lockfile
bun start
```

To install a standalone command:

```sh
bun run install:local
maestro
```

The installer compiles a binary and installs it under `$BUN_INSTALL/bin`, or
`~/.local/bin`. It can add that directory to your shell profile. Use
`bun run install:local --no-path` to leave the profile alone, or `--prefix <dir>`
to choose the destination. `bun run build` only creates `dist/maestro`.

## First run

A full-height blue caret slides across a large, six-line ASCII **maestro**
wordmark and diamond in Maestro blue and white. Narrow terminals use a compact
ASCII version. The 1.8-second intro leads into setup:

1. **Tools:** detect Git, `gh`, Claude and Codex on PATH. Choose an installed
   agent automatically, or use a shell if neither agent is available.
2. **GitHub:** reuse `gh auth login --hostname github.com`, or choose token mode.
   Optionally filter the repository picker to a GitHub user or organization.
3. **Issues:** select Linear or Jira Cloud and enter credentials.
4. **Workspace:** choose a worktree root, default agent, terminal, launch target,
   model overrides and additional handoff instructions.
5. **Ready:** review connections and open Maestro.

Use arrows to move, Enter to edit/save, and left/right to change an option.
`Ctrl+N` verifies and continues; `Ctrl+S` defers a connection; `Ctrl+B` goes back.
Values are saved as you go. Secrets stay masked even while pasting.

`maestro --setup` reopens setup. `maestro --no-intro` skips the animation and
uses reduced motion. Settings also provide a persistent reduced-motion toggle.
Enter, Escape or Space skips the intro immediately.

### Credentials

| Integration | Setup |
| --- | --- |
| GitHub CLI | `gh auth login --hostname github.com`; Maestro borrows its token |
| GitHub token | Repository read access; token mode uses a stored token or `GH_TOKEN` / `GITHUB_TOKEN` |
| Linear | Personal API key from Settings → Security & access; or `LINEAR_API_KEY` |
| Jira Cloud | HTTPS site origin, Atlassian email and an unscoped API token; or `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |

Jira tokens can be created at [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens).
Jira Data Center and scoped-token cloud-ID routing are not currently supported.
Jira quick creation chooses Task (or the first non-subtask type). Projects with
additional required fields may require creating the issue in Jira first.

Environment credentials override saved credentials and are not copied into
config.json. The app does not install agents or sign into them for you; their
existing CLI authentication is used.

## Workspaces

Press `n`, pick an issue, then select repositories with Space. Tab marks the
main repository. The starting branch defaults to **`main`** when present (or the
repository's GitHub default if it has no `main`). Press **`→`** on a repository
to choose a different starting branch, then **Enter** to use it.
Enter starts creation. Maestro manages its own bare clones:

```text
~/maestro/
  .repos/<owner>/<repo>.git
  <owner>/<repo>/<ISSUE-123-short-title>/
```

Linear's suggested branch name is preferred; Jira branches include the issue
key. Worktrees branch from the selected remote base. Each completed repository
is checkpointed; failures are displayed and can be retried.

Open a workspace and press **`a` to add repositories**. The issue, branch, main
repository and session stay attached to that workspace. Existing repositories
are excluded, and `→` chooses a starting branch for each added repository.
Failed repositories can be retried, and duplicate selections do
not create duplicate records. Copy the updated map with `y` for an already-open
agent session; adding repositories does not inject text into a running session.

`o` focuses a live session, resumes the newest known session, or starts a new
one. `l` opens the explicit session menu. A fresh session starts in the main
worktree with the issue link and all worktree paths typed but not submitted.
Terminal.app receives that prompt through the clipboard instead.

### Agent launch policy

Claude always starts with **`--dangerously-skip-permissions`** (the supported CLI
flag); Codex always starts with **`--yolo`**. This applies to fresh sessions,
resumed sessions and fallback commands. Agents run without permission prompts;
Codex also bypasses sandboxing. Use trusted repositories and an appropriately
isolated environment. See [SECURITY.md](../SECURITY.md).

## Keys

| View | Keys |
| --- | --- |
| Workspaces | `↑↓` / `jk` move; `←→` enter/leave PR rows; Enter opens |
| Workspaces | `n` new; `o` open session; `t` issue; `s` settings; `q` quit |
| Workspaces | `/` search; `f` filter; `S` sort; `h` hide/unhide; `z` fold PRs |
| Workspaces | `d` delete menu; `w` remove clean worktrees + entry; `e` forget entry |
| Workspace | `a` add repos; `o` open session; `l` session menu |
| Workspace | `y` copy map; `Y` copy paths; `c` copy selected path |
| Workspace | `t` issue; `p` PRs; Tab cycles tabs; `b` browser; `r` refresh |
| Issue picker | Type to search; `Ctrl+N` create an issue |
| Repo picker | Space selects; Tab sets main; `→` starting branch; `Ctrl+A` all visible |
| Repo picker | `Ctrl+R` refresh repository list; Enter creates; Esc returns |
| Branch picker | Type to filter; `↑↓` move; Enter uses branch; `Ctrl+R` refresh; Esc returns |
| Settings | Enter edit; `←→` change; `r` recheck; `c` clear cache; `o` setup |

`?` in the workspace list shows the full key reference. Dirty worktrees are
preserved when deletion fails; commit/stash changes or forget the entry.

## Caching and customization

Repository lists are cached privately for **15 minutes**, scoped to the GitHub
credential. Reopening the picker uses the cache; `Ctrl+R` forces a refresh.
Temporary network failures can show a labeled offline snapshot up to seven days
old. Changing credentials uses a separate cache. Settings `c` clears all saved
repository caches; setting cache duration to `0` disables caching.

Settings include repository owner filtering, cache lifetime, concurrent Git jobs
(1–8), refresh pace, reduced motion, terminal/window preference, agent/model
choices, and extra handoff instructions. List sorting, filtering and folding are
remembered. A workspace keeps its recorded paths when the default root changes.

Config and state live in `~/.config/maestro/`, overridden by
`MAESTRO_CONFIG_DIR` or `XDG_CONFIG_HOME`. Saved files are private (`0600`), but
credentials are plaintext on disk. Back up `config.json` and `workspaces.json`.
Malformed files are never automatically reset. Only one interactive instance
can write a given config directory at a time.

## Diagnostics and development

```sh
maestro --doctor                      # tools and local state; no remote calls
maestro --doctor --check-connections  # also verify GitHub and issue credentials
bun run check                         # typecheck and isolated test suites
bun audit                             # dependency vulnerability report
bun run build                         # standalone executable
bun run release:archive               # checksummed archive for this machine
```

See [CONTRIBUTING.md](../CONTRIBUTING.md), [architecture](architecture.md),
[release preparation](releasing.md) and [CHANGELOG.md](../CHANGELOG.md).
No telemetry is sent by Maestro itself. Agent CLIs and integrations have their
own data policies. Release archives are currently unsigned and not notarized.
