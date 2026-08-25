/**
 * blueberry identity: the terminal title contract.
 *
 * pi re-asserts ITS title from several internal events (updateTerminalTitle:
 * startup .finally(), session switches, model changes...). The extension
 * re-claims on every event it can see (session_start, session_info_changed,
 * model_select, agent_start) — self-healing within one turn.
 *
 * Unit-tested invariants: never contains "pi", always starts with the
 * blueberry mark, project name always present, session variant well-formed.
 */

export const TITLE_MARK = "blueberry";

/** Project name from a root path (last segment). */
export function projectNameFor(root: string): string {
 return root.split("/").filter(Boolean).pop() ?? root;
}

/**
 * The canonical terminal title.
 * With a session name: `blueberry — <session> — <project>` (pi-compatible shape).
 * Without: `blueberry — <project>`.
 */
export function terminalTitle(
 project: string,
 sessionName?: string | null,
): string {
 const p = project.trim() === "" ? "blueberry" : project.trim();
 if (
  sessionName !== undefined &&
  sessionName !== null &&
  sessionName.trim() !== ""
 ) {
  return `${TITLE_MARK} — ${sessionName.trim()} — ${p}`;
 }
 return `${TITLE_MARK} — ${p}`;
}

/**
 * Keys that ALIAS primary keys in legacy terminal byte-encoding — claiming
 * any of these rebinds the aliased key globally (the ctrl+m == Enter
 * regression: Enter started cycling models). NEVER bind these in blueberry.
 * This is the denylist every claim must pass.
 */
export const UNSAFE_KEY_ALIASES: Record<string, string> = {
	"ctrl+m": "Enter (CR, 0x0D)",
	"ctrl+j": "Line Feed (LF, 0x0A) — aliases shift+enter on some terminals",
	"ctrl+i": "Tab (0x09)",
	"ctrl+h": "Backspace on some terminals",
	"ctrl+[": "Escape on some terminals",
};

/** Every key blueberry claims must pass this or the contract test fails. */
export function validateClaimedKey(key: string): string | null {
	return UNSAFE_KEY_ALIASES[key] ?? null;
}

/** Validate the whole contract; throws on the first unsafe claim. */
export function validateKeybindings(bindings: Record<string, string>): void {
	for (const [id, key] of Object.entries(bindings)) {
		const alias = validateClaimedKey(key);
		if (alias !== null) {
			throw new Error(`keybindings claim unsafe: ${id} → ${key} aliases ${alias}`);
		}
	}
}

/**
 * The default keybindings blueberry claims (written by bin/setup.sh to
 * <agentDir>/keybindings.json). A distribution's prerogative via stock pi
 * rebinding — verified by unit test so the shipped file can never drift
 * from what the extensions expect.
 *
 * - shift+tab → mode ring (extensions/plan): thinking moves to ctrl+shift+t
 * - ctrl+p    → todo pane (extensions/todo): model cycling moves to alt+m
 *   (NEVER ctrl+m — it is byte-identical to Enter; the regression that
 *   shipped 2025-08-25 and made Enter cycle models)
 */
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
	"app.thinking.cycle": "ctrl+shift+t",
	"app.model.cycleForward": "alt+m",
};
