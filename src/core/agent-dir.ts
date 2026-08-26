/**
 * blueberry state-root resolution. One state root, one product:
 * ~/.blueberry (or $BLUEBERRY_AGENT_DIR), holding registry, sessions,
 * trash, and pi's trust.json — which is why we point pi's own
 * PI_CODING_AGENT_DIR at the same place.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde, resolve } from "./util.ts";

/** The blueberry state root. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["BLUEBERRY_AGENT_DIR"];
  if (override && override.trim() !== "") {
    return resolve(expandTilde(override, homedir()));
  }
  return join(homedir(), ".blueberry");
}

export function getRegistryPath(agentDir: string): string {
  return join(agentDir, "registry.json");
}

export function getSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

/** Central session store for a project slug. */
export function getCentralStoreDir(agentDir: string, slug: string): string {
  return join(getSessionsRoot(agentDir), slug);
}

/** pi's trust store lives at <agentDir>/trust.json (verified in pi source). */
export function getTrustPath(agentDir: string): string {
  return join(agentDir, "trust.json");
}

export function getTrashDir(agentDir: string): string {
  return join(agentDir, "trash");
}

/** In-repo session store (travels with the project directory). */
export function getInRepoStoreDir(projectRoot: string): string {
  return join(projectRoot, ".blueberry", "sessions");
}
