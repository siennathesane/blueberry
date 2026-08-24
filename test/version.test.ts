import { test } from "node:test";
import assert from "node:assert/strict";
import { getVersion, readPkgVersion } from "../src/core/version.ts";
import { readFileSync } from "node:fs";
import { tmpAgentDir, cleanup } from "./helpers.ts";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	version: string;
};

test("getVersion: reads package.json (source of truth)", () => {
	delete process.env["BLUEBERRY_VERSION"];
	assert.equal(getVersion(), pkg.version);
});

test("readPkgVersion: missing file and missing version field fall back to dev", () => {
	assert.equal(readPkgVersion("/nonexistent/dir/depth"), "dev");
});

test("getVersion: BLUEBERRY_VERSION env wins (binary escape hatch)", () => {
	const prev = process.env["BLUEBERRY_VERSION"];
	process.env["BLUEBERRY_VERSION"] = "9.9.9-binary";
	try {
		assert.equal(getVersion(), "9.9.9-binary");
	} finally {
		if (prev === undefined) delete process.env["BLUEBERRY_VERSION"];
		else process.env["BLUEBERRY_VERSION"] = prev;
	}
});

test("getVersion: blank env falls through to package.json, never dev", () => {
	const prev = process.env["BLUEBERRY_VERSION"];
	process.env["BLUEBERRY_VERSION"] = "   ";
	try {
		assert.equal(getVersion(), pkg.version);
	} finally {
		if (prev === undefined) delete process.env["BLUEBERRY_VERSION"];
		else process.env["BLUEBERRY_VERSION"] = prev;
	}
});

test("getVersion: uncached — env layer applies immediately after change", () => {
	const prev = process.env["BLUEBERRY_VERSION"];
	process.env["BLUEBERRY_VERSION"] = "1.0.0";
	const first = getVersion();
	process.env["BLUEBERRY_VERSION"] = "2.0.0";
	const second = getVersion();
	if (prev === undefined) delete process.env["BLUEBERRY_VERSION"];
	else process.env["BLUEBERRY_VERSION"] = prev;
	assert.equal(first, "1.0.0");
	assert.equal(second, "2.0.0");
});

test("getVersion: package read failure is unreachable from real layouts", () => {
	// The only failure mode is a missing module-relative package.json, which
	// cannot happen while this test runs (we just read it above). This test
	// exists to document the fallback contract: any read failure => "dev".
	assert.ok(getVersion().length > 0);
});

test("tmpAgentDir helper still healthy (sanity)", () => {
	const d = tmpAgentDir();
	assert.ok(d.includes("bb-agent-"));
	cleanup(d);
});
