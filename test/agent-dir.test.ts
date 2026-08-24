import { test } from "node:test";
import assert from "node:assert/strict";
import { getAgentDir, getRegistryPath, getSessionsRoot, getCentralStoreDir, getTrustPath, getTrashDir, getInRepoStoreDir } from "../src/core/agent-dir.ts";
import { join } from "node:path";
import { homedir } from "node:os";

test("getAgentDir: default is ~/.blueberry", () => {
	assert.equal(getAgentDir({}), join(homedir(), ".blueberry"));
});

test("getAgentDir: env override wins, tilde expanded", () => {
	assert.equal(getAgentDir({ BLUEBERRY_AGENT_DIR: "/custom" }), "/custom");
	assert.equal(getAgentDir({ BLUEBERRY_AGENT_DIR: "~/state" }), join(homedir(), "state"));
	assert.equal(getAgentDir({ BLUEBERRY_AGENT_DIR: "  " }), join(homedir(), ".blueberry"));
});

test("paths derive from agent dir", () => {
	assert.equal(getRegistryPath("/A"), "/A/registry.json");
	assert.equal(getSessionsRoot("/A"), "/A/sessions");
	assert.equal(getCentralStoreDir("/A", "my-proj"), "/A/sessions/my-proj");
	assert.equal(getTrustPath("/A"), "/A/trust.json");
	assert.equal(getTrashDir("/A"), "/A/trash");
	assert.equal(getInRepoStoreDir("/proj/root"), "/proj/root/.blueberry/sessions");
});
