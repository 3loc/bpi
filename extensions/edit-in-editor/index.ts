import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

/**
 * edit-in-editor
 *
 * Registers a single tool the agent can call to open an arbitrary file
 * in the user's terminal editor (`$EDITOR`, falling back to `vi`) with
 * full TTY access — useful when the agent wants the user to author or
 * review a structured markdown buffer the agent itself wrote (e.g. the
 * pre-commit review template from the `code-review` skill).
 *
 * Flow:
 *   1. Agent writes the file (via the bash tool, no TTY needed).
 *   2. Agent calls `open_in_editor` with the path.
 *   3. Tool suspends the TUI, runs `${EDITOR:-vi} <path>` with
 *      `stdio: "inherit"`, restarts the TUI, and returns the saved
 *      file contents as the tool result.
 *   4. The agent parses the returned text however it likes.
 *
 * Why a tool, not a slash command or `user_bash` hook:
 *   - Slash commands are user-driven; this needs to fire from the
 *     agent loop so the gate can run automatically before commits.
 *   - `user_bash` only intercepts user `!` commands, not agent bash.
 *   - A registered tool fits the agent loop naturally: invoke, block,
 *     get structured output, continue.
 *
 * Non-interactive fallback: when `ctx.mode !== "tui"` (RPC, print,
 * json), the tool returns an error string. Callers (skills) decide
 * how to degrade — e.g. fall back to in-chat prompting.
 */

const DEFAULT_EDITOR = "vi";

function resolveEditor(): { cmd: string; args: string[] } {
	const raw = process.env.EDITOR?.trim() || DEFAULT_EDITOR;
	const parts = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [DEFAULT_EDITOR];
	const cmd = parts[0]!;
	const args = parts.slice(1);
	return { cmd, args };
}

const OpenInEditorParams = Type.Object({
	path: Type.String({ description: "Absolute path to the file the editor should open" }),
});

export default function editInEditorExtension(pi: ExtensionAPI): void {
	pi.registerFlag("edit-in-editor", {
		description: "Enable the open_in_editor tool for spawning $EDITOR with full TTY access (default: on)",
		type: "boolean",
		default: true,
	});

	pi.registerTool({
		name: "open_in_editor",
		label: "Open in editor",
		description:
			"Open a file in the user's terminal editor ($EDITOR, fallback vi) with full TTY access. The TUI is suspended while the editor runs; on exit the saved file contents are returned as the tool result. Use this when the agent wants the user to author or review a structured buffer the agent wrote (e.g. the pre-commit review file from the code-review skill).",
		parameters: OpenInEditorParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Error: open_in_editor requires an interactive TTY session (running in non-interactive mode). The caller should fall back to in-chat prompting.",
						},
					],
				};
			}

			const { cmd, args } = resolveEditor();

			const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");

				const result = spawnSync(cmd, [...args, params.path], {
					stdio: "inherit",
					env: process.env,
				});

				tui.start();
				tui.requestRender(true);
				done(result.status);
				return { render: () => [], invalidate: () => {} };
			});

			let contents: string;
			try {
				contents = readFileSync(params.path, "utf8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: editor exited (status=${exitCode ?? "null"}) but the file could not be read back: ${(err as Error).message}`,
						},
					],
				};
			}

			const statusLabel = exitCode === 0 ? "saved" : `exited with status ${exitCode}`;
			const byteLen = Buffer.byteLength(contents, "utf8");
			return {
				content: [
					{
						type: "text",
						text: `Editor ${statusLabel}. File contents (${byteLen} bytes):\n\n${contents}`,
					},
				],
			};
		},
	});
}
