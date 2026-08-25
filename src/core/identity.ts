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
export function terminalTitle(project: string, sessionName?: string | null): string {
	const p = project.trim() === "" ? "blueberry" : project.trim();
	if (sessionName !== undefined && sessionName !== null && sessionName.trim() !== "") {
		return `${TITLE_MARK} — ${sessionName.trim()} — ${p}`;
	}
	return `${TITLE_MARK} — ${p}`;
}

/**
 * The default keybindings blueberry claims (written by bin/setup.sh to
 * <agentDir>/keybindings.json). A distribution's prerogative via stock pi
 * rebinding — verified by unit test so the shipped file can never drift
 * from what the extensions expect.
 *
 * - shift+tab → mode ring (extensions/plan): thinking moves to ctrl+shift+t
 * - ctrl+p    → todo pane (extensions/todo): model cycling moves to ctrl+m
 */
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
	"app.thinking.cycle": "ctrl+shift+t",
	"app.model.cycleForward": "ctrl+m",
};
