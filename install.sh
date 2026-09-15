#!/bin/sh
# Install a compiled GitHub release. No Bun, sudo or shell-profile edits.
# Overrides: MAESTRO_REPO, MAESTRO_VERSION, MAESTRO_BIN_DIR.
set -eu

main() {
  repo=${MAESTRO_REPO:-aidaspa-embedder/maestro}
  version=${MAESTRO_VERSION:-latest}
  bin_dir=${MAESTRO_BIN_DIR:-${HOME:?HOME is not set}/.local/bin}
  scratch=
  staged=

  fail() { printf 'maestro: %s\n' "$*" >&2; exit 1; }
  cleanup() {
    [ -z "$staged" ] || rm -f "$staged"
    [ -z "$scratch" ] || rm -rf "$scratch"
    :
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP

  case ${1:-} in
    --help|-h)
      printf '%s\n' 'Usage: sh install.sh' \
        '  MAESTRO_VERSION=v0.2.0    Pin a release (default: latest).' \
        '  MAESTRO_BIN_DIR=/path     Choose the binary directory (default: ~/.local/bin).' \
        '  MAESTRO_REPO=owner/repo   Use a fork or another release repository.'
      return ;;
    '') ;;
    *) fail 'Unknown option. Run sh install.sh --help.' ;;
  esac

  case "$repo" in
    ''|/*|*/|*/*/*|*[!A-Za-z0-9._/-]*) fail 'MAESTRO_REPO must be owner/repository.' ;;
    */*) ;;
    *) fail 'MAESTRO_REPO must be owner/repository.' ;;
  esac
  case "$repo" in ./*|../*|*/.|*/..) fail 'Invalid GitHub repository.' ;; esac
  # Absolute destinations also prevent paths from being interpreted as options.
  case "$bin_dir" in /*) ;; *) fail 'MAESTRO_BIN_DIR must be an absolute path.' ;; esac
  case $(uname -s) in
    Darwin) platform=darwin ;;
    *) fail 'Prebuilt releases support macOS. To build from source, see CONTRIBUTING.md.' ;;
  esac
  case $(uname -m) in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail 'No release is available for this CPU architecture.' ;;
  esac
  for tool in curl tar mktemp chmod mv mkdir cat rm; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool"
  done
  if command -v shasum >/dev/null 2>&1; then
    checksum() { shasum -a 256 "$1"; }
  elif command -v sha256sum >/dev/null 2>&1; then
    checksum() { sha256sum "$1"; }
  else
    fail 'SHA-256 verification requires shasum or sha256sum.'
  fi
  fetch() {
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location --retry 2 \
      --connect-timeout 15 --max-time 300 "$@"
  }
  if [ "$version" = latest ]; then
    latest=$(fetch --head --output /dev/null --write-out '%{url_effective}' "https://github.com/$repo/releases/latest") ||
      fail "Cannot find a published release for $repo. Install from a checkout until a release is available."
    case "$latest" in
      "https://github.com/$repo/releases/tag/"*) version=${latest##*/} ;;
      *) fail "No published release found for $repo." ;;
    esac
  fi
  case "$version" in
    *[!A-Za-z0-9.+-]*) fail 'MAESTRO_VERSION must be a release tag such as v0.2.0.' ;;
    v[0-9]*) ;;
    *) fail 'MAESTRO_VERSION must be a release tag such as v0.2.0.' ;;
  esac

  umask 077
  case ${TMPDIR:-/tmp} in /*) ;; *) fail 'TMPDIR must be an absolute path.' ;; esac
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/maestro-install.XXXXXX") || fail 'Cannot create a temporary directory.'
  package="maestro-$version-$platform-$arch"
  archive="$package.tar.gz"
  base="https://github.com/$repo/releases/download/$version"
  printf 'Downloading Maestro %s (%s)…\n' "$version" "$arch"
  fetch --output "$scratch/$archive" "$base/$archive" || fail "Cannot download $archive. Check that the release includes your platform."
  fetch --output "$scratch/checksum" "$base/$archive.sha256" || fail 'Cannot download the release checksum.'
  IFS=' ' read -r expected filename < "$scratch/checksum" || fail 'Invalid release checksum.'
  case "$expected" in ''|*[!0-9a-fA-F]*) fail 'Invalid release checksum.' ;; esac
  [ "${#expected}" -eq 64 ] && [ "$filename" = "$archive" ] || fail 'Invalid release checksum.'
  actual=$(checksum "$scratch/$archive") || fail 'Cannot compute the archive checksum.'
  [ "${actual%% *}" = "$expected" ] || fail 'Checksum mismatch; the installed binary was not changed.'

  # Read only the named binary to stdout. Archive paths never get extracted.
  tar -xOzf "$scratch/$archive" "$package/maestro" > "$scratch/maestro" || fail 'The archive does not contain a Maestro binary.'
  [ -s "$scratch/maestro" ] || fail 'The release binary is empty.'
  chmod 755 "$scratch/maestro"
  reported=$("$scratch/maestro" --version) || fail 'The downloaded binary cannot run on this machine.'
  [ "$reported" = "${version#v}" ] || fail 'The binary version does not match the release.'

  mkdir -p "$bin_dir" || fail "Cannot create $bin_dir. Choose a writable MAESTRO_BIN_DIR."
  [ ! -d "$bin_dir/maestro" ] || fail 'The install target is a directory.'
  staged=$(mktemp "$bin_dir/.maestro.XXXXXX") || fail 'Cannot stage the new binary.'
  cat "$scratch/maestro" > "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$bin_dir/maestro"
  staged=
  printf '\nInstalled: %s/maestro\n' "$bin_dir"
  printf 'Run %s/maestro to start setup.\n' "$bin_dir"
  case ":${PATH:-}:" in
    *":$bin_dir:"*) ;;
    *) printf 'Add %s to PATH to run maestro from anywhere.\n' "$bin_dir" ;;
  esac
}

# Run only after the whole script has arrived when piped through curl.
main "$@"
