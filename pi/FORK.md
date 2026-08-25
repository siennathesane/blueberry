# pi fork

Live fork of pi-mono vendored **for modification** — unlike `vendored/` (read-only reference), this tree is blueberry-owned source. Divergence is intentional and tracked here.

| Upstream | Commit | Forked |
| --- | --- | --- |
| ~/Development/pi (github.com/earendil-works/pi-mono) | dcd461925db2edf69a43c8135db1180d418afd54 | 2025-08-25 |

## First divergence: DB-only session persistence

Stock session-manager hardcodes ~14 JSONL fs sites. Fork routes persistence
into blueberry.db (`sessions`/`session_entries`/`session_fts`) — JSONL becomes
an export format (`bb restore`/`bb export`), never a live write path.

| Change | File | Notes |
| --- | --- | --- |
| `SessionStore` seam + `JsonlStore` (stock behavior) | `src/core/session-store.ts` | module-level `setSessionStore()`; default = bit-for-bit stock |
| `BlueberryDbStore` | `src/core/session-store-db.ts` | schema contract = blueberry `src/core/db.ts` byte-identical; WAL + busy_timeout |
| All 14 persistence sites store-routed | `src/core/session-manager.ts` | writes, reads, discovery, listing, compaction, fork, migration |
| `BLUEBERRY_DB` arms the store | `src/main.ts` | env unset → stock JSONL (upstream-compatible default) |
| cloudflare `openai-completions` dropped | `../ai/src/providers/cloudflare-ai-gateway.ts` | upstream HEAD doesn't build offline (catalog drift); FORK fix |

Proven by `test/fork-smoke.sh`: live session → 0 `.jsonl` created, entries +
FTS land in blueberry.db, crash-tolerant (persistence survives model-call
failure). Launcher (`src/core/launcher.ts`) execs the fork bundle with
`BLUEBERRY_DB` derived from the agent dir (test sandboxes get sandbox DBs).

## Policy

- `bin/blueberry` execs the fork build (`pi/packages/coding-agent/dist/bundle/cli.js`).
- Build: per-package `npm run build` (offline chain for `ai`) — the monorepo `npm run build` regenerates catalogs and fails deterministically at HEAD.
- Re-sync from upstream: rsync again, re-apply FORK.md-listed divergences.
- Every divergence MUST be listed above or in commits touching `pi/`.
