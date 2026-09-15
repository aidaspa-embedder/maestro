#!/bin/sh
# Install a compiled GitHub release. No Bun or sudo required. Adds the binary directory to your shell PATH.
# Overrides: MAESTRO_REPO, MAESTRO_VERSION, MAESTRO_BIN_DIR.
set -eu

main() {
  repo=${MAESTRO_REPO:-aidaspa-embedder/maestro}
  version=${MAESTRO_VERSION:-latest}
  bin_dir=${MAESTRO_BIN_DIR:-${HOME:?HOME is not set}/.local/bin}
  scratch=
  staged=
  update_path=1

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
      printf '%s\n' 'Usage: sh install.sh [--no-path]' \
        '  --no-path                Skip automatic shell PATH configuration.' \
        '  MAESTRO_VERSION=v0.2.0    Pin a release (default: latest).' \
        '  MAESTRO_BIN_DIR=/path     Choose the binary directory (default: ~/.local/bin).' \
        '  MAESTRO_REPO=owner/repo   Use a fork or another release repository.'
      return ;;
    --no-path) update_path=0 ;;
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
  for tool in curl tar mktemp chmod mv mkdir cat rm sed grep dirname; do
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
  if [ "$update_path" = 0 ]; then
    printf 'Run %s/maestro to start setup.\n' "$bin_dir"
    return
  fi
  case ":${PATH:-}:" in
    *":$bin_dir:"*) printf 'Run maestro to start setup.\n'; return ;;
  esac
  # Quote literal paths; never evaluate profile contents during installation.
  case "$bin_dir" in
    *:*|*'
'*) fail 'Installed, but this directory cannot be added to PATH (colon or newline).' ;;
  esac
  shell_name=${SHELL:-/bin/zsh}
  shell_name=${shell_name##*/}
  case "${shell_name:-zsh}" in
    fish)
      profile=${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish
      escaped=$(printf '%s' "$bin_dir" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
      path_line="fish_add_path '$escaped'"
      ;;
    *)
      case "${shell_name:-zsh}" in
        zsh) profile=${ZDOTDIR:-$HOME}/.zshrc ;;
        bash)
          profile=$HOME/.bash_profile
          if [ ! -f "$profile" ]; then
            if [ -f "$HOME/.bash_login" ]; then profile=$HOME/.bash_login
            elif [ -f "$HOME/.profile" ]; then profile=$HOME/.profile; fi
          fi
          ;;
        *) profile=$HOME/.profile ;;
      esac
      escaped=$(printf '%s' "$bin_dir" | sed 's/[\\$`"]/\\&/g')
      # Expand PATH when the user's shell starts, not during installation.
      # shellcheck disable=SC2016
      path_line='case ":${PATH:-}:" in *:"'"$escaped"'":*) ;; *) export PATH="'"$escaped"':$PATH" ;; esac'
      ;;
  esac
  profile=${MAESTRO_PROFILE:-$profile}
  case "$profile" in /*) ;; *) fail 'MAESTRO_PROFILE must be an absolute path.' ;; esac
  if [ ! -f "$profile" ] || ! grep -Fqx -- "$path_line" "$profile"; then
    mkdir -p "$(dirname "$profile")" || fail "Installed, but cannot create the profile directory: $profile"
    printf '\n# added by maestro\n%s\n' "$path_line" >> "$profile" || fail "Installed, but cannot update PATH in $profile"
  fi
  printf 'PATH configured in %s.\nOpen a new terminal and run maestro to start setup.\n' "$profile"
}

# Run only after the whole script has arrived when piped through curl.
main "$@"
