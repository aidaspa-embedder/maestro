# Changelog

## 0.2.1

- Fall back to Ghostty’s command-line launcher when macOS rejects its AppleScript
  definitions with a syntax error. The fallback opens a window and copies the
  handoff prompt for pasting.
- Automatically configure shell PATH in the download installer.

## 0.2.0

- Short README with an archiving roadmap, detailed usage guide, and a standalone
  macOS installer for checksummed GitHub release downloads.
- Guided first-run setup with a full-height blue caret revealing a large,
  blue-and-white ASCII Maestro wordmark, reduced motion, GitHub
  connection checks, Jira/Linear selection and agent autodetection.
- Jira Cloud issue search, details, creation and workflow synchronization through
  a shared issue provider contract. Existing Linear workspaces remain compatible.
- Persistent repository caching, forced refresh, owner filtering and bounded Git
  concurrency. Shared animation clock and configurable refresh pace.
- Add repositories or retry failed provisioning inside existing workspaces.
- Visible per-repository starting branch selection for new and existing
  workspaces; prefer `main` when available, with searchable branch choices.
- Mandatory Claude permission bypass and Codex `--yolo`, including resumes;
  optional model overrides and handoff instructions.
- Atomic private state, corruption recovery, single-instance protection, safer
  shell quoting, owner-qualified worktree paths and Git-verified deletion.
- Open-source license, contributor/security documentation, diagnostics and
  macOS release preparation workflows.
