/**
 * Full-UX test harness: drive the REAL blueberry binary from outside.
 *
 * Two harnesses:
 * - runCli(): subprocess CLI runs (bb <cmd>) with stdout/stderr/exit-code
 * - TuiSession: tmux-backed pseudo-terminal — send keys, capture the rendered
 *   screen (ANSI-stripped by tmux), wait for patterns, detect exit.
 *
 * These tests exercise bin/blueberry → entry → main/launcher → pi end to end,
 * including things in-process suites cannot see: the opener, the pane as
 * rendered, navigation keys, /exit. They live in test/ and are outside the
 * coverage include set — they guard UX truth, not line counts.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
export const BB_BIN = join(REPO_ROOT, "bin", "blueberry");

const TMUX = safeWhich("tmux");
function safeWhich(bin: string): string | null {
	try {
		const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
		return out === "" ? null : out;
	} catch {
		return null;
	}
}

export function tmuxAvailable(): boolean {
	return TMUX !== null;
}

// --- shared fixtures ------------------------------------------------------------

export interface UxWorld {
	agentDir: string;
	projectDir: string;
}

/** Fresh agent dir + plain project dir; settings.json wired for TUI launch. */
export function makeWorld(prefix: string): UxWorld {
	const agentDir = join(tmpdir(), `bb-ux-${prefix}-${randomUUID().slice(0, 8)}`);
	const projectDir = join(tmpdir(), `bb-ux-${prefix}-proj-${randomUUID().slice(0, 8)}`);
	mkdirSync(join(agentDir), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// minimal settings: theme + quiet + THIS repo as a package so extensions load
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ theme: "blueberry", quietStartup: true, packages: [REPO_ROOT] }, null, 2)}\n`,
	);
	return { agentDir, projectDir };
}

export function destroyWorld(world: UxWorld): void {
	for (const dir of [world.agentDir, world.projectDir]) {
		try {
			execFileSync("rm", ["-rf", dir]);
		} catch {
			// best effort
		}
	}
}

// --- CLI harness -----------------------------------------------------------------

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Env for subprocesses: blueberry override + coverage-tracking vars stripped
 * (spawning node entry.ts under node:test's ambient NODE_V8_COVERAGE writes
 * import-only partial profiles that corrupt the merge). */
function childEnv(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, BLUEBERRY_AGENT_DIR: agentDir };
	delete env["NODE_V8_COVERAGE"];
	return env;
}

/** Run the real binary: bb <args...> against a world. */
export function runCli(args: string[], world: UxWorld, timeoutMs = 20_000): Promise<CliResult> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(BB_BIN, args, {
			cwd: world.projectDir,
			env: childEnv(world.agentDir),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`runCli timeout after ${timeoutMs}ms: bb ${args.join(" ")}`));
		}, timeoutMs);
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
	});
}

// --- TUI harness (tmux pty) --------------------------------------------------------

const SESSION_PREFIX = `bb-e2e-${process.pid}`;

export class TuiSession {
	readonly name: string;

	private constructor(name: string) {
		this.name = name;
	}

	/** Launch the blueberry TUI in a detached tmux session. */
	static launch(world: UxWorld, opts: { width?: number; height?: number } = {}): TuiSession {
		if (!tmuxAvailable()) throw new Error("tmux not available");
		const name = `${SESSION_PREFIX}-${randomUUID().slice(0, 8)}`;
		const width = opts.width ?? 120;
		const height = opts.height ?? 30;
		execFileSync(TMUX!, [
			"new-session", "-d", "-s", name,
			"-x", String(width), "-y", String(height),
			"-c", world.projectDir,
			`env -u NODE_V8_COVERAGE BLUEBERRY_AGENT_DIR=${world.agentDir} '${BB_BIN}'`,
		]);
		return new TuiSession(name);
	}

	/** Type literal text into the editor. */
	send(text: string): void {
		execFileSync(TMUX!, ["send-keys", "-t", this.name, "-l", text]);
	}

	/** Send special keys (Enter, Up, Down, Left, Right, Escape, BSpace...). */
	sendKeys(...keys: string[]): void {
		execFileSync(TMUX!, ["send-keys", "-t", this.name, ...keys]);
	}

	/** Submit what's in the editor (Enter). */
	submit(): void {
		this.sendKeys("Enter");
	}

	/** Plain-text screen capture (tmux strips ANSI). */
	capture(): string {
		return execFileSync(TMUX!, ["capture-pane", "-p", "-t", this.name], { encoding: "utf8" });
	}

	/** Lines of the current capture. */
	lines(): string[] {
		return this.capture().split("\n");
	}

	/** True when the screen currently contains the pattern. */
	shows(pattern: RegExp | string): boolean {
		const text = this.capture();
		return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
	}

	/** Poll until the pattern renders (or throw on timeout). */
	async waitFor(what: string, pattern: RegExp | string, timeoutMs = 10_000): Promise<string> {
		const started = Date.now();
		for (;;) {
			const text = this.capture();
			const hit = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
			if (hit) return text;
			if (Date.now() - started > timeoutMs) {
				throw new Error(`TUI waitFor(${what}) timed out after ${timeoutMs}ms.\n--- screen ---\n${text}`);
			}
			await sleep(150);
		}
	}

	/** True once the pane process has exited (session gone). */
	exited(): boolean {
		try {
			execFileSync(TMUX!, ["has-session", "-t", this.name], { stdio: "ignore" });
			return false;
		} catch {
			return true;
		}
	}

	/** Wait for process exit (after /exit). */
	async waitForExit(timeoutMs = 8_000): Promise<void> {
		const started = Date.now();
		while (!this.exited()) {
			if (Date.now() - started > timeoutMs) {
				throw new Error(`TUI did not exit within ${timeoutMs}ms.\n--- screen ---\n${this.capture()}`);
			}
			await sleep(120);
		}
	}

	kill(): void {
		try {
			execFileSync(TMUX!, ["kill-session", "-t", this.name], { stdio: "ignore" });
		} catch {
			// already gone
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Kill sessions leaked by a crashed test run — THIS process's only.
 * (node --test runs files in parallel processes; a global sweep would kill
 * sibling processes' live sessions.) */
export function cleanupSessions(): void {
	if (!tmuxAvailable()) return;
	try {
		const out = execFileSync(TMUX!, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
		for (const line of out.split("\n")) {
			const name = line.trim();
			if (name.startsWith(SESSION_PREFIX)) {
				try {
					execFileSync(TMUX!, ["kill-session", "-t", name], { stdio: "ignore" });
				} catch {
					// race
				}
			}
		}
	} catch {
		// no server running
	}
}

export { existsSync, mkdirSync, join };
