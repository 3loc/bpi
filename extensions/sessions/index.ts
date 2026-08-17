/**
 * Sessions extension for the pi coding agent.
 *
 * Lists pi sessions with an activity status. pi persists every session as
 * JSONL under ~/.pi/agent/sessions/ but has no built-in way to *survey*
 * them — /resume only picks one. This extension answers "what sessions
 * exist, which are live, and what were they about?".
 *
 * Status classes (pi does not lock session files, so "active" is inferred
 * from recency — a session touched minutes ago is almost certainly open
 * in some pi pane/window):
 *
 *   ● current   this process's session
 *   ● active    modified < 10 min ago (likely open elsewhere)
 *   ◐ recent    modified < 24 h ago
 *   ○ inactive  older
 *
 * Commands:
 *   /sessions            list this project's sessions
 *   /sessions all        list sessions across all projects (adds project column)
 *   /sessions switch     interactive picker; switches to the chosen session
 *
 * Flag: pi --sessions  → show the most recent sessions once at startup
 * (TUI only). Also serves as the load-proof for pi --help / verify.sh.
 *
 * In print mode (pi -p "/sessions") the table is written to stdout so the
 * list is scriptable without an LLM call.
 */

import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Modified more recently than this ⇒ likely open in a live pi process. */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** Modified more recently than this ⇒ "recent". */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Rows shown by default (most interesting first). */
const MAX_ROWS = 20;
/** Preview length for the name/first-message column. */
const PREVIEW_LENGTH = 56;

type Status = "current" | "active" | "recent" | "inactive";

interface StatusStyle {
	priority: number;
	label: string;
}

const STATUS_STYLE: Record<Status, StatusStyle> = {
	current: { priority: 0, label: "● current " },
	active: { priority: 1, label: "● active  " },
	recent: { priority: 2, label: "◐ recent  " },
	inactive: { priority: 3, label: "○ inactive" },
};

function classifySession(
	path: string,
	id: string,
	currentFile: string | undefined,
	currentId: string | undefined,
	modified: Date,
): Status {
	if ((currentFile !== undefined && path === currentFile) || id === currentId) {
		return "current";
	}
	const age = Date.now() - modified.getTime();
	if (age < ACTIVE_WINDOW_MS) return "active";
	if (age < RECENT_WINDOW_MS) return "recent";
	return "inactive";
}

function formatAge(modified: Date): string {
	const ms = Date.now() - modified.getTime();
	if (ms < 60_000) return "now";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return modified.toISOString().slice(0, 10);
}

function formatPreview(name: string | undefined, firstMessage: string): string {
	const raw = (name?.trim() || firstMessage.trim() || "(empty)").replace(/\s+/g, " ");
	const text = raw.length > PREVIEW_LENGTH ? `${raw.slice(0, PREVIEW_LENGTH - 1)}…` : raw;
	return text;
}

function formatProject(cwd: string): string {
	// Session dirs encode the cwd (--home-jonbec-src-my-pi--); SessionInfo.cwd
	// carries the real path (empty for very old sessions).
	if (cwd) return cwd.replace(/^\/home\/[^/]+/, "~");
	return "(unknown)";
}

function renderTable(
	rows: Array<{
		status: Status;
		age: string;
		messageCount: number;
		preview: string;
		project?: string;
		forked: boolean;
	}>,
	hidden: number,
	withProject: boolean,
): string {
	const statusWidth = "● inactive".length;
	const lines = rows.map((row) => {
		const fork = row.forked ? "⑂ " : "  ";
		const status = row.status === "current" ? STATUS_STYLE.current.label : STATUS_STYLE[row.status].label;
		const base =
			`${status.padEnd(statusWidth + 1)}${row.age.padStart(4)}  ${String(row.messageCount).padStart(4)} msg  ${fork}${row.preview}`;
		return withProject ? `${base}  ${row.project}` : base;
	});
	if (hidden > 0) {
		lines.push(`… ${hidden} more hidden (older)`);
	}
	return lines.join("\n");
}

export default function sessionsExtension(pi: ExtensionAPI): void {
	pi.registerFlag("sessions", {
		description: "Show the most recent sessions at startup",
		type: "boolean",
		default: false,
	});

	async function collectSessions(cwd: string, all: boolean) {
		const infos = all ? await SessionManager.listAll() : await SessionManager.list(cwd);
		return infos;
	}

	async function listSessions(ctx: ExtensionContext, all: boolean): Promise<void> {
		const currentFile = ctx.sessionManager.getSessionFile();
		const currentId = ctx.sessionManager.getSessionId();
		const infos = await collectSessions(ctx.cwd, all);

		if (infos.length === 0) {
			const scope = all ? "any project" : "this project";
			const message = `No saved sessions for ${scope} yet.`;
			if (ctx.mode === "print") console.log(message);
			else ctx.ui.notify(message, "info");
			return;
		}

		const rows = infos
			.map((info) => {
				const status = classifySession(
					info.path,
					info.id,
					currentFile,
					currentId,
					info.modified,
				);
				return {
					info,
					status,
					priority: STATUS_STYLE[status].priority,
				};
			})
			.sort((a, b) => {
				if (a.priority !== b.priority) return a.priority - b.priority;
				return b.info.modified.getTime() - a.info.modified.getTime();
			});

		const visible = rows.slice(0, MAX_ROWS);
		const header =
			`Sessions ${all ? "(all projects)" : `(${formatProject(ctx.cwd)})`} — ` +
			`${infos.length} total, sorted by status then activity`;
		const table = renderTable(
			visible.map(({ info, status }) => ({
				status,
				age: formatAge(info.modified),
				messageCount: info.messageCount,
				preview: formatPreview(info.name, info.firstMessage),
				project: formatProject(info.cwd),
				forked: info.parentSessionPath !== undefined,
			})),
			rows.length - visible.length,
			all,
		);
		const legend = "status: ● current = this session · ● active = touched < 10 min · ◐ recent = < 24 h · ○ inactive = older · ⑂ = forked";

		const output = `${header}\n${table}\n${legend}`;
		if (ctx.mode === "print") {
			console.log(output);
		} else {
			ctx.ui.notify(output, "info");
		}
	}

	async function switchSession(ctx: ExtensionCommandContext): Promise<void> {
		const currentFile = ctx.sessionManager.getSessionFile();
		const currentId = ctx.sessionManager.getSessionId();
		const infos = await collectSessions(ctx.cwd, false);

		if (infos.length === 0) {
			ctx.ui.notify("No saved sessions for this project yet.", "info");
			return;
		}

		const sorted = [...infos].sort((a, b) => b.modified.getTime() - a.modified.getTime());
		const labels = sorted.map((info) => {
			const status = classifySession(info.path, info.id, currentFile, currentId, info.modified);
			const marker =
				status === "current" ? "[current] " : status === "active" ? "[active] " : "";
			return `${marker}${formatAge(info.modified)} · ${info.messageCount} msg · ${formatPreview(info.name, info.firstMessage)}`;
		});
		const choice = await ctx.ui.select("Switch to session:", labels);
		if (choice === undefined) return;
		const index = labels.indexOf(choice);
		if (index === -1) return;
		const target = sorted[index];
		if (target.path === currentFile) {
			ctx.ui.notify("Already on that session.", "info");
			return;
		}
		const result = await ctx.switchSession(target.path, {
			withSession: async (next) => {
				next.ui.notify(`Switched to ${formatPreview(target.name, target.firstMessage)}`, "info");
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("Session switch was cancelled.", "warning");
		}
	}

	const SUBCOMMANDS = ["all", "switch"];

	pi.registerCommand("sessions", {
		description: "List sessions: /sessions [all|switch]",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({
				value: sub,
				label: sub,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim()) {
				case "":
					await listSessions(ctx, false);
					break;
				case "all":
					await listSessions(ctx, true);
					break;
				case "switch":
					await switchSession(ctx);
					break;
				default:
					ctx.ui.notify(`Unknown argument "${args.trim()}". Usage: /sessions [all|switch]`, "warning");
			}
		},
	});

	// pi --sessions: one-shot glance at recent sessions when starting up.
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("sessions") !== true || ctx.mode !== "tui") return;
		try {
			await listSessions(ctx, false);
		} catch (error) {
			ctx.ui.notify(`Could not list sessions: ${String(error)}`, "warning");
		}
	});
}
