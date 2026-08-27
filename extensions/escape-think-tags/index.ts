/**
 * Escape literal think-tag substrings in rendered assistant text.
 *
 * Why
 * ---
 * Reasoning models (MiniMax-M3, DeepSeek R1, etc.) and humans writing
 * about them both produce literal "open-angle + think + close-angle" and
 * matching close-tag sequences inside assistant-visible text: in code
 * examples, in markdown docs, in explanations of how a model reasons.
 *
 * pi itself does not currently scrub these substrings — assistant text
 * flows through a standard Markdown renderer and the literal sequences
 * display as-is. That is fine for pi's TUI today.
 *
 * The problem surfaces downstream: any markdown consumer that does treat
 * those sequences as thinking-block markers (some chat UIs, third-party
 * rendering pipelines, copy/paste into LLMs that interpret them as
 * out-of-band reasoning) will hide, drop, or mis-route the enclosed
 * content. When that happens, the assistant message appears to "lose"
 * portions of its prose — the same corner case observed in this session
 * when the chat interface between the user and the assistant scrubbed
 * literal think-tag substrings out of an assistant reply.
 *
 * This extension is a defensive belt-and-suspenders: it registers a
 * Markdown transformer that runs only on `assistant` messages (never on
 * real `assistant-thinking` content blocks — those are already extracted
 * by the upstream stream cleaner and rendered separately) and wraps any
 * literal think-tag pair in inline code spans so the substring renders
 * as visible code text rather than a marker.
 *
 * Opt-in: pi --escape-think-tags enables the transformer. Off by default
 * because (a) pi does not currently need it, and (b) users pasting
 * markdown docs that legitimately contain think-tag sequences may
 * prefer to see them rendered as code anyway — opting in is a
 * deliberate choice, not a silent default.
 *
 * Patterns handled:
 *   <think>...</think>           → `<think>...</think>` (code spans)
 *   unclosed <think>             → `<think>` (single code span)
 *   unclosed stray </think>      → `</think>` (single code span)
 *
 * The close-tag rule is symmetric so an unterminated open tag in one
 * message and the matching close tag in a later message don't get
 * matched across the boundary — each is escaped on its own.
 *
 * What it does NOT touch:
 *   - Real thinking blocks (`assistant-thinking` messageType, set by
 *     pi's own renderer for content blocks of type "thinking").
 *   - User messages, tool calls, or anything outside the assistant
 *     markdown pipeline.
 *   - The on-disk session JSONL (transformer runs at render time only;
 *     replayed history keeps the original text verbatim).
 *
 * Flag: pi --escape-think-tags  → enable the transformer (load proof
 * for pi --help / verify.sh).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export default function escapeThinkTagsExtension(pi: ExtensionAPI): void {
	pi.registerFlag("escape-think-tags", {
		description: "Escape literal <think>/</think> in rendered assistant markdown (render-time only)",
		type: "boolean",
		default: false,
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		if (!pi.getFlag("escape-think-tags")) return markdown;

		// Match a complete pair first so inner content survives intact as a
		// single code span; then escape any unpaired open or close tags left
		// over (unterminated thinking, or cross-message splits).
		let result = markdown.replace(
			/<think>([\s\S]*?)<\/think>/g,
			(_match, inner) => `\`${OPEN_TAG}${inner}${CLOSE_TAG}\``,
		);
		result = result.replace(/<think>/g, `\`${OPEN_TAG}\``);
		result = result.replace(/<\/think>/g, `\`${CLOSE_TAG}\``);
		return result;
	});
}
