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
import {
  loadRegistrySync,
  saveRegistrySync,
  syncConfigsAtLaunch,
} from "./db.ts";
import { resolveProject, storeDirFor } from "./resolution.ts";
import { trustPaths } from "./trust.ts";
import { getAgentDir } from "./agent-dir.ts";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

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
  const registry = opts.registry ?? loadRegistrySync(agentDir);
  // §Data: materialize settings.json/auth.json from (or into) blueberry.db
  if (opts.persist !== false) {
    syncConfigsAtLaunch(agentDir);
  }

  let plan: LaunchPlan;
  if (opts.projectSlug) {
    const project = registry.projects.find((p) => p.slug === opts.projectSlug);
    if (!project) {
      throw new Error(
        `no project '${opts.projectSlug}' (known: ${
          registry.projects.map((p) => p.slug).join(", ") || "none"
        })`,
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
      ...(opts.gitRemoteReader
        ? { gitRemoteReader: opts.gitRemoteReader }
        : {}),
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
      ...(opts.gitRemoteReader
        ? { gitRemoteReader: opts.gitRemoteReader }
        : {}),
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

  // PI_OFFLINE kills pi's startup network chatter (pi version check, package
  // update check → the 'Package Updates Available' banner, install telemetry).
  // Verified in pi source: model calls and model-catalog refresh are NOT gated
  // by this flag. Runs explicitly needing the checks can clear it.
  plan.env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: plan.sessionDir,
    PI_OFFLINE: process.env["PI_OFFLINE"] ?? "1",
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
    saveRegistrySync(agentDir, registry);
  }
  if (trusted && opts.persist !== false) {
    await trustPaths(agentDir, [root]);
  }
}

/**
 * Run the fork's pi IN-PROCESS (single-binary product): our entrypoint is the
 * one `main`; the forked pi framework is loaded as a library and its main()
 * is called directly. No subprocess, no sibling binary, no pre-built bundle —
 * `deno compile` folds the fork sources into OUR binary.
 */

/** The fork's exported main(), called as a library function. */
export type PiMain = (args: string[]) => unknown;

let piMainLoader: (() => Promise<PiMain>) | null = null;

/** Test seam: swap how the fork main is obtained (null restores the default). */
export function setPiMainLoader(loader: (() => Promise<PiMain>) | null): void {
  piMainLoader = loader;
}

async function loadPiMain(): Promise<PiMain> {
  const mod = await import("../../pi/packages/coding-agent/src/main.ts");
  const fn = mod.main as PiMain;
  if (typeof fn !== "function") throw new Error("fork main() is not callable");
  return fn;
}

/** Run the fork pi in-process per the plan. Returns pi's exit code. */
export type PiRunner = (plan: LaunchPlan) => Promise<number>;

/** Env keys the handover owns (restored afterward — tests run in-process). */
const HANDOVER_ENV = [
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "BLUEBERRY_DB",
  "PI_CODING_AGENT",
  "AI_AGENT",
] as const;

export async function defaultRunPi(plan: LaunchPlan): Promise<number> {
  const agentDir = plan.env["PI_CODING_AGENT_DIR"] ??
    join(homedir(), ".blueberry");

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of HANDOVER_ENV) savedEnv[key] = process.env[key];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_CODING_AGENT_SESSION_DIR"] = plan.sessionDir;
  process.env["PI_OFFLINE"] ??= "1";
  // DB-only persistence: derived from the agent dir (same rule as db.ts
  // openDb) — BLUEBERRY_AGENT_DIR test sandboxes get sandbox DBs for free.
  process.env["BLUEBERRY_DB"] ??= join(agentDir, "blueberry.db");
  // Replicate the fork's own cli.ts bootstrap — WE are the entry now.
  process.env["PI_CODING_AGENT"] = "true";
  process.env["AI_AGENT"] = "pi";
  try {
    process.emitWarning = (() => {}) as typeof process.emitWarning;
  } catch {
    // deno may pin emitWarning; harmless
  }

  const prevCwd = Deno.cwd();
  const prevExitCode = process.exitCode;
  try {
    const { configureHttpDispatcher } = await import(
      "../../pi/packages/coding-agent/src/core/http-dispatcher.ts"
    );
    configureHttpDispatcher();
    process.chdir(plan.root);
    const piMain = piMainLoader ? await piMainLoader() : await loadPiMain();
    await piMain(plan.argv);
    // node types exitCode as string | number; our contract is number
    return Number(process.exitCode ?? 0);
  } finally {
    process.chdir(prevCwd);
    for (const key of HANDOVER_ENV) {
      const v = savedEnv[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
    process.exitCode = prevExitCode;
  }
}
