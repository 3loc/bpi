/**
 * Pure helpers for the workflow-mode extension.
 *
 * Everything in here is side-effect free so the parsing, directive-building,
 * and review-verdict logic can be tested and audited independently of the
 * extension runtime.
 *
 * Two parsing concerns:
 *   - Drafting: extract a numbered plan from the model's reply (the
 *     "Plan:" header format). The model is told this format once at
 *     drafting time; the manager parses it. This is acceptable because
 *     drafting is a one-shot prompt — there is no tight loop relying on
 *     the model emitting the format mid-work.
 *   - Review verdicts: parse the dedicated review turn's reply. The
 *     verdict turn uses an EXACTLY-ONE-LINE format prompt that models
 *     reliably follow (a marker inside a busy execution turn is what
 *     broke the old design; a marker inside a single-purpose turn is
 *     robust).
 */

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

/** Maximum steps accepted from a single plan. */
const MAX_STEPS = 50;
/** Maximum characters kept for a single step description. */
const MAX_STEP_LENGTH = 80;

// ============================================================================
// Bash guardrail for the drafting phase
// ----------------------------------------------------------------------------
// Same allowlist/denylist approach as before — guardrail, not a sandbox.
// ============================================================================

/**
 * Commands that mutate state. Matched anywhere in the command line so that
 * constructs like `cat foo | tee bar` or `true && rm -rf /` are rejected
 * even when the leading command looks harmless.
 */
const BLOCKED_PATTERNS: RegExp[] = [
	// Filesystem mutation
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/\bln\b/i,
	/\binstall\b/i,
	// Permissions
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bsetfacl\b/i,
	/\bchattr\b/i,
	// Redirection into files (covers `>`, `>>`, and `2>` forms)
	/(^|[^<])>(?!>)/,
	/>>/,
	// curl/wget writing to disk instead of stdout
	/\bcurl\b.*\s(-o|-O|--output)\b/,
	// Package managers (mutating subcommands; read-only queries are allowlisted below)
	/\bnpm\s+(install|uninstall|update|ci|link|publish|create|exec)\b/i,
	/\byarn\s+(add|remove|install|publish|create|exec)\b/i,
	/\bpnpm\s+(add|remove|install|publish|create|exec)\b/i,
	/\bbun\s+(add|remove|install|link|exec)\b/i,
	/\bpip3?\s+(install|uninstall)\b/i,
	/\bcargo\s+(install|add|remove|update)\b/i,
	/\bgo\s+(install|get|mod\s+(tidy|download|edit))\b/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
	/\bbrew\s+(install|uninstall|upgrade)\b/i,
	/\bgem\s+(install|uninstall)\b/i,
	/\bmake\b/i,
	// Git mutation
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|revert|stash|cherry-pick|tag|init|clone|checkout|switch|restore|clean|apply|am|bisect|worktree)\b/i,
	// Privilege escalation / process control
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bdoas\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bpoweroff\b/i,
	/\bsystemctl\s+(start|stop|restart|reload|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	// Interactive editors (hang the agent)
	/\b(vim?|nano|emacs|ed|code|subl)\b/i,
];

/**
 * Read-only commands, matched against the start of the command line.
 * A command is allowed only if it starts with one of these AND does not
 * match any blocked pattern.
 */
const ALLOWED_PREFIXES: RegExp[] = [
	// File inspection
	/^\s*(cat|head|tail|less|more|bat)\b/,
	// Search
	/^\s*(grep|egrep|fgrep|rg|ag)\b/,
	// Directory traversal
	/^\s*(find|fd|locate)\b/,
	/^\s*(ls|tree|pwd|stat|file|du|df)\b/,
	// Text processing that only reads stdin/files
	/^\s*(echo|printf|wc|sort|uniq|cut|paste|column|rev|nl|tr)\b/,
	/^\s*(diff|cmp|comm)\b/,
	/^\s*(sed\s+-n|awk)\b/,
	/^\s*jq\b/,
	// Lookup / environment info
	/^\s*(which|whereis|type|command\s+-v)\b/,
	/^\s*(env|printenv|uname|whoami|id|date|cal|uptime|hostname|arch)\b/,
	/^\s*(ps|top|htop|free|lsof)\b/,
	// Git read-only subcommands
	/^\s*git\s+(status|log|diff|show|branch|tag|remote|describe|rev-parse|blame|shortlog|reflog|grep|ls-.+|config\s+--get)\b/i,
	// Package manager read-only queries
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit|why)\b/i,
	/^\s*(yarn|pnpm)\s+(list|info|why|audit)\b/i,
	// Version queries
	/^\s*(node|python3?|ruby|perl|pip3?|cargo|go|java)\s+--version/i,
	// Network reads that print to stdout
	/^\s*curl\b/,
	/^\s*wget\s+-O\s*-\b/,
];

export function isReadOnlyCommand(command: string): boolean {
	const blocked = BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
	const allowed = ALLOWED_PREFIXES.some((pattern) => pattern.test(command));
	return allowed && !blocked;
}

// ============================================================================
// Step text cleanup + plan parsing (drafting phase)
// ============================================================================

/** Strip markdown emphasis and inline-code markers, collapse whitespace. */
export function cleanStepText(raw: string): string {
	let cleaned = raw
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > MAX_STEP_LENGTH) {
		cleaned = `${cleaned.slice(0, MAX_STEP_LENGTH - 1)}…`;
	}
	return cleaned;
}

function isPlausibleStep(cleaned: string): boolean {
	if (cleaned.length < 4) return false;
	// Skip lines that are clearly fragments (flags, paths, continuations)
	if (cleaned.startsWith("`") || cleaned.startsWith("/") || cleaned.startsWith("-")) return false;
	return true;
}

/**
 * Extract numbered plan steps from assistant text.
 * Uses the last "Plan:" header so refined plans supersede earlier drafts.
 */
export function extractPlanSteps(text: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerIndex = text.lastIndexOf("Plan:");
	if (headerIndex === -1) return items;

	const section = text.slice(headerIndex);
	const stepPattern = /^[ \t]*(\d+)[.)][ \t]+(.+)$/gm;
	for (const match of section.matchAll(stepPattern)) {
		if (items.length >= MAX_STEPS) break;
		const cleaned = cleanStepText(match[2]);
		if (isPlausibleStep(cleaned)) {
			items.push({ step: items.length + 1, text: cleaned, completed: false });
		}
	}
	return items;
}

// ============================================================================
// Step directive + review prompt (manager messages)
// ============================================================================

/**
 * Build the manager's step directive: a self-contained message that names
 * exactly one step to work on, what follows, and the contract (work on
 * this step only; the manager will run a quick review turn afterward).
 *
 * Returns null when every step is already complete.
 */
export function buildStepDirective(items: TodoItem[], options?: { note?: string }): string | null {
	const index = items.findIndex((item) => !item.completed);
	if (index === -1) return null;
	const current = items[index];
	const remaining = items.slice(index + 1).filter((item) => !item.completed);
	const total = items.length;
	const done = total - remaining.length - 1;
	const lines = [
		`[workflow-manager] step ${current.step} (${done}/${total} done)`,
		"",
		`NOW: ${current.step}. ${current.text}`,
	];
	if (remaining.length > 0) {
		lines.push("", "After this step:", ...remaining.map((item) => `${item.step}. ${item.text}`));
	}
	lines.push(
		"",
		`Work on step ${current.step} only. Do not start later steps.`,
		`The plan manager treats your settled run as the unit of completion — there is no marker to emit, the next turn is a brief review of what you just did.`,
	);
	if (options?.note) {
		lines.push("", `Note from the manager: ${options.note}`);
	}
	return lines.join("\n");
}

/**
 * Build the review prompt: a dedicated, single-purpose turn whose entire
 * purpose is to audit the previous execution turn. The verdict format is
 * strict (EXACTLY one line, one of three options) because this turn has
 * nothing else to do — models reliably follow strict single-line
 * instructions.
 */
export function buildReviewPrompt(items: TodoItem[], current: TodoItem): string {
	const completedList = items
		.filter((item) => item.completed)
		.map((item) => `${item.step}. ${item.text} ✓`);
	const remainingList = items
		.filter((item) => !item.completed && item.step !== current.step)
		.map((item) => `${item.step}. ${item.text}`);

	const lines = [
		`[workflow-review] auditing step ${current.step}`,
		"",
		`Step under review: ${current.step}. ${current.text}`,
	];
	if (completedList.length > 0) {
		lines.push("", "Already done:", ...completedList);
	}
	if (remainingList.length > 0) {
		lines.push("", "Still to do:", ...remainingList);
	}
	lines.push(
		"",
		"Inspect the previous turn — its tool calls, tool results, and the assistant's final reply. Decide whether step " +
			`${current.step} is verifiably complete.`,
		"",
		"Reply with EXACTLY ONE of these three lines, on its own line, with nothing else in the reply:",
		`[VERIFY:DONE]            — step ${current.step} is verifiably complete (artifacts exist, the claim is consistent)`,
		`[VERIFY:CONTINUE: <gap>] — significant work on step ${current.step} is missing; <gap> names the gap`,
		`[VERIFY:BLOCKED: <why>]  — step ${current.step} is wrong or impossible; <why> gives a one-line reason`,
	);
	return lines.join("\n");
}

// ============================================================================
// Review verdict parsing
// ============================================================================

export type ReviewVerdict =
	| { kind: "done" }
	| { kind: "continue"; gap: string }
	| { kind: "blocked"; reason: string }
	| { kind: "malformed"; raw: string };

const VERIFY_DONE = /\[VERIFY:DONE\]/gi;
const VERIFY_CONTINUE = /\[VERIFY:CONTINUE:\s*([^\]]*?)\s*\]/gi;
const VERIFY_BLOCKED = /\[VERIFY:BLOCKED:\s*([^\]]*?)\s*\]/gi;

/**
 * Parse the model reply from the review turn.
 *
 * Resolution rules:
 *   - Take the LAST occurrence of any verdict marker (later reasoning wins).
 *   - Multiple distinct verdicts: the last one wins (model is allowed to
 *     revise; this is the explicit choice).
 *   - If nothing matches, return kind="malformed" so the manager can decide
 *     how to handle it (default: treat as a CONTINUE with no gap).
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
	const candidates: Array<{ index: number; verdict: ReviewVerdict }> = [];

	for (const match of text.matchAll(VERIFY_DONE)) {
		candidates.push({ index: match.index ?? 0, verdict: { kind: "done" } });
	}
	for (const match of text.matchAll(VERIFY_CONTINUE)) {
		const gap = (match[1] ?? "").trim().slice(0, 200);
		candidates.push({ index: match.index ?? 0, verdict: { kind: "continue", gap } });
	}
	for (const match of text.matchAll(VERIFY_BLOCKED)) {
		const reason = (match[1] ?? "").trim().slice(0, 200);
		candidates.push({ index: match.index ?? 0, verdict: { kind: "blocked", reason } });
	}

	if (candidates.length === 0) {
		return { kind: "malformed", raw: text.slice(0, 200) };
	}

	// Last verdict in source order wins. If kinds tie on index, prefer
	// blocked > continue > done (a blocked judgement outranks a done one).
	candidates.sort((a, b) => {
		if (a.index !== b.index) return b.index - a.index;
		const rank = { done: 0, continue: 1, blocked: 2, malformed: -1 } as const;
		return rank[b.verdict.kind] - rank[a.verdict.kind];
	});
	return candidates[0].verdict;
}

// ============================================================================
// Plan file rendering (manager-owned artifact, default PLAN.md)
// ============================================================================

/** Render the workflow as a markdown checklist file. */
export function renderPlanMarkdown(items: TodoItem[], title = "# Workflow"): string {
	const completed = items.filter((item) => item.completed).length;
	const lines = [
		title,
		"",
		`_Generated by pi workflow mode — ${new Date().toISOString().replace("T", " ").slice(0, 16)}_`,
		"",
	];
	for (const item of items) {
		lines.push(`- [${item.completed ? "x" : " "}] ${item.step}. ${item.text}`);
	}
	lines.push("", `_Summary: ${completed}/${items.length} steps complete._`, "");
	return lines.join("\n");
}
