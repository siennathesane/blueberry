/**
 * blueberry todo — todos that are actually useful.
 *
 * STATUS: scaffold only. Do not implement before reading DESIGN.md §Todo
 * and resolving its open questions with the user.
 *
 * Reference material (do not load, do not import): vendored/rpiv-todo/
 * Upstream: https://github.com/juicesharp/rpiv-mono (packages/rpiv-todo) v2.7.0
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
 // Intentionally empty. See DESIGN.md §Todo for the target design:
 // - one dead-simple tool the model will actually call
 // - branch-correct state via tool-result details (see pi docs "State Management")
 // - visible surface: status line / widget (placement TBD)
 // - integration point for plan-mode execution tracking
}
