/**
 * blueberry CLI entry. Kept separate from main.ts so the command layer stays
 * fully testable and this file is the only uncovered surface.
 *
 * Runtime-portable dispatch: `import.meta.main` is true when this module is
 * the entrypoint under `deno run` AND under `deno compile`; `Deno.args` is
 * user args in both modes (a compiled binary's process.argv has no script
 * slot — the old argv[1]-identity check silently no-op'd when compiled).
 */
import { main, defaultDeps } from "./main.ts";

if (import.meta.main) {
	const code = await main(Deno.args, defaultDeps());
	process.exit(code);
}
