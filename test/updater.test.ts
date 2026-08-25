/**
 * Updater tests — offline, via fake IO. The security-critical branches:
 * checksum verification (mismatch = refuse), sidecar requirement (missing =
 * refuse), dev-binary refusal, atomic-swap ordering (temp → rename).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assetNameFor,
	checkForUpdate,
	isCompiledBinary,
	isNewer,
	parseRelease,
	parseVersion,
	performUpdate,
	pickAsset,
	releaseSidecarUrl,
	sha256Hex,
	verifyChecksum,
	type UpdaterIO,
} from "../src/core/updater.ts";
import { createHash } from "node:crypto";

// ── pure version logic ─────────────────────────────────────────────────────

test("parseVersion: v-prefix, padding, dirty suffixes", () => {
	assert.deepEqual(parseVersion("0.1.0"), [0, 1, 0]);
	assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
	assert.deepEqual(parseVersion("1.2"), [1, 2, 0]);
	assert.deepEqual(parseVersion("2.0.0-rc.1"), [2, 0, 0]);
});

test("isNewer: strict comparison both directions", () => {
	assert.ok(isNewer("0.1.0", "v0.2.0"));
	assert.ok(isNewer("0.1.9", "0.2.0"));
	assert.ok(isNewer("1.9.9", "2.0.0"));
	assert.ok(!isNewer("0.2.0", "0.1.0"));
	assert.ok(!isNewer("0.1.0", "v0.1.0"), "same version is not newer");
});

// ── release parsing ────────────────────────────────────────────────────────

test("parseRelease: tag + assets mapped; missing tag throws", () => {
	const rel = parseRelease({
		tag_name: "v0.2.0",
		assets: [
			{ name: "blueberry-darwin-aarch64", browser_download_url: "https://x/darwin-aarch64" },
			{ name: "blueberry-darwin-aarch64.sha256", browser_download_url: "https://x/darwin-aarch64.sha256" },
			{ name: "blueberry-linux-x86_64", browser_download_url: "https://x/linux-x86_64" },
		],
	});
	assert.equal(rel.tag, "v0.2.0");
	assert.equal(pickAsset(rel, "darwin-aarch64"), "https://x/darwin-aarch64");
	assert.equal(pickAsset(rel, "windows-x86_64"), null, "absent platform → null");
	assert.throws(() => parseRelease({ assets: [] }), /tag_name/);
	assert.throws(() => parseRelease("nope"), /not an object/);
});

test("assetNameFor / releaseSidecarUrl", () => {
	assert.equal(assetNameFor("linux-x86_64"), "blueberry-linux-x86_64");
	assert.equal(releaseSidecarUrl("https://x/blueberry-darwin-aarch64"), "https://x/blueberry-darwin-aarch64.sha256");
	assert.equal(releaseSidecarUrl("https://x/blueberry-darwin-aarch64.sha256"), null, "already a sidecar");
});

// ── checksum ───────────────────────────────────────────────────────────────

test("sha256Hex + verifyChecksum: valid, wrong-hash, missing-line", () => {
	const bytes = new TextEncoder().encode("binary payload");
	const hex = sha256Hex(bytes);
	const sidecar = `${hex}  blueberry-darwin-aarch64\n`;
	assert.ok(verifyChecksum(bytes, sidecar, "blueberry-darwin-aarch64"));
	assert.ok(!verifyChecksum(new TextEncoder().encode("tampered"), sidecar, "blueberry-darwin-aarch64"), "tampered bytes fail");
	assert.ok(!verifyChecksum(bytes, `${hex}  other-asset\n`, "blueberry-darwin-aarch64"), "wrong asset line = missing");
	assert.ok(!verifyChecksum(bytes, "", "blueberry-darwin-aarch64"), "empty sidecar fails");
	// hex must be a real sha256 of the content (spot-check against node crypto)
	assert.equal(hex, createHash("sha256").update(bytes).digest("hex"));
});

// ── compiled-binary guard ──────────────────────────────────────────────────

test("isCompiledBinary: deno/node refused, artifacts accepted", () => {
	assert.ok(!isCompiledBinary("/opt/homebrew/bin/deno"));
	assert.ok(!isCompiledBinary("/usr/local/bin/node"));
	assert.ok(isCompiledBinary("/Users/x/bin/blueberry"));
	assert.ok(isCompiledBinary("/Users/x/.local/bin/blueberry-darwin-aarch64"));
});

// ── check + perform with fake IO ───────────────────────────────────────────

function fakeIo(opts: {
	release: unknown;
	assetBytes: Uint8Array;
	shaText: string;
	execPath: string;
	existing?: boolean;
}): UpdaterIO & { wrote: Array<{ path: string; mode?: number }>; renames: Array<[string, string]> } {
	const wrote: Array<{ path: string; mode?: number }> = [];
	const renames: Array<[string, string]> = [];
	return {
		wrote,
		renames,
		async fetchJson() {
			return opts.release;
		},
		async fetchBytes(url: string) {
			if (url.endsWith(".sha256")) return new TextEncoder().encode(opts.shaText);
			return opts.assetBytes;
		},
		execPath() {
			return opts.execPath;
		},
		async writeFile(path, bytes, mode) {
			wrote.push({ path, mode });
			assert.ok(bytes.length > 0, "empty write");
		},
		async rename(from, to) {
			renames.push([from, to]);
		},
		exists: () => opts.existing ?? true,
	};
}

test("checkForUpdate: newer release with asset → available", async () => {
	const io = fakeIo({
		release: { tag_name: "v0.3.0", assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "u" }] },
		assetBytes: new Uint8Array(),
		shaText: "",
		execPath: "/x/blueberry",
	});
	const res = await checkForUpdate("0.2.0", "darwin-aarch64", io);
	assert.ok(res.updateAvailable);
	assert.equal(res.latestTag, "v0.3.0");
});

test("checkForUpdate: same version or missing asset → not available", async () => {
	const mk = (tag: string, withAsset: boolean) =>
		fakeIo({
			release: { tag_name: tag, assets: withAsset ? [{ name: "blueberry-darwin-aarch64", browser_download_url: "u" }] : [] },
			assetBytes: new Uint8Array(),
			shaText: "",
			execPath: "/x/blueberry",
		});
	assert.ok(!(await checkForUpdate("0.2.0", "darwin-aarch64", mk("v0.2.0", true))).updateAvailable);
	assert.ok(!(await checkForUpdate("0.2.0", "darwin-aarch64", mk("v9.0.0", false))).updateAvailable, "no asset → no update");
});

test("performUpdate: download → verify → temp 755 → atomic rename to execPath", async () => {
	const assetBytes = new TextEncoder().encode("NEW BINARY BYTES");
	const shaText = `${sha256Hex(assetBytes)}  blueberry-darwin-aarch64\n`;
	const io = fakeIo({
		release: { tag_name: "v0.3.0", assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "https://x/asset" }] },
		assetBytes,
		shaText,
		execPath: "/users/x/bin/blueberry",
	});
	const res = await performUpdate("0.2.0", "darwin-aarch64", io);
	assert.equal(res.to, "v0.3.0");
	assert.equal(res.path, "/users/x/bin/blueberry");
	// temp written beside the target, mode 755, then renamed OVER it
	assert.equal(io.wrote.length, 1);
	assert.match(io.wrote[0]!.path, /^\/users\/x\/bin\/\.blueberry-update-\d+$/);
	assert.equal(io.wrote[0]!.mode, 0o755);
	assert.deepEqual(io.renames, [[io.wrote[0]!.path, "/users/x/bin/blueberry"]]);
});

test("performUpdate: checksum mismatch refuses, nothing written", async () => {
	const io = fakeIo({
		release: { tag_name: "v0.3.0", assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "u" }] },
		assetBytes: new TextEncoder().encode("TAMPERED"),
		shaText: `${sha256Hex(new TextEncoder().encode("EXPECTED"))}  blueberry-darwin-aarch64\n`,
		execPath: "/users/x/bin/blueberry",
	});
	await assert.rejects(() => performUpdate("0.2.0", "darwin-aarch64", io), /checksum mismatch/);
	assert.equal(io.wrote.length, 0);
});

test("performUpdate: dev runtime (deno on PATH) refuses", async () => {
	const assetBytes = new TextEncoder().encode("B");
	const io = fakeIo({
		release: { tag_name: "v0.3.0", assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "u" }] },
		assetBytes,
		shaText: `${sha256Hex(assetBytes)}  blueberry-darwin-aarch64\n`,
		execPath: "/opt/homebrew/bin/deno",
	});
	await assert.rejects(() => performUpdate("0.2.0", "darwin-aarch64", io), /compiled binary/);
});

test("performUpdate: no newer release refuses before any download", async () => {
	const io = fakeIo({
		release: { tag_name: "v0.2.0", assets: [{ name: "blueberry-darwin-aarch64", browser_download_url: "u" }] },
		assetBytes: new Uint8Array(),
		shaText: "",
		execPath: "/users/x/bin/blueberry",
	});
	await assert.rejects(() => performUpdate("0.2.0", "darwin-aarch64", io), /no update available/);
});
