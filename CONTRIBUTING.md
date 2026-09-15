# Contributing

Maestro is a Bun + React terminal application built on OpenTUI. Native terminal
launching supports macOS (Ghostty, iTerm2 and Terminal.app).

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun run build
```

Use Bun 1.3.14 or later. CI builds and tests both Apple Silicon and Intel macOS.
Test suites run in separate processes because module mocks and temporary HOME
values must not leak between suites. See [AGENTS.md](AGENTS.md) and
[architecture](docs/architecture.md) before changing service boundaries.

## Pull requests

Explain the problem, resulting behavior, and relevant validation. Include a
headless frame or terminal recording for UI changes. Keep credentials, real
issue contents, transcripts and local workspace data out of fixtures.

Add tests for behavior that can lose data, leak credentials, run commands, or
change provider semantics. Use local Git fixtures and mocked HTTP; no live keys
are needed. Keep the lockfile committed and use frozen installs in automation.

## Issues and security

Include the Maestro version, platform, terminal and sanitized `maestro --doctor`
output with bug reports. Never paste config.json, credentials or transcripts.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Contributions are provided under the repository's MIT license.
