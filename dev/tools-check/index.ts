/**
 * tools-check extension for the pi coding agent.
 *
 * Wraps the structural lint born from the d6760e5 background-tasks
 * bug -- passing TypeScript interfaces as parameters
 * to pi.registerTool. It targets a class of bug
 * the existing tests cannot catch at the repo level: tsc would compile
 * it, the handler unit tests exercise handlers directly without going
 * through pi.registerTool, and the headless verify checks only confirm
 * that the extension loaded, not that the tool schemas were valid.
 *
 * Two routes share the same scanner:
 *
 * - `pi --tools-check` flag, registered primarily so verify.sh can
 *   prove the extension loaded (Check 2 in verify.sh greps pi --help
 *   for the flag; the headless smoke in Check 2f invokes
 *   `/tools-check`).
 * - `/tools-check` command, for in-TUI invocation -- the agent uses
 *   this after editing an extension's registerTool call, the same way
 *   it uses /sessions and /context-report.
 *
 * The scanner itself lives in ./check.ts so it can be unit-tested
 * independently of the pi loader (see check.test.ts).
 *
 * Out of scope for this extension: a real TypeScript compiler. A full
 * tsc pass would catch every category of misuse, but at the cost of
 * adding the typescript package (~70 MB) just for one lint. The text
 * scan catches that bug class and its type-only variants.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { checkTools } from "./check.ts";

export default function toolsCheckExtension(pi: ExtensionAPI): void {
	pi.registerFlag("tools-check", {
		description: "Show the tool-parameter schema scan at startup (default: off -- use /tools-check)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("tools-check", {
		description: "Scan every extension's pi.registerTool(...) call for the type-only parameters bug class (parameters passed as TS type-only values)",
		handler: async (_args, ctx) => {
			const root = resolvePath(process.cwd());
			const result = checkTools(root);
			const banner = `tools-check: scanned ${result.scanned} extension${result.scanned === 1 ? "" : "s"}; ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`;
			if (result.findings.length === 0) {
				const ok = `ok: ${banner}`;
				if (ctx.mode === "print") console.log(ok);
				else ctx.ui.notify(ok, "info");
				return;
			}
			const lines = [banner];
			for (const f of result.findings) {
				lines.push(`FAIL: ${f.file}:${f.line} [${f.severity}] ${f.message}`);
			}
			lines.push("hint: fix the parameters field, or add `// @tools-check-ok` above the call to opt out.");
			const text = lines.join("\n");
			if (ctx.mode === "print") console.log(text);
			else ctx.ui.notify(text, "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("tools-check") !== true) return;
		if (ctx.mode !== "tui") return;
		const root = resolvePath(process.cwd());
		const result = checkTools(root);
		const text = result.findings.length === 0
			? `tools-check: scanned ${result.scanned} extension${result.scanned === 1 ? "" : "s"}; 0 findings`
			: [
				`tools-check: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}:`,
				...result.findings.map((f) => `FAIL: ${f.file}:${f.line} ${f.message}`),
				"hint: fix the parameters field, or add `// @tools-check-ok` above the call to opt out.",
			].join("\n");
		const level = result.ok ? "info" : "warning";
		ctx.ui.notify(text, level);
	});
}
