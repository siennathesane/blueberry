/**
 * Import existing pi session history into blueberry.
 *
 * pi stores sessions under <agentDir>/sessions/--<mangled-cwd>--/<file>.jsonl
 * where the mangled name is ambiguous. The HEADER cwd inside each file is
 * authoritative: adopt groups by header cwd, not by directory name. Directory
 * decoding is only a fallback for sessions with empty/stale headers (old pi
 * versions), verified against the filesystem before use.
 *
 * Adopt never rewrites session bodies; at most it stamps a missing header cwd
 * (so pi's "missing session cwd" prompt can never appear) and moves files into
 * the project's central store, preserving mtimes.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Project, Registry } from "./registry.ts";
import { findByPath, mutations } from "./registry.ts";
import { getCentralStoreDir } from "./agent-dir.ts";
import {
  type MoveOptions,
  moveSession,
  readSessionHeader,
  rewriteSessionHeader,
} from "./sessions.ts";
import { decodeDirNameToPathCandidates } from "./util.ts";

export interface AdoptReport {
  imported: Array<{ project: string; sessions: number }>;
  skipped: Array<{ file: string; reason: string }>;
  stamped: number;
  /** Files skipped because already present in the destination (--copy re-runs). */
  duplicates: number;
}

/** Find or create the project owning a given root path (no marker writes). */
export function ensureProjectForRoot(
  root: string,
  registry: Registry,
): Project {
  const existing = findByPath(registry, root);
  if (existing) return existing;
  return mutations.register(registry, { root });
}

export interface AdoptOptions {
  /** source sessions root, e.g. ~/.pi/agent/sessions */
  sourceDir: string;
  /** blueberry agent dir (store placement target) */
  agentDir: string;
  /** explicit overrides: mangled dir name -> real project root */
  map?: Record<string, string>;
  /** existence check used to validate decoded paths (injectable for tests) */
  pathExists?: (p: string) => boolean;
  /** Leave source files in place (copy instead of move). Re-runs skip files already adopted. */
  copy?: boolean;
}

interface Collected {
  project: Project;
  file: string;
  needsStamp: boolean;
  root: string;
}

export function adoptSessions(
  registry: Registry,
  opts: AdoptOptions,
): AdoptReport {
  const report: AdoptReport = {
    imported: [],
    skipped: [],
    stamped: 0,
    duplicates: 0,
  };
  if (!existsSync(opts.sourceDir)) return report;

  const exists = opts.pathExists ?? existsSync;
  const collected: Collected[] = [];

  for (const entry of readdirSync(opts.sourceDir)) {
    const entryPath = join(opts.sourceDir, entry);

    if (entry.endsWith(".jsonl")) {
      collectFile(entryPath, undefined, undefined);
      continue;
    }

    const override = opts.map?.[entry];
    const dirFiles = readdirSync(entryPath).filter((f) => f.endsWith(".jsonl"));
    for (const f of dirFiles) {
      collectFile(join(entryPath, f), entry, override);
    }
  }

  function collectFile(
    file: string,
    dirName: string | undefined,
    override: string | undefined,
  ): void {
    const header = readSessionHeader(file);
    if (!header) {
      report.skipped.push({ file, reason: "unreadable or invalid header" });
      return;
    }

    let root: string | null = null;
    const hasHeaderCwd = typeof header.cwd === "string" &&
      header.cwd.trim() !== "";
    if (hasHeaderCwd) {
      root = header.cwd!;
    } else if (dirName) {
      if (override) {
        root = override;
      } else {
        const candidates = decodeDirNameToPathCandidates(dirName, exists);
        root = candidates[0] ?? null;
      }
    }

    if (!root) {
      report.skipped.push({
        file,
        reason: dirName
          ? `no header cwd and directory '${dirName}' does not decode to an existing path (use --map)`
          : "no header cwd and no enclosing project directory",
      });
      return;
    }

    const project = ensureProjectForRoot(root, registry);
    collected.push({ project, file, needsStamp: !hasHeaderCwd, root });
  }

  // Stamp missing header cwds first (on source files), then move.
  for (const item of collected) {
    if (!item.needsStamp) continue;
    rewriteSessionHeader(item.file, (h) => {
      h.cwd = item.root;
      return h;
    });
    report.stamped++;
  }

  // Group moves per project so parentSession chains rewrite within the batch.
  const byProject = new Map<Project, Collected[]>();
  for (const item of collected) {
    const list = byProject.get(item.project) ?? [];
    list.push(item);
    byProject.set(item.project, list);
  }

  for (const [project, items] of byProject) {
    const store = getCentralStoreDir(opts.agentDir, project.slug);
    const movedMap = new Map<string, string>();
    const batchFiles = new Set(items.map((i) => i.file));
    let movedCount = 0;

    const place = (item: Collected): boolean => {
      const target = join(store, basename(item.file));
      if (opts.copy && existsSync(target)) {
        // already adopted on a previous --copy run; map the path so any
        // children in this batch still rewrite parentSession correctly
        movedMap.set(item.file, target);
        return false;
      }
      const moveOpts: MoveOptions = { newCwd: project.canonicalPath, movedMap };
      if (opts.copy) moveOpts.copy = true;
      const placed = moveSession(item.file, store, moveOpts);
      movedMap.set(item.file, placed);
      return true;
    };

    // Multi-pass move: a child whose parentSession points at another file in
    // this batch must move AFTER that parent so the link rewrites to the new
    // path instead of being cleared as dangling. Deferring keeps the result
    // correct regardless of directory iteration order.
    let pending = items;
    while (pending.length > 0) {
      const deferred: typeof items = [];
      for (const item of pending) {
        const parent = readSessionHeader(item.file)?.parentSession;
        if (
          typeof parent === "string" &&
          batchFiles.has(parent) &&
          !movedMap.has(parent)
        ) {
          deferred.push(item);
          continue;
        }
        if (place(item)) movedCount++;
        else report.duplicates++;
      }
      if (deferred.length === pending.length) break; // no progress (self-reference): move as-is below
      pending = deferred;
    }
    // Theoretically unreachable; any survivor moves plainly (dangling parents cleared).
    for (const item of pending) {
      if (place(item)) movedCount++;
      else report.duplicates++;
    }
    if (movedCount > 0) {
      report.imported.push({ project: project.slug, sessions: movedCount });
    }
  }

  return report;
}
