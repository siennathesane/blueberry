/**
 * Launch preparation: resolve the project, canonicalize to its root, and
 * produce the exact cwd/env/argv pi should be spawned with.
 *
 * Canonicalization has two halves that only work together:
 *   store half — PI_CODING_AGENT_SESSION_DIR points at the project's store
 *   cwd half   — we chdir to the project root so session headers carry the
 *                root (pi's resume filtering is exact-cwd-equality)
 *
 * Because the chdir changes path meaning, path-like CLI arguments are
 * rewritten to absolute paths against the ORIGINAL cwd first.
 */
import type { Registry } from "./registry.ts";
import { loadRegistry, saveRegistry } from "./registry.ts";
import { resolveProject, storeDirFor } from "./resolution.ts";
import { trustPaths } from "./trust.ts";
import { getAgentDir } from "./agent-dir.ts";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

/** Flags whose values are path-like (absolutized before chdir). */
const PATH_FLAGS = new Set([
	"--session",
	"--fork",
	"--session-dir",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
]);

/** Rewrite path-like argv entries to absolute, relative to fromDir. */
export function rewriteArgsForCwd(
	argv: readonly string[],
	fromDir: string,
): string[] {
	const out: string[] = [];
	let expectPathValue = false;

	for (const arg of argv) {
		if (expectPathValue) {
			expectPathValue = false;
			out.push(absolutize(arg, fromDir));
			continue;
		}
		if (PATH_FLAGS.has(arg)) {
			expectPathValue = true;
			out.push(arg);
			continue;
		}
		if (
			arg.startsWith("--") &&
			arg.includes("=") &&
			PATH_FLAGS.has(arg.slice(0, arg.indexOf("=")))
		) {
			const [flag, ...rest] = arg.split("=");
			out.push(`${flag}=${absolutize(rest.join("="), fromDir)}`);
			continue;
		}
		if (arg.startsWith("@")) {
			const path = arg.slice(1);
			out.push("@" + absolutize(path, fromDir));
			continue;
		}
		out.push(arg);
	}
	return out;
}

function absolutize(p: string, fromDir: string): string {
	if (p === "" || isAbsolute(p)) return p;
	// bare tokens (uuid prefixes, names, urls) are left alone: only things that
	// look like relative paths get rewritten
	if (
		!p.startsWith("./") &&
		!p.startsWith("../") &&
		!p.startsWith(".") &&
		!p.startsWith("~") &&
		!p.includes("/")
	) {
		return p;
	}
	return resolvePath(fromDir, p);
}

export interface LaunchPlan {
	root: string;
	sessionDir: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
	actions: string[];
}

export interface LaunchOptions {
	cwd: string;
	argv: readonly string[];
	agentDir?: string;
	/** registry override (tests); loads from disk when omitted */
	registry?: Registry;
	/** skip cwd canonicalization (--here): keep launch dir as session identity */
	here?: boolean;
	/** force a specific project slug (--project) */
	projectSlug?: string;
	/** persist registry mutations (disabled in tests when registry injected) */
	persist?: boolean;
	gitRemoteReader?: (root: string) => string | null;
}

/** Compute the full launch plan without spawning anything. */
export async function prepareLaunch(opts: LaunchOptions): Promise<LaunchPlan> {
	const agentDir = opts.agentDir ?? getAgentDir();
	const registry = opts.registry ?? loadRegistry(agentDir);

	let plan: LaunchPlan;
	if (opts.projectSlug) {
		const project = registry.projects.find((p) => p.slug === opts.projectSlug);
		if (!project) {
			throw new Error(
				`no project '${opts.projectSlug}' (known: ${registry.projects.map((p) => p.slug).join(", ") || "none"})`,
			);
		}
		plan = {
			root: project.canonicalPath,
			sessionDir: storeDirFor(agentDir, project),
			argv: rewriteArgsForCwd(opts.argv, opts.cwd),
			env: process.env,
			actions: [`forced project '${project.slug}'`],
		};
	} else if (opts.here) {
		// --here: session identity is this exact directory; store still resolves
		// via the boundary project so files never leave the project's store.
		const res = resolveProject({
			cwd: opts.cwd,
			registry,
			...(opts.gitRemoteReader ? { gitRemoteReader: opts.gitRemoteReader } : {}),
		});
		plan = {
			root: opts.cwd,
			sessionDir: storeDirFor(agentDir, res.project),
			argv: rewriteArgsForCwd(opts.argv, opts.cwd),
			env: process.env,
			actions: [
				...res.actions,
				"--here: cwd NOT canonicalized (history may fragment)",
			],
		};
		await finalizeResolution(
			agentDir,
			registry,
			res.registryMutated,
			opts,
			res.root,
			res.project.trusted,
		);
	} else {
		const res = resolveProject({
			cwd: opts.cwd,
			registry,
			...(opts.gitRemoteReader ? { gitRemoteReader: opts.gitRemoteReader } : {}),
		});
		plan = {
			root: res.root,
			sessionDir: storeDirFor(agentDir, res.project),
			argv: rewriteArgsForCwd(opts.argv, opts.cwd),
			env: process.env,
			actions: res.actions,
		};
		await finalizeResolution(
			agentDir,
			registry,
			res.registryMutated,
			opts,
			res.root,
			res.project.trusted,
		);
	}

	mkdirSync(plan.sessionDir, { recursive: true });

	plan.env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: plan.sessionDir,
	};
	return plan;
}

async function finalizeResolution(
	agentDir: string,
	registry: Registry,
	mutated: boolean,
	opts: LaunchOptions,
	root: string,
	trusted: boolean,
): Promise<void> {
	if (mutated && opts.persist !== false) {
		await saveRegistry(agentDir, registry);
	}
	if (trusted && opts.persist !== false) {
		await trustPaths(agentDir, [root]);
	}
}

/** Spawn pi per the plan. Returns pi's exit code. Injectable for tests. */
export type PiSpawner = (plan: LaunchPlan) => Promise<number>;

export function defaultSpawnPi(plan: LaunchPlan): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("pi", plan.argv, {
			cwd: plan.root,
			env: plan.env,
			stdio: "inherit",
		});
		for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.on(sig, () => child.kill(sig));
		}
		child.on("error", reject);
		child.on("close", (code) => resolvePromise(code ?? 0));
	});
}
