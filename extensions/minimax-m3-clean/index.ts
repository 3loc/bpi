/**
 * MiniMax-M3 clean streaming for the pi coding agent.
 *
 * Why this exists
 * ---------------
 * pi's built-in `minimax` provider routes every model (M2.7, M3) through
 * MiniMax's Anthropic-compatible endpoint (`api.minimax.io/anthropic`).
 * That endpoint works, but MiniMax-M3's own OpenAI-compatible endpoint
 * (`api.minimax.io/v1`) is where the model behaves best: it applies
 * passive/automatic prompt caching (`prompt_tokens_details.cached_tokens`)
 * without any cache_control markers.
 *
 * The catch: on the OpenAI-compatible endpoint M3 streams its reasoning
 * inline in `content`, wrapped in `<think>…</think>` markers (verified on
 * the wire: no `reasoning_content` field, all deltas in `content`). pi's
 * openai-completions driver would show that raw `<think>` soup as visible
 * text. Some M3 builds additionally alternate between `reasoning_content`
 * and inline `<think>` across chunks, duplicating the same reasoning.
 *
 * An upstream fix (earendil-works/pi commit b85b91c9, "route MiniMax-M3 to
 * openai-completions for passive caching" + a `skipThinkingBlock` compat
 * flag) was never merged — the commit is absent from all refs and the
 * object is gone from GitHub — so as of pi 0.84.3 the built-in provider
 * still has no M3-specific handling. This extension is a local backport of
 * the approach used by the community package
 * `@razllivan/pi-minimax-m3-caching-fix` (MIT, stream-cleaner design
 * adapted here with attribution).
 *
 * What it does
 * ------------
 * Overrides the built-in `minimax` provider (same id, so the stored
 * `minimax` credential keeps working and existing sessions keep their
 * model pinning) with an explicit model list:
 *
 *   MiniMax-M2.7, MiniMax-M2.7-highspeed  → unchanged, Anthropic-compatible
 *                                          endpoint via the built-in driver
 *   MiniMax-M3                            → custom api id `minimax-m3-clean`,
 *                                          routed to `api.minimax.io/v1`
 *                                          (openai-completions driver) with
 *                                          the stream cleaned in flight
 *
 * The cleaner rewrites the openai-completions event stream so that:
 *   - `<think>…</think>` spans never reach a visible text block; tags split
 *     across stream deltas are held back until they can be classified;
 *   - inner think content becomes a proper thinking block when (and only
 *     when) the endpoint did not already stream reasoning fields — when it
 *     did, the inline copy is a duplicate and is dropped;
 *   - re-streamed/duplicated reasoning-field thinking collapses into one
 *     thinking block (prefix dedupe);
 *   - visible text starts at its first non-whitespace character (M3 emits
 *     a blank line after `</think>`).
 *
 * Thinking blocks produced this way are not replayed to the API on later
 * turns (pi's openai-completions driver drops unsigned thinking on replay),
 * which matches MiniMax's passive-caching design: the server caches the
 * prompt prefix, the model re-reasons fresh each turn.
 *
 * Note: M3 always reasons; the openai-compatible endpoint has no parameter
 * to disable it, so "thinking off" cannot be enforced for M3 on this route.
 * The cleaner still keeps the output tidy either way.
 *
 * Flag: pi --m3-clean  → print the model→endpoint routing at startup.
 * Also serves as the load-proof for pi --help / verify.sh.
 *
 * Tuning: contextWindow/cost overrides work through pi's native
 * `~/.pi/agent/models.json` (`minimax` provider `modelOverrides`); no
 * extension-specific override file is needed.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
// pi's own bundled llama extension imports from the same compat entrypoint.
import { streamSimple as dispatchStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ *
 * Constants                                                           *
 * ------------------------------------------------------------------ */

/** Custom api id: only models registered with this api hit our handler
 *  (pi dispatches extension streamSimple on model.api === provider api). */
const M3_API = "minimax-m3-clean" as Api;

const ANTHROPIC_BASE = "https://api.minimax.io/anthropic";
const OPENAI_BASE = "https://api.minimax.io/v1";

/** Compat flags for MiniMax's OpenAI-compatible endpoint. `store` and
 *  `developer` role are OpenAI-isms MiniMax does not want; M3 takes no
 *  reasoning_effort parameter; max_tokens is the accepted budget field. */
const M3_OPENAI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
} as const;

/** Model list mirrors pi's generated minimax catalog (models.dev) so the
 *  M2.7 entries keep their built-in metadata and endpoint; only M3 moves
 *  to the cleaned OpenAI-compatible route. */
const MODELS = [
	{
		id: "MiniMax-M2.7",
		name: "MiniMax-M2.7",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax-M2.7-highspeed",
		api: "anthropic-messages",
		baseUrl: ANTHROPIC_BASE,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.6, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 131072,
	},
	{
		id: "MiniMax-M3",
		name: "MiniMax-M3",
		api: M3_API,
		baseUrl: OPENAI_BASE,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
		compat: M3_OPENAI_COMPAT,
	},
];

/* ------------------------------------------------------------------ *
 * ThinkScanner — incremental <think> tag stripper                     *
 * ------------------------------------------------------------------ */

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Splits a text stream into visible text and `<think>…</think>` inner
 * content. Tags split across deltas are held back until they can be
 * classified (a trailing "<thi" is buffered, not emitted).
 */
class ThinkScanner {
	private buf = "";
	private inThink = false;

	feed(chunk: string): { text: string; think: string } {
		let text = "";
		let think = "";
		const s = this.buf + chunk;
		this.buf = "";
		let i = 0;
		while (i < s.length) {
			const tag = this.inThink ? CLOSE_TAG : OPEN_TAG;
			const idx = s.indexOf(tag, i);
			if (idx !== -1) {
				const piece = s.slice(i, idx);
				if (this.inThink) think += piece;
				else text += piece;
				this.inThink = !this.inThink;
				i = idx + tag.length;
			} else {
				const keep = partialTagSuffix(s, i, tag);
				const piece = s.slice(i, s.length - keep);
				if (this.inThink) think += piece;
				else text += piece;
				this.buf = s.slice(s.length - keep);
				i = s.length;
			}
		}
		return { text, think };
	}

	/** Flush held-back bytes at end of block. An unterminated `<think>`
	 *  stays thinking — it was never visible text. */
	flush(): { text: string; think: string } {
		const rest = this.buf;
		this.buf = "";
		if (!rest) return { text: "", think: "" };
		return this.inThink ? { text: "", think: rest } : { text: rest, think: "" };
	}
}

/** Longest k < tag.length such that s (from `from`) ends with tag.slice(0, k). */
function partialTagSuffix(s: string, from: number, tag: string): number {
	const max = Math.min(tag.length - 1, s.length - from);
	for (let k = max; k > 0; k--) {
		if (s.endsWith(tag.slice(0, k))) return k;
	}
	return 0;
}

/* ------------------------------------------------------------------ *
 * cleanStream — event-stream rewriter                                 *
 * ------------------------------------------------------------------ */

interface TextState {
	scanner: ThinkScanner;
	started: boolean;
	index: number;
	block: TextContent;
}

interface ThinkingSegment {
	block: ThinkingContent;
	index: number;
	open: boolean;
	/** Leading-whitespace-trimmed accumulated thinking text. */
	text: string;
	signature?: string;
}

/**
 * Wrap the openai-completions event stream so `<think>` content never
 * reaches a visible text block and duplicated/re-streamed reasoning
 * collapses into a single thinking block. Tool calls, usage, stop
 * reasons and error/done framing pass through (with content indices
 * remapped to the rewritten content array).
 *
 * Adapted from `@razllivan/pi-minimax-m3-caching-fix` (MIT) — the
 * ThinkScanner + single-merged-segment design is theirs; refinement:
 * inline `<think>` copies are suppressed only when the reasoning fields
 * actually delivered text, not on a bare empty reasoning block.
 */
function cleanStream(base: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	void (async () => {
		let output: AssistantMessage | undefined;
		const toolIndexMap = new Map<number, number>();
		const textStates = new Map<number, TextState>();
		/** Accumulated text per base thinking block, for prefix dedupe. */
		const baseThinkingAccs = new Map<number, string>();
		/** True once reasoning fields delivered non-empty thinking text. */
		let sawBaseThinkingText = false;
		let segment: ThinkingSegment | undefined;

		const ensureOutput = (partial: AssistantMessage): AssistantMessage => {
			if (!output) output = { ...partial, content: [] };
			return output;
		};

		// The base driver mutates its partial in place; mirror everything but
		// content (usage, stopReason, responseId, …) onto our partial.
		const syncMeta = (partial: AssistantMessage) => {
			if (!output) {
				ensureOutput(partial);
				return;
			}
			for (const key of Object.keys(partial)) {
				if (key === "content") continue;
				(output as unknown as Record<string, unknown>)[key] = (
					partial as unknown as Record<string, unknown>
				)[key];
			}
		};

		const ensureSegment = (): ThinkingSegment => {
			if (segment?.open) return segment;
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output!.content.push(block);
			segment = {
				block,
				index: output!.content.length - 1,
				open: true,
				text: "",
			};
			baseThinkingAccs.clear();
			out.push({
				type: "thinking_start",
				contentIndex: segment.index,
				partial: output!,
			});
			return segment;
		};

		const closeSegment = () => {
			if (!segment?.open) return;
			segment.open = false;
			segment.text = segment.text.trimEnd();
			segment.block.thinking = segment.text;
			if (segment.signature) {
				(
					segment.block as ThinkingContent & { thinkingSignature?: string }
				).thinkingSignature = segment.signature;
			}
			out.push({
				type: "thinking_end",
				contentIndex: segment.index,
				content: segment.text,
				partial: output!,
			});
		};

		/** Append already-deduped thinking text to the current segment. */
		const appendThinking = (delta: string) => {
			if (!delta || !output) return;
			const seg = ensureSegment();
			if (seg.text === "") {
				delta = delta.replace(/^\s+/, "");
				if (!delta) return;
			}
			seg.text += delta;
			seg.block.thinking = seg.text;
			out.push({
				type: "thinking_delta",
				contentIndex: seg.index,
				delta,
				partial: output,
			});
		};

		/**
		 * Thinking from a base reasoning-field block. Some M3 builds
		 * re-stream the same reasoning when the driver switches reasoning
		 * fields, so emit only the part that extends what the current
		 * segment already holds.
		 */
		const pushBaseThinking = (contentIndex: number, delta: string) => {
			const acc = (baseThinkingAccs.get(contentIndex) ?? "") + delta;
			baseThinkingAccs.set(contentIndex, acc);
			if (acc.trim().length > 0) sawBaseThinkingText = true;
			const seg = segment?.open ? segment : undefined;
			const have = seg?.text ?? "";
			const norm = acc.replace(/^\s+/, "");
			if (norm.length <= have.length) {
				// Duplicate prefix of what we already emitted → suppress.
				if (have.startsWith(norm)) return;
				appendThinking(delta);
			} else if (norm.startsWith(have)) {
				appendThinking(norm.slice(have.length));
			} else {
				appendThinking(delta);
			}
		};

		/** Thinking recovered from inline `<think>…</think>` markers. */
		const pushInlineThinking = (think: string) => {
			// If the endpoint streamed real reasoning fields, the inline copy
			// is a duplicate — drop it.
			if (!think || sawBaseThinkingText || !output) return;
			appendThinking(think);
		};

		const pushText = (state: TextState, text: string) => {
			if (!text || !output) return;
			if (!state.started) {
				text = text.replace(/^\s+/, "");
				if (!text) return;
				closeSegment();
				output.content.push(state.block);
				state.index = output.content.length - 1;
				state.started = true;
				out.push({
					type: "text_start",
					contentIndex: state.index,
					partial: output,
				});
			}
			state.block.text += text;
			out.push({
				type: "text_delta",
				contentIndex: state.index,
				delta: text,
				partial: output,
			});
		};

		try {
			for await (const ev of base) {
				switch (ev.type) {
					case "start": {
						ensureOutput(ev.partial);
						out.push({ type: "start", partial: output! });
						break;
					}
					case "thinking_start": {
						syncMeta(ev.partial);
						baseThinkingAccs.set(ev.contentIndex, "");
						break;
					}
					case "thinking_delta": {
						syncMeta(ev.partial);
						pushBaseThinking(ev.contentIndex, ev.delta);
						break;
					}
					case "thinking_end": {
						syncMeta(ev.partial);
						// Don't close the merged segment: the driver may open a
						// follow-up block that continues the same reasoning. Just
						// remember the signature for the final block.
						const baseBlock = ev.partial.content[ev.contentIndex] as
							| (ThinkingContent & { thinkingSignature?: string })
							| undefined;
						if (
							segment &&
							baseBlock?.type === "thinking" &&
							baseBlock.thinkingSignature
						) {
							segment.signature = baseBlock.thinkingSignature;
						}
						break;
					}
					case "text_start": {
						syncMeta(ev.partial);
						// Don't emit yet: the block may turn out to be pure
						// <think> content. text_start fires on the first visible
						// character.
						textStates.set(ev.contentIndex, {
							scanner: new ThinkScanner(),
							started: false,
							index: -1,
							block: { type: "text", text: "" },
						});
						break;
					}
					case "text_delta": {
						syncMeta(ev.partial);
						const state = textStates.get(ev.contentIndex);
						if (!state) break;
						const { text, think } = state.scanner.feed(ev.delta);
						pushInlineThinking(think);
						pushText(state, text);
						break;
					}
					case "text_end": {
						syncMeta(ev.partial);
						const state = textStates.get(ev.contentIndex);
						if (!state) break;
						const tail = state.scanner.flush();
						pushInlineThinking(tail.think);
						pushText(state, tail.text);
						if (state.started) {
							state.block.text = state.block.text.trimEnd();
							out.push({
								type: "text_end",
								contentIndex: state.index,
								content: state.block.text,
								partial: output!,
							});
						}
						break;
					}
					case "toolcall_start": {
						syncMeta(ev.partial);
						closeSegment();
						const baseBlock = ev.partial.content[ev.contentIndex];
						output!.content.push(
							baseBlock as AssistantMessage["content"][number],
						);
						toolIndexMap.set(ev.contentIndex, output!.content.length - 1);
						out.push({
							type: "toolcall_start",
							contentIndex: toolIndexMap.get(ev.contentIndex)!,
							partial: output!,
						});
						break;
					}
					case "toolcall_delta": {
						syncMeta(ev.partial);
						const idx = toolIndexMap.get(ev.contentIndex);
						if (idx === undefined) break;
						out.push({
							type: "toolcall_delta",
							contentIndex: idx,
							delta: ev.delta,
							partial: output!,
						});
						break;
					}
					case "toolcall_end": {
						syncMeta(ev.partial);
						const idx = toolIndexMap.get(ev.contentIndex);
						if (idx === undefined) break;
						output!.content[idx] = ev.toolCall;
						out.push({
							type: "toolcall_end",
							contentIndex: idx,
							toolCall: ev.toolCall,
							partial: output!,
						});
						break;
					}
					case "done": {
						closeSegment();
						const message: AssistantMessage = {
							...ev.message,
							content: output ? output.content : ev.message.content,
						};
						out.push({ type: "done", reason: ev.reason, message });
						break;
					}
					case "error": {
						closeSegment();
						const error: AssistantMessage = {
							...ev.error,
							content: output ? output.content : ev.error.content,
						};
						out.push({ type: "error", reason: ev.reason, error });
						break;
					}
				}
			}
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			const fallback: AssistantMessage = output ?? {
				role: "assistant",
				content: [],
				api: M3_API,
				provider: "minimax",
				model: "MiniMax-M3",
				usage: {} as AssistantMessage["usage"],
				stopReason: "error",
				timestamp: Date.now(),
			};
			out.push({
				type: "error",
				reason: "error",
				error: { ...fallback, stopReason: "error", errorMessage },
			});
		}
	})();

	return out;
}

/* ------------------------------------------------------------------ *
 * Extension entry                                                     *
 * ------------------------------------------------------------------ */

/**
 * streamSimple handler for models registered under the `minimax-m3-clean`
 * api id. Dispatches to pi's built-in openai-completions driver against
 * MiniMax's OpenAI-compatible endpoint (auth already resolved into
 * options.apiKey by the model runtime) and cleans the stream in flight.
 * baseUrl/compat are re-asserted in the spread so the driver sees the
 * canonical route regardless of what the registration path produced.
 */
function streamM3Clean(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const routed = {
		...model,
		api: "openai-completions",
		baseUrl: OPENAI_BASE,
		compat: M3_OPENAI_COMPAT,
	} as unknown as Model<"openai-completions">;
	return cleanStream(dispatchStreamSimple(routed, context, options));
}

export default function minimaxM3Clean(pi: ExtensionAPI): void {
	pi.registerFlag("m3-clean", {
		description: "Show MiniMax model→endpoint routing at startup",
		type: "boolean",
		default: false,
	});

	// Same provider id as the built-in: the stored `minimax` credential is
	// inherited by the composed provider, and sessions pinned to
	// minimax/MiniMax-* keep resolving. models.json modelOverrides still
	// apply on top of this list.
	pi.registerProvider("minimax", {
		api: M3_API,
		streamSimple: streamM3Clean,
		models: MODELS,
	});

	pi.on("session_start", (_event, ctx) => {
		if (pi.getFlag("m3-clean") !== true) return;
		const lines = [
			"minimax routing:",
			"  MiniMax-M2.7(-highspeed) → api.minimax.io/anthropic (built-in driver)",
			"  MiniMax-M3 → api.minimax.io/v1 (openai-completions, <think> cleaned, passive caching)",
		];
		for (const line of lines) {
			if (ctx.mode === "tui") ctx.ui.notify(line, "info");
			else console.log(line);
		}
	});
}
