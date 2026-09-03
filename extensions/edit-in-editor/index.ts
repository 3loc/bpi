import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { formatSavedResult, lastAssistantText, resolveEditor } from "./utils.ts";

/**
 * edit-in-editor
 *
 * Registers `open_in_editor`: opens a buffer in the user's terminal
 * editor (`$EDITOR`, falling back to `vi`) with full TTY access — for
 * when the agent wants the user to author or review a structured
 * markdown buffer (e.g. the review report from the `code-review`
 * skill).
 *
 * Two sources, exactly one per call:
 *   - `path`: an existing file on disk (generic file opening).
 *   - `context: "lastAssistant"`: the text of the most recent
 *     assistant message that carries text — normally the very message
 *     containing this tool call. The extension materializes that text
 *     into a temp buffer itself, so content that is already in the
 *     conversation never has to be written out (and paid for) a
 *     second time via a write/bash tool call.
 *
 * Return value is diff-first: after the editor exits, the tool returns
 * a unified diff of what changed while the editor was open. The
 * baseline is already in context (the file's former contents, or the
 * assistant text that was materialized), so the diff is enough to
 * reconstruct the saved buffer while sending back only the user's
 * changes. `full: true` opts into the entire saved contents instead;
 * an unchanged buffer and a missing diff(1) degrade to a compact
 * "unchanged" label / full-contents fallback respectively. The buffer
 * path is always reported so the same file can be re-opened by `path`
 * later (context-mode temp buffers persist for exactly that).
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

const OpenInEditorParams = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Absolute path of an existing file to open in the editor" }),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("lastAssistant")], {
			description:
				'Open text already in the conversation instead of a file: "lastAssistant" takes the text of your most recent assistant message with text content (normally the message containing this tool call) and materializes it into a temp buffer. Present the buffer content as the text of the message that calls this tool; it is not duplicated into context again.',
		}),
	),
	full: Type.Optional(
		Type.Boolean({
			description:
				"Return the entire saved buffer contents instead of a unified diff of what changed while the editor was open (default: diff only)",
		}),
	),
});

/**
 * Unified diff of baseline → contents via diff(1).
 * Returns "" when identical, null when diff(1) is unavailable or
 * fails (callers fall back to full contents).
 */
function computeDiff(baseline: string, contents: string): string | null {
	if (baseline === contents) return "";
	const dir = mkdtempSync(join(tmpdir(), "edit-in-editor-diff-"));
	const baselinePath = join(dir, "baseline");
	const editedPath = join(dir, "edited");
	writeFileSync(baselinePath, baseline, "utf8");
	writeFileSync(editedPath, contents, "utf8");
	try {
		const result = spawnSync(
			"diff",
			["-u", "--label", "original", "--label", "edited", baselinePath, editedPath],
			{ encoding: "utf8" },
		);
		if (result.error || result.status === null || (result.status !== 0 && result.status !== 1)) {
			return null;
		}
		if (result.status === 0) return "";
		return result.stdout.replace(/\n+$/, "\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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
			'Open a buffer in the user\'s terminal editor ($EDITOR, fallback vi) with full TTY access; the TUI is suspended while the editor runs. Source: `path` opens an existing file; `context: "lastAssistant"` materializes the text of your current assistant message into a temp buffer (present the content as the text of the message that calls this tool — it is not re-sent into context). After the editor exits, returns a unified diff of the user\'s changes plus the buffer path (re-open later via `path`); pass `full: true` for the entire saved contents instead of the diff.',
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

			const hasPath = typeof params.path === "string";
			const hasContext = typeof params.context === "string";
			if (hasPath === hasContext) {
				return {
					content: [
						{
							type: "text",
							text: "Error: pass exactly one of `path` (existing file) or `context` (\"lastAssistant\").",
						},
					],
				};
			}

			let bufferPath: string;
			let baseline: string;
			let source: string;
			if (hasContext) {
				const text = lastAssistantText(ctx.sessionManager.getBranch());
				if (text === undefined) {
					return {
						content: [
							{
								type: "text",
								text: 'Error: no assistant message with text content found in the session — present the buffer text in your reply before calling with context: "lastAssistant", or pass `path`.',
							},
						],
					};
				}
				const dir = mkdtempSync(join(tmpdir(), "edit-in-editor-"));
				bufferPath = join(dir, "buffer.md");
				writeFileSync(bufferPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
				baseline = readFileSync(bufferPath, "utf8");
				const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "";
				source = `context: lastAssistant — "${firstLine.slice(0, 100)}"`;
			} else {
				bufferPath = params.path!;
				try {
					baseline = readFileSync(bufferPath, "utf8");
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `Error: could not read ${bufferPath}: ${(err as Error).message}`,
							},
						],
					};
				}
				source = "file";
			}

			const { cmd, args } = resolveEditor(process.env.EDITOR);

			const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
				// ctx.ui.custom is the only API that exposes the runtime
				// TUI's start()/stop() to extensions. We need stop() to
				// release the raw terminal for the editor (otherwise the
				// TUI renderer and vi fight over stdin/stdout), and start()
				// to resume the TUI when the editor exits. The Component
				// we hand back is a placeholder — nothing visible — because
				// tui.stop() below releases the terminal and the editor
				// inherits raw mode for the duration of its session.
				//
				// Mirrors the pattern pi itself uses for its built-in
				// `/external-editor` action (`handleOpenExternalEditor` in
				// modes/interactive/app.ts): stop the TUI, spawn the editor
				// synchronously (stdin/stdout/stderr all inherited so vi
				// gets a clean terminal), then start the TUI again.
				const placeholder: { render: (width: number) => string[] } = {
					render: (_width: number) => [],
				};

				tui.stop();
				process.stdout.write("\x1b[2J\x1b[H");

				const result = spawnSync(cmd, [...args, bufferPath], {
					stdio: "inherit",
					env: process.env,
				});

				tui.start();
				tui.requestRender(true);
				done(result.status);
				return placeholder;
			});

			let contents: string;
			try {
				contents = readFileSync(bufferPath, "utf8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: editor exited (status=${exitCode ?? "null"}) but the buffer could not be read back: ${(err as Error).message}`,
						},
					],
				};
			}

			const full = params.full === true;
			const diff = full ? null : computeDiff(baseline, contents);
			return {
				content: [
					{
						type: "text",
						text: formatSavedResult({
							exitStatus: exitCode,
							bufferPath,
							source,
							baseline,
							contents,
							full,
							diff,
						}),
					},
				],
			};
		},
	});
}
