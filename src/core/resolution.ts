/**
 * Launch-time resolution: cwd -> project, following the decision ladder
 *   1. marker file (fast path, identity travels with the repo)
 *   2. git remote match (auto-reattach after moves/re-clones)
 *   3. canonical path / alias match
 *   4. mint a new project (and write its marker)
 * then follow nested-session merges (mergedInto) to the effective project.
 *
 * Resolution never loses data: the worst case is a split (a second checkout
 * minting a new project), never a merge of two different projects' stores.
 */
import type { Boundary } from "./markers.ts";
import {
  findProjectBoundary,
  getGitRemote,
  readMarkerId,
  writeMarkerId,
} from "./markers.ts";
import type { Project, Registry } from "./registry.ts";
import {
  findByGitRemote,
  findById,
  findByPath,
  mutations,
} from "./registry.ts";
import { getCentralStoreDir, getInRepoStoreDir } from "./agent-dir.ts";
import { samePath } from "./util.ts";
import { existsSync } from "node:fs";

export type ResolveStatus = "marker" | "remote" | "path" | "new";

export interface ResolveResult {
  /** The effective project (after following mergedInto). */
  project: Project;
  /** The project the boundary resolved to before nested-merge following. */
  boundaryProject: Project;
  /** The detected (or minted) boundary at/above cwd. */
  boundary: Boundary;
  /** Effective root: canonicalPath of the effective project. */
  root: string;
  status: ResolveStatus;
  /** True when this project is session-merged into another. */
  nested: boolean;
  actions: string[];
  registryMutated: boolean;
}

const NESTED_DEPTH_LIMIT = 16;

export function resolveProject(opts: {
  cwd: string;
  registry: Registry;
  gitRemoteReader?: (root: string) => string | null;
}): ResolveResult {
  const { cwd, registry } = opts;
  const remoteReader = opts.gitRemoteReader ?? getGitRemote;

  const actions: string[] = [];
  let mutated = false;

  // 1. Find (or mint) the boundary.
  let boundary = findProjectBoundary(cwd);
  if (!boundary) {
    boundary = { root: cwd, kind: "plain" };
  }

  // 2. Marker fast path.
  const markerId = readMarkerId(boundary);
  let project: Project | undefined;
  let status: ResolveStatus = "new"; // mint is the fallback; ladder steps overwrite

  if (markerId) {
    project = findById(registry, markerId);
    if (project) {
      status = "marker";
      if (project.canonicalPath !== boundary.root) {
        mutations.reattach(registry, project, boundary.root);
        actions.push(
          `reattached '${project.slug}' via marker: ${
            project.aliases[project.aliases.length - 1]
          } -> ${boundary.root}`,
        );
        mutated = true;
      }
    } else {
      // Marker from another machine / wiped registry: adopt the identity.
      project = mutations.register(registry, {
        root: boundary.root,
        id: markerId,
      });
      status = "new";
      actions.push(
        `registered '${project.slug}' adopting marker id from ${boundary.root}`,
      );
      mutated = true;
    }
  } else {
    // 3. Remote match (auto-reattach).
    const remote = remoteReader(boundary.root);
    project = remote ? findByGitRemote(registry, remote) : undefined;
    if (project) {
      status = "remote";
      if (project.canonicalPath !== boundary.root) {
        mutations.reattach(registry, project, boundary.root);
        actions.push(`reattached '${project.slug}' via git remote ${remote}`);
        mutated = true;
      }
      writeMarkerId(boundary, project.id);
      actions.push(
        `wrote marker at ${boundary.root} (remote now resolves via marker)`,
      );
    } else if (!remote) {
      // 4. Path/alias match (no remote to disambiguate; only safe when the
      //    canonical path no longer exists — otherwise this is a split).
      // samePath: symlink-aware (/var vs /private/var are one project).
      const byPath = findByPath(registry, boundary.root);
      if (
        byPath &&
        (samePath(byPath.canonicalPath, boundary.root) ||
          !existsSync(byPath.canonicalPath))
      ) {
        project = byPath;
        status = "path";
        if (!samePath(project.canonicalPath, boundary.root)) {
          mutations.reattach(registry, project, boundary.root);
          actions.push(
            `reattached '${project.slug}' via path match: ${boundary.root}`,
          );
          mutated = true;
        }
        writeMarkerId(boundary, project.id);
        actions.push(
          `wrote marker at ${boundary.root} (path now resolves via marker)`,
        );
      }
    }
  }

  // 5. Mint.
  if (!project) {
    const remote = remoteReader(boundary.root);
    project = mutations.register(registry, {
      root: boundary.root,
      gitRemote: remote,
    });
    mutated = true;
    actions.push(
      `registered new project '${project.slug}' at ${boundary.root}`,
    );
    writeMarkerId(boundary, project.id);
  }

  // 6. Follow nested-session merges to the effective project.
  const boundaryProject = project;
  let effective = project;
  let nested = false;
  let depth = 0;
  while (effective.mergedInto) {
    const next = findById(registry, effective.mergedInto);
    if (!next) {
      actions.push(
        `warning: '${effective.slug}' merged into missing project ${effective.mergedInto}; treating '${effective.slug}' as effective`,
      );
      break;
    }
    effective = next;
    nested = true;
    if (++depth > NESTED_DEPTH_LIMIT) {
      actions.push(
        `warning: nested chain too deep (cycle?); stopping at '${effective.slug}'`,
      );
      break;
    }
  }

  return {
    project: effective,
    boundaryProject,
    boundary,
    root: effective.canonicalPath,
    status,
    nested,
    actions,
    registryMutated: mutated,
  };
}

/** Session store directory for a project's configured mode. */
export function storeDirFor(agentDir: string, project: Project): string {
  return project.sessionStore === "in-repo"
    ? getInRepoStoreDir(project.canonicalPath)
    : getCentralStoreDir(agentDir, project.slug);
}
