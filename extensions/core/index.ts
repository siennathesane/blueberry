/**
 * blueberry core — identity: opener header, terminal title, session-start guard.
 *
 * The opener replaces pi's stock startup header (DESIGN.md §Identity):
 *   line 1 — identity
 *   line 2 — project · branch · session (state at a glance)
 *   line 3 — one hint line (shortcuts aren't discoverable otherwise)
 * Everything else (resource listings, update banners) is suppressed, not
 * decorated over: quietStartup in settings, PI_OFFLINE in the launcher.
 * Skills stay model-side — the header never lists them (user decision).
 *
 * pi re-asserts its own terminal title on session events (updateTerminalTitle);
 * we re-assert ours on session_start and session_info_changed.
 *
 * The guard (§Sessions) warns when a launch would fragment history — the one
 * startup message that SHOULD interrupt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findProjectBoundary } from "../../src/core/markers.ts";
import { getVersion } from "../../src/core/version.ts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Current branch name from .git/HEAD; null when not a git repo / unreadable. */
function gitBranch(root: string): string | null {
	try {
		const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		if (match) return match[1]!;
		if (head !== "") return "detached";
	} catch {
		// no .git (lore repos, plain dirs): no branch segment
	}
	return null;
}

function lastSegment(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

export default function (pi: ExtensionAPI) {
	// /exit — the muscle-memory command pi never shipped. Graceful: defers
	// until the agent is idle (queued messages drain first) and emits
	// session_shutdown, so every cleanup hook runs.
	pi.registerCommand("exit", {
		description: "Quit blueberry",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	const applyIdentity = (
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		reason: string,
	) => {
		const cwd = resolve(ctx.cwd);
		const boundary = findProjectBoundary(cwd);
		const root = boundary ? boundary.root : cwd;
		const name = lastSegment(root);
		const branch = boundary ? gitBranch(root) : null;
		const sessionId = ctx.sessionManager.getSessionId().slice(0, 8);
		const resumed = reason === "resume" || reason === "fork";

		if (ctx.mode === "tui") {
			ctx.ui.setHeader((_tui, theme) => ({
				render(_width: number): string[] {
					const line1 =
						theme.fg("accent", theme.bold("🫐 blueberry")) +
						theme.fg("muted", ` ${getVersion()}`) +
						theme.fg("dim", " · orange juice");
					const segments = [name];
					if (branch) segments.push(branch);
					segments.push(`session ${sessionId}`);
					if (resumed) segments.push("resumed");
					const line2 = theme.fg("muted", segments.join(" · "));
					const line3 = theme.fg(
						"dim",
						"esc interrupt · / commands · ctrl+o everything else",
					);
					return [line1, line2, line3];
				},
				invalidate() {},
			}));
			ctx.ui.setTitle(`blueberry — ${name}`);
		}
		return { cwd, boundary };
	};

	pi.on("session_start", (event, ctx) => {
		const { cwd, boundary } = applyIdentity(ctx, event.reason);

		// Fragmentation guard (§Sessions): warn when this session is NOT
		// anchored at a project root — the one startup interrupt that matters.
		if (!ctx.hasUI) return;
		if (!boundary) {
			if (process.env["PI_CODING_AGENT_SESSION_DIR"] === undefined) {
				ctx.ui.notify(
					"blueberry guard: no project boundary above this directory and no blueberry session dir — this looks like a bare `pi` launch. History may fragment; use `bb`.",
					"warning",
				);
			}
			return;
		}
		if (boundary.root !== cwd) {
			ctx.ui.notify(
				`blueberry guard: session cwd is '${cwd}', not the project root '${boundary.root}'. Use bb (canonicalizes automatically) or bb --here (intentional).`,
				"warning",
			);
		}
	});

	// pi re-asserts its terminal title when the session name changes; re-claim it.
	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode === "tui") {
			const cwd = resolve(ctx.cwd);
			const boundary = findProjectBoundary(cwd);
			ctx.ui.setTitle(
				`blueberry — ${lastSegment(boundary ? boundary.root : cwd)}`,
			);
		}
	});

	// §Data sync: ingest this session's JSONL into blueberry.db at compaction
	// and shutdown. Fire-and-forget — sync failures must never disturb the
	// session; bb sync catches anything missed (e.g. crashes).
	const syncThisSession = (ctx: { sessionManager: { getSessionFile(): string | undefined } }) => {
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return;
			const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? "";
			if (agentDir === "") return;
			// inline dynamic import to keep module load light under jiti
			void import("../../src/core/db.ts").then(async ({ openDb, loadRegistryDb }) => {
				const { ingestSessionFile } = await import("../../src/core/sync.ts");
				const db = openDb(agentDir);
				try {
					const registry = loadRegistryDb(db);
					const byPath = new Map<string, string>();
					for (const p of registry.projects) {
						byPath.set(p.canonicalPath, p.id);
						for (const a of p.aliases) byPath.set(a, p.id);
					}
					ingestSessionFile(db, file, (cwd) => (cwd ? (byPath.get(cwd) ?? null) : null));
				} finally {
					db.close();
				}
			}).catch(() => {
				// best-effort only
			});
		} catch {
			// best-effort only
		}
	};
	pi.on("session_compact", (_event, ctx) => syncThisSession(ctx));
	pi.on("session_shutdown", (_event, ctx) => syncThisSession(ctx));
}
