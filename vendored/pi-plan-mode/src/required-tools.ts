import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-tool.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-tool.js";
import { unique } from "./tool-selection.js";

export function withRequiredPlanModeTools(toolNames: string[]) {
	return unique([
		...withoutRequiredPlanModeTools(toolNames),
		PLAN_MODE_QUESTION_TOOL_NAME,
		PLAN_MODE_COMPLETE_TOOL_NAME,
	]);
}

export function withoutPlanModeQuestionTool(toolNames: string[]) {
	return toolNames.filter((toolName) => toolName !== PLAN_MODE_QUESTION_TOOL_NAME);
}

export function withoutRequiredPlanModeTools(toolNames: string[]) {
	return toolNames.filter(
		(toolName) =>
			toolName !== PLAN_MODE_QUESTION_TOOL_NAME && toolName !== PLAN_MODE_COMPLETE_TOOL_NAME,
	);
}
