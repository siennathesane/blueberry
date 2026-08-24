/**
 * Single source of truth for the blueberry version: package.json.
 *
 * Resolution order (DESIGN.md §Distribution):
 * 1. BLUEBERRY_VERSION env — the binary/wrapper escape hatch. Single-file
 *    bundles and compiled binaries (bun/deno compile, SEA) have no real
 *    filesystem layout; their build step injects the version here.
 * 2. module-relative package.json read — correct for npm/git distribution,
 *    jiti (pi extensions), and Node type-stripping (CLI/tests) alike.
 * 3. "dev" — never crashes, always truthful about being fallback.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the version from the package.json two levels above `dir`. */
export function readPkgVersion(dir: string): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(dir, "..", "..", "package.json"), "utf8"),
		) as {
			version?: string;
		};
		return pkg.version ?? "dev";
	} catch {
		return "dev";
	}
}

export function getVersion(): string {
	const env = (process.env as Record<string, string | undefined>)[
		"BLUEBERRY_VERSION"
	];
	if (env !== undefined && env.trim() !== "") {
		return env.trim();
	}
	return readPkgVersion(dirname(fileURLToPath(import.meta.url)));
}
