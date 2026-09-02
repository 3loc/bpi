/**
 * systemd-jobs extension for the pi coding agent.
 *
 * Runs commands as transient systemd units and reports completion or
 * timeout back into the running pi session via pi.sendMessage so an
 * agent turn ends promptly after launching a long job and a fresh
 * turn starts when systemd decides the job is done.
 *
 * Why this exists
 * ---------------
 * pi's bash tool blocks for the duration of a command. The escape
 * hatch for long-running work (tests, builds, downloads, syncs) is to
 * hand the lifecycle to systemd — already running as PID 1 — and let
 * it own the process. The matching `systemd-jobs` skill documents
 * the underlying mechanics; this extension wires the lifecycle into
 * the agent loop.
 *
 * Design
 * ------
 *
 *   ┌──────────┐   systemd-run --user    ┌────────────┐
 *   │ LLM      │ ─────────────────────► │ systemd    │
 *   │ tool     │ ◄───────────────────── │ (PID 1,    │
 *   │ call     │   {unit, label, …}      │  user mgr) │
 *   └──────────┘                         └────────────┘
 *        │                                    │
 *        │  stored in session entry            │ owns the
 *        ▼                                     ▼ process
 *   ┌──────────┐    setInterval 2s    ┌────────────┐
 *   │ runtime  │ ──────────────────► │ systemctl  │
 *   │ job map  │ ◄────────────────── │ --user     │
 *   └──────────┘   is-active /       └────────────┘
 *        │         ExecMainStatus
 *        │             │
 *        │             │  completion / timeout
 *        ▼             ▼
 *   pi.sendMessage({ triggerTurn: true, deliverAs: "followUp" })
 *        │
 *        ▼
 *   ┌──────────┐
 *   │ next     │  LLM sees the completion notification,
 *   │ agent    │  reads ExecMainStatus, decides what to do
 *   │ turn     │
 *   └──────────┘
 *
 * Impossibility-scope (the watcher's reach is bounded)
 * ----------------------------------------------------
 * The watcher runs inside the pi process. When pi exits the watcher
 * dies; jobs continue under systemd but completion notifications
 * don't fire until the next session_start reattaches. After reload
 * the watcher restarts; jobs that finished while pi was down are
 * already terminal in their persisted entries and are not re-fired.
 * systemd owns the process; pi owns the notification — those are
 * different actors, deliberately.
 *
 * `--user` by default (the user's systemd manager, not PID 1).
 * System mode (`--system`, runs as root under PID 1) is opt-in via
 * the tool's `system: true` parameter — it requires polkit, runs
 * as root, and the failure modes are wider. The skill explains why
 * `--user` is the safe default.
 *
 * Tools
 * -----
 *   systemd_run     launch a command as a transient user unit
 *   systemd_status  non-blocking status snapshot for one or all jobs
 *   systemd_wait    block until a job reaches a terminal state (uses
 *                   systemctl --user wait under the hood — race-free)
 *   systemd_cancel  stop a running job
 *
 * Commands
 * --------
 *   /jobs           list active and recent jobs with status + runtime
 *   /jobs wait <u>  wait for a specific job (delegates to systemd_wait)
 *   /jobs cancel <u> stop a specific job
 *
 * Flag: pi --systemd-jobs       → print the active job table at startup
 *                                 (TUI only). Also serves as the load-
 *                                 proof for pi --help / verify.sh.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/* ------------------------------------------------------------------ *
 * Constants                                                           *
 * ------------------------------------------------------------------ */

/** Custom types for entries + custom messages. Kept short to limit the
 *  per-message token footprint. */
const JOB_ENTRY_TYPE = "systemd-jobs-job";
const JOB_RESULT_CUSTOM_TYPE = "systemd-jobs-result";

/** Wall-clock interval between status polls. 2 s balances latency
 *  against the cost of running `systemctl --user show` per active job. */
const POLL_INTERVAL_MS = 2_000;

/** Soft cap on how much stdout/stderr from the journal we echo into
 *  the completion notification. systemd's journal itself is the
 *  long-term log; the notification is just a digest. Kept small so
 *  noisy jobs don't bloat the LLM context — callers needing more use
 *  systemd_journal to pull a specific window from the journal. */
const RESULT_PREVIEW_CHARS = 200;

/** Default output file when the caller doesn't override `outputFile`.
 *  Standardized so /jobs can find it. */
const DEFAULT_OUTPUT_DIR = ".cache/pi-systemd-jobs";

/** Window after a terminal-state job is still considered "recent" in
 *  the default listing. Long enough to cover natural glances at the
 *  table; short enough that a long session doesn't grow it unboundedly. */
const RECENT_JOB_WINDOW_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Job state                                                           *
 * ------------------------------------------------------------------ */

type JobState = "starting" | "running" | "completed" | "failed" | "timeout" | "cancelled";

interface Job {
	unit: string;
	label: string;
	command: string;
	workingDirectory?: string;
	system: boolean;
	startedAt: number;
	/** Wall-clock deadline in ms; undefined = no timeout. */
	timeoutMs?: number;
	/** Path to the output file when `outputFile: true` was used. */
	outputFile?: string;
	state: JobState;
	/** Filled in once the unit reaches a terminal state. */
	exitStatus?: number;
	result?: string;
	finishedAt?: number;
}

interface PersistedJobEntry {
	job: Job;
}

/* ------------------------------------------------------------------ *
 * Status parsing                                                      *
 * ------------------------------------------------------------------ */

interface StatusSnapshot {
	state: "starting" | "running" | "completed" | "failed" | "timeout";
	exitStatus?: number;
	result?: string;
}

/** Parse `systemctl --user show` output into a status snapshot. */
function parseShowOutput(stdout: string): StatusSnapshot {
	const get = (key: string): string | undefined => {
		const re = new RegExp(`^${key}=(.*)$`, "m");
		const m = stdout.match(re);
		return m?.[1];
	};

	const activeState = get("ActiveState") ?? "";
	const execMainStatus = get("ExecMainStatus");
	const result = get("Result") ?? "";
	const activeEnterTimestamp = get("ActiveEnterTimestampMonotonic");

	// `ActiveState` is the public state machine. "active" is the steady
	// state; "activating"/"reloading" are transitions. "inactive" +
	// "failed" are the two terminal cases.
	if (activeState === "active" || activeState === "activating" || activeState === "reloading") {
		// Not finished. Distinguish "hasn't started yet" from "running"
		// by checking whether ActiveEnterTimestampMonotonic is non-zero.
		return {
			state: activeEnterTimestamp && activeEnterTimestamp !== "0" ? "running" : "starting",
		};
	}

	// Terminal state. Map Result= to our state enum.
	let state: StatusSnapshot["state"] = "completed";
	if (result === "timeout") state = "timeout";
	else if (
		result === "exit-code" ||
		result === "signal" ||
		result === "resources" ||
		result === "core-dump" ||
		result === "watchdog"
	) {
		state = "failed";
	} else if (activeState === "failed") {
		// No Result= but ActiveState=failed — older systemd, treat as failed.
		state = "failed";
	}

	const exit = execMainStatus && execMainStatus !== "" ? Number(execMainStatus) : undefined;

	return { state, exitStatus: exit, result };
}

/* ------------------------------------------------------------------ *
 * Tool parameter schemas                                              *
 * ------------------------------------------------------------------ */

const SystemdRunParams = Type.Object({
	command: Type.String({ description: "Shell command to run as the transient unit's ExecStart (joined by bash -c)" }),
	label: Type.Optional(
		Type.String({ description: "Human-readable label shown in /jobs and the completion notification. Defaults to the first argv of `command`." }),
	),
	workingDirectory: Type.Optional(
		Type.String({ description: "WorkingDirectory= for the unit. Defaults to ctx.cwd. Different from the agent's bash cwd." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Wall-clock timeout in ms. The extension's poller emits a `timeout` notification at this deadline in addition to systemd's RuntimeMaxSec=." }),
	),
	outputFile: Type.Optional(
		Type.Union([
			Type.Boolean({ description: "true = capture stdout+stderr to ~/.cache/pi-systemd-jobs/<label>.log" }),
			Type.String({ description: "absolute or %h-prefixed path for StandardOutput=file:…" }),
		]),
	),
	system: Type.Optional(
		Type.Boolean({ description: "Use --system instead of --user (runs as PID 1, needs polkit, wider blast radius). Defaults to false." }),
	),
	unit: Type.Optional(
		Type.String({ description: "Optional explicit unit name. If absent, an auto-generated run-*.service name is used. The function is auto-generated; the extension resolves it from systemctl show after launch." }),
	),
});

const SystemdStatusParams = Type.Object({
	unit: Type.Optional(
		Type.String({ description: "Unit name to inspect. If omitted, lists jobs known to this session (default: active + recently completed; pass `filter: \"all\"` to see every persisted job)." }),
	),
	filter: Type.Optional(
		Type.String({ description: "Job filter for the no-unit listing: 'active' (default; starting + running + jobs that finished within the last 5 minutes) or 'all' (every persisted job in this session — can be a long table)." }),
	),
});

const SystemdWaitParams = Type.Object({
	unit: Type.String({ description: "Unit name to wait for" }),
	state: Type.Optional(
		Type.String({ description: "Target state to wait for. Defaults to 'inactive'. 'failed' waits for failed-state." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Override the session-scoped wait timeout (default 24 h). The tool returns a structured error on timeout; the underlying systemd timeout remains in effect." }),
	),
});

const SystemdCancelParams = Type.Object({
	unit: Type.String({ description: "Unit name to cancel" }),
	signal: Type.Optional(
		Type.String({ description: "Signal to send (default SIGTERM via `systemctl stop`; pass 'SIGKILL' for `systemctl kill`)." }),
	),
});

const SystemdJournalParams = Type.Object({
	unit: Type.String({ description: "Unit name to read journal entries for. Must be a unit known to this session (i.e. previously launched by systemd_run)." }),
	limit: Type.Optional(
		Type.Number({ description: "Max number of journal lines to return (default 200, max 5000). The journal may have more; narrow with `since`/`until`." }),
	),
	since: Type.Optional(
		Type.String({ description: "Lower time bound, systemd time span (e.g. '1h ago', '2026-09-02 12:00:00'). Optional." }),
	),
	until: Type.Optional(
		Type.String({ description: "Upper time bound in the same format. Optional." }),
	),
	maxChars: Type.Optional(
		Type.Number({ description: "Hard cap on returned characters (default 8000, max 50000). The tool errors rather than silently truncating with a `…` to keep callers from trusting a partial log." }),
	),
});

/* ------------------------------------------------------------------ *
 * Extension entry                                                     *
 * ------------------------------------------------------------------ */

export default function systemdJobsExtension(pi: ExtensionAPI): void {
	pi.registerFlag("systemd-jobs", {
		description: "Show the active systemd-jobs table at startup",
		type: "boolean",
		default: false,
	});

	// Runtime job registry, mirrored from session entries.
	const jobs = new Map<string, Job>();
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let sessionActive = false;
	/** Set by session_shutdown; checked by in-flight ticks too (a tick
	 *  that's already running when shutdown fires won't be cancelled by
	 *  clearInterval, but it must still skip the sendMessage at the end). */
	let shuttingDown = false;

	/* ----- persistence ---------------------------------------------- */

	function persistJob(job: Job): void {
		pi.appendEntry<PersistedJobEntry>(JOB_ENTRY_TYPE, {
			job: {
				unit: job.unit,
				label: job.label,
				command: job.command,
				workingDirectory: job.workingDirectory,
				system: job.system,
				startedAt: job.startedAt,
				timeoutMs: job.timeoutMs,
				outputFile: job.outputFile,
				state: job.state,
				exitStatus: job.exitStatus,
				result: job.result,
				finishedAt: job.finishedAt,
			},
		});
	}

	function loadJobsFromSession(ctx: ExtensionContext): void {
		jobs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== JOB_ENTRY_TYPE) continue;
			const data = entry.data as PersistedJobEntry | undefined;
			if (!data?.job?.unit) continue;
			// `data.job` already matches the in-memory `Job` shape; clone so
			// later mutations don't bleed back into the entry.
			jobs.set(data.job.unit, { ...data.job });
		}
	}

	/* ----- command execution helpers --------------------------------- */

	function systemctlArgs(system: boolean, ...args: string[]): string[] {
		return system ? ["--system", ...args] : ["--user", ...args];
	}

	async function systemctlShow(unit: string, system: boolean): Promise<StatusSnapshot | undefined> {
		const result = await pi.exec(
			"systemctl",
			systemctlArgs(system, "show", unit, "--property=ActiveState,SubState,ExecMainStatus,Result,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic"),
			{ timeout: 5_000 },
		);
		if (result.code !== 0) return undefined;
		return parseShowOutput(result.stdout);
	}

	async function journalPreview(unit: string, system: boolean): Promise<string> {
		const result = await pi.exec(
			"journalctl",
			systemctlArgs(system, "-u", unit, "-n", "200", "--no-pager", "-o", "cat"),
			{ timeout: 5_000 },
		);
		if (result.code !== 0) return "";
		return result.stdout.slice(-RESULT_PREVIEW_CHARS);
	}

	/* ----- lifecycle: watcher ----------------------------------------- */

	function stopWatcher(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function startWatcher(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			void tick();
		}, POLL_INTERVAL_MS);
		// Don't keep the event loop alive just for the poller — pi may
		// be shutting down, and we want the process to exit cleanly.
		pollTimer.unref?.();
	}

	/** Drive the watcher: transition starting→running, detect terminal
	 *  states, fire notifications, enforce timeouts. */
	async function tick(): Promise<void> {
		if (!sessionActive || shuttingDown) return;
		const now = Date.now();

		// Iterate over a snapshot — finishJob() mutates the map.
		for (const job of [...jobs.values()]) {
			if (shuttingDown) return;
			if (job.state !== "starting" && job.state !== "running") continue;

			// Timeout is enforced by the watcher, not just by systemd.
			// This makes the timeout fire even when RuntimeMaxSec is unset
			// (the default), so callers can rely on the notification.
			if (job.timeoutMs !== undefined && now - job.startedAt >= job.timeoutMs && job.state !== "timeout") {
				job.state = "timeout";
				job.finishedAt = now;
				// Best-effort stop; do not block the tick on it.
				void pi.exec("systemctl", systemctlArgs(job.system, "stop", job.unit), { timeout: 5_000 });
				finishJob(job);
				continue;
			}

			const snap = await systemctlShow(job.unit, job.system);
			if (!snap) continue; // transient — try again next tick

			if (snap.state === "starting" || snap.state === "running") {
				// Promote from "starting" to "running" once systemd sees it
				// in active state — visible in /jobs as a confidence signal.
				if (job.state === "starting" && snap.state === "running") {
					job.state = "running";
					persistJob(job);
				}
				continue;
			}

			// Terminal state reached.
			job.state = snap.state;
			job.exitStatus = snap.exitStatus;
			job.result = snap.result;
			job.finishedAt = now;
			finishJob(job);
		}
	}

	/** Common terminal path: persist, notify, append entry. */
	async function finishJob(job: Job): Promise<void> {
		persistJob(job);

		const preview = await journalPreview(job.unit, job.system);

		// Build a compact, deterministic completion message. The shape
		// is fixed so downstream skills (or future tools) can parse it.
		const status = formatJobStatus(job);
		const exitLine = job.exitStatus !== undefined ? `exit=${job.exitStatus}` : "exit=unknown";
		const resultLine = job.result ? `result=${job.result}` : "";
		const timeMs = (job.finishedAt ?? Date.now()) - job.startedAt;
		const header = `[systemd-jobs] ${job.label} (${job.unit}) — ${status} — ${exitLine}${resultLine ? ` ${resultLine}` : ""} — ${humanDuration(timeMs)}`;

		const tail = preview ? `\n\n--- last ${RESULT_PREVIEW_CHARS} chars of journal ---\n${preview}` : "";
		const tailOutput = job.outputFile ? `\n\nFull output: ${job.outputFile}` : "";

		persistJob(job);
		pi.sendMessage(
			{
				customType: JOB_RESULT_CUSTOM_TYPE,
				content: `${header}${tailOutput}${tail}`,
				display: true,
				details: {
					unit: job.unit,
					label: job.label,
					state: job.state,
					exitStatus: job.exitStatus,
					result: job.result,
					durationMs: timeMs,
					startedAt: job.startedAt,
					finishedAt: job.finishedAt,
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/* ----- tool: systemd_run ----------------------------------------- */

	pi.registerTool({
		name: "systemd_run",
		label: "systemd run",
		description:
			"Launch a command as a transient systemd unit and report completion or timeout back into the running pi session. The tool returns immediately with the unit name; the watcher fires a `systemd-jobs-result` message on the next agent turn when the unit reaches a terminal state. By default uses --user (your user systemd manager).",
		promptSnippet: "Launch a background command as a transient systemd unit; completion / timeout is reported back into the session",
		promptGuidelines: [
			"Use systemd_run when the command will take more than a few seconds and the agent has other useful work to do.",
			"Prefer --user (the default) — system mode needs polkit and runs as PID 1.",
			"Pass timeoutMs when the wall-clock cost matters; the watcher enforces it independently of systemd's RuntimeMaxSec=.",
		],
		parameters: SystemdRunParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const system = params.system === true;
			const label = (params.label ?? params.command.split(/\s+/)[0] ?? "job").slice(0, 80);

			// Resolve working directory before the unit starts.
			let workingDirectory = params.workingDirectory;
			if (!workingDirectory) workingDirectory = ctx.cwd;
			else if (!workingDirectory.startsWith("/") && !workingDirectory.startsWith("%")) {
				workingDirectory = `${ctx.cwd}/${workingDirectory}`;
			}

			// Output file path resolution.
			let outputFile: string | undefined;
			const outputArg = params.outputFile;
			if (outputArg === true) {
				outputFile = `${process.env.HOME ?? "."}/${DEFAULT_OUTPUT_DIR}/${slugify(label)}.log`;
			} else if (typeof outputArg === "string") {
				outputFile = outputArg;
			}

			// Build the systemd-run command. --no-block makes systemd-run
			// return after queueing the unit, not after it starts. We do
			// NOT pass --quiet: systemd-run's "Running as unit: X" line
			// is the only reliable way to recover the unit name in one
			// round trip (with --quiet the unit must be resolved by
			// querying systemd afterwards, which races).
			const args: string[] = ["--no-block"];
			if (system) args.push("--system");
			else args.push("--user");
			if (params.unit) args.push("-u", params.unit);
			args.push("--working-directory=" + workingDirectory);
			if (outputFile) {
				args.push("-p", `StandardOutput=file:${outputFile}`);
				args.push("-p", `StandardError=inherit`);
			}
			if (params.timeoutMs !== undefined) {
				// Add a small grace period (5 s) over the watcher deadline so
				// systemd doesn't race the watcher; the watcher wins by 5 s.
				const graceMs = params.timeoutMs + 5_000;
				args.push("-p", `RuntimeMaxSec=${Math.ceil(graceMs / 1000)}s`);
			}
			args.push("--", "bash", "-c", params.command);

			const result = await pi.exec("systemd-run", args, { timeout: 10_000 });
			if (result.code !== 0) {
				throw new Error(`systemd-run failed (exit=${result.code}):\n${result.stderr || "(no stderr)"}`);
			}

			// systemd-run prints "Running as unit: <unit>" — but the stream
			// depends on flags: with --no-block it's stderr, without it's
			// stdout (alongside the job-progress banner). Scan both.
			const combined = `${result.stdout}\n${result.stderr}`;
			const match = combined.match(/Running as unit:\s*([^\s;]+)/);
			const unit = match?.[1] ?? "";
			if (!unit.endsWith(".service") && !unit.endsWith(".scope")) {
				throw new Error(`systemd-run produced an unparseable unit name (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`);
			}

			const job: Job = {
				unit,
				label,
				command: params.command,
				workingDirectory,
				system,
				startedAt: Date.now(),
				timeoutMs: params.timeoutMs,
				outputFile,
				state: "starting",
			};
			jobs.set(unit, job);
			persistJob(job);

			return {
				content: [
					{
						type: "text",
						text:
							`Launched ${label} as ${unit} (${system ? "system" : "user"})\n` +
							`  workingDirectory: ${workingDirectory}\n` +
							(params.timeoutMs !== undefined
								? `  timeout: ${humanDuration(params.timeoutMs)}\n`
								: "") +
							(outputFile ? `  outputFile: ${outputFile}\n` : "") +
							`\nA completion notification will arrive via the next turn when the unit reaches a terminal state. Use systemd_status to inspect, systemd_wait to block.`,
					},
				],
				details: { unit, label, system, timeoutMs: params.timeoutMs, outputFile },
			};
		},
	});

	/* ----- tool: systemd_status -------------------------------------- */

	pi.registerTool({
		name: "systemd_status",
		label: "systemd status",
		description:
			"Non-blocking status snapshot for a single unit or the session's known jobs. For a single unit, returns a parsed ActiveState / ExecMainStatus / Result. With no unit, returns a table of all jobs known to this session (active + recent terminal).",
		parameters: SystemdStatusParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (params.unit) {
				const job = jobs.get(params.unit);
				if (!job) {
					return {
						content: [{ type: "text", text: `No job with unit "${params.unit}" in this session.` }],
						details: {},
					};
				}
				const snap = await systemctlShow(job.unit, job.system);
				if (!snap) {
					return {
						content: [
							{
								type: "text",
								text: `Unit ${job.unit} status unavailable (systemctl show failed). It may have been garbage-collected; transient units are removed on next systemd refresh after they reach inactive.`,
							},
						],
						details: {},
					};
				}
				// Reconcile in-memory state with what systemd reports.
				if (snap.state === "starting" || snap.state === "running") {
					job.state = snap.state;
				} else {
					job.state = snap.state;
					job.exitStatus = snap.exitStatus;
					job.result = snap.result;
				}
				persistJob(job);
				const status = formatJobStatus(job);
				const exitLine = job.exitStatus !== undefined ? `exit=${job.exitStatus}` : "";
				const resultLine = job.result ? `result=${job.result}` : "";
				return {
					content: [
						{
							type: "text",
							text: `${job.label} (${job.unit}): ${status} ${exitLine} ${resultLine}`.trim(),
						},
					],
					details: { job: { ...job } },
				};
			}

			// List jobs, filtered.
			if (jobs.size === 0) {
				return {
					content: [{ type: "text", text: "No jobs registered in this session. Use systemd_run to launch one." }],
					details: {},
				};
			}
			const filter = params.filter === "all" ? "all" : "active";
			const list = filter === "active" ? filterActiveJobs(jobs) : [...jobs.values()];
			if (list.length === 0) {
				const hidden = jobs.size;
				return {
					content: [{
						type: "text",
						text:
							`No active or recent jobs (${hidden} older terminal job${hidden === 1 ? "" : "s"} hidden — pass filter="all" to see them).`,
					}],
					details: { count: 0, hidden },
				};
			}
			const lines = ["unit                              state      exit  result        label           runtime"];
			const now = Date.now();
			const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
			for (const job of sorted) {
				const runtime = job.finishedAt ? job.finishedAt - job.startedAt : now - job.startedAt;
				lines.push(
					`${pad(job.unit, 34)} ${pad(formatJobStatus(job), 10)} ${pad(job.exitStatus?.toString() ?? "-", 5)} ${pad(job.result ?? "-", 13)} ${pad(job.label, 15)} ${humanDuration(runtime)}`,
				);
			}
			const hidden = jobs.size - list.length;
			if (hidden > 0) {
				lines.push(`\u2026 ${hidden} older terminal job${hidden === 1 ? "" : "s"} hidden. Pass filter="all" to show them.`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: list.length, hidden, filter },
			};
		},
	});

	/* ----- tool: systemd_wait ---------------------------------------- */

	pi.registerTool({
		name: "systemd_wait",
		label: "systemd wait",
		description:
			"Block until a job's unit reaches a target state (default `inactive`). Implemented via `systemctl --user wait` so it is race-free and signal-safe. Distinct from the watcher's completion notification — this blocks the calling turn; the watcher fires on a future turn.",
		parameters: SystemdWaitParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = jobs.get(params.unit);
			if (!job) {
				throw new Error(`No job with unit "${params.unit}" in this session.`);
			}
			const targetState = params.state ?? "inactive";
			const timeoutMs = params.timeoutMs ?? 24 * 60 * 60 * 1000;

			const result = await pi.exec(
				"systemctl",
				systemctlArgs(job.system, "wait", job.unit, `--state=${targetState}`, `--timeout=${Math.ceil(timeoutMs / 1000)}s`),
				{ timeout: timeoutMs + 5_000 },
			);

			if (result.code === 0) {
				// Re-fetch to capture exit / result.
				const snap = await systemctlShow(job.unit, job.system);
				if (snap && snap.state !== "starting" && snap.state !== "running") {
					job.state = snap.state;
					job.exitStatus = snap.exitStatus;
					job.result = snap.result;
					job.finishedAt = job.finishedAt ?? Date.now();
					persistJob(job);
				}
				return {
					content: [
						{
							type: "text",
							text: `${job.label} (${job.unit}) reached ${targetState}. ${formatJobStatus(job)} exit=${job.exitStatus ?? "?"} result=${job.result ?? "?"}`,
						},
					],
					details: { job: { ...job } },
				};
			}
			throw new Error(
				`systemctl wait failed for ${job.unit} (exit=${result.code}). Likely a timeout — the unit did not reach state=${targetState} within ${humanDuration(timeoutMs)}.`,
			);
		},
	});

	/* ----- tool: systemd_cancel -------------------------------------- */

	pi.registerTool({
		name: "systemd_cancel",
		label: "systemd cancel",
		description:
			"Stop a running job. Default uses systemctl stop (SIGTERM then SIGKILL after TimeoutStopSec). Pass signal=SIGKILL for a hard kill. The watcher will subsequently fire a `cancelled` completion notification.",
		parameters: SystemdCancelParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = jobs.get(params.unit);
			if (!job) {
				throw new Error(`No job with unit "${params.unit}" in this session.`);
			}
			const args =
				params.signal === "SIGKILL"
					? systemctlArgs(job.system, "kill", "-s", "SIGKILL", job.unit)
					: systemctlArgs(job.system, "stop", job.unit);
			const result = await pi.exec("systemctl", args, { timeout: 30_000 });
			if (result.code !== 0) {
				throw new Error(`Cancel failed for ${job.unit} (exit=${result.code}): ${result.stderr}`);
			}
			// Mark as cancelled so the watcher's completion event reports
			// the right reason rather than treating the stop as a normal exit.
			job.state = "cancelled";
			job.finishedAt = Date.now();
			persistJob(job);
			return {
				content: [{ type: "text", text: `Cancelled ${job.label} (${job.unit}).` }],
				details: { job: { ...job } },
			};
		},
	});

	/* ----- tool: systemd_journal ------------------------------------ */

	pi.registerTool({
		name: "systemd_journal",
		label: "systemd journal",
		description:
			"Read the systemd journal for a known unit (one previously launched by systemd_run). The completion notification only echoes ~200 chars of the journal tail; use this tool to fetch more (bounded by `limit` / `maxChars`). Pair with `outputFile: true` on the original systemd_run when the log is too large for the journal window you need.",
		parameters: SystemdJournalParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = jobs.get(params.unit);
			if (!job) {
				throw new Error(`No job with unit "${params.unit}" in this session.`);
			}
			const limit = Math.min(Math.max(params.limit ?? 200, 1), 5_000);
			const maxChars = Math.min(Math.max(params.maxChars ?? 8_000, 256), 50_000);

			const args = systemctlArgs(job.system, "-u", job.unit, "-n", String(limit), "--no-pager", "-o", "cat");
			if (params.since) args.push("--since", params.since);
			if (params.until) args.push("--until", params.until);

			const result = await pi.exec("journalctl", args, { timeout: 15_000 });
			if (result.code !== 0) {
				throw new Error(`journalctl failed (exit=${result.code}): ${result.stderr}`);
			}
			if (result.stdout.length > maxChars) {
				throw new Error(
					`Journal for ${params.unit} is ${result.stdout.length} chars, exceeds maxChars=${maxChars}. Narrow with limit/since/until, or rerun systemd_run with outputFile: true to capture stdout to disk instead.`,
				);
			}
			return {
				content: [{ type: "text", text: result.stdout || "(journal empty)" }],
				details: { unit: params.unit, lines: result.stdout.split("\n").length, chars: result.stdout.length },
			};
		},
	});

	/* ----- command: /jobs ------------------------------------------- */

	const JOB_SUBCOMMANDS = ["list", "all", "wait", "cancel"];

	pi.registerCommand("jobs", {
		description: "Inspect systemd-jobs: /jobs [list|wait <unit>|cancel <unit>]",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			const head = parts[0] ?? "";
			if (parts.length === 1) {
				const items = JOB_SUBCOMMANDS.filter((sub) => sub.startsWith(head)).map((sub) => ({
					value: sub,
					label: sub,
				}));
				return items.length > 0 ? items : null;
			}
			if ((head === "wait" || head === "cancel") && parts.length === 2) {
				const unitPrefix = parts[1] ?? "";
				const items = [...jobs.keys()]
					.filter((unit) => unit.startsWith(unitPrefix))
					.map((unit) => ({ value: `${head} ${unit}`, label: unit }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "list" || trimmed === "all") {
				const filter = trimmed === "all" ? "all" : "active";
				const snap = await systemctlStatusSnapshot(ctx, filter);
				const text = snap || "No jobs registered in this session. Use systemd_run to launch one.";
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "info");
				return;
			}
			const parts = trimmed.split(/\s+/);
			const sub = parts[0];
			const unit = parts[1];
			if (!unit) {
				const text = `Usage: /jobs ${sub} <unit>`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, "warning");
				return;
			}
			if (sub === "wait") {
				const result = await pi.exec("systemctl", systemctlArgs(false, "wait", unit, "--state=inactive"), { timeout: 30_000 });
				const text = result.code === 0 ? `${unit} is now inactive.` : `Wait failed for ${unit} (exit=${result.code}).`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, result.code === 0 ? "info" : "warning");
				return;
			}
			if (sub === "cancel") {
				const result = await pi.exec("systemctl", systemctlArgs(false, "stop", unit), { timeout: 30_000 });
				const text = result.code === 0 ? `Cancelled ${unit}.` : `Cancel failed for ${unit} (exit=${result.code}).`;
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, result.code === 0 ? "info" : "warning");
				return;
			}
			const text = `Unknown /jobs subcommand: "${sub}". Usage: /jobs [list|wait <unit>|cancel <unit>]`;
			if (ctx.mode === "print") console.log(text);
			else ctx.ui.notify(text, "warning");
		},
	});

	/* ----- helpers used by /jobs and the startup flag ---------------- */

	async function systemctlStatusSnapshot(_ctx: ExtensionContext, filter: "active" | "all" = "active"): Promise<string | undefined> {
		if (jobs.size === 0) return undefined;
		// Refresh each running job; terminal jobs already have their state.
		for (const job of [...jobs.values()]) {
			if (job.state !== "starting" && job.state !== "running") continue;
			const snap = await systemctlShow(job.unit, job.system);
			if (!snap) continue;
			if (snap.state === "starting" || snap.state === "running") {
				job.state = snap.state;
			} else {
				job.state = snap.state;
				job.exitStatus = snap.exitStatus;
				job.result = snap.result;
				job.finishedAt = Date.now();
			}
		}
		const visible = filter === "all" ? [...jobs.values()] : filterActiveJobs(jobs);
		if (visible.length === 0) return undefined;
		const lines = ["unit                              state      exit  result        label           runtime"];
		const now = Date.now();
		const sorted = visible.sort((a, b) => b.startedAt - a.startedAt);
		for (const job of sorted) {
			const runtime = job.finishedAt ? job.finishedAt - job.startedAt : now - job.startedAt;
			lines.push(
				`${pad(job.unit, 34)} ${pad(formatJobStatus(job), 10)} ${pad(job.exitStatus?.toString() ?? "-", 5)} ${pad(job.result ?? "-", 13)} ${pad(job.label, 15)} ${humanDuration(runtime)}`,
			);
		}
		const hidden = jobs.size - visible.length;
		if (hidden > 0) {
			lines.push(`… ${hidden} older terminal job${hidden === 1 ? "" : "s"} hidden. Run /jobs all to show them.`);
		}
		return lines.join("\n");
	}

	/* ----- lifecycle hooks ------------------------------------------ */

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;
		shuttingDown = false; // resume re-enables the watcher
		loadJobsFromSession(ctx);

		// After reload, run one synchronous tick so any jobs that reached
		// a terminal state while we weren't watching get their status
		// reconciled. We do NOT fire notifications — jobs already in a
		// terminal state are absorbed silently into the table.
		await tick();

		startWatcher();

		if (pi.getFlag("systemd-jobs") === true && ctx.mode === "tui") {
			const snap = await systemctlStatusSnapshot(ctx);
			if (snap) ctx.ui.notify(snap, "info");
			else ctx.ui.notify("systemd-jobs loaded (no active jobs).", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		// Set the guard BEFORE stopping the timer so any in-flight tick
		// also short-circuits on its next job iteration. sendMessage on
		// a torn-down session is safe but pointless.
		shuttingDown = true;
		sessionActive = false;
		stopWatcher();
	});
}

/* ------------------------------------------------------------------ *
 * Formatting helpers                                                  *
 * ------------------------------------------------------------------ */

/** Default-list filter: starting + running + terminal jobs that finished
 *  within RECENT_JOB_WINDOW_MS. */
function filterActiveJobs(jobs: Map<string, Job>): Job[] {
	const now = Date.now();
	const out: Job[] = [];
	for (const job of jobs.values()) {
		if (job.state === "starting" || job.state === "running") {
			out.push(job);
			continue;
		}
		const finishedAt = job.finishedAt ?? job.startedAt;
		if (now - finishedAt <= RECENT_JOB_WINDOW_MS) out.push(job);
	}
	return out;
}

function formatJobStatus(job: Job): string {
	switch (job.state) {
		case "starting":
			return "starting";
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "timeout":
			return "timeout";
		case "cancelled":
			return "cancelled";
	}
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = sec / 60;
	if (min < 60) return `${min.toFixed(1)}m`;
	const hr = min / 60;
	if (hr < 24) return `${hr.toFixed(1)}h`;
	return `${(hr / 24).toFixed(1)}d`;
}

function pad(s: string, width: number): string {
	return s.length >= width ? `${s.slice(0, width - 1)}…` : s + " ".repeat(width - s.length);
}

function slugify(label: string): string {
	return label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}