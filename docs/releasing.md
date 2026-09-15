# Releasing

The repository contains release preparation automation; creating a release is a
maintainer action. Nothing is published by `bun run check` or `bun run build`.

1. Set the version in package.json and record changes in CHANGELOG.md.
2. Run `bun install --frozen-lockfile`, `bun run check`, `bun audit`, and
   `bun run build`. Smoke-test `dist/maestro --version`, `--help`, and `--doctor`.
3. On a throwaway account/config, test onboarding and live Jira/Linear/GitHub
   access, a private repository clone, and new/resumed sessions in each supported
   terminal. Mocked tests do not establish that those services accept real keys.
4. Review the source/package contents for credentials and personal artifacts.
   `.embedder`, `.env`, logs and local state must remain excluded. Inspect Git
   history separately for old secrets before making a private repository public.
5. Enable GitHub private vulnerability reporting and branch protection. Confirm
   the MIT license and public package/repository name before publishing.
6. Push a version tag (`v` followed by package.json's version), or manually run
   the release workflow. It checks/builds on Apple Silicon and Intel macOS and
   uploads versioned archives with SHA-256 checksums as workflow artifacts.
7. Review/download those artifacts and attach them to a GitHub release. This
   workflow deliberately has no publishing token or repository write permission.
   The artifacts are unsigned and not notarized. Decide signing/notarization
   and distribution channels before advertising verified binary downloads.

## Download installer

The short README uses `install.sh` from the `main` branch of
`aidaspa-embedder/maestro`. Publish the release assets before advertising the
download installer. If the destination changes, update the default in
`install.sh` and the README URL together.

Attach `maestro-v<VERSION>-darwin-arm64.tar.gz` and
`maestro-v<VERSION>-darwin-x64.tar.gz`, each with its matching `.sha256` file.
The release tag must match `v<VERSION>` from package.json. The installer resolves
GitHub's latest published release, verifies SHA-256 and the binary's version,
then atomically installs it. It never edits shell profiles or requires sudo.

Pin a version or choose a destination with environment variables:

```sh
MAESTRO_VERSION=v0.2.0 MAESTRO_BIN_DIR="$HOME/bin" sh install.sh
```

`MAESTRO_REPO=owner/repo` selects another GitHub repository. Run
`bun run test:install` for isolated installer tests with local release fixtures.
Also smoke-test the README command against the first public release.

For a local installation, `bun run install:local --no-path` compiles and stages a
binary beside its destination before an atomic rename. `--prefix <dir>` chooses
a different destination. With no `--no-path`, the installer can add a PATH line
to the user's shell profile. Test installers with a temporary prefix/profile.
