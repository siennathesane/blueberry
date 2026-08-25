# Windows CI Test Debt (#32) — Mechanical Cross-Platform Fixes

## Cluster Table

| Cluster (Root Cause) | Affected Tests | Fix Applied |
|---------------------|----------------|-------------|
| chmod/permission-bit tests (genuinely unix-only) | test/sessions.test.ts (listSessions unreadable, listSessions count), test/tail-close.test.ts (doc-index unreadable file), test/final-branches.test.ts, test/lsp.test.ts (readFileSync throws on unreadable), test/library.test.ts (parseSessionFile unreadable) | Platform-skip the chmod 0o000 tests on Windows — chmod semantics differ; add `import platform from "node:os"` and guard with `platform !== "win32"` plus `// #32: unix-only chmod semantics` comment. Original assertions preserved on macOS/Linux. |
| Unix-style absolute paths in fake cwd values | test/util.test.ts (expandTilde: expects `/home/tester`), test/trust.test.ts (trustPaths round-trip uses `/x/proj-a`), test/tail-close.test.ts (`/definitely/not/a/project`), test/sessions.test.ts (`/x/p` pattern, `/old`/`/new`), test/last-mile.test.ts (`/no/such/dir`), test/sync.test.ts (`/no/such/project`), test/import-history.test.ts (`/work/proj`), test/final-points.test.ts (`/x`), test/context-composer.test.ts (`/tmp/proj`) | Use `os.homedir()` on macOS/Linux; on Windows, skip or use `C:\\Users\\test` equivalent with platform guard. For fake paths in session headers: replace `/x/p` with `C:\\x\\p` on Windows or use a platform-relative temp path. Trust paths: the function stores strings; comparison is exact-match. The test paths must be adapted to Windows-style when run on Windows. |
| encodeCwdToDirName / decodeDirNameToPathCandidates (path separator handling) | test/util.test.ts (decodeDirNameToPathCandidates: round-trips real dirs, rejects non-pi) | The encode function strips both `/` and `\` (line 83: `replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")`). The decode function reconstructs with `/`. On Windows, `exists("/x/y")` fails when the actual path is `C:\x\y`. The test creates directories using `mkdirSync(\`\${base}/foo-bar\`)` which works but the decode candidate uses `/foo-bar`. Fix: normalize candidates using `path.win32.resolve` on Windows before passing to exists, or skip the test on Windows with #32. |

## Non-Mechanical Leftovers (Needs Human Decision)

- src/core/db.ts:270 — `chmodSync(path, 0o600)` for the database file. On Windows, file permissions work differently; this may be acceptable as-is (Windows default is user-only) or may need a skip.
- src/core/updater.ts: comment references `chmod 755` — comment only, no change.
- src/core/lsp-manager.ts:80 — shebang check `#!/bin/sh` — comment only.

## Commits by Cluster

1. commit: skip chmod tests on Windows (#32) — 5 test files
2. commit: adapt unix-style path tests to Windows (#32) — 9 test files
3. commit: encodeCwdToDirName path separator handling (#32) — 1 test file