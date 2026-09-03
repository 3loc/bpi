/**
 * Pure helpers for the edit-in-editor extension.
 *
 * Side-effect free so the editor-string parsing, context extraction,
 * and result formatting can be tested without the extension runtime
 * or a TTY (utils.test.ts).
 */

export interface EditorCommand {
	cmd: string;
	args: string[];
}

/**
 * Parse an $EDITOR value into a command + leading args.
 * Handles simple quoting so values like `code --wait` or
 * `'my editor' -w` work (surrounding quotes are stripped — the
 * shell is not involved, so they must not reach spawn as part of
 * the binary name). Empty/unset falls back to vi.
 *
 * Quoting/arg-splitting/fallback behavior covered by the
 * `resolveEditor` suite in utils.test.ts — keep them in sync.
 */
export function resolveEditor(raw: string | undefined): EditorCommand {
	const trimmed = raw?.trim() || "vi";
	const parts = (trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? ["vi"]).map((part) =>
		part.replace(/^("[^"]*"|'[^']*')$/, (_match, quoted: string) => quoted.slice(1, -1)),
	);
	return { cmd: parts[0]!, args: parts.slice(1) };
}

/**
 * Minimal structural type of a session entry — enough to read message
 * entries without importing pi's full SessionEntry union (keeps this
 * module importable by node --test without the pi package).
 */
export interface EntryShape {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * Extract the text of the most recent assistant message that actually
 * carries text content, walking a root→leaf entry list.
 *
 * Assistant messages containing only tool calls are skipped, so the
 * result is the model's latest prose reply — normally the very message
 * that carries the open_in_editor tool call (text + tool call share one
 * message), or the prose right before it. Returns undefined when no
 * assistant text exists in the branch.
 */
export function lastAssistantText(entries: readonly EntryShape[]): string | undefined {
	let last: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = textBlocks(entry.message.content);
		if (text.trim().length > 0) last = text;
	}
	return last;
}

export interface SavedResultInput {
	/** Editor exit status (null = killed by signal). */
	exitStatus: number | null;
	/** Path of the buffer that was open (reported so it can be re-opened by path). */
	bufferPath: string;
	/** Human label of where the buffer came from. */
	source: string;
	/** Buffer contents before the editor ran (file contents or materialized context text). */
	baseline: string;
	/** Buffer contents after the editor exited. */
	contents: string;
	/** Caller asked for the entire contents back. */
	full: boolean;
	/** Unified diff baseline→contents, "" when identical, null when diff(1) is unavailable/failed. */
	diff: string | null;
}

function bytesOf(text: string): string {
	return `${Buffer.byteLength(text, "utf8")} bytes`;
}

/**
 * Format the tool result text. Diff-first: the baseline is already in
 * context (it is either a file the agent just wrote or the assistant
 * text the tool materialized), so a diff carries only the user's
 * changes. Full contents are returned when explicitly requested, when
 * diff(1) is missing, or when the diff would be larger than the
 * contents themselves (then full is strictly more information per
 * token).
 */
export function formatSavedResult(input: SavedResultInput): string {
	const status = input.exitStatus === 0 ? "saved" : `exited with status ${input.exitStatus ?? "null"}`;
	const header = `Editor ${status}. Buffer: ${input.bufferPath} (${input.source}).`;
	if (input.full) {
		return `${header} Full contents (${bytesOf(input.contents)}):\n\n${input.contents}`;
	}
	if (input.contents === input.baseline) {
		return `${header} Unchanged while open (${bytesOf(input.contents)}).`;
	}
	if (input.diff === null) {
		return `${header} Diff unavailable (diff(1) missing or failed) — full contents (${bytesOf(input.contents)}):\n\n${input.contents}`;
	}
	if (input.diff.length > input.contents.length) {
		return `${header} Diff larger than contents — full contents (${bytesOf(input.contents)}):\n\n${input.contents}`;
	}
	return `${header} Changes while open (unified diff):\n\n${input.diff}`;
}
