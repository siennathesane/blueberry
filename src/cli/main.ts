/**
 * blueberry CLI entry: management commands + pi launch mode.
 *
 *   blueberry [pi-args...]                    -> launch pi in this project
 *   blueberry projects list|rename|merge|forget|nest|unnest|sessions
 *   blueberry sessions list|rename|move|open|trash
 *   blueberry adopt [dir] [--map dir=path] [--copy]
 *   blueberry sync | restore
 *   blueberry search <text> [--code] [--context N]
 *   blueberry fix [--dry-run] | doctor
 *
 * main() is dependency-injected (cwd, io, spawn) so the command layer is
 * fully testable; bin/blueberry supplies the real process bindings.
 */
import { mutations, findBySlug } from "../core/registry.ts";
import { loadRegistrySync, saveRegistrySync } from "../core/db.ts";
import { getAgentDir, getTrashDir } from "../core/agent-dir.ts";
import { resolveProject, storeDirFor } from "../core/resolution.ts";
import {
	prepareLaunch,
	defaultSpawnPi,
	type PiSpawner,
} from "../core/launcher.ts";
import { adoptSessions, type AdoptOptions } from "../core/adopt.ts";
import { runFix, runDoctor } from "../core/fix.ts";
import {
	listSessions,
	renameSession,
	moveSession,
	trashSession,
	selectSession,
} from "../core/sessions.ts";
import {
	resolveAddress,
	parseSessionFile,
	renderSummary,
	renderTree,
	renderMessages,
	renderMessage,
	searchSessions,
	formatSearchHits,
	forkSession,
	type ViewKind,
} from "../core/library.ts";
import { getVersion } from "../core/version.ts";
import { openDb, loadRegistryDb } from "../core/db.ts";
import { syncStores, restoreMissing } from "../core/sync.ts";
import {
	searchSessionsWithContext,
	formatSessionHits,
	searchCode,
} from "../core/search.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliDeps {
	cwd: string;
	agentDir: string;
	spawn: PiSpawner;
	out: (line: string) => void;
	err: (line: string) => void;
	gitRemoteReader?: (root: string) => string | null;
}

export function defaultDeps(): CliDeps {
	return {
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		spawn: defaultSpawnPi,
		out: (l) => process.stdout.write(l + "\n"),
		err: (l) => process.stderr.write(l + "\n"),
	};
}

const USAGE = `blueberry — a personal pi distribution

usage:
  blueberry [flags] [pi-args...]          launch pi in this project (canonicalized)
  blueberry projects list [--json]
  blueberry projects rename <slug> <new>
  blueberry projects merge <from> --into <to>
  blueberry projects forget <slug> [--purge]
  blueberry projects nest <child> --into <parent>
  blueberry projects unnest <child>
  blueberry projects sessions <central|repo> <slug>
  blueberry sessions list [--all] [--json]
  blueberry sessions rename <sel> <name>
  blueberry sessions move <sel> <project-slug>
  blueberry sessions open <sel>
  blueberry sessions trash <sel>
  blueberry sessions show <[project/]sel> [--view summary|tree|messages|message] [--offset N] [--limit N] [--message N]
  blueberry sessions search <text> [--all]
  blueberry sessions fork <[project/]sel>
  blueberry adopt [dir] [--map <mangled-dir>=<root>] [--copy]
  blueberry sync            ingest session stores into blueberry.db
  blueberry restore         rebuild missing session files from the DB
  blueberry search <text> [--code] [--context N]  FTS5 search (history + code)
  blueberry fix [--dry-run]
  blueberry doctor

launch flags:
  --here            keep this exact directory as session cwd (may fragment history)
  --project <slug>  launch a registered project from anywhere

session selectors: list index (1-based), uuid prefix (>=4), or exact name`;

export async function main(
	argv: readonly string[],
	deps: CliDeps,
): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		deps.out(USAGE);
		return 0;
	}
	if (argv.includes("--version") || argv.includes("-v")) {
		deps.out(`blueberry ${getVersion()}`);
		return 0;
	}

	const [cmd, ...rest] = argv;
	switch (cmd) {
		case undefined:
			return launchMode(argv, deps);
		case "projects":
			return projectsCmd(rest, deps);
		case "sessions":
			return sessionsCmd(rest, deps);
		case "adopt":
			return adoptCmd(rest, deps);
		case "fix":
			return fixCmd(rest, false, deps);
		case "doctor":
			return fixCmd(rest, true, deps);
		case "sync":
			return syncCmd(deps);
		case "restore":
			return restoreCmd(deps);
		case "search":
			return searchCmd(rest, deps);
		default:
			// anything that isn't a known subcommand is treated as pi launch
			return launchMode(argv, deps);
	}
}

// --- launch -----------------------------------------------------------------

async function launchMode(
	argv: readonly string[],
	deps: CliDeps,
): Promise<number> {
	const here = argv.includes("--here");
	const projectIdx = argv.indexOf("--project");
	const projectSlug = projectIdx >= 0 ? argv[projectIdx + 1] : undefined;
	// strip blueberry-specific flags and --project's value; keep everything else for pi
	const skipIndexes = new Set<number>();
	if (projectIdx >= 0) {
		skipIndexes.add(projectIdx);
		skipIndexes.add(projectIdx + 1);
	}
	const piArgs = argv.filter((a, i) => a !== "--here" && !skipIndexes.has(i));

	try {
		const plan = await prepareLaunch({
			cwd: deps.cwd,
			argv: piArgs,
			agentDir: deps.agentDir,
			here,
			...(projectSlug ? { projectSlug } : {}),
			...(deps.gitRemoteReader ? { gitRemoteReader: deps.gitRemoteReader } : {}),
		});
		for (const action of plan.actions) deps.err(`blueberry: ${action}`);
		return await deps.spawn(plan);
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

// --- current project helper ---------------------------------------------------

async function currentProject(deps: CliDeps, slugOverride?: string) {
	const registry = loadRegistrySync(deps.agentDir);
	if (slugOverride) {
		const p = findBySlug(registry, slugOverride);
		if (!p) throw new Error(`no project '${slugOverride}'`);
		return { registry, project: p };
	}
	const res = resolveProject({
		cwd: deps.cwd,
		registry,
		...(deps.gitRemoteReader ? { gitRemoteReader: deps.gitRemoteReader } : {}),
	});
	return { registry, project: res.project };
}

// --- projects ------------------------------------------------------------------

async function projectsCmd(rest: string[], deps: CliDeps): Promise<number> {
	const [sub, ...args] = rest;
	try {
		switch (sub) {
			case "list": {
				const registry = loadRegistrySync(deps.agentDir);
				const json = args.includes("--json");
				if (json) {
					deps.out(JSON.stringify(registry.projects, null, 2));
					return 0;
				}
				if (registry.projects.length === 0) {
					deps.out(
						"no projects registered — launch blueberry in a directory to mint one",
					);
					return 0;
				}
				for (const p of registry.projects) {
					const nested = p.mergedInto
						? ` -> nested into ${findBySlug(registry, p.mergedInto)?.slug ?? p.mergedInto}`
						: "";
					const store = p.sessionStore === "in-repo" ? "in-repo" : "central";
					deps.out(`${p.slug}  [${store}]${nested}  ${p.canonicalPath}`);
				}
				return 0;
			}
			case "rename": {
				const [slug, newName] = args;
				if (!slug || !newName)
					return usageErr(deps, "projects rename <slug> <new>");
				const registry = loadRegistrySync(deps.agentDir);
				mutations.renameSlug(deps.agentDir, registry, slug, newName);
				saveRegistrySync(deps.agentDir, registry);
				deps.out(`renamed '${slug}' -> '${newName}' (store moved)`);
				return 0;
			}
			case "merge": {
				const from = args[0];
				const intoIdx = args.indexOf("--into");
				const into = intoIdx >= 0 ? args[intoIdx + 1] : undefined;
				if (!from || !into)
					return usageErr(deps, "projects merge <from> --into <to>");
				const registry = loadRegistrySync(deps.agentDir);
				const { survivor, moved } = mutations.merge(
					deps.agentDir,
					registry,
					from,
					into,
				);
				saveRegistrySync(deps.agentDir, registry);
				deps.out(
					`merged '${from}' into '${survivor.slug}' (${moved} sessions moved)`,
				);
				return 0;
			}
			case "forget": {
				const slug = args[0];
				if (!slug) return usageErr(deps, "projects forget <slug> [--purge]");
				const purge = args.includes("--purge");
				const registry = loadRegistrySync(deps.agentDir);
				const { storeDir } = mutations.forget(deps.agentDir, registry, slug, {
					purge,
				});
				saveRegistrySync(deps.agentDir, registry);
				deps.out(
					storeDir
						? `forgot '${slug}' (sessions kept at ${storeDir})`
						: `forgot '${slug}'${purge ? " (store purged)" : ""}`,
				);
				return 0;
			}
			case "nest": {
				const child = args[0];
				const intoIdx = args.indexOf("--into");
				const parent = intoIdx >= 0 ? args[intoIdx + 1] : undefined;
				if (!child || !parent)
					return usageErr(deps, "projects nest <child> --into <parent>");
				const registry = loadRegistrySync(deps.agentDir);
				mutations.setNested(registry, child, parent);
				saveRegistrySync(deps.agentDir, registry);
				deps.out(
					`sessions of '${child}' now belong to '${parent}' (existing sessions: move with 'sessions move')`,
				);
				return 0;
			}
			case "unnest": {
				const child = args[0];
				if (!child) return usageErr(deps, "projects unnest <child>");
				const registry = loadRegistrySync(deps.agentDir);
				mutations.setNested(registry, child, null);
				saveRegistrySync(deps.agentDir, registry);
				deps.out(`'${child}' has its own sessions again`);
				return 0;
			}
			case "sessions": {
				const [mode, slug] = args;
				if (mode !== "central" && mode !== "repo")
					return usageErr(deps, "projects sessions <central|repo> <slug>");
				if (!slug) return usageErr(deps, "projects sessions <central|repo> <slug>");
				const registry = loadRegistrySync(deps.agentDir);
				mutations.setStoreMode(
					deps.agentDir,
					registry,
					slug,
					mode === "repo" ? "in-repo" : "central",
				);
				saveRegistrySync(deps.agentDir, registry);
				deps.out(
					`'${slug}' sessions now ${mode === "repo" ? "live in the repo (.blueberry/sessions)" : "centralized"}`,
				);
				return 0;
			}
			default:
				return usageErr(
					deps,
					"projects list|rename|merge|forget|nest|unnest|sessions",
				);
		}
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

// --- sessions -----------------------------------------------------------------

async function sessionsCmd(rest: string[], deps: CliDeps): Promise<number> {
	const projectFlag = extractValue(rest, "--project");
	const [sub, ...args] = stripFlags(rest, ["--project", "--all", "--json"]);
	try {
		switch (sub) {
			case "list": {
				const all = rest.includes("--all");
				const json = rest.includes("--json");
				if (all) {
					const registry = loadRegistrySync(deps.agentDir);
					const lines: unknown[] = [];
					for (const p of registry.projects) {
						for (const s of listSessions(storeDirFor(deps.agentDir, p))) {
							lines.push(json ? s : fmtSession(s, p.slug));
						}
					}
					if (json) deps.out(JSON.stringify(lines, null, 2));
					else lines.forEach((l) => deps.out(String(l)));
					return 0;
				}
				const { project } = await currentProject(deps, projectFlag);
				const sessions = listSessions(storeDirFor(deps.agentDir, project));
				if (json) {
					deps.out(JSON.stringify(sessions, null, 2));
					return 0;
				}
				if (sessions.length === 0) {
					deps.out(`no sessions for '${project.slug}' yet`);
					return 0;
				}
				sessions.forEach((s, i) => deps.out(fmtSession(s, project.slug, i + 1)));
				return 0;
			}
			case "rename": {
				const [sel, ...nameParts] = args;
				const name = nameParts.join(" ");
				if (!sel || !name) return usageErr(deps, "sessions rename <sel> <name>");
				const { project } = await currentProject(deps, projectFlag);
				const session = selectSession(storeDirFor(deps.agentDir, project), sel);
				if (!session) return deps.err(`no session matching '${sel}'`), 1;
				renameSession(session.file, name);
				deps.out(`renamed session ${session.id.slice(0, 8)} -> '${name}'`);
				return 0;
			}
			case "move": {
				const [sel, targetSlug] = args;
				if (!sel || !targetSlug)
					return usageErr(deps, "sessions move <sel> <project-slug>");
				const registry = loadRegistrySync(deps.agentDir);
				const { project } = await currentProject(deps, projectFlag);
				const target = findBySlug(registry, targetSlug);
				if (!target) return deps.err(`no project '${targetSlug}'`), 1;
				const session = selectSession(storeDirFor(deps.agentDir, project), sel);
				if (!session) return deps.err(`no session matching '${sel}'`), 1;
				const dest = moveSession(session.file, storeDirFor(deps.agentDir, target), {
					newCwd: target.canonicalPath,
				});
				deps.out(
					`moved session ${session.id.slice(0, 8)} -> '${targetSlug}' (${dest})`,
				);
				return 0;
			}
			case "open": {
				const sel = args[0];
				if (!sel) return usageErr(deps, "sessions open <sel>");
				const { project } = await currentProject(deps, projectFlag);
				const session = selectSession(storeDirFor(deps.agentDir, project), sel);
				if (!session) return deps.err(`no session matching '${sel}'`), 1;
				const plan = await prepareLaunch({
					cwd: deps.cwd,
					argv: ["--session", session.file],
					agentDir: deps.agentDir,
					projectSlug: project.slug,
					persist: false,
				});
				return await deps.spawn(plan);
			}
			case "trash": {
				const sel = args[0];
				if (!sel) return usageErr(deps, "sessions trash <sel>");
				const { project } = await currentProject(deps, projectFlag);
				const session = selectSession(storeDirFor(deps.agentDir, project), sel);
				if (!session) return deps.err(`no session matching '${sel}'`), 1;
				const trashed = trashSession(session.file, getTrashDir(deps.agentDir));
				deps.out(`trashed session ${session.id.slice(0, 8)} -> ${trashed}`);
				return 0;
			}
			case "show": {
				const addr = positionals(rest, "show")[0];
				if (!addr)
					return usageErr(
						deps,
						"sessions show <project/selector> [--view summary|tree|messages|message] [--offset N] [--limit N] [--message N]",
					);
				const view = (extractValue(rest, "--view") ?? "summary") as ViewKind;
				const registry = loadRegistrySync(deps.agentDir);
				const { project: current } = await currentProject(deps, projectFlag);
				const resolved = resolveAddress(
					registry,
					deps.agentDir,
					current.slug,
					addr,
				);
				const parsed = parseSessionFile(resolved.session.file);
				if (!parsed) return deps.err(`cannot parse ${resolved.session.file}`), 1;
				switch (view) {
					case "summary":
						deps.out(renderSummary(resolved.session, parsed));
						break;
					case "tree":
						deps.out(renderTree(parsed));
						break;
					case "messages": {
						const offset = Number(extractValue(rest, "--offset") ?? 0);
						const limit = Number(extractValue(rest, "--limit") ?? 80);
						deps.out(renderMessages(parsed, offset, limit));
						break;
					}
					case "message": {
						const n = Number(extractValue(rest, "--message") ?? 0);
						if (!Number.isInteger(n) || n < 1)
							return usageErr(deps, "sessions show ... --view message --message N");
						deps.out(renderMessage(parsed, n));
						break;
					}
					default:
						return usageErr(
							deps,
							"sessions show ... --view summary|tree|messages|message",
						);
				}
				return 0;
			}
			case "search": {
				const text = positionals(rest, "search").join(" ");
				if (!text) return usageErr(deps, "sessions search <text> [--all]");
				const registry = loadRegistrySync(deps.agentDir);
				const { project: current } = await currentProject(deps, projectFlag);
				const hits = searchSessions(registry, deps.agentDir, text, {
					all: rest.includes("--all"),
					currentSlug: current.slug,
				});
				deps.out(formatSearchHits(hits));
				return 0;
			}
			case "fork": {
				const addr = positionals(rest, "fork")[0];
				if (!addr) return usageErr(deps, "sessions fork <project/selector>");
				const registry = loadRegistrySync(deps.agentDir);
				const { project: current } = await currentProject(deps, projectFlag);
				const resolved = resolveAddress(
					registry,
					deps.agentDir,
					current.slug,
					addr,
				);
				const result = forkSession({
					agentDir: deps.agentDir,
					sourceFile: resolved.session.file,
					sourceProject: resolved.project,
					sourceSession: resolved.session,
					targetProject: current,
				});
				deps.out(`forked -> ${result.name}`);
				deps.out(result.file);
				return 0;
			}
			default:
				return usageErr(
					deps,
					"sessions list|rename|move|open|trash|show|search|fork",
				);
		}
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

function fmtSession(
	s: ReturnType<typeof listSessions>[number],
	slug: string,
	index?: number,
): string {
	const num = index === undefined ? "" : `${index}. `;
	const label = s.name ?? s.firstUserText?.slice(0, 60) ?? "(empty)";
	const date = new Date(s.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
	const cwdNote = s.cwd && s.cwd !== "" ? "" : " [no cwd]";
	return `${num}${s.id.slice(0, 8)}  ${date}  [${slug}] ${label} (${s.messageCount} msgs)${cwdNote}`;
}

// --- adopt / fix ----------------------------------------------------------------

async function adoptCmd(rest: string[], deps: CliDeps): Promise<number> {
	try {
		const sourceDir =
			rest.find((a) => !a.startsWith("--") && !a.includes("=")) ??
			join(homedir(), ".pi", "agent", "sessions");
		const map: Record<string, string> = {};
		for (const a of rest) {
			const eq = a.indexOf("=");
			if (a.startsWith("--map")) continue;
			if (eq > 0) {
				const k = a.slice(0, eq);
				const v = a.slice(eq + 1);
				if (!k.startsWith("--")) map[k] = v;
			}
		}
		// --map k=v handled: pairs after the flag
		const mapIdx = rest.indexOf("--map");
		if (mapIdx >= 0 && rest[mapIdx + 1]?.includes("=")) {
			const [k, v] = rest[mapIdx + 1]!.split("=");
			if (k && v) map[k] = v;
		}

		const registry = loadRegistrySync(deps.agentDir);
		const copy = rest.includes("--copy");
		const adoptOpts: AdoptOptions = { sourceDir, agentDir: deps.agentDir, map };
		if (copy) adoptOpts.copy = true;
		const report = adoptSessions(registry, adoptOpts);
		saveRegistrySync(deps.agentDir, registry);

		for (const line of report.imported)
			deps.out(
				`imported ${line.sessions} sessions -> ${line.project}${copy ? " (copied)" : ""}`,
			);
		if (report.duplicates > 0)
			deps.out(
				`skipped ${report.duplicates} sessions already present (nothing to do)`,
			);
		if (report.stamped > 0)
			deps.out(`stamped ${report.stamped} sessions with a missing header cwd`);
		for (const s of report.skipped) deps.out(`skipped ${s.file}: ${s.reason}`);
		if (
			report.imported.length === 0 &&
			report.skipped.length === 0 &&
			report.duplicates === 0
		)
			deps.out("nothing to adopt");
		return 0;
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

// --- sync / restore --------------------------------------------------------------

async function syncCmd(deps: CliDeps): Promise<number> {
	try {
		const db = openDb(deps.agentDir);
		try {
			const registry = loadRegistryDb(db);
			const report = syncStores(db, deps.agentDir, registry);
			deps.out(
				`sync: ${report.ingested} ingested · ${report.unchanged} unchanged`,
			);
			for (const o of report.orphans) deps.out(`orphan: ${o.file} (${o.detail})`);
			for (const e of report.errors) deps.out(`error: ${e.file} (${e.detail})`);
		} finally {
			db.close();
		}
		return 0;
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

// --- search -----------------------------------------------------------------

async function searchCmd(rest: string[], deps: CliDeps): Promise<number> {
	try {
		// positional tokens, skipping flags AND their values (--context N)
		const skipNext = new Set(["--context"]);
		const positional: string[] = [];
		for (let i = 0; i < rest.length; i++) {
			if (skipNext.has(rest[i]!)) {
				i++;
				continue;
			}
			if (!rest[i]!.startsWith("--")) positional.push(rest[i]!);
		}
		const query = positional.join(" ");
		if (!query) return usageErr(deps, "search <text> [--code] [--context N]");
		const db = openDb(deps.agentDir);
		try {
			if (rest.includes("--code")) {
				const hits = searchCode(db, query);
				if (hits.length === 0) {
					deps.out("no matches");
					return 0;
				}
				for (const h of hits)
					deps.out(`${h.path}:${h.line}  ${h.text.slice(0, 160)}`);
				return 0;
			}
			const contextN = Number(rest[rest.indexOf("--context") + 1] ?? "");
			const opts =
				Number.isInteger(contextN) && contextN >= 0 && contextN <= 9
					? { contextBefore: contextN, contextAfter: contextN }
					: {};
			const hits = searchSessionsWithContext(db, query, opts);
			deps.out(formatSessionHits(hits));
			return 0;
		} finally {
			db.close();
		}
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

async function restoreCmd(deps: CliDeps): Promise<number> {
	try {
		const db = openDb(deps.agentDir);
		try {
			const restored = restoreMissing(db);
			if (restored.length === 0) deps.out("restore: nothing missing");
			for (const r of restored)
				deps.out(`restored ${r.id.slice(0, 8)} -> ${r.path}`);
		} finally {
			db.close();
		}
		return 0;
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

async function fixCmd(
	rest: string[],
	dryRun: boolean,
	deps: CliDeps,
): Promise<number> {
	try {
		const registry = loadRegistrySync(deps.agentDir);
		const report =
			dryRun || rest.includes("--dry-run")
				? runDoctor(registry, deps.agentDir)
				: runFix(registry, deps.agentDir);
		if (!dryRun && !rest.includes("--dry-run"))
			saveRegistrySync(deps.agentDir, registry);

		if (report.findings.length === 0) {
			deps.out("all clear — registry, stores, and sessions consistent");
			return 0;
		}
		for (const f of report.findings) deps.out(`${f.kind}: ${f.detail}`);
		return 0;
	} catch (err) {
		deps.err(`blueberry: ${(err as Error).message}`);
		return 1;
	}
}

// --- arg helpers ----------------------------------------------------------------

function extractValue(
	args: readonly string[],
	flag: string,
): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

/** Positional tokens after a subcommand, ignoring flag tokens and their values. */
function positionals(rest: readonly string[], sub: string): string[] {
	const idx = rest.indexOf(sub);
	if (idx < 0) return [];
	const out: string[] = [];
	for (let i = idx + 1; i < rest.length; i++) {
		const tok = rest[i]!;
		if (tok.startsWith("--")) {
			if (
				tok === "--view" ||
				tok === "--offset" ||
				tok === "--limit" ||
				tok === "--message" ||
				tok === "--project"
			) {
				i++; // skip the value
			}
			continue;
		}
		out.push(tok);
	}
	return out;
}

function stripFlags(args: readonly string[], flags: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i]!)) {
			i++; // skip its value too
			continue;
		}
		out.push(args[i]!);
	}
	return out;
}

function usageErr(deps: CliDeps, usage: string): number {
	deps.err(`usage: blueberry ${usage}`);
	return 2;
}
