/**
 * pi trust store management. pi's trust.json (verified in pi source:
 * ProjectTrustStore) is a flat map of { "<absolute-path>": true | false },
 * keyed by normalized cwd. The registry owns trust completely: register,
 * reattach, and adopt all write trust entries so project moves never
 * re-trigger pi's trust prompt.
 */
import { readJsonIfExists, atomicWriteJson, resolve } from "./util.ts";
import { getTrustPath } from "./agent-dir.ts";

export type TrustData = Record<string, boolean>;

export interface TrustUpdate {
	path: string;
	/** true = trusted, false = untrusted, null = remove entry */
	decision: boolean | null;
}

export function readTrust(agentDir: string): TrustData {
	return readJsonIfExists<TrustData>(getTrustPath(agentDir)) ?? {};
}

export async function writeTrustEntries(
	agentDir: string,
	updates: TrustUpdate[],
): Promise<TrustData> {
	const data = readTrust(agentDir);
	for (const { path, decision } of updates) {
		const key = resolve(path);
		if (decision === null) {
			delete data[key];
		} else {
			data[key] = decision;
		}
	}
	await atomicWriteJson(getTrustPath(agentDir), data);
	return data;
}

/** Mark a set of paths trusted (the common case). */
export async function trustPaths(
	agentDir: string,
	paths: string[],
): Promise<TrustData> {
	return writeTrustEntries(
		agentDir,
		paths.map((path) => ({ path, decision: true })),
	);
}
