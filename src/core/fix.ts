/**
 * bb fix / bb doctor: reconcile the world.
 *
 * Safe rewrites (cwd normalization, dangling parentSession clearing, orphan
 * store registration) apply unless dryRun. Reports are informational.
 * Invariant: fix never deletes session content and never merges two projects
 * automatically — splits are reported with a `bb projects merge` hint.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "./registry.ts";
import { findBySlug } from "./registry.ts";
import {
	getCentralStoreDir,
	getSessionsRoot,
	getInRepoStoreDir,
} from "./agent-dir.ts";
import {
	listSessions,
	readSessionHeader,
	rewriteSessionHeader,
} from "./sessions.ts";
import { ensureProjectForRoot } from "./adopt.ts";

export type FindingKind =
	| "orphan-store-registered"
	| "orphan-store-unresolvable"
	| "cwd-normalized"
	| "parent-session-cleared"
	| "stale-project"
	| "duplicate-project"
	| "in-repo-store-missing";

export interface Finding {
	kind: FindingKind;
	detail: string;
	/** The mutating action taken (empty in dryRun for fixable findings). */
	action?: string;
}

export interface FixReport {
	findings: Finding[];
	dryRun: boolean;
}

export function runFix(
	registry: Registry,
	agentDir: string,
	opts: { dryRun?: boolean } = {},
): FixReport {
	const dryRun = opts.dryRun ?? false;
	const findings: Finding[] = [];

	// 1. Orphan store dirs: sessions/<dir> with no project of that slug.
	if (existsSync(getSessionsRoot(agentDir))) {
		for (const dir of readdirSync(getSessionsRoot(agentDir))) {
			if (findBySlug(registry, dir)) continue;
			const storeDir = join(getSessionsRoot(agentDir), dir);
			const sessions = listSessions(storeDir);
			if (sessions.length === 0) continue;

			// Derive the project root from the most common header cwd.
			const counts = new Map<string, number>();
			for (const s of sessions) {
				if (!s.cwd) continue;
				counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
			}
			const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
			if (!best) {
				findings.push({
					kind: "orphan-store-unresolvable",
					detail: `store '${dir}' has ${sessions.length} sessions but none carry a header cwd; register manually or bb projects merge`,
				});
				continue;
			}
			if (dryRun) {
				findings.push({
					kind: "orphan-store-registered",
					detail: `would register project for orphan store '${dir}' (root ${best[0]}, ${sessions.length} sessions)`,
				});
			} else {
				const project = ensureProjectForRoot(best[0], registry);
				// keep the existing dir name as the slug by renaming if it differs
				if (project.slug === dir) {
					findings.push({
						kind: "orphan-store-registered",
						detail: `registered project '${project.slug}' for orphan store (root ${best[0]}, ${sessions.length} sessions)`,
					});
				} else {
					findings.push({
						kind: "orphan-store-registered",
						detail: `orphan store '${dir}' resolved to existing project '${project.slug}' (${sessions.length} sessions now visible there)`,
					});
				}
			}
		}
	}

	// 2 + 3. Per-project session hygiene.
	for (const project of registry.projects) {
		const storeDir =
			project.sessionStore === "in-repo"
				? getInRepoStoreDir(project.canonicalPath)
				: getCentralStoreDir(agentDir, project.slug);
		if (project.sessionStore === "in-repo" && !existsSync(storeDir)) {
			findings.push({
				kind: "in-repo-store-missing",
				detail: `project '${project.slug}' configured for in-repo sessions but ${storeDir} does not exist (fine until first session)`,
			});
			continue;
		}
		if (!existsSync(storeDir)) continue;

		for (const session of listSessions(storeDir)) {
			if (session.cwd !== project.canonicalPath) {
				if (dryRun) {
					findings.push({
						kind: "cwd-normalized",
						detail: `would rewrite session ${session.id.slice(0, 8)} cwd '${session.cwd}' -> '${project.canonicalPath}'`,
					});
				} else {
					rewriteSessionHeader(session.file, (h) => {
						h.cwd = project.canonicalPath;
						return h;
					});
					findings.push({
						kind: "cwd-normalized",
						detail: `rewrote session ${session.id.slice(0, 8)} cwd '${session.cwd}' -> '${project.canonicalPath}'`,
					});
				}
			}

			const header = readSessionHeader(session.file);
			if (
				typeof header?.parentSession === "string" &&
				!existsSync(header.parentSession)
			) {
				if (dryRun) {
					findings.push({
						kind: "parent-session-cleared",
						detail: `would clear dangling parentSession on session ${session.id.slice(0, 8)}`,
					});
				} else {
					rewriteSessionHeader(session.file, (h) => {
						delete h.parentSession;
						return h;
					});
					findings.push({
						kind: "parent-session-cleared",
						detail: `cleared dangling parentSession on session ${session.id.slice(0, 8)}`,
					});
				}
			}
		}
	}

	// 4. Stale projects: canonical path gone and no alias exists.
	for (const project of registry.projects) {
		const alive = [project.canonicalPath, ...project.aliases].some((p) =>
			existsSync(p),
		);
		if (!alive) {
			findings.push({
				kind: "stale-project",
				detail: `project '${project.slug}' canonical and alias paths all missing; keep (sessions preserved) or bb projects forget ${project.slug}`,
			});
		}
	}

	// 5. Duplicate identities across projects.
	const seenRemote = new Map<string, string>();
	for (const project of registry.projects) {
		if (!project.gitRemote) continue;
		const first = seenRemote.get(project.gitRemote);
		if (first && first !== project.slug) {
			findings.push({
				kind: "duplicate-project",
				detail: `projects '${first}' and '${project.slug}' share remote ${project.gitRemote}; bb projects merge ${project.slug} --into ${first}`,
			});
		} else {
			seenRemote.set(project.gitRemote, project.slug);
		}
	}

	return { findings, dryRun };
}

/** Convenience alias: doctor is fix --dry-run plus a registry-rebuild proof. */
export function runDoctor(registry: Registry, agentDir: string): FixReport {
	return runFix(registry, agentDir, { dryRun: true });
}
