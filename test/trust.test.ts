import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readTrust, writeTrustEntries, trustPaths } from "../src/core/trust.ts";
import { tmpAgentDir, cleanup } from "./helpers.ts";
import { existsSync } from "node:fs";
import { readJsonIfExists } from "../src/core/util.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
});
afterEach(() => {
	cleanup(agentDir);
});

test("readTrust: missing file -> {}", () => {
	assert.deepEqual(readTrust(agentDir), {});
});

test("trust round-trip: set, read, remove", async () => {
	await trustPaths(agentDir, ["/x/proj-a", "/x/proj-b"]);
	const t = readTrust(agentDir);
	assert.equal(t["/x/proj-a"], true);
	assert.equal(t["/x/proj-b"], true);

	await writeTrustEntries(agentDir, [{ path: "/x/proj-a", decision: null }]);
	const t2 = readTrust(agentDir);
	assert.equal(t2["/x/proj-a"], undefined);
	assert.equal(t2["/x/proj-b"], true);
});

test("writeTrustEntries: false records explicit distrust", async () => {
	await writeTrustEntries(agentDir, [{ path: "/x/bad", decision: false }]);
	assert.equal(readTrust(agentDir)["/x/bad"], false);
});

test("trust file is valid JSON with no temp residue", async () => {
	await trustPaths(agentDir, ["/x/p"]);
	const raw = readJsonIfExists<Record<string, boolean>>(
		`${agentDir}/trust.json`,
	);
	assert.ok(raw);
	assert.equal(raw["/x/p"], true);
	assert.ok(!existsSync(`${agentDir}/trust.json.tmp`));
});
