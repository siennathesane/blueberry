/**
 * blueberry todo — pane shell (preview data until §Data lands).
 *
 * All rendering and interaction logic lives in src/core/todo-pane.ts (pure,
 * UI-tested). This shell maps terminal keys to intents and feeds cards.
 * When the sqlite store ships, the MOCK block is replaced by a store read.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import {
	applyInput,
	CLOSED,
	renderTodoPane,
	visibleCells,
	type Intent,
	type PaneState,
	type TodoCard,
} from "../../src/core/todo-pane.ts";

const MOCK: TodoCard[] = [
	{ id: "9f3a2c", title: "dag core + persistence", stage: "doing", age: "4h" },
	{ id: "a11b02", title: "quiet opener polish", stage: "review", age: "2h" },
	{ id: "c7d4e9", title: "bb sync catch-up walk", stage: "review", age: "1d" },
	{ id: "5e8f31", title: "fts5 schema + migration", stage: "todo", age: "new", ready: true },
	{ id: "3b9k77", title: "bb_search tool", stage: "todo", age: "new", blockedBy: ["5e8f31"] },
	{ id: "d2c4a8", title: "symbol index", stage: "todo", age: "new", blockedBy: ["5e8f31"] },
	{ id: "f6g1h3", title: "native lsp", stage: "todo", age: "new", blockedBy: ["d2c4a8"] },
	{ id: "7i5j9k", title: "plan file format", stage: "todo", age: "new", ready: true },
	{ id: "1k2l3m", title: "tool gate (read-only)", stage: "todo", age: "new", blockedBy: ["7i5j9k"] },
	{ id: "4n5o6p", title: "approval flow", stage: "todo", age: "new", blockedBy: ["7i5j9k"] },
	{ id: "8q9r0s", title: "pane graph mode", stage: "todo", age: "new", blockedBy: ["9f3a2c"] },
	{ id: "2t3u4v", title: "session registry", stage: "done", age: "2d" },
	{ id: "6w7x8y", title: "cross-project library", stage: "done", age: "2d" },
	{ id: "0z1a2b", title: "/exit + opener", stage: "done", age: "1d" },
];

/** Terminal key → pane intent. Bare-letter vim keys included. */
function keyToIntent(data: string): Intent | null {
	if (matchesKey(data, Key.enter)) return "enter";
	if (matchesKey(data, Key.backspace)) return "back";
	if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "h" || data === "j") return "prev";
	if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "l" || data === "k") return "next";
	if (matchesKey(data, Key.escape) || data === "q") return "close";
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("todo", {
		description: "Todo pane (preview — mock data until §Data lands)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("todo pane requires interactive mode", "warning");
				return;
			}
			let state: PaneState = { cursor: 0, detail: false };
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let cachedLines: string[] | undefined;
				const component: Component = {
					render(width: number): string[] {
						let lines = cachedLines;
						if (!lines) {
							lines = renderTodoPane(width, theme, MOCK, state);
							cachedLines = lines;
						}
						return lines;
					},
					invalidate(): void {
						cachedLines = undefined;
					},
					handleInput(data: string): void {
						const intent = keyToIntent(data);
						if (!intent) return;
						const next = applyInput(state, intent, visibleCells(MOCK).length);
						if (next === CLOSED) {
							done();
							return;
						}
						state = next;
						cachedLines = undefined;
						tui.requestRender();
					},
				};
				return component;
			});
		},
	});
}
