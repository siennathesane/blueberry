/**
 * Self-update from GitHub releases (§Distribution).
 *
 * Contract with bin/compile.sh artifacts:
 *   - release assets are named `blueberry-<os>-<arch>` (+ `.sha256` sidecar)
 *   - `latest` release = the update target
 *
 * The core is injectable and side-effect-free by default (fetch, fs, and
 * paths passed in) so every branch is unit-testable offline. The CLI layer
 * (main.ts) supplies deno-real implementations.
 *
 * Update = download → sha256-verify → same-dir temp write → chmod 755 →
 * atomic rename over the running binary. Same-dir rename is atomic on POSIX;
 * the running process keeps its inode until exit.
 */
import { createHash } from "node:crypto";

export const UPDATER_REPO = "siennathesane/blueberry";

/** Minimal release shape we consume from the GitHub API. */
export interface ReleaseInfo {
	tag: string;
	/** download URLs keyed by asset name */
	assets: Record<string, string>;
}

export interface UpdaterIO {
	/** Fetch JSON (release metadata). */
	fetchJson(url: string, headers?: Record<string, string>): Promise<unknown>;
	/** Fetch raw bytes (asset / checksum). */
	fetchBytes(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
	/** The running executable's absolute path (swap target). */
	execPath(): string;
	/** Write a file (temp), rename, chmod — real fs at the CLI layer. */
	writeFile(path: string, bytes: Uint8Array, mode?: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	exists(path: string): boolean;
}

/** Parse "v1.2.3" / "1.2.3" into exactly three comparable numbers.
 * Dirty suffixes ("2.0.0-rc.1") collapse to their release triple [2,0,0] —
 * a prerelease never compares newer than its release, so `bb update` never
 * auto-updates into an rc. */
export function parseVersion(v: string): number[] {
	const parts = v.trim().replace(/^v/, "").split(".");
	const out: number[] = [];
	for (const p of parts) {
		const n = Number(p.replace(/[^0-9].*$/, ""));
		out.push(Number.isFinite(n) ? n : 0);
		if (out.length === 3) break;
	}
	while (out.length < 3) out.push(0);
	return out;
}

/** true when latest > current (strict). */
export function isNewer(current: string, latest: string): boolean {
	const a = parseVersion(current);
	const b = parseVersion(latest);
	for (let i = 0; i < 3; i++) {
		if (b[i]! > a[i]!) return true;
		if (b[i]! < a[i]!) return false;
	}
	return false;
}

/** Extract the release fields we need from the GitHub API payload. */
export function parseRelease(json: unknown): ReleaseInfo {
	if (typeof json !== "object" || json === null)
		throw new Error("release payload is not an object");
	const j = json as Record<string, unknown>;
	const tag = typeof j["tag_name"] === "string" ? j["tag_name"] : "";
	if (tag === "") throw new Error("release payload missing tag_name");
	const assets: Record<string, string> = {};
	if (Array.isArray(j["assets"])) {
		for (const a of j["assets"]) {
			if (typeof a !== "object" || a === null) continue;
			const name = (a as Record<string, unknown>)["name"];
			const url = (a as Record<string, unknown>)["browser_download_url"];
			if (typeof name === "string" && typeof url === "string") assets[name] = url;
		}
	}
	return { tag, assets };
}

/** The asset name this platform's update wants (windows assets carry .exe —
 * deno compile appends it and the release contract matches). */
export function assetNameFor(platform: string): string {
	return `blueberry-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
}

/** Pick this platform's asset URL from a release; null when absent. */
export function pickAsset(
	release: ReleaseInfo,
	platform: string,
): string | null {
	return release.assets[assetNameFor(platform)] ?? null;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Verify downloaded bytes against the sidecar checksum content. */
export function verifyChecksum(
	bytes: Uint8Array,
	shaFileText: string,
	asset: string,
): boolean {
	// sidecar line: "<hex>  blueberry-<os>-<arch>" (shasum format)
	const line = shaFileText
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.includes(asset));
	if (!line) return false;
	const expected = line.split(/\s+/)[0]?.toLowerCase() ?? "";
	return expected !== "" && expected === sha256Hex(bytes);
}

export interface CheckResult {
	currentVersion: string;
	latestTag: string;
	assetUrl: string | null;
	updateAvailable: boolean;
}

/** Check the latest release against the current version (no download). */
export async function checkForUpdate(
	currentVersion: string,
	platform: string,
	io: UpdaterIO,
	repo = UPDATER_REPO,
	token?: string,
): Promise<CheckResult> {
	const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
	const json = await io.fetchJson(
		`https://api.github.com/repos/${repo}/releases/latest`,
		headers,
	);
	const release = parseRelease(json);
	const assetUrl = pickAsset(release, platform);
	return {
		currentVersion,
		latestTag: release.tag,
		assetUrl,
		updateAvailable: assetUrl !== null && isNewer(currentVersion, release.tag),
	};
}

/** Dev-mode guard: the swap target must be a compiled binary, not `deno`. */
export function isCompiledBinary(execPath: string): boolean {
	// both separators: windows paths arrive with backslashes
	const base = execPath.slice(
		Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\")) + 1,
	);
	return !/^(deno|deno\.exe|node|node\.exe)$/.test(base);
}

/** Portable dirname: accepts "/" and "\\" separators. */
export function dirOf(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? "." : p.slice(0, i);
}

export interface UpdateResult {
	from: string;
	to: string;
	path: string;
}

/** Full update: check → download → verify → atomic swap. */
export async function performUpdate(
	currentVersion: string,
	platform: string,
	io: UpdaterIO,
	repo = UPDATER_REPO,
	token?: string,
): Promise<UpdateResult> {
	const check = await checkForUpdate(currentVersion, platform, io, repo, token);
	if (!check.updateAvailable || check.assetUrl === null) {
		throw new Error(
			`no update available (current ${currentVersion}, latest ${check.latestTag})`,
		);
	}

	const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
	const bytes = await io.fetchBytes(check.assetUrl, headers);

	// verify against the sidecar when the release ships one; a missing
	// sidecar is a release-packaging error and we refuse to install unverified
	const shaUrl = releaseSidecarUrl(check.assetUrl);
	if (shaUrl === null) throw new Error("release asset has no checksum sidecar");
	const shaText = new TextDecoder().decode(await io.fetchBytes(shaUrl, headers));
	if (!verifyChecksum(bytes, shaText, assetNameFor(platform))) {
		throw new Error("checksum mismatch — refusing to install");
	}

	const target = io.execPath();
	if (!isCompiledBinary(target)) {
		throw new Error(
			"self-update requires a compiled binary (bash bin/compile.sh)",
		);
	}
	const lastSep = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
	// tmp joins with the target's OWN separator style (no mixed /\ paths)
	const tmpBase = lastSep === -1 ? "" : target.slice(0, lastSep + 1);
	const isWindows = platform.startsWith("windows");
	const tmp = `${tmpBase}.blueberry-update-${Date.now()}${isWindows ? ".exe" : ""}`;
	await io.writeFile(tmp, bytes, 0o755);
	try {
		await io.rename(tmp, target);
	} catch {
		// windows: the RUNNING exe is locked — move it aside, then swap in
		// (the stale .old is cleaned up by the next update / by hand)
		await io.rename(target, `${target}.old`);
		await io.rename(tmp, target);
	}
	return { from: currentVersion, to: check.latestTag, path: target };
}

/** `…/blueberry-<os>-<arch>` → `…/blueberry-<os>-<arch>.sha256`. */
export function releaseSidecarUrl(assetUrl: string): string | null {
	return assetUrl.endsWith(".sha256") ? null : `${assetUrl}.sha256`;
}
