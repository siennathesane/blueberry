/**
 * blueberry search — embedded, disk-based code search.
 *
 * STATUS: scaffold only. Do not implement before reading DESIGN.md §Search
 * and resolving its open questions with the user.
 *
 * Reference material (do not load, do not import): vendored/pi-fff/
 * Upstream: https://github.com/dmtrKovalenko/fff (packages/pi-fff) v0.10.5
 *
 * Key constraint: near-zero resident memory. The index lives on disk.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  // Intentionally empty. See DESIGN.md §Search for the target design:
  // - node:sqlite (built into Node 22.5+) with FTS5 — on-disk, BM25-ranked
  // - incremental indexing by mtime; index stored under the agent dir
  // - tools: content search (grep-like), path/symbol search, refresh
}
