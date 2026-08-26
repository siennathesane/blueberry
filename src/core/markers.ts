/**
 * Project boundary detection and identity markers.
 *
 * The identity travels with the repo via a marker file; the registry is the
 * database. Marker locations by project kind:
 *   git       -> .git/blueberry-id      (inside .git, never committed)
 *   lore      -> .lore/blueberry-id     (.lore is lore's local-state dir)
 *   worktree  -> .blueberry/id          (.git is a FILE in worktrees)
 *   plain     -> .blueberry/id          (no VCS: we mint one at the root)
 *
 * Walk rule: nearest boundary wins — a subdir that is its own repo is its own
 * project; unmarked subdirs belong to the outer project.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

export type BoundaryKind = "git" | "lore" | "worktree" | "plain";

export interface Boundary {
  root: string;
  kind: BoundaryKind;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Detect the marker boundary at a single directory, if any. */
export function boundaryAt(dir: string): Boundary | null {
  if (isDir(join(dir, ".git"))) return { root: dir, kind: "git" };
  if (isDir(join(dir, ".lore"))) return { root: dir, kind: "lore" };
  if (isFile(join(dir, ".git"))) return { root: dir, kind: "worktree" };
  if (isFile(join(dir, ".blueberry", "id"))) {
    return { root: dir, kind: "plain" };
  }
  return null;
}

/** Walk up from startDir; first boundary wins. Null when none found. */
export function findProjectBoundary(startDir: string): Boundary | null {
  let current = startDir;
  for (;;) {
    const boundary = boundaryAt(current);
    if (boundary) return boundary;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function markerPath(boundary: Boundary): string {
  switch (boundary.kind) {
    case "git":
      return join(boundary.root, ".git", "blueberry-id");
    case "lore":
      return join(boundary.root, ".lore", "blueberry-id");
    case "worktree":
    case "plain":
      return join(boundary.root, ".blueberry", "id");
  }
}

/** Read the project id from the boundary's marker, or null. */
export function readMarkerId(boundary: Boundary): string | null {
  const path = markerPath(boundary);
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Write the project id to the boundary's marker (creating parent dirs). */
export function writeMarkerId(boundary: Boundary, id: string): void {
  const path = markerPath(boundary);
  if (boundary.kind === "worktree" || boundary.kind === "plain") {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, id + "\n", "utf8");
}

/** Best-effort origin remote URL for a repo root; null when unavailable. */
export function getGitRemote(root: string): string | null {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const url = out.trim();
    return url === "" ? null : url;
  } catch {
    return null;
  }
}
