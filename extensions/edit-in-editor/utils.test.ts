/**
 * Unit tests for the edit-in-editor pure helpers.
 *
 * Covers the three pieces with real logic:
 *   - resolveEditor: $EDITOR parsing (quoting, args, fallbacks).
 *   - lastAssistantText: which session entry the context mode
 *     materializes — the last assistant message with text, skipping
 *     tool-call-only messages, is the load-bearing choice; picking
 *     the in-flight tool-call message (no text) or an older prose
 *     message would open the wrong buffer.
 *   - formatSavedResult: diff-first result text and its degradation
 *     ladder (full → unchanged → no-diff fallback → diff-larger-than-
 *     contents → diff), which is what keeps the report from being
 *     re-sent into context on every editor round-trip.
 *
 * Not covered here: the editor spawn / TUI suspension (needs a real
 * TTY) and computeDiff (shells out to diff(1)) — exercised by live
 * use via the code-review skill.
 *
 * Run with:  node --test --experimental-strip-types extensions/edit-in-editor/utils.test.ts
 * Or:        npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSavedResult, lastAssistantText, resolveEditor } from "./utils.ts";
import type { EntryShape } from "./utils.ts";

describe("resolveEditor", () => {
	it("falls back to vi when unset or blank", () => {
		assert.deepEqual(resolveEditor(undefined), { cmd: "vi", args: [] });
		assert.deepEqual(resolveEditor("   "), { cmd: "vi", args: [] });
	});

	it("splits a bare command", () => {
		assert.deepEqual(resolveEditor("nvim"), { cmd: "nvim", args: [] });
	});

	it("keeps leading args for wrapper editors", () => {
		assert.deepEqual(resolveEditor("code --wait"), { cmd: "code", args: ["--wait"] });
	});

	it("honors quoted command names", () => {
		assert.deepEqual(resolveEditor("'my editor' -w"), { cmd: "my editor", args: ["-w"] });
		assert.deepEqual(resolveEditor('"my editor"'), { cmd: "my editor", args: [] });
	});
});

describe("lastAssistantText", () => {
	it("returns undefined for an empty branch", () => {
		assert.equal(lastAssistantText([]), undefined);
	});

	it("skips non-assistant entries", () => {
		const entries: EntryShape[] = [
			{ type: "message", message: { role: "user", content: "review please" } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "output" }] } },
			{ type: "custom", message: undefined },
		];
		assert.equal(lastAssistantText(entries), undefined);
	});

	it("skips assistant entries that carry only tool calls", () => {
		const entries: EntryShape[] = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
			},
		];
		assert.equal(lastAssistantText(entries), undefined);
	});

	it("skips assistant entries with empty text blocks", () => {
		const entries: EntryShape[] = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "  \n" }] } },
		];
		assert.equal(lastAssistantText(entries), undefined);
	});

	it("extracts assistant text blocks", () => {
		const entries: EntryShape[] = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "thinking", text: "hm" }, { type: "text", text: "part 1" }, { type: "text", text: "part 2" }] },
			},
		];
		assert.equal(lastAssistantText(entries), "part 1\npart 2");
	});

	it("accepts string content", () => {
		const entries: EntryShape[] = [
			{ type: "message", message: { role: "assistant", content: "plain text" } },
		];
		assert.equal(lastAssistantText(entries), "plain text");
	});

	it("prefers the last assistant message with text over earlier ones and tool-only tails", () => {
		const entries: EntryShape[] = [
			{ type: "message", message: { role: "user", content: "go" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "early report" }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }] },
			},
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final report" }] } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "t3", name: "open_in_editor", arguments: {} }] },
			},
		];
		assert.equal(lastAssistantText(entries), "final report");
	});
});

describe("formatSavedResult", () => {
	const base = {
		exitStatus: 0,
		bufferPath: "/tmp/edit-in-editor-x/buffer.md",
		source: 'context: lastAssistant — "## Review"',
	} as const;

	it("returns full contents when asked", () => {
		const text = formatSavedResult({
			...base,
			baseline: "old",
			contents: "new contents",
			full: true,
			diff: null,
		});
		assert.match(text, /Editor saved\. Buffer: \/tmp\/edit-in-editor-x\/buffer\.md/);
		assert.match(text, /Full contents \(12 bytes\):/);
		assert.match(text, /\n\nnew contents$/);
	});

	it("reports unchanged buffers compactly", () => {
		const text = formatSavedResult({
			...base,
			baseline: "same",
			contents: "same",
			full: false,
			diff: "",
		});
		assert.match(text, /Unchanged while open \(4 bytes\)\./);
		assert.doesNotMatch(text, /\n\nsame/);
	});

	it("falls back to full contents when diff is unavailable", () => {
		const text = formatSavedResult({
			...base,
			baseline: "a",
			contents: "b",
			full: false,
			diff: null,
		});
		assert.match(text, /Diff unavailable \(diff\(1\) missing or failed\)/);
		assert.match(text, /\n\nb$/);
	});

	it("falls back to full contents when the diff is larger than the contents", () => {
		const text = formatSavedResult({
			...base,
			baseline: "",
			contents: "xy",
			full: false,
			diff: "--- original\n+++ edited\n@@\n-...\n+xy\n",
		});
		assert.match(text, /Diff larger than contents/);
		assert.match(text, /\n\nxy$/);
	});

	it("returns the diff when it is smaller than the contents", () => {
		const baseline = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n";
		const contents = "line1\nline2\nline3\nline4 edited\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n";
		const diff = "--- original\n+++ edited\n@@ -4 +4 @@\n-line4\n+line4 edited\n";
		const text = formatSavedResult({
			...base,
			baseline,
			contents,
			full: false,
			diff,
		});
		assert.match(text, /Changes while open \(unified diff\):/);
		assert.match(text, new RegExp(`\\n\\n${diff.replaceAll("\n", "\\n").replaceAll("+", "\\+")}$`));
	});

	it("labels non-zero editor exit status", () => {
		const text = formatSavedResult({
			...base,
			exitStatus: 1,
			baseline: "same",
			contents: "same",
			full: false,
			diff: "",
		});
		assert.match(text, /Editor exited with status 1\./);
	});

	it("labels a killed editor", () => {
		const text = formatSavedResult({
			...base,
			exitStatus: null,
			baseline: "same",
			contents: "same",
			full: false,
			diff: "",
		});
		assert.match(text, /Editor exited with status null\./);
	});
});
