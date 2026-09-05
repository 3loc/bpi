/**
 * background-tasks extension for the pi coding agent.
 *
 * Runs commands as background tasks (currently: transient systemd
 * units under your user manager) and reports completion or timeout
 * back into the running pi session via pi.sendMessage, so an agent
 * turn ends promptly after launching a long job and a fresh turn
 * starts when the task finishes.
 *
 * Architecture (3 layers):
 *
 *   ┌──────────┐   Backend.launch()     ┌────────────┐
 *   │ LLM      │ ─────────────────────► │ backend    │
 *   │ tool     │ ◄───────────────────── │ (systemd / │
 *   │ call     │   {id, label, …}       │  inproc)   │
 *   └──────────┘                         └────────────┘
 *        │                                    │
 *        │  stored in session entry            │ owns the
 *        ▼                                     ▼ process
 *   ┌──────────┐    setInterval 2s    ┌────────────┐
 *   │ runtime  │ ──────────────────► │ watcher    │
 *   │ job map  │ ◄────────────────── │ + backend  │
 *   └──────────┘   status / wait     └────────────┘
 *        │             │
 *        │             │  completion / timeout
 *        ▼             ▼
 *   pi.sendMessage({ triggerTurn: true, deliverAs: fulfillment ? "steer" : "followUp" })
 *
 * Impossibility-scope: the watcher runs inside the pi process. When
 * pi exits the watcher dies; tasks continue under their backend but
 * completion notifications don't fire until the next session_start
 * reattaches. After reload the watcher restarts; jobs that finished
 * while pi was down are already terminal in their persisted entries
 * and are not re-fired. The backend owns the process; pi owns the
 * notification — those are different actors, deliberately.
 *
 * `--user` by default (your user systemd manager, not PID 1).
 * System mode (`--system`, runs as root under PID 1) is opt-in via
 * the tool's `system: true` parameter — requires polkit, runs as
 * root, wider blast radius. The skill explains why `--user` is the
 * safe default.
 *
 * Tools:
 *   background_run     launch a command as a background task
 *   background_status  non-blocking status snapshot for one or all jobs
 *   background_wait    block until a job reaches a target state (race-free)
 *   background_cancel  stop a running job
 *   background_journal read the captured output
 *
 * Command: /jobs      list active and recent jobs
 *           /jobs all   show every job in this session
 *           /jobs wait <id>  wait for a specific job
 *           /jobs cancel <id>  stop a specific job
 *
 * Flag: pi --background-tasks  → print the active job table at startup
 *                                (TUI only). Also serves as the load-
 *                                proof for pi --help / verify.sh.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Backend } from "./backend.ts";
import { SystemdBackend } from "./backends/systemd.ts";
import { isTerminal, type Job } from "./state.ts";
import { tick } from "./watcher.ts";
import { completionDeliveryMode } from "./notification.ts";
import {
	CancelParamsSchema,
	JournalParamsSchema,
	RunParamsSchema,
	StatusParamsSchema,
	WaitParamsSchema,
} from "./schemas.ts";
import {
	COMMAND_PREVIEW_CHARS,
	filterActive,
	formatJobTable,
	handleCancel,
	handleJournal,
	handleRun,
	handleStatus,
	humanDuration,
	handleWait,
	oneLine,
	trunc,
	type ToolContext,
} from "./tools.ts";

/* ------------------------------------------------------------------ *
 * Constants                                                           *
 * ------------------------------------------------------------------ */

const JOB_ENTRY_TYPE = "background-tasks-job";
const JOB_RESULT_CUSTOM_TYPE = "background-tasks-result";

const POLL_INTERVAL_MS = 2_000;
const RESULT_PREVIEW_CHARS = 200;
const DEFAULT_OUTPUT_DIR = ".cache/background-tasks";
const RECENT_JOB_WINDOW_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Extension entry                                                     *
 * ------------------------------------------------------------------ */

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	pi.registerFlag("background-tasks", {
		description: "Show the active background-tasks table at startup",
		type: "boolean",
		default: false,
	});

	const jobs = new Map<string, Job>();
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let sessionActive = false;
	let shuttingDown = false;
	let backend: Backend | undefined;

	/* ----- pi.exec adapter (injects HOME from process.env) ---------- */

	function piExecAdapter(cmd: string, args: string[], opts?: { timeout?: number }) {
		return pi.exec(cmd, args, opts);
	}

	/* ----- persistence ---------------------------------------------- */

	function persistJob(job: Job): void {
		pi.appendEntry<{ job: Job }>(JOB_ENTRY_TYPE, { job: { ...job } });
	}

	function loadJobsFromSession(ctx: ExtensionContext): void {
		jobs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== JOB_ENTRY_TYPE) continue;
			const data = entry.data as { job?: Partial<Job> } | undefined;
			if (!data?.job?.id) continue;
			// Defensive defaults for fields added after the entry was
			// persisted — old sessions lack `notify` and `nextStep`,
			// which the publish path now relies on.
			const job: Job = {
				notify: "fulfillment",
				...data.job,
			} as Job;
			jobs.set(job.id, job);
		}
	}

	/* ----- completion publisher ------------------------------------ */

	async function publishCompletion(job: Job): Promise<void> {
		if (!backend) return;
		// Preview the journal tail for the notification.
		let preview = "";
		try {
			const chunk = await backend.journal(job.id, { limit: 200, maxChars: RESULT_PREVIEW_CHARS }, job.scope);
			preview = chunk.lines.join("\n").slice(-RESULT_PREVIEW_CHARS);
		} catch {
			preview = "";
		}

		const status = job.state;
		const exitLine = `exit=${job.exitStatus ?? "unknown"}`;
		const resultLine = job.result ? ` result=${job.result}` : "";
		const timeMs = (job.finishedAt ?? Date.now()) - job.startedAt;
		const header = `[background-tasks] ${job.label} (${job.id}) — ${status} — ${exitLine}${resultLine} — ${humanDuration(timeMs)}`;
		// The notification lands on a later turn, where the original
		// background_run call may be far back in history — restate the
		// command so the verdict is self-contained.
		const commandLine = `\ncommand: ${trunc(oneLine(job.command), COMMAND_PREVIEW_CHARS)}`;
		const tailOutput = job.outputFile ? `\n\nFull output: ${job.outputFile}` : "";
		const tail = preview ? `\n\n--- last ${RESULT_PREVIEW_CHARS} chars of journal ---\n${preview}` : "";

		// Frame the notification based on the mode the caller asked for.
		// The mode is a single decision the model needs to make when the
		// notification arrives: is it expected to act on this (fulfillment),
		// or to decide whether to act (watcher)? pi core drops the
		// structured `details` payload on the way to the LLM, so the
		// framing has to ride on `content` itself.
		const framing = frameNotification(job);

		persistJob(job);
		pi.sendMessage(
			{
				customType: JOB_RESULT_CUSTOM_TYPE,
				content: `${framing}\n\n${header}${commandLine}${tailOutput}${tail}`,
				display: true,
				details: {
					id: job.id,
					label: job.label,
					command: job.command,
					state: job.state,
					exitStatus: job.exitStatus,
					result: job.result,
					durationMs: timeMs,
					startedAt: job.startedAt,
					finishedAt: job.finishedAt,
					notify: job.notify,
				},
			},
			{
				triggerTurn: true,
				deliverAs: completionDeliveryMode(job.notify),
			},
		);
	}

	function frameNotification(job: Job): string {
		if (job.notify === "watcher") {
			const step = job.nextStep?.trim()
				? `\nNext step specified at launch: ${job.nextStep}`
				: "\nNo next step was specified at launch — decide whether this is relevant to your current task, defer, or surface to the user.";
			return `<system-reminder type="background-watcher">A background job you launched asynchronously has finished. This is not necessarily relevant to your current task — evaluate the outcome and the user's intent before acting.${step}\n\nIf you decide the job's result is relevant, act on it. If not, briefly acknowledge and stop.</system-reminder>`;
		}
		return `<system-reminder type="background-fulfillment">A background job you launched to fulfill your current request has finished. You are expected to act on its result — read the journal (background_journal), then continue the task you were working on. Use background_status or background_journal for more detail.</system-reminder>`;
	}

	/* ----- watcher -------------------------------------------------- */

	function stopWatcher(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function startWatcher(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			void onTick();
		}, POLL_INTERVAL_MS);
		pollTimer.unref?.();
	}

	async function onTick(): Promise<void> {
		if (!sessionActive || shuttingDown || !backend) return;
		const outcome = await tick(jobs, backend, Date.now());
		for (const job of outcome.finished) {
			await publishCompletion(job);
		}
		// Persist starting→running promotions (the tick mutates the
		// map; we want the table to survive a session reload).
		for (const job of jobs.values()) {
			if (job.state === "running") persistJob(job);
		}
	}

	/* ----- tool context ------------------------------------------- */

	function toolContext(): ToolContext {
		return {
			cwd: process.cwd(),
			home: process.env.HOME ?? ".",
			capabilities: backend?.capabilities ?? { userScope: true, cancellable: true, persistentJournal: true },
		};
	}

	/* ----- tools --------------------------------------------------- */

	pi.registerTool({
		name: "background_run",
		label: "background run",
		description:
			"Launch a command as a background task and report completion or timeout back into the running pi session. The tool returns immediately with the job id; the watcher fires a `background-tasks-result` message on the next agent turn when the task reaches a terminal state. By default uses user scope (your user systemd manager); pass system=true only if you genuinely need root.",
		promptSnippet: "Launch a background command; completion / timeout is reported back into the session",
		promptGuidelines: [
			"Use background_run when the command will take more than a few seconds and the agent has other useful work to do.",
			"Prefer user scope (the default) — system scope needs polkit and runs as PID 1.",
			"Pass timeoutMs when the wall-clock cost matters; the watcher enforces it independently of any backend-side timer.",
		],
		parameters: RunParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const tc = { ...toolContext(), cwd: ctx.cwd };
			return handleRun(jobs, backend!, tc, params);
		},
	});

	pi.registerTool({
		name: "background_status",
		label: "background status",
		description:
			"Non-blocking status snapshot for a single job or the session's known jobs. For a single id, returns the parsed state / exit / result. With no id, returns a table of all jobs known to this session (active + recent terminal).",
		parameters: StatusParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return handleStatus(jobs, backend!, toolContext(), params);
		},
	});

	pi.registerTool({
		name: "background_wait",
		label: "background wait",
		description:
			"Block until a job reaches a target state (default `completed`). Implemented via the backend's blocking wait (a bounded poll of ground-truth status where the substrate has no native wait verb). Distinct from the watcher's completion notification — this blocks the calling turn; the watcher fires on a future turn.",
		parameters: WaitParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return handleWait(jobs, backend!, toolContext(), params);
		},
	});

	pi.registerTool({
		name: "background_cancel",
		label: "background cancel",
		description:
			"Stop a running job. Default uses the backend's stop primitive (SIGTERM → SIGKILL after TimeoutStopSec). Pass signal=SIGKILL for a hard kill. The watcher will subsequently fire a `cancelled` completion notification.",
		parameters: CancelParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return handleCancel(jobs, backend!, toolContext(), params);
		},
	});

	pi.registerTool({
		name: "background_journal",
		label: "background journal",
		description:
			"Read the captured output for a known job. The completion notification only echoes ~200 chars; use this tool to fetch more (bounded by `limit` / `maxChars`). Pair with `outputFile: true` on the original `background_run` when the log is too large for any reasonable journal window.",
		parameters: JournalParamsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return handleJournal(jobs, backend!, toolContext(), params);
		},
	});

	/* ----- command: /jobs ------------------------------------------- */

	const JOB_SUBCOMMANDS = ["list", "all", "wait", "cancel"];

	pi.registerCommand("jobs", {
		description: "Inspect background tasks: /jobs [list|wait <id>|cancel <id>]",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			const head = parts[0] ?? "";
			if (parts.length === 1) {
				const items = JOB_SUBCOMMANDS.filter((sub) => sub.startsWith(head)).map((sub) => ({ value: sub, label: sub }));
				return items.length > 0 ? items : null;
			}
			if ((head === "wait" || head === "cancel") && parts.length === 2) {
				const idPrefix = parts[1] ?? "";
				const items = [...jobs.keys()].filter((id) => id.startsWith(idPrefix)).map((id) => ({ value: `${head} ${id}`, label: id }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "list" || trimmed === "all") {
				const filter = trimmed === "all" ? "all" : "active";
				const text = await renderJobsTable(filter) ?? "No jobs registered in this session. Use background_run to launch one.";
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "info");
				return;
			}
			const parts = trimmed.split(/\s+/);
			const sub = parts[0];
			const id = parts[1];
			if (!id) {
				const text = `Usage: /jobs ${sub} <id>`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "warning");
				return;
			}
			const job = jobs.get(id);
			if (!job) {
				const text = `No job with id "${id}".`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "warning");
				return;
			}
			if (sub === "wait") {
				if (!backend) return;
				const result = await backend.wait(job.id, "completed", 30_000, job.scope);
				const text = result ? `${job.label} (${job.id}) reached terminal: ${job.state}` : `Wait timed out for ${job.id}.`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, result ? "info" : "warning");
				return;
			}
			if (sub === "cancel") {
				if (!backend) return;
				await backend.cancel(job.id, "SIGTERM", job.scope);
				job.state = "cancelled";
				job.finishedAt = Date.now();
				const text = `Cancelled ${job.label} (${job.id}).`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "info");
				return;
			}
			const text = `Unknown /jobs subcommand: "${sub}". Usage: /jobs [list|wait <id>|cancel <id>]`;
			if (ctx.mode === "print") console.log(text);
			else ctx.ui.notify(text, "warning");
		},
	});

	/* ----- /jobs table renderer ----------------------------------- */

	async function renderJobsTable(filter: "active" | "all"): Promise<string | undefined> {
		if (jobs.size === 0) return undefined;
		if (!backend) return undefined;
		// Refresh each non-terminal job against the live backend.
		for (const job of [...jobs.values()]) {
			if (isTerminal(job.state)) continue;
			const snap = await backend.status(job.id, job.scope).catch(() => undefined);
			if (!snap) continue;
			if (!isTerminal(snap.state)) {
				job.state = snap.state;
			} else {
				job.state = snap.state;
				job.exitStatus = snap.exitStatus;
				job.result = snap.result;
				job.finishedAt = Date.now();
			}
		}
		const visible = filter === "all" ? [...jobs.values()] : filterActive(jobs);
		if (visible.length === 0) return undefined;
		return formatJobTable(visible, jobs.size, "Run /jobs all to show them.");
	}

	/* ----- lifecycle hooks ---------------------------------------- */

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;
		shuttingDown = false;
		loadJobsFromSession(ctx);

		// Initialize the backend. Today this is always the systemd
		// backend; a future world where multiple backends coexist
		// would pick here based on availability.
		backend = new SystemdBackend(piExecAdapter, { cwd: ctx.cwd, home: process.env.HOME ?? "." });

		// Reconcile any in-flight jobs that finished while we weren't
		// watching. No notifications fired — the in-memory state just
		// catches up.
		await onTick();

		startWatcher();

		if (pi.getFlag("background-tasks") === true && ctx.mode === "tui") {
			const text = await renderJobsTable("active");
			if (text) ctx.ui.notify(text, "info");
			else ctx.ui.notify("background-tasks loaded (no active jobs).", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		sessionActive = false;
		stopWatcher();
	});
}

/* ------------------------------------------------------------------ *
 * (no extra helpers — formatJobTable / filterActive / pad / trunc     *
 *  all live in tools.ts so they cannot drift between call sites)     *
 * ------------------------------------------------------------------ */
