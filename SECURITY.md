# Security

## Agent permissions

Maestro intentionally starts Claude with `--dangerously-skip-permissions` and
Codex with `--yolo` for both new and resumed sessions. These agents can execute
commands without approval; Codex also bypasses its sandbox. Maestro is **not a
security boundary**. Use trusted repositories and an appropriately isolated
machine/environment. An issue description or repository can contain instructions
an agent may follow. The initial worktree map is typed without being submitted.

## Credentials and local data

- GitHub CLI authentication is preferred. PAT mode also supports `GH_TOKEN` and
  `GITHUB_TOKEN`. Jira/Linear credentials can come from environment variables.
- Saved config, workspace state and repository caches are mode `0600`; newly
  created config/cache directories are `0700`. JSON writes are serialized,
  flushed and atomically renamed. Corrupt state is preserved for recovery.
- Credentials in config.json are plaintext protected by filesystem permissions;
  Maestro does not currently use the OS keychain. Secret input never renders the
  typed or pasted value, and previously saved values are never shown for editing.
- Repository caches contain private repository metadata, keyed by a SHA-256
  credential fingerprint. They expire after 15 minutes by default. Offline
  fallback is limited to seven days. Settings `c` clears this data.
- Tokens are never placed in clone URLs, persisted Git configuration or process
  arguments. PAT Git authentication uses an environment-scoped HTTP header limited
  to GitHub. Other processes running as your user may inspect process environments.
- Network integrations use HTTPS, reject redirects and have request timeouts.
  Browser links accept only HTTP/HTTPS. No telemetry is sent by Maestro itself;
  the agent CLIs and integrations have their own data policies.

## Filesystem operations

New worktrees are namespaced by owner and repository. Branch names and path
segments are validated. Reuse checks the Git repository and branch. Removal uses
Git's registered worktree ownership and refuses dirty worktrees by default; there
is no recursive-delete fallback. The interactive app locks its state directory
to avoid concurrent writers. Do not edit state files while Maestro is running.

## Reporting

Use the repository's **Security → Advisories → Report a vulnerability** facility
when enabled. If it is unavailable, ask for a private contact channel in an issue
without including exploit details or secrets. Maintainers should enable private
vulnerability reporting before publishing the repository. Never post credentials
or private issue data in a public report.

No independent security audit or signed/notarized binary distribution is claimed.
