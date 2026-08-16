/**
 * Pure helpers for the plan-mode extension.
 *
 * Everything in here is side-effect free so the plan-parsing and
 * command-safety logic can be tested and audited independently of the
 * extension runtime.
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
 * match any blocked pattern. This is a guardrail, not a sandbox.
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

/** Collect `[DONE:n]` step numbers from assistant text. */
export function extractDoneSteps(text: string): number[] {
	const steps: number[] = [];
	for (const match of text.matchAll(/\[DONE:\s*(\d+)\s*\]/gi)) {
		const step = Number(match[1]);
		if (Number.isInteger(step) && step > 0 && !steps.includes(step)) {
			steps.push(step);
		}
	}
	return steps;
}

/** Mark items completed per [DONE:n] markers. Returns how many changed. */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	let changed = 0;
	for (const step of extractDoneSteps(text)) {
		const item = items.find((candidate) => candidate.step === step);
		if (item && !item.completed) {
			item.completed = true;
			changed++;
		}
	}
	return changed;
}

/** Render the plan as a markdown checklist file. */
export function renderPlanMarkdown(items: TodoItem[]): string {
	const completed = items.filter((item) => item.completed).length;
	const lines = [
		"# Plan",
		"",
		`_Generated by pi plan mode — ${new Date().toISOString().replace("T", " ").slice(0, 16)}_`,
		"",
	];
	for (const item of items) {
		lines.push(`- [${item.completed ? "x" : " "}] ${item.step}. ${item.text}`);
	}
	lines.push("", `_Summary: ${completed}/${items.length} steps complete._`, "");
	return lines.join("\n");
}
