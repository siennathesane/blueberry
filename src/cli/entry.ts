/**
 * bin/blueberry entry shim. Kept separate from main.ts so the command layer
 * stays fully testable and this file is the only uncovered surface
 * (excluded from coverage via package.json).
 */
import { main, defaultDeps } from "./main.ts";
import { pathToFileURL } from "node:url";

const invokedDirectly =
 process.argv[1] !== undefined &&
 import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
 const code = await main(process.argv.slice(2), defaultDeps());
 process.exit(code);
}
