/**
 * scripts/dump-prompt.ts — render the CURRENT composed system prompt.
 *
 * Composes exactly what a live session builds: composeSystemPrompt
 * with the real extension surfaces (snippets + guidelines extracted from the
 * tool sources) and blueberry's identity, all probe options ENABLED
 * (lsp installed, design lifecycle present, todos exist, pi-internals true).
 *
 * Run:  env -u BLUEBERRY_DB deno run -A --config deno.json scripts/dump-prompt.ts
 *
 * To preview a FUTURE prompt (before landing prompt changes), edit the probe
 * or the tool source files — this script is a canvas, not a snapshot: it
 * always composes from the live sources.
 */
import {
	composeSystemPrompt,
	extractToolSurfaces,
} from "../src/core/context-composer.ts";

const TOOL_SOURCES = [
	"src/core/tools/search.ts",
	"extensions/library/index.ts",
	"extensions/lsp/index.ts",
	"extensions/todo/index.ts",
];

const { snippets, guidelines } = extractToolSurfaces(TOOL_SOURCES);

// probe: everything enabled — the maximal prompt
const prompt = composeSystemPrompt({
	cwd: Deno.cwd(),
	probe: {
		cwd: Deno.cwd(),
		lspLanguages: ["typescript"],
		hasDesignLifecycle: true,
		hasTodos: true,
		isPiInternals: true,
	},
	toolSnippets: snippets,
	promptGuidelines: guidelines,
});

console.log(prompt);
