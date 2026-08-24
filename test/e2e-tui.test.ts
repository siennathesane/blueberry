/**
 * Full-UX TUI tests: the real blueberry interactive mode driven through a
 * tmux pseudo-terminal. Keys are sent, the rendered screen is captured, and
 * assertions run against what a human would actually see.
 *
 * Skipped automatically when tmux is unavailable.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	TuiSession,
	cleanupSessions,
	destroyWorld,
	makeWorld,
	tmuxAvailable,
	type UxWorld,
} from "./harness.ts";
import { openDb } from "../src/core/db.ts";
import { createTodo, setStage } from "../src/core/todo-store.ts";
import { samePath } from "../src/core/util.ts";

const describe = test; // node:test top-level suite naming
const it = tmuxAvailable() ? test : { skip: test }.skip;

let world: UxWorld;
let tui: TuiSession | null = null;

beforeEach(() => {
	world = makeWorld("tui");
});
afterEach(() => {
	tui?.kill();
	tui = null;
	destroyWorld(world);
	cleanupSessions();
});

/** Launch and wait for the opener. */
async function boot(): Promise<TuiSession> {
	tui = TuiSession.launch(world);
	await tui.waitFor("opener", "🫐 blueberry");
	return tui;
}

/** Resolve (or mint) the world's project row in blueberry.db. */
function worldProjectId(): string {
	const db = openDb(world.agentDir);
	try {
		const rows = db
			.prepare("SELECT id, canonical_path FROM projects")
			.all() as Array<{ id: string; canonical_path: string }>;
		// symlink-aware: process.cwd() inside the TUI stores /private/var/... while
		// the test created /var/... (macOS tmpdir symlink)
		const hit = rows.find((r) => samePath(r.canonical_path, world.projectDir));
		if (!hit) throw new Error("project not minted — launch the TUI first");
		return hit.id;
	} finally {
		db.close();
	}
}

describe("tui opener", { skip: !tmuxAvailable() }, async () => {
	await it("renders the 3-line opener and no resource wall", async () => {
		const t = await boot();
		const screen = await t.waitFor(
			"project line",
			new RegExp(world.projectDir.split("/").pop()!),
		);
		assert.ok(screen.includes("esc interrupt · / commands"), "hint line renders");
		// quiet startup: the resource wall must NOT render
		assert.ok(!screen.includes("[Skills]"), "no skills listing");
		assert.ok(!screen.includes("[Prompts]"), "no prompts listing");
		assert.ok(!screen.includes("Skill conflicts"), "no conflict box");
	});

	await it("/todo shows the empty board and q closes it", async () => {
		const t = await boot();
		await t.waitFor("settled", "esc interrupt");
		t.send("/todo");
		t.submit();
		await t.waitFor("pane header", "⬡ todos");
		const screen = t.capture();
		assert.ok(screen.includes("todo 0"), "empty board counts");
		assert.ok(screen.includes("doing 0/5"), "wip cap shown");
		t.sendKeys("q");
		await t.waitFor("back to editor", "esc interrupt");
		assert.ok(!t.capture().includes("⬡ todos"));
	});
});

describe("tui todo pane", { skip: !tmuxAvailable() }, async () => {
	await it("renders seeded tasks, cursor moves with arrows, enter/backspace detail", async () => {
		const t = await boot();
		await t.waitFor("settled", "esc interrupt");

		// seed two tasks after the project exists
		const pid = worldProjectId();
		const db = openDb(world.agentDir);
		const first = createTodo(db, pid, "alpha ux task", { sessionId: null });
		const second = createTodo(db, pid, "beta ux task", { sessionId: null });
		setStage(db, pid, first.todo!.hex6, "doing", { sessionId: null });
		db.close();
		assert.ok(first.ok && second.ok);

		t.send("/todo");
		t.submit();
		const board = await t.waitFor("tasks", "alpha ux task");
		assert.ok(board.includes("beta ux task"));
		assert.ok(board.includes("0/2 done"), "summary line renders (none done yet)");
		// cursor starts on the first visible cell (todo column → beta)
		const markerLine = (screen: string): string =>
			screen.split("\n").find((l) => l.includes("▸")) ?? "";
		assert.ok(
			markerLine(board).includes("beta ux task"),
			"marker starts on beta (flat[0])",
		);
		assert.ok(board.includes("◉"), "doing glyph present");

		// move cursor: marker moves from beta to alpha (doing column)
		t.sendKeys("Right");
		const moved = await t.waitFor("cursor moved", /▸◉.*alpha ux task/);
		assert.ok(markerLine(moved).includes("alpha ux task"), "marker on alpha row");

		// enter → detail card
		t.sendKeys("Enter");
		await t.waitFor("detail", "waits on");
		assert.ok(
			t.capture().includes("nothing — ready"),
			"unblocked card shows ready",
		);

		// backspace → back to the pane
		t.sendKeys("BSpace");
		await t.waitFor("back to pane", "⬡ todos");
	});

	await it("/exit quits cleanly (session dies, no residue)", async () => {
		const t = await boot();
		await t.waitFor("settled", "esc interrupt");
		t.send("/exit");
		t.submit();
		await t.waitForExit(8_000);
		assert.ok(t.exited());
	});
});
