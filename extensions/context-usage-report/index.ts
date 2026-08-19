/**
 * context-usage-report extension for the pi coding agent.
 *
 * Reports the size of the current LLM context — the model-reported total,
 * its share of the model's context window, and a per-category breakdown
 * of where those tokens go.
 *
 * The breakdown partitions the prompt + conversation into:
 *
 *   - System prompt       default base prompt (or custom prompt) +
 *                         --append-system-prompt / APPEND_SYSTEM.md
 *   - Project context     AGENTS.md / AGENTS.override.md / CLAUDE.md
 *                         files loaded from cwd and ancestors
 *   - Skills              each loaded skill's metadata block in the prompt
 *   - Conversation        user prompts, assistant replies, tool results,
 *                         custom messages — from the active session branch
 *
 * Estimating tokens (why not a real tokenizer):
 *   Every provider uses a different BPE vocabulary (OpenAI: tiktoken
 *   encodings; GLM: own BPE, ~151k vocab; MiniMax: own BPE, ~200k vocab;
 *   Anthropic: unpublished). Their tokenizer files are 10-20 MB artifacts
 *   on HuggingFace and shipping one per provider is not worth it for a
 *   status display. Instead:
 *
 *   1. Content-aware heuristic, tuned against the real GLM-4.6 tokenizer
 *      (151k BPE vocab, tokenizer.json from HuggingFace) on real pi
 *      content — rendered prompt + a full coding session:
 *        prose/markdown (AGENTS.md, skills XML)   3.95-4.06 chars/token
 *        code/JSON (tool results, tool-call args) 3.45 chars/token
 *        CJK text                                 1.92 chars/token
 *        dense English boilerplate (system prompt, user msgs) ~4.6
 *      With 4.0 / 3.5 / 1.9 the total lands within ~2% of the real
 *      count; the folklore chars/4 underestimates by ~11% here and is
 *      ~2.5x off on CJK.
 *   2. Clear attribution. Providers report exactly one number — the
 *      grand total — never per-section counts. The table therefore has
 *      two token columns: "Provider" (measured; fills in at the Total row
 *      after the first LLM call) and "Heuristic" (per-category estimates,
 *      always shown raw — no scaling — so the two totals quantify the
 *      estimate's drift live). Model-agnostic, zero dependencies.
 *
 *   Before the first LLM call (usage not yet reported) the raw heuristic
 *   counts are shown and the footer says so.
 *
 * Commands:
 *   /context-report              full breakdown table (default)
 *   /context-report total        one-line summary (tokens + % + model)
 *   /context-report system       system + project + skills (no conversation)
 *
 * Flags:
 *   pi --context-report          show full breakdown table at startup
 *                                (default: one-line header only)
 *
 * Output:
 *   - TUI mode (default): rendered via ctx.ui.notify (a single multi-line
 *     notification with a Unicode-bordered table)
 *   - Print mode (pi -p "/context-report"): written to stdout so the same
 *     path is scriptable without an LLM call
 */

import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ *
 * Token estimation                                                    *
 * ------------------------------------------------------------------ */

/** chars per token for prose/markdown-heavy text (measured vs GLM-4.6: 3.95-4.06) */
const RATIO_PROSE = 4.0;
/** chars per token for code/JSON-heavy text (measured vs GLM-4.6: 3.45) */
const RATIO_CODE = 3.5;
/** chars per token for CJK scripts (measured vs GLM-4.6: 1.92) */
const RATIO_CJK = 1.9;
/** matches pi's compaction estimator: one image ≈ 4800 chars ≈ ~1.3k tokens */
const ESTIMATED_IMAGE_CHARS = 4800;

/** CJK + hangul + kana ranges — these tokenize at ~1.5 chars/token. */
const CJK_RE = /[\u1100-\u11FF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

/**
 * Estimate tokens for a string, splitting CJK from non-CJK runs so that
 * mixed-language text is not wildly off (a naive chars/N treats Chinese
 * like English and can be off by >2x).
 */
function textTokens(text: string, charsPerToken: number): number {
	let cjkChars = 0;
	const nonCjk = text.replace(CJK_RE, () => {
		cjkChars++;
		return "";
	});
	return Math.ceil(cjkChars / RATIO_CJK) + Math.ceil(nonCjk.length / charsPerToken);
}

/**
 * Estimate tokens for one session message, mirroring pi's
 * estimateTokens() content walk but with content-aware ratios:
 * tool results and tool-call arguments are JSON/code (RATIO_CODE),
 * ordinary text is prose (RATIO_PROSE).
 */
function messageTokens(message: { role: string; content?: unknown }): number {
	const m = message as {
		content?: string | Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>;
	};
	let prose = "";
	let code = "";
	let images = 0;

	const pushText = (t: string | undefined, codeIsh: boolean): void => {
		if (!t) return;
		if (codeIsh) code += t;
		else prose += t;
	};

	switch (m.role) {
		case "user":
		case "toolResult":
		case "custom": {
			// toolResult content is mostly JSON/file dumps → code ratio;
			// user/custom content is typically prose with some pasted code.
			const codeIsh = m.role === "toolResult";
			if (typeof m.content === "string") {
				pushText(m.content, codeIsh);
			} else if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block.type === "text") pushText(block.text, codeIsh);
					else if (block.type === "image") images++;
				}
			}
			break;
		}
		case "assistant": {
			if (Array.isArray(m.content)) {
				for (const block of m.content) {
					if (block.type === "text") pushText(block.text, false);
					else if (block.type === "thinking") pushText(block.thinking, false);
					else if (block.type === "toolCall") {
						pushText(block.name, true);
						pushText(JSON.stringify(block.arguments), true);
					}
				}
			}
			break;
		}
		case "bashExecution": {
			const b = message as { command: string; output: string };
			pushText(b.command + b.output, true);
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			const s = message as { summary: string };
			pushText(s.summary, false);
			break;
		}
		default:
			return 0;
	}

	return (
		textTokens(prose, RATIO_PROSE) +
		textTokens(code, RATIO_CODE) +
		images * Math.ceil(ESTIMATED_IMAGE_CHARS / RATIO_PROSE)
	);
}

/* ------------------------------------------------------------------ *
 * System prompt parsing                                               *
 * ------------------------------------------------------------------ */

interface ContextFileSection {
	path: string;
	label: string;
	text: string;
}

interface SkillSection {
	name: string;
	path: string;
	text: string;
}

interface ParsedPrompt {
	/** system prompt text excluding the tagged sections and cwd suffix */
	systemText: string;
	projectFiles: ContextFileSection[];
	skills: SkillSection[];
	/** working-directory footer (`\nCurrent working directory: ...`) */
	cwdText: string;
}

function shortHome(path: string): string {
	const home = process.env.HOME ?? "";
	if (home && (path === home || path.startsWith(home + "/"))) {
		return "~" + path.slice(home.length);
	}
	return path;
}

/** Build a short, human-friendly label for a project context file. */
function labelForContextPath(path: string): string {
	const base = path.replace(/^.*\//, "");
	const home = process.env.HOME ?? "";
	const agentDir = `${home}/.pi/agent`;
	// Global AGENTS.md (in ~/.pi/agent) — distinguish from project copies.
	if (path === `${agentDir}/${base}` || path.startsWith(`${agentDir}/`)) {
		return `${base} (~/.pi/agent)`;
	}
	return base;
}

/**
 * Parse the rendered system prompt into its top-level sections.
 *
 * The prompt structure comes from buildSystemPrompt() (see the package's
 * src/core/system-prompt.ts) — clear XML-like tags delimit the variable
 * parts, so we can split the fixed base from the per-resource blocks
 * without needing the structured BuildSystemPromptOptions (which is only
 * available on ExtensionCommandContext, not the regular ExtensionContext
 * we get at session_start).
 */
function parseSystemPrompt(prompt: string): ParsedPrompt {
	const projectFiles: ContextFileSection[] = [];
	const skills: SkillSection[] = [];

	const projectBlock = prompt.match(/<project_context>[\s\S]*?<\/project_context>/);
	if (projectBlock) {
		const inner = projectBlock[0];
		const fileRe = /<project_instructions path="([^"]+)">([\s\S]*?)<\/project_instructions>/g;
		let m: RegExpExecArray | null;
		while ((m = fileRe.exec(inner)) !== null) {
			const filePath = m[1];
			const content = m[2];
			projectFiles.push({
				path: filePath,
				label: labelForContextPath(filePath),
				// Tag overhead (path attr + open/close tags) rides along as noise.
				text: `${filePath}${content}${"<project_instructions></project_instructions>"}`,
			});
		}
	}

	const skillsBlock = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
	if (skillsBlock) {
		const inner = skillsBlock[0];
		const skillRe = /<skill>([\s\S]*?)<\/skill>/g;
		let m: RegExpExecArray | null;
		while ((m = skillRe.exec(inner)) !== null) {
			const skillInner = m[1];
			const name = skillInner.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? "(unnamed)";
			const path = skillInner.match(/<location>([\s\S]*?)<\/location>/)?.[1]?.trim() ?? "";
			// Skill metadata only (name + description + location). The body is
			// not in the prompt — the model reads SKILL.md on demand.
			skills.push({
				name,
				path: shortHome(path),
				text: skillInner,
			});
		}
	}

	// System prompt text = prompt minus the tagged blocks minus cwd footer.
	// The cwd footer is the trailing `Current working directory: <path>` line.
	const cwdMatch = prompt.match(/\nCurrent working directory: [^\n]*\n?$/);
	const cwdText = cwdMatch ? cwdMatch[0] : "";

	const systemText = prompt
		.replace(projectBlock?.[0] ?? "", "")
		.replace(skillsBlock?.[0] ?? "")
		.replace(cwdText, "");

	return {
		systemText,
		projectFiles,
		skills,
		cwdText,
	};
}

/* ------------------------------------------------------------------ *
 * Conversation breakdown                                              *
 * ------------------------------------------------------------------ */

interface ConversationBreakdown {
	user: number;
	assistant: number;
	toolResult: number;
	custom: number;
	summaries: number;
	other: number;
	total: number;
}

/**
 * Sum estimated tokens across the messages the model actually sees,
 * grouped by role — i.e. buildContextEntries(), the compaction-aware entry
 * list (post-compaction kept entries + the compaction summary), not the
 * full getBranch() history. Summarized-away messages are not counted.
 */
function breakdownConversation(ctx: ExtensionContext): ConversationBreakdown {
	const result: ConversationBreakdown = {
		user: 0,
		assistant: 0,
		toolResult: 0,
		custom: 0,
		summaries: 0,
		other: 0,
		total: 0,
	};
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		// Entries that do not participate in context project to [].
		for (const message of sessionEntryToContextMessages(entry)) {
			const tokens = messageTokens(message);
			result.total += tokens;
			switch (message.role) {
				case "user":
					result.user += tokens;
					break;
				case "assistant":
					result.assistant += tokens;
					break;
				case "toolResult":
					result.toolResult += tokens;
					break;
				case "custom":
					result.custom += tokens;
					break;
				case "compactionSummary":
				case "branchSummary":
					result.summaries += tokens;
					break;
				default:
					result.other += tokens;
					break;
			}
		}
	}
	return result;
}

/* ------------------------------------------------------------------ *
 * Rendering                                                           *
 * ------------------------------------------------------------------ */

interface BreakdownRow {
	label: string;
	tokens: number;
}

/** Format a number with thousands separators (e.g. 12345 → "12,345"). */
function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function padLeft(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function padRight(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

interface TableColumn {
	header: string;
	align: "left" | "right";
}

/**
 * Render a Unicode-bordered table with per-column alignment. Column widths
 * are computed from the widest content; numeric columns are right-aligned,
 * the category column is left-aligned (with `  ` indentation for sub-rows
 * so the hierarchy is obvious).
 *
 * Box-drawing chars (single-line): top ┌─┬─┐, header sep ├─┼─┤,
 * row cell │, bottom └─┴─┘. Pure ASCII would be more portable but
 * significantly noisier — pi's TUI is monospace, so the chars align.
 */
function renderTable(columns: TableColumn[], rows: string[][], totalRow: string[] | undefined): string {
	const widths = columns.map((c, i) => {
		let w = c.header.length;
		for (const row of rows) w = Math.max(w, row[i]?.length ?? 0);
		if (totalRow) w = Math.max(w, totalRow[i]?.length ?? 0);
		return w;
	});

	const hLine = (left: string, mid: string, right: string): string =>
		left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right;
	const top = hLine("┌", "┬", "┐");
	const mid = hLine("├", "┼", "┤");
	const bot = hLine("└", "┴", "┘");

	const cellRow = (cells: string[]): string =>
		"│ " +
		cells
			.map((c, i) => (columns[i].align === "left" ? padRight(c, widths[i]) : padLeft(c, widths[i])))
			.join(" │ ") +
		" │";

	const out: string[] = [top, cellRow(columns.map((c) => c.header)), mid];
	for (const row of rows) {
		out.push(cellRow(row));
	}
	if (totalRow) {
		out.push(mid);
		out.push(cellRow(totalRow));
	}
	out.push(bot);
	return out.join("\n");
}

/**
 * Render the breakdown as a multi-line string.
 *
 * Sections are disjoint: the total sums only the top-level sections
 * (system+cwd, project, skills, conversation) — sub-rows are subsets of
 * their parents and must not be counted twice.
 *
 * Token counts are attributed in two columns: "Provider" holds what the
 * model actually reported (only the grand total — providers never report
 * per-section counts) and "Heuristic" holds our per-category estimates,
 * shown raw (no scaling) so the two totals quantify the estimate's drift.
 * Percentages are shares of the heuristic total.
 */
function renderBreakdown(
	model: { provider: string; id: string; name: string },
	window: number,
	actualTokens: number | null,
	parsed: ParsedPrompt,
	convo: ConversationBreakdown,
	systemOnly = false,
): string {
	const systemRow: BreakdownRow = { label: "System prompt", tokens: textTokens(parsed.systemText, RATIO_PROSE) };
	const cwdRow: BreakdownRow = { label: "Working directory", tokens: textTokens(parsed.cwdText, RATIO_PROSE) };
	const projectRows: BreakdownRow[] = parsed.projectFiles.map((f) => ({
		label: f.label,
		tokens: textTokens(f.text, RATIO_PROSE),
	}));
	const skillRows: BreakdownRow[] = parsed.skills.map((s) => ({
		label: s.name,
		tokens: textTokens(s.text, RATIO_PROSE),
	}));
	const convoRows: BreakdownRow[] = [
		{ label: "User prompts", tokens: convo.user },
		{ label: "Assistant replies", tokens: convo.assistant },
		{ label: "Tool results", tokens: convo.toolResult },
		{ label: "Custom messages", tokens: convo.custom },
	];
	if (convo.summaries > 0)
		convoRows.push({ label: "Compaction/branch summaries", tokens: convo.summaries });
	if (convo.other > 0) convoRows.push({ label: "Other", tokens: convo.other });

	// Display rows: parents at indent 0, children at indent 2 (children are
	// subsets of parents — excluded from the total).
	const rows: Array<{ row: BreakdownRow; indent: number }> = [];
	rows.push({ row: systemRow, indent: 0 });
	if (parsed.cwdText.length > 0) rows.push({ row: cwdRow, indent: 2 });
	if (projectRows.length > 0) {
		rows.push({
			row: { label: "Project context", tokens: projectRows.reduce((s, r) => s + r.tokens, 0) },
			indent: 0,
		});
		for (const r of projectRows) rows.push({ row: r, indent: 2 });
	}
	if (skillRows.length > 0) {
		const totalSkills = skillRows.reduce((s, r) => s + r.tokens, 0);
		rows.push({ row: { label: "Skills (metadata)", tokens: totalSkills }, indent: 0 });
		for (const r of skillRows) rows.push({ row: r, indent: 2 });
	}
	if (!systemOnly && convo.total > 0) {
		rows.push({ row: { label: "Conversation", tokens: convo.total }, indent: 0 });
		for (const r of convoRows) {
			if (r.tokens === 0) continue;
			rows.push({ row: r, indent: 2 });
		}
	}

	// Disjoint section totals — no parent/child double counting.
	const breakdownTotal =
		systemRow.tokens +
		cwdRow.tokens +
		projectRows.reduce((s, r) => s + r.tokens, 0) +
		skillRows.reduce((s, r) => s + r.tokens, 0) +
		(systemOnly ? 0 : convo.total);

	// Two token columns for attribution: "Provider" = what the model
	// actually reported (total only — providers never report per section),
	// "Heuristic" = our per-category estimate, raw (no scaling) so the two
	// totals visibly quantify the heuristic's drift.
	const tableRows: string[][] = rows.map(({ row, indent }) => {
		const label = " ".repeat(indent) + row.label;
		const pct = breakdownTotal > 0 ? `${((row.tokens / breakdownTotal) * 100).toFixed(1)}%` : "—";
		return [label, "—", fmt(row.tokens), pct];
	});

	const totalRow: string[] = [
		"Total",
		actualTokens !== null ? fmt(actualTokens) : "—",
		fmt(breakdownTotal),
		breakdownTotal > 0 ? "100.0%" : "—",
	];

	const lines: string[] = [];
	const pct = actualTokens !== null && window > 0 ? (actualTokens / window) * 100 : null;
	const modelLine = `${model.provider}/${model.id}`;
	const usageLine =
		actualTokens !== null
			? `${fmt(actualTokens)} / ${fmt(window)} tokens (${pct?.toFixed(1)}%)`
			: `unknown / ${fmt(window)} tokens`;
	lines.push(`Context: ${usageLine} — model: ${modelLine}`);
	lines.push("");
	lines.push(
		renderTable(
			[
				{ header: "Category", align: "left" },
			{ header: "Provider", align: "right" },
			{ header: "Heuristic", align: "right" },
			{ header: "%", align: "right" },
			],
			tableRows,
			totalRow,
		),
	);
	lines.push("");
	if (actualTokens !== null && actualTokens > 0) {
		const drift = ((breakdownTotal - actualTokens) / actualTokens) * 100;
		lines.push(
			"Provider column = measured usage; only the grand total is ever reported",
			"(never per section). Heuristic column = estimate, currently",
			`${drift >= 0 ? "+" : ""}${drift.toFixed(1)}% vs the measurement (tokenizers differ per model — ratios are tuned on GLM-4.6).`,
		);
	} else {
		lines.push(
			"Provider column fills in after the first model call. Heuristic column =",
			"content-aware estimate (≈4 chars/token prose, ≈3.5 code, ≈1.9 CJK; within",
			"~3% of the real GLM-4.6 tokenizer on coding-session content).",
		);
	}
	lines.push("Skill bodies (full SKILL.md) are read on demand and not counted here.");

	return lines.join("\n");
}

/** One-line summary: total tokens + % of window + model. */
function renderHeader(
	model: { provider: string; id: string },
	window: number,
	actualTokens: number | null,
): string {
	const modelLine = `${model.provider}/${model.id}`;
	if (actualTokens === null) {
		return `Context: — / ${fmt(window)} tokens — model: ${modelLine} (no usage reported yet — /context-report for breakdown)`;
	}
	const pct = window > 0 ? (actualTokens / window) * 100 : 0;
	return `Context: ${fmt(actualTokens)} / ${fmt(window)} tokens (${pct.toFixed(1)}%) — model: ${modelLine} — /context-report for breakdown`;
}

/* ------------------------------------------------------------------ *
 * Extension wiring                                                    *
 * ------------------------------------------------------------------ */

interface ModelInfo {
	provider: string;
	id: string;
	name: string;
}

function modelInfo(ctx: ExtensionContext): ModelInfo | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return { provider: m.provider, id: m.id, name: m.name };
}

/** Emit the rendered string via notify (TUI) or stdout (print / rpc). */
function emit(ctx: ExtensionContext, text: string): void {
	if (ctx.mode === "print") {
		console.log(text);
	} else {
		ctx.ui.notify(text, "info");
	}
}

function runBreakdown(ctx: ExtensionContext, systemOnly: boolean): void {
	const model = modelInfo(ctx);
	if (!model) {
		// Silent skip — the footer already shows "no model" and an empty
		// notification is just noise at startup.
		return;
	}
	const usage = ctx.getContextUsage();
	// ctx.model.contextWindow is the static field on the Model shape;
	// usage.contextWindow is the runtime-effective window (usually identical,
	// but kept here as the canonical source when available).
	const actualTokens = usage?.tokens ?? null;
	const effectiveWindow =
		usage?.contextWindow ?? (ctx.model as { contextWindow?: number })?.contextWindow ?? 0;
	const parsed = parseSystemPrompt(ctx.getSystemPrompt());
	const convo = breakdownConversation(ctx);
	const output = renderBreakdown(model, effectiveWindow, actualTokens, parsed, convo, systemOnly);
	emit(ctx, output);
}

function runHeader(ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	const model = modelInfo(ctx);
	if (!model) {
		// Without a model, ctx.getSystemPrompt() may be empty too — nothing
		// useful to say. Skip silently (the footer already shows "no model").
		return;
	}
	const window = usage?.contextWindow ?? (ctx.model as { contextWindow?: number })?.contextWindow ?? 0;
	emit(ctx, renderHeader({ provider: model.provider, id: model.id }, window, usage?.tokens ?? null));
}

export default function contextUsageReportExtension(pi: ExtensionAPI): void {
	pi.registerFlag("context-report", {
		description: "Show a full context usage breakdown table at startup (default: one-line header only)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("context-report", {
		description: "Context usage: /context-report [breakdown|total|system] (default: breakdown)",
		handler: async (args, ctx) => {
			const sub = args.trim();
			switch (sub) {
				case "":
				case "breakdown":
					runBreakdown(ctx, false);
					return;
				case "total":
					runHeader(ctx);
					return;
				case "system":
					runBreakdown(ctx, true);
					return;
				default:
					ctx.ui.notify(
						`Unknown argument "${sub}". Usage: /context-report [breakdown|total|system]`,
						"warning",
					);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// TUI only for the auto-display (rpc/print have other startup paths).
		// ctx.mode is "tui" / "rpc" / "json" / "print". Skip non-tui to avoid
		// noisy startup banners in scripted runs.
		if (ctx.mode !== "tui") return;

		if (pi.getFlag("context-report") === true) {
			// Full breakdown at startup. The flag is also the load-proof
			// for verify.sh — proves the extension ran (its --context-report
			// flag only appears in `pi --help` if the extension loaded).
			runBreakdown(ctx, false);
		} else {
			runHeader(ctx);
		}
	});
}
