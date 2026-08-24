/**
 * blueberry plan — plan mode, rewritten from scratch.
 *
 * STATUS: scaffold only. Do not implement before reading DESIGN.md §Plan
 * and resolving its open questions with the user.
 *
 * Reference material (do not load, do not import): vendored/pi-plan-mode/
 * Upstream: https://github.com/narumiruna/pi-extensions (packages/pi-plan-mode) v0.52.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  // Intentionally empty. See DESIGN.md §Plan for the target design:
  // - plan as durable artifact (PLAN.md in repo)
  // - read-only tool restriction while planning
  // - explicit approval gate before execution
  // - execution tracking wired to blueberry todo
}
