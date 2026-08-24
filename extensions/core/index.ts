/**
 * blueberry core — identity, session-start guard, small behaviors.
 *
 * The guard is mitigation (b) from DESIGN.md §Sessions: canonicalization lives
 * in the launcher, so a bare `pi` (or `bb --here`) can still fragment history.
 * On session_start we marker-walk from the actual cwd and warn loudly when the
 * session is NOT anchored at a project root — catching the habit before it
 * costs history.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findProjectBoundary } from "../../src/core/markers.ts";
import { resolve } from "node:path";

const VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`🫐 blueberry v${VERSION} — with orange juice`, "info");
		}

		// Fragmentation guard: is this session anchored at a project root?
		const cwd = resolve(ctx.cwd);
		const boundary = findProjectBoundary(cwd);
		if (!ctx.hasUI) return;

		if (!boundary) {
			// no repo and no marker anywhere above: a plain-dir session. Fine if
			// intentional (bb mints a marker), suspicious under bare pi.
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
}
