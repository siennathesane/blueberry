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
import { existsSync, readFileSync } from "node:fs";
import { findBySlug, mutations } from "../core/registry.ts";
import { loadRegistrySync, saveRegistrySync } from "../core/db.ts";
import { getAgentDir, getTrashDir } from "../core/agent-dir.ts";
import { resolveProject, storeDirFor } from "../core/resolution.ts";
import {
  defaultRunPi,
  type PiRunner,
  prepareLaunch,
} from "../core/launcher.ts";
import { type AdoptOptions, adoptSessions } from "../core/adopt.ts";
import { runDoctor, runFix } from "../core/fix.ts";
import {
  listSessions,
  moveSession,
  renameSession,
  selectSession,
  trashSession,
} from "../core/sessions.ts";
import {
  forkSession,
  formatSearchHits,
  parseSessionFile,
  renderMessage,
  renderMessages,
  renderSummary,
  renderTree,
  resolveAddress,
  searchSessions,
  type ViewKind,
} from "../core/library.ts";
import { getVersion } from "../core/version.ts";
import { parseJunit, readLcovIfPresent } from "../core/lifecycle.ts";
import type { UpdaterIO } from "../core/updater.ts";
import { loadRegistryDb, openDb } from "../core/db.ts";
import { restoreMissing, syncStores } from "../core/sync.ts";
import {
  formatSessionHits,
  indexProject,
  searchCode,
  searchSessionsWithContext,
} from "../core/search.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliDeps {
  cwd: string;
  agentDir: string;
  runPi: PiRunner;
  out: (line: string) => void;
  err: (line: string) => void;
  gitRemoteReader?: (root: string) => string | null;
}

export function defaultDeps(): CliDeps {
  return {
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    runPi: defaultRunPi,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
  };
}

const LICENSE_SUMMARY = `blueberry licensing

  blueberry-authored code ....... PolyForm Strict License 1.0.0
                                   noncommercial use only; no distribution,
                                   sublicensing, modification, or contributions

  MIT-derived portions (pi/ and
  code compiled from it) ........ MIT License, (c) 2025 Mario Zechner
                                   (pi-mono). The MIT grant for those
                                   portions stands as written.

The full text of both licenses — including the MIT notice required to
travel with all copies and substantial portions — lives in LICENSE.md
at the repository root and ships with release binaries.`;

const USAGE = `blueberry — a personal agentic harness

usage:
  blueberry [flags] [args...]             launch the agent in this project (canonicalized to its root)
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
  blueberry update [--check]        self-update from GitHub releases
  blueberry --license               licensing summary (PolyForm Strict + MIT notice)
  blueberry cmd new 'n=cmd'... [--dep n:d]...  define a command graph
  blueberry cmd run <id|template> [--arg k=v] [--bg]  execute (waits; --bg detaches)
  blueberry cmd ls | ps | logs <id> [node]     inspect
  blueberry cmd template save <name> <p1,p2> 'n=cmd'...  store a template
  blueberry import [--from claude|kimi|all] [--apply] [--limit N]  import history (dry-run default)

launch flags:
  --here            keep this exact directory as session cwd (may fragment history)
  --project <slug>  launch a registered project from anywhere

session selectors: list index (1-based), uuid prefix (>=4), or exact name`;

export async function main(
  argv: readonly string[],
  deps: CliDeps,
): Promise<number> {
  // internal: detached executor — spawned by `cmd run --bg`; runs one
  // graph to completion, writing state to blueberry.db as it goes
  if (argv[0] === "cmd-executor") {
    let graphId = argv[1];
    if (!graphId) {
      deps.err("blueberry: cmd-executor needs a graph id");
      return 1;
    }
    // graph ids may arrive as display prefixes — resolve to full uuid
    const full = resolveGraph(openDb(deps.agentDir), graphId);
    if (!full) {
      deps.err(`blueberry: no graph '${graphId}'`);
      return 1;
    }
    graphId = full;
    const { runGraph } = await import("../core/cmd-graph.ts");
    const db = openDb(deps.agentDir);
    try {
      await runGraph(db, graphId);
      const g = db.prepare("SELECT status FROM cmd_graphs WHERE id = ?").get(
        graphId,
      ) as
        | { status: string }
        | undefined;
      return g?.status === "failed" ? 1 : 0;
    } finally {
      db.close();
    }
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    deps.out(USAGE);
    return 0;
  }
  if (argv.includes("--license")) {
    deps.out(LICENSE_SUMMARY);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    deps.out(`blueberry ${getVersion()}`);
    deps.out(
      "license: PolyForm Strict 1.0.0 + MIT notice (blueberry --license)",
    );
    return 0;
  }

  // --- update (self-update from GitHub releases; §Update) -------------------------

  // --- cmd (command graph; design 003) ----------------------------------------------

  // --- import (history → blueberry.db; #45) -------------------------------------------

  async function importCmd(rest: string[], deps: CliDeps): Promise<number> {
    const { importHistory } = await import("../core/import-history.ts");
    const source = rest.includes("--from")
      ? (rest[rest.indexOf("--from") + 1] as "claude" | "kimi" | "all")
      : "all";
    const apply = rest.includes("--apply");
    const limitFlag = rest.indexOf("--limit");
    const limit = limitFlag >= 0 ? Number(rest[limitFlag + 1]) : undefined;
    const db = openDb(deps.agentDir);
    try {
      const registry = loadRegistryDb(db);
      const byPath = new Map<string, string>();
      for (const p of registry.projects) {
        byPath.set(p.canonicalPath, p.id);
        for (const a of p.aliases) byPath.set(a, p.id);
      }
      const home = (await import("node:os")).homedir();
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      // auto-register projects for encountered cwds (the import's sources
      // ARE real projects on disk — registration is the natural step, same
      // as prepareLaunch mints; orphan-refusal then never bites)
      const { slugify } = await import("../core/util.ts");
      const { randomUUID } = await import("node:crypto");
      const { existsSync } = await import("node:fs");
      const { basename } = await import("node:path");
      const mint = new Map<string, string>();
      const regOrMint = (cwd: string | null): string | null => {
        if (cwd === null) return null;
        const hit = byPath.get(cwd);
        if (hit) return hit;
        const existing = mint.get(cwd);
        if (existing) return existing;
        if (!existsSync(cwd)) return null; // gone on disk: stays an orphan
        let slug = slugify(basename(cwd));
        const taken = new Set<string>(registry.projects.map((p) => p.slug));
        let n = 2;
        while (taken.has(slug)) slug = `${slugify(basename(cwd))}-${n++}`;
        const id = randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO projects (id, slug, canonical_path, session_store, trusted, created_at, updated_at) VALUES (?, ?, ?, 'central', 1, ?, ?)",
        ).run(id, slug, cwd, now, now);
        mint.set(cwd, id);
        return id;
      };
      const report = importHistory(
        db,
        regOrMint,
        {
          claude: join(home, ".claude", "projects"),
          kimi: join(home, ".kimi-code", "sessions"),
        },
        { source, apply, limit },
        join(tmpdir(), "bb-import"),
      );
      const mode = apply ? "imported" : "would import";
      deps.out(
        `${mode}: ${report.imported.length} · skipped: ${report.skipped} · errors: ${report.errors.length} (scanned ${report.scanned})`,
      );
      for (const s of report.imported.slice(0, 5)) {
        deps.out(
          `  ${s.source.padEnd(6)} ${s.cwd ?? "—"} · ${s.messages} msgs`,
        );
      }
      if (report.imported.length > 5) {
        deps.out(`  … +${report.imported.length - 5} more`);
      }
      for (const e of report.errors.slice(0, 3)) {
        deps.err(`  ${e.sessionId}: ${e.detail}`);
      }
      return report.errors.length > 0 && apply ? 1 : 0;
    } finally {
      db.close();
    }
  }

  async function cmdCmd(rest: string[], deps: CliDeps): Promise<number> {
    const {
      createGraph,
      listGraphs,
      getGraph,
      graphNodes,
      nodeOutput,
      runGraph,
      runTemplate,
      saveTemplate,
      getTemplate,
      purgeOutput,
    } = await import("../core/cmd-graph.ts");
    const [verb, ...args] = rest;
    const db = openDb(deps.agentDir);
    try {
      purgeOutput(db); // reaper-on-invocation
      const project = null; // graphs are project-agnostic for now (003 keeps options open)
      switch (verb) {
        case "new": {
          // bb cmd new 'name=cmd' 'name2=cmd2' [--dep name2:name1] [--name g]
          const nodes: Array<{ name: string; command: string }> = [];
          const edges: Array<{ node: string; dep: string }> = [];
          let name: string | undefined;
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!;
            if (a === "--dep") {
              const [node, dep] = (args[++i] ?? "").split(":");
              if (!node || !dep) {
                deps.err("blueberry: --dep takes node:dep");
                return 1;
              }
              edges.push({ node, dep });
            } else if (a === "--name") {
              name = args[++i];
            } else {
              const eq = a.indexOf("=");
              if (eq <= 0) {
                deps.err(
                  `blueberry: node spec must be name=command, got '${a}'`,
                );
                return 1;
              }
              nodes.push({ name: a.slice(0, eq), command: a.slice(eq + 1) });
            }
          }
          if (nodes.length === 0) {
            deps.err("blueberry: cmd new needs at least one name=command node");
            return 1;
          }
          const id = createGraph(db, project, nodes, edges, name);
          deps.out(id);
          return 0;
        }
        case "run": {
          // blueberry cmd run <graph-id> | blueberry cmd run <template> --arg k=v
          const target = args[0];
          if (!target) {
            deps.err("blueberry: cmd run needs a graph id or template name");
            return 1;
          }
          let id = target;
          if (getTemplate(db, target)) {
            const targs: Record<string, string> = {};
            for (const a of args.slice(1)) {
              if (a.startsWith("--arg ")) void 0;
            }
            // --arg k=v (repeatable)
            for (let i = 1; i < args.length; i++) {
              if (args[i] === "--arg") {
                const kv = (args[++i] ?? "").split("=");
                if (kv.length < 2) {
                  deps.err("blueberry: --arg takes k=v");
                  return 1;
                }
                targs[kv[0]!] = kv.slice(1).join("=");
              }
            }
            id = runTemplate(db, target, targs, project);
          }
          const resolved = resolveGraph(db, id);
          if (!resolved) {
            deps.err(`blueberry: no graph '${id}'`);
            return 1;
          }
          id = resolved;
          if (args.includes("--bg")) {
            // detached executor: the graph outlives this invocation.
            // dev mode: deno run entry.ts; compiled: re-exec self
            // (the binary IS the entry — argv[0] is blueberry itself)
            const { spawn } = await import("node:child_process");
            db.prepare(
              "UPDATE cmd_graphs SET status = 'queued', updated_at = ? WHERE id = ?",
            ).run(new Date().toISOString(), id);
            const execPath = Deno.execPath();
            const isCompiled = !/deno(\.exe)?$/.test(
              execPath.slice(execPath.lastIndexOf("/") + 1),
            );
            const child = isCompiled
              ? spawn(execPath, ["cmd-executor", id], {
                detached: true,
                stdio: "ignore",
                env: { ...process.env },
              })
              : spawn(
                execPath,
                [
                  "run",
                  "-A",
                  "--no-check",
                  new URL("./entry.ts", import.meta.url).pathname,
                  "cmd-executor",
                  id,
                ],
                { detached: true, stdio: "ignore", env: { ...process.env } },
              );
            child.unref();
            deps.out(`bg ${id.slice(0, 8)} (blueberry cmd ps / logs)`);
            return 0;
          }
          await runGraph(db, id);
          const g = getGraph(db, id)!;
          deps.out(`graph ${id.slice(0, 8)} ${g.status}`);
          return g.status === "failed" ? 1 : 0;
        }
        case "ls": {
          for (const g of listGraphs(db, project)) {
            deps.out(
              `${g.id.slice(0, 8)}  ${g.status.padEnd(8)} ${
                g.origin.padEnd(9)
              } ${g.name ?? "—"}`,
            );
          }
          return 0;
        }
        case "ps": {
          const running = listGraphs(db, project).filter(
            (g) => g.status === "running",
          );
          for (const g of running) {
            for (const n of graphNodes(db, g.id)) {
              if (n.status === "running") {
                deps.out(
                  `${g.id.slice(0, 8)}  ${
                    String(n.pid ?? "—").padEnd(7)
                  } ${n.name}`,
                );
              }
            }
          }
          return 0;
        }
        case "logs": {
          // blueberry cmd logs <graph-id> [node-name]
          const target = args[0];
          if (!target) {
            deps.err("blueberry: cmd logs needs a graph id");
            return 1;
          }
          const id = resolveGraph(db, target);
          if (!id) {
            deps.err(`blueberry: no graph '${target}'`);
            return 1;
          }
          const nodes = args[1]
            ? graphNodes(db, id).filter((n) => n.name === args[1])
            : graphNodes(db, id);
          for (const n of nodes) {
            deps.out(
              `── ${n.name} [${n.status}${
                n.exit_code === null ? "" : ` ${n.exit_code}`
              }] ──`,
            );
            for (const l of nodeOutput(db, n.id)) {
              deps.out(
                `  ${l.stream === "err" ? "!" : " "} ${
                  l.text.replace(/\n$/, "")
                }`,
              );
            }
          }
          return 0;
        }
        case "template": {
          const sub = args[0];
          if (sub === "save") {
            // blueberry cmd template save <name> <params=a,b> 'n=cmd'... --dep n:d
            const tname = args[1];
            if (!tname) {
              deps.err("blueberry: template save <name> <params> nodes...");
              return 1;
            }
            const params = (args[2] ?? "").split(",").filter((p) => p !== "");
            const nodes: Array<{ name: string; command: string }> = [];
            const edges: Array<{ node: string; dep: string }> = [];
            for (let i = 3; i < args.length; i++) {
              const a = args[i]!;
              if (a === "--dep") {
                const [node, dep] = (args[++i] ?? "").split(":");
                if (node && dep) edges.push({ node, dep });
              } else {
                const eq = a.indexOf("=");
                if (eq <= 0) {
                  deps.err(
                    `blueberry: node spec must be name=command, got '${a}'`,
                  );
                  return 1;
                }
                nodes.push({ name: a.slice(0, eq), command: a.slice(eq + 1) });
              }
            }
            saveTemplate(db, tname, { params, nodes, edges });
            deps.out(`template '${tname}' saved (${nodes.length} nodes)`);
            return 0;
          }
          if (sub === "list") {
            const rows = db
              .prepare(
                "SELECT name, updated_at FROM cmd_templates ORDER BY name",
              )
              .all() as Array<{ name: string; updated_at: string }>;
            for (const r of rows) {
              deps.out(`${r.name.padEnd(20)} ${r.updated_at}`);
            }
            return 0;
          }
          deps.err("blueberry: cmd template save|list");
          return 1;
        }
        default:
          deps.err(
            "blueberry: cmd new|run|ls|ps|logs|template — see DESIGN.md §command-graph",
          );
          return 1;
      }
    } catch (err) {
      deps.err(`blueberry: ${(err as Error).message}`);
      return 1;
    } finally {
      db.close();
    }
  }

  function resolveGraph(
    db: ReturnType<typeof openDb>,
    target: string,
  ): string | null {
    const exact = db
      .prepare("SELECT id FROM cmd_graphs WHERE id = ?")
      .get(target) as { id: string } | undefined;
    if (exact) return exact.id;
    const rows = db
      .prepare("SELECT id FROM cmd_graphs WHERE id LIKE ?")
      .all(`${target}%`) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : null;
  }

  async function updateCmd(rest: string[], deps: CliDeps): Promise<number> {
    const { checkForUpdate, performUpdate, UPDATER_REPO } = await import(
      "../core/updater.ts"
    );
    const platform = `${Deno.build.os}-${Deno.build.arch}`;
    const token = process.env["GITHUB_TOKEN"];
    const headers = { "User-Agent": "blueberry-updater" };
    const io: UpdaterIO = {
      async fetchJson(url, h) {
        const res = await fetch(url, { headers: { ...headers, ...h } });
        if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
        return await res.json();
      },
      async fetchBytes(url, h) {
        const res = await fetch(url, { headers: { ...headers, ...h } });
        if (!res.ok) {
          throw new Error(`download failed ${res.status} for ${url}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      },
      execPath: () => Deno.execPath(),
      writeFile: (path, bytes, mode) => Deno.writeFile(path, bytes, { mode }),
      rename: (from, to) => Deno.rename(from, to),
      exists: (path) => existsSync(path),
    };
    const version = getVersion();

    try {
      if (rest.includes("--check")) {
        const res = await checkForUpdate(
          version,
          platform,
          io,
          UPDATER_REPO,
          token,
        );
        if (res.updateAvailable) {
          deps.out(
            `update available: ${version} → ${res.latestTag} (${platform})`,
          );
          deps.out("run: blueberry update");
        } else if (res.assetUrl === null) {
          deps.out(
            `up to date (${version}); latest release has no ${platform} asset`,
          );
        } else {
          deps.out(`up to date (${version}, latest ${res.latestTag})`);
        }
        return 0;
      }
      deps.out(`blueberry ${version} · checking latest release…`);
      const res = await performUpdate(
        version,
        platform,
        io,
        UPDATER_REPO,
        token,
      );
      deps.out(`updated ${res.from} → ${res.to}`);
      deps.out(
        `replaced ${res.path} — restart blueberry to run the new version`,
      );
      return 0;
    } catch (err) {
      deps.err(`blueberry: update failed: ${(err as Error).message}`);
      return 1;
    }
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
    case "lifecycle":
      return lifecycleCmd(rest, deps);
    case "update":
      return updateCmd(rest, deps);
    case "cmd":
      return cmdCmd(rest, deps);
    case "import":
      return importCmd(rest, deps);
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
      ...(deps.gitRemoteReader
        ? { gitRemoteReader: deps.gitRemoteReader }
        : {}),
    });
    for (const action of plan.actions) deps.err(`blueberry: ${action}`);
    return await deps.runPi(plan);
  } catch (err) {
    deps.err(`blueberry: ${(err as Error).message}`);
    return 1;
  }
}

// --- current project helper ---------------------------------------------------

function currentProject(deps: CliDeps, slugOverride?: string) {
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

function projectsCmd(rest: string[], deps: CliDeps): number {
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
            ? ` -> nested into ${
              findBySlug(registry, p.mergedInto)?.slug ?? p.mergedInto
            }`
            : "";
          const store = p.sessionStore === "in-repo" ? "in-repo" : "central";
          deps.out(`${p.slug}  [${store}]${nested}  ${p.canonicalPath}`);
        }
        return 0;
      }
      case "rename": {
        const [slug, newName] = args;
        if (!slug || !newName) {
          return usageErr(deps, "projects rename <slug> <new>");
        }
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
        if (!from || !into) {
          return usageErr(deps, "projects merge <from> --into <to>");
        }
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
        if (!child || !parent) {
          return usageErr(deps, "projects nest <child> --into <parent>");
        }
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
        if (mode !== "central" && mode !== "repo") {
          return usageErr(deps, "projects sessions <central|repo> <slug>");
        }
        if (!slug) {
          return usageErr(deps, "projects sessions <central|repo> <slug>");
        }
        const registry = loadRegistrySync(deps.agentDir);
        mutations.setStoreMode(
          deps.agentDir,
          registry,
          slug,
          mode === "repo" ? "in-repo" : "central",
        );
        saveRegistrySync(deps.agentDir, registry);
        deps.out(
          `'${slug}' sessions now ${
            mode === "repo"
              ? "live in the repo (.blueberry/sessions)"
              : "centralized"
          }`,
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
        const { project } = currentProject(deps, projectFlag);
        const sessions = listSessions(storeDirFor(deps.agentDir, project));
        if (json) {
          deps.out(JSON.stringify(sessions, null, 2));
          return 0;
        }
        if (sessions.length === 0) {
          deps.out(`no sessions for '${project.slug}' yet`);
          return 0;
        }
        sessions.forEach((s, i) =>
          deps.out(fmtSession(s, project.slug, i + 1))
        );
        return 0;
      }
      case "rename": {
        const [sel, ...nameParts] = args;
        const name = nameParts.join(" ");
        if (!sel || !name) {
          return usageErr(deps, "sessions rename <sel> <name>");
        }
        const { project } = currentProject(deps, projectFlag);
        const session = selectSession(storeDirFor(deps.agentDir, project), sel);
        if (!session) return deps.err(`no session matching '${sel}'`), 1;
        renameSession(session.file, name);
        deps.out(`renamed session ${session.id.slice(0, 8)} -> '${name}'`);
        return 0;
      }
      case "move": {
        const [sel, targetSlug] = args;
        if (!sel || !targetSlug) {
          return usageErr(deps, "sessions move <sel> <project-slug>");
        }
        const registry = loadRegistrySync(deps.agentDir);
        const { project } = currentProject(deps, projectFlag);
        const target = findBySlug(registry, targetSlug);
        if (!target) return deps.err(`no project '${targetSlug}'`), 1;
        const session = selectSession(storeDirFor(deps.agentDir, project), sel);
        if (!session) return deps.err(`no session matching '${sel}'`), 1;
        const dest = moveSession(
          session.file,
          storeDirFor(deps.agentDir, target),
          {
            newCwd: target.canonicalPath,
          },
        );
        deps.out(
          `moved session ${
            session.id.slice(0, 8)
          } -> '${targetSlug}' (${dest})`,
        );
        return 0;
      }
      case "open": {
        const sel = args[0];
        if (!sel) return usageErr(deps, "sessions open <sel>");
        const { project } = currentProject(deps, projectFlag);
        const session = selectSession(storeDirFor(deps.agentDir, project), sel);
        if (!session) return deps.err(`no session matching '${sel}'`), 1;
        const plan = await prepareLaunch({
          cwd: deps.cwd,
          argv: ["--session", session.file],
          agentDir: deps.agentDir,
          projectSlug: project.slug,
          persist: false,
        });
        return await deps.runPi(plan);
      }
      case "trash": {
        const sel = args[0];
        if (!sel) return usageErr(deps, "sessions trash <sel>");
        const { project } = currentProject(deps, projectFlag);
        const session = selectSession(storeDirFor(deps.agentDir, project), sel);
        if (!session) return deps.err(`no session matching '${sel}'`), 1;
        const trashed = trashSession(session.file, getTrashDir(deps.agentDir));
        deps.out(`trashed session ${session.id.slice(0, 8)} -> ${trashed}`);
        return 0;
      }
      case "show": {
        const addr = positionals(rest, "show")[0];
        if (!addr) {
          return usageErr(
            deps,
            "sessions show <project/selector> [--view summary|tree|messages|message] [--offset N] [--limit N] [--message N]",
          );
        }
        const view = (extractValue(rest, "--view") ?? "summary") as ViewKind;
        const registry = loadRegistrySync(deps.agentDir);
        const { project: current } = currentProject(deps, projectFlag);
        const resolved = resolveAddress(
          registry,
          deps.agentDir,
          current.slug,
          addr,
        );
        const parsed = parseSessionFile(resolved.session.file);
        if (!parsed) {
          return deps.err(`cannot parse ${resolved.session.file}`), 1;
        }
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
            if (!Number.isInteger(n) || n < 1) {
              return usageErr(
                deps,
                "sessions show ... --view message --message N",
              );
            }
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
        const { project: current } = currentProject(deps, projectFlag);
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
        const { project: current } = currentProject(deps, projectFlag);
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
  return `${num}${
    s.id.slice(0, 8)
  }  ${date}  [${slug}] ${label} (${s.messageCount} msgs)${cwdNote}`;
}

// --- adopt / fix ----------------------------------------------------------------

function adoptCmd(rest: string[], deps: CliDeps): number {
  try {
    const sourceDir = rest.find((a) =>
      !a.startsWith("--") && !a.includes("=")
    ) ??
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

    for (const line of report.imported) {
      deps.out(
        `imported ${line.sessions} sessions -> ${line.project}${
          copy ? " (copied)" : ""
        }`,
      );
    }
    if (report.duplicates > 0) {
      deps.out(
        `skipped ${report.duplicates} sessions already present (nothing to do)`,
      );
    }
    if (report.stamped > 0) {
      deps.out(`stamped ${report.stamped} sessions with a missing header cwd`);
    }
    for (const s of report.skipped) deps.out(`skipped ${s.file}: ${s.reason}`);
    if (
      report.imported.length === 0 &&
      report.skipped.length === 0 &&
      report.duplicates === 0
    ) {
      deps.out("nothing to adopt");
    }
    return 0;
  } catch (err) {
    deps.err(`blueberry: ${(err as Error).message}`);
    return 1;
  }
}

// --- sync / restore --------------------------------------------------------------

function syncCmd(deps: CliDeps): number {
  try {
    const db = openDb(deps.agentDir);
    try {
      const registry = loadRegistryDb(db);
      const report = syncStores(db, deps.agentDir, registry);
      deps.out(
        `sync: ${report.ingested} ingested · ${report.unchanged} unchanged`,
      );
      for (const o of report.orphans) {
        deps.out(`orphan: ${o.file} (${o.detail})`);
      }
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

// --- lifecycle ----------------------------------------------------------------

async function lifecycleCmd(rest: string[], deps: CliDeps): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "junit": {
      const path = args[0];
      if (!path) return usageErr(deps, "lifecycle junit <path>");
      let xml: string;
      try {
        xml = readFileSync(path, "utf8");
      } catch {
        deps.err(`cannot read junit file: ${path}`);
        return 1;
      }
      const cases = parseJunit(xml);
      const db = openDb(deps.agentDir);
      try {
        const ins = db.prepare(
          "INSERT INTO junit_results (test_name, class_name, outcome, id, ts) VALUES (?, ?, ?, ?, ?)",
        );
        const ts = new Date().toISOString();
        for (const c of cases) {
          ins.run(c.testName, c.className, c.outcome, c.id, ts);
        }
      } finally {
        db.close();
      }
      const tagged = cases.filter((c) => c.id !== null).length;
      const failed = cases.filter((c) => c.outcome === "fail").length;
      deps.out(
        `ingested ${cases.length} cases (${tagged} tagged, ${failed} failed)`,
      );
      return 0;
    }
    case "lcov": {
      const path = args[0];
      if (!path) return usageErr(deps, "lifecycle lcov <path>");
      const summary = readLcovIfPresent(path);
      if (summary === null) {
        deps.err(`no lcov file at ${path} (or unreadable) — skipping; nothing stored`);
        return 0;
      }
      const db = openDb(deps.agentDir);
      try {
        db.prepare(
          "INSERT OR REPLACE INTO lcov_snapshot (path, lines_hit, lines_found, mtime, read_at) VALUES (?, ?, ?, ?, ?)",
        ).run(
          path,
          summary.linesHit,
          summary.linesFound,
          summary.mtime,
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
      deps.out(`lcov: ${summary.linesHit}/${summary.linesFound} lines (mtime ${summary.mtime})`);
      return 0;
    }
    default:
      return usageErr(deps, "lifecycle junit <path> | lcov <path>");
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
    if (!query) {
      return usageErr(deps, "search <text> [--code] [--docs] [--context N]");
    }
    const db = openDb(deps.agentDir);
    try {
      if (rest.includes("--code")) {
        // auto-index: a first-ever code query must work, not return "no
        // matches" against an empty index
        const { project } = currentProject(deps);
        indexProject(db, project.canonicalPath);
        const hits = searchCode(db, query);
        if (hits.length === 0) {
          deps.out("no matches");
          return 0;
        }
        for (const h of hits) {
          deps.out(`${h.path}:${h.line}  ${h.text.slice(0, 160)}`);
        }
        return 0;
      }
      if (rest.includes("--docs")) {
        // refresh design docs from disk, then search the unified index
        const { project: current } = currentProject(deps);
        const { ingestDesignDocs } = await import("../core/doc-index.ts");
        const report = ingestDesignDocs(db, current.canonicalPath, current.id);
        if (report.errors.length > 0) {
          for (const e of report.errors) {
            deps.out(`warn: ${e.file}: ${e.detail}`);
          }
        }
        const { searchDocs, formatDocHits } = await import(
          "../core/doc-index.ts"
        );
        const docHits = searchDocs(db, query);
        deps.out(formatDocHits(docHits));
        return 0;
      }
      const contextN = Number(rest[rest.indexOf("--context") + 1] ?? "");
      const opts = Number.isInteger(contextN) && contextN >= 0 && contextN <= 9
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

function restoreCmd(deps: CliDeps): number {
  try {
    const db = openDb(deps.agentDir);
    try {
      const restored = restoreMissing(db);
      if (restored.length === 0) deps.out("restore: nothing missing");
      for (const r of restored) {
        deps.out(`restored ${r.id.slice(0, 8)} -> ${r.path}`);
      }
    } finally {
      db.close();
    }
    return 0;
  } catch (err) {
    deps.err(`blueberry: ${(err as Error).message}`);
    return 1;
  }
}

function fixCmd(
  rest: string[],
  dryRun: boolean,
  deps: CliDeps,
): number {
  try {
    const registry = loadRegistrySync(deps.agentDir);
    const report = dryRun || rest.includes("--dry-run")
      ? runDoctor(registry, deps.agentDir)
      : runFix(registry, deps.agentDir);
    if (!dryRun && !rest.includes("--dry-run")) {
      saveRegistrySync(deps.agentDir, registry);
    }

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
