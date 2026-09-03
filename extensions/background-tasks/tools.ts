/**
 * The 5 tool handlers, parameterized by a Backend.
 *
 * Each handler is a pure function of (jobs map, backend, params,
 * ctx). The extension's index.ts adapts them to pi.registerTool by
 * binding the live job map and providing a publish() function that
 * wraps pi.sendMessage.
 *
 * Why parameterize: integration tests exercise the tool handlers
 * directly against InProcBackend, so the "the right custom message
 * fires with the right shape" assertion lives in tests, not in a
 * live session.
 *
 * Note: the TypeBox parameter schemas (the things actually passed
 * to pi.registerTool as `parameters:`) live in `./schemas.ts`. The
 * interfaces below are TypeScript-only mirrors of those schemas and
 * describe the shape the handlers accept. If you change one, change
 * the other — and run schemas.test.ts, which would have caught the
 * original bug (parameters set to a TypeScript interface = empty at
 * runtime = 400 from the LLM provider).
 */

import type { Backend, BackendCapabilities } from "./backend.ts";
import type { Job, JobState } from "./state.ts";
import { isTerminal, TERMINAL_STATES } from "./state.ts";

/* ------------------------------------------------------------------ *
 * Shared types                                                        *
 *                                                                    *
 * These interfaces are TypeScript-only mirrors of the TypeBox       *
 * schemas in ./schemas.ts. They describe the shape the handlers     *
 * accept; they are NOT passed to pi.registerTool (interfaces are    *
 * erased at runtime, so doing so would leave the LLM provider      *
 * with an empty parameter block and the next tool call would fail   *
 * with a 400). See schemas.ts for the runtime schemas.              *
 * ------------------------------------------------------------------ */

export interface RunParams {
	command: string;
	label?: string;
	workingDirectory?: string;
	timeoutMs?: number;
	outputFile?: boolean | string;
	system?: boolean;
}

export interface StatusParams {
	id?: string;
	filter?: string;
}

export interface WaitParams {
	id: string;
	state?: string;
	timeoutMs?: number;
}

export interface CancelParams {
	id: string;
	signal?: string;
}

export interface JournalParams {
	id: string;
	limit?: number;
	since?: string;
	until?: string;
	maxChars?: number;
}

// Re-export so schemas.ts (or index.ts) can use the same source of
// truth for the `state` enum string in the typebox schema description.
export { TERMINAL_STATES };

export interface ToolContext {
	cwd: string;
	home: string;
	capabilities: BackendCapabilities;
}

export interface JobLaunchResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Handlers                                                            *
 * ------------------------------------------------------------------ */

export async function handleRun(jobs: Map<string, Job>, backend: Backend, ctx: ToolContext, params: { command: string; label?: string; workingDirectory?: string; timeoutMs?: number; outputFile?: boolean | string; system?: boolean }): Promise<JobLaunchResult> {
	const scope = params.system === true ? "system" : "user";
	const label = (params.label ?? params.command.split(/\s+/)[0] ?? "job").slice(0, 80);

	let workingDirectory = params.workingDirectory;
	if (!workingDirectory) workingDirectory = ctx.cwd;
	else if (!workingDirectory.startsWith("/") && !workingDirectory.startsWith("%")) {
		workingDirectory = `${ctx.cwd}/${workingDirectory}`;
	}

	let outputFile: string | undefined;
	if (params.outputFile === true) {
		outputFile = `${ctx.home}/.cache/background-tasks/${slugify(label)}.log`;
	} else if (typeof params.outputFile === "string") {
		outputFile = params.outputFile;
	}

	const launchReq = {
		command: params.command,
		workingDirectory,
		timeoutMs: params.timeoutMs,
		outputFile,
		scope: scope as "user" | "system",
	};

	const result = await backend.launch(launchReq);

	const job: Job = {
		id: result.id,
		label,
		command: params.command,
		workingDirectory,
		scope,
		startedAt: Date.now(),
		timeoutMs: params.timeoutMs,
		outputFile,
		state: "starting",
	};
	jobs.set(result.id, job);

	const summary = [
		`Launched ${label} as ${result.id} (${scope})`,
		`  workingDirectory: ${workingDirectory}`,
		params.timeoutMs !== undefined ? `  timeout: ${humanDuration(params.timeoutMs)}` : "",
		outputFile ? `  outputFile: ${outputFile}` : "",
		``,
		`A completion notification arrives on the next turn when the job reaches a terminal state. Use background_status to inspect, background_wait to block.`,
	].filter(Boolean).join("\n");

	return {
		content: [{ type: "text", text: summary }],
		details: { id: result.id, label, scope, timeoutMs: params.timeoutMs, outputFile },
	};
}

export interface JobListResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export async function handleStatus(jobs: Map<string, Job>, backend: Backend, _ctx: ToolContext, params: { id?: string; filter?: string }): Promise<JobListResult> {
	if (params.id) {
		const job = jobs.get(params.id);
		if (!job) {
			return {
				content: [{ type: "text", text: `No job with id "${params.id}" in this session.` }],
				details: {},
			};
		}
		const snap = await backend.status(job.id).catch(() => undefined);
		if (!snap) {
			return {
				content: [{ type: "text", text: `Job ${job.id} status unavailable (backend returned no data). The job may have been garbage-collected.` }],
				details: {},
			};
		}
		// Reconcile in-memory state with what the backend reports.
		if (!isTerminal(snap.state)) {
			job.state = snap.state;
		} else {
			job.state = snap.state;
			job.exitStatus = snap.exitStatus;
			job.result = snap.result;
			if (!job.finishedAt) job.finishedAt = Date.now();
		}
		return {
			content: [{
				type: "text",
				text: `${job.label} (${job.id}): ${formatState(job.state)} exit=${job.exitStatus ?? "?"} result=${job.result ?? "?"}`.trim(),
			}],
			details: { job: { ...job } },
		};
	}

	if (jobs.size === 0) {
		return {
			content: [{ type: "text", text: "No jobs registered in this session. Use background_run to launch one." }],
			details: {},
		};
	}
	const filter = params.filter === "all" ? "all" : "active";
	const list = filter === "active" ? filterActive(jobs) : [...jobs.values()];
	if (list.length === 0) {
		return {
			content: [{
				type: "text",
				text: `No active or recent jobs (${jobs.size} older terminal job${jobs.size === 1 ? "" : "s"} hidden — pass filter="all" to see them).`,
			}],
			details: { count: 0, hidden: jobs.size },
		};
	}
	const lines = ["id                                state      exit  result         label           runtime"];
	const now = Date.now();
	const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt);
	for (const job of sorted) {
		const runtime = job.finishedAt ? job.finishedAt - job.startedAt : now - job.startedAt;
		lines.push(
			`${pad(job.id, 34)} ${pad(formatState(job.state), 10)} ${pad(job.exitStatus?.toString() ?? "-", 5)} ${pad(job.result ?? "-", 14)} ${pad(job.label, 15)} ${humanDuration(runtime)}`,
		);
	}
	const hidden = jobs.size - list.length;
	if (hidden > 0) {
		lines.push(`… ${hidden} older terminal job${hidden === 1 ? "" : "s"} hidden. Pass filter="all" to show them.`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { count: list.length, hidden, filter },
	};
}

export async function handleWait(jobs: Map<string, Job>, backend: Backend, _ctx: ToolContext, params: { id: string; state?: string; timeoutMs?: number }): Promise<JobLaunchResult> {
	const job = jobs.get(params.id);
	if (!job) {
		throw new Error(`No job with id "${params.id}" in this session.`);
	}
	const state = (params.state as JobState | undefined) ?? "completed";
	const timeoutMs = params.timeoutMs ?? 24 * 60 * 60 * 1000;

	let final = await backend.wait(job.id, state, timeoutMs);
	if (!final && isTerminal(job.state)) {
		// systemd garbage-collects finished transient units; when the
		// substrate no longer knows the job, the session's own record is
		// the verdict.
		final = { state: job.state, exitStatus: job.exitStatus, result: job.result };
	}
	if (!final) {
		throw new Error(`Wait timed out after ${humanDuration(timeoutMs)} — job ${job.id} did not reach ${state}.`);
	}
	if (isTerminal(final.state) && !isTerminal(job.state)) {
		job.state = final.state;
		job.exitStatus = final.exitStatus;
		job.result = final.result;
		job.finishedAt = job.finishedAt ?? Date.now();
	}
	return {
		content: [{
			type: "text",
			text: `${job.label} (${job.id}) reached ${state}. ${formatState(job.state)} exit=${job.exitStatus ?? "?"} result=${job.result ?? "?"}`,
		}],
		details: { job: { ...job } },
	};
}

export async function handleCancel(jobs: Map<string, Job>, backend: Backend, _ctx: ToolContext, params: { id: string; signal?: string }): Promise<JobLaunchResult> {
	const job = jobs.get(params.id);
	if (!job) {
		throw new Error(`No job with id "${params.id}" in this session.`);
	}
	const signal = (params.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM") as "SIGTERM" | "SIGKILL";
	await backend.cancel(job.id, signal);
	// Mark cancelled immediately so subsequent status reads report the
	// right reason; the watcher reconciles on its next tick.
	job.state = "cancelled";
	job.finishedAt = Date.now();
	return {
		content: [{ type: "text", text: `Cancelled ${job.label} (${job.id}).` }],
		details: { job: { ...job } },
	};
}

export async function handleJournal(jobs: Map<string, Job>, backend: Backend, _ctx: ToolContext, params: { id: string; limit?: number; since?: string; until?: string; maxChars?: number }): Promise<JobLaunchResult> {
	const job = jobs.get(params.id);
	if (!job) {
		throw new Error(`No job with id "${params.id}" in this session.`);
	}
	const limit = Math.min(Math.max(params.limit ?? 200, 1), 5_000);
	const maxChars = Math.min(Math.max(params.maxChars ?? 8_000, 256), 50_000);
	const chunk = await backend.journal(job.id, { limit, maxChars, since: params.since, until: params.until });
	return {
		content: [{ type: "text", text: chunk.lines.join("\n") || "(journal empty)" }],
		details: { id: params.id, lines: chunk.lines.length, chars: chunk.totalChars },
	};
}

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

const RECENT_JOB_WINDOW_MS = 5 * 60 * 1000;

function filterActive(jobs: Map<string, Job>): Job[] {
	const now = Date.now();
	const out: Job[] = [];
	for (const job of jobs.values()) {
		if (!isTerminal(job.state)) {
			out.push(job);
			continue;
		}
		const finishedAt = job.finishedAt ?? job.startedAt;
		if (now - finishedAt <= RECENT_JOB_WINDOW_MS) out.push(job);
	}
	return out;
}

function formatState(state: JobState): string {
	return state;
}

export function humanDuration(ms: number): string {
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
