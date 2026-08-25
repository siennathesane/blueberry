import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readTrust, writeTrustEntries, trustPaths } from "../src/core/trust.ts";
import { tmpAgentDir, cleanup, tmpDir } from "./helpers.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readJsonIfExists } from "../src/core/util.ts";

let agentDir: string;
let area: string;

beforeEach(() => {
	agentDir = tmpAgentDir();
	area = tmpDir("bb-trust-");
});
afterEach(() => {
	cleanup(agentDir, area);
});

test("readTrust: missing file -> {}", () => {
	assert.deepEqual(readTrust(agentDir), {});
});

test("trust round-trip: set, read, remove", async () => {
	const projA = join(area, "proj-a");
	const projB = join(area, "proj-b");
	await trustPaths(agentDir, [projA, projB]);
	const t = readTrust(agentDir);
	assert.equal(t[projA], true);
	assert.equal(t[projB], true);

	await writeTrustEntries(agentDir, [{ path: projA, decision: null }]);
	const t2 = readTrust(agentDir);
	assert.equal(t2[projA], undefined);
	assert.equal(t2[projB], true);
});

test("writeTrustEntries: false records explicit distrust", async () => {
	const bad = join(area, "bad");
	await writeTrustEntries(agentDir, [{ path: bad, decision: false }]);
	assert.equal(readTrust(agentDir)[bad], false);
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
