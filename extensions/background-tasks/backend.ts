/**
 * Backend abstraction for background tasks.
 *
 * A backend owns the lifecycle of a launched process against some
 * execution substrate (systemd, an in-process simulation for tests,
 * a future Docker/Kubernetes adapter, …). The watcher and tool
 * handlers are written against this interface and never touch a
 * substrate directly.
 *
 * Design rules:
 *   - Methods are async and may throw on transport-level failures
 *     (process not found, timeout reached). Domain-level failures
 *     (the command exited non-zero) are NOT thrown — they surface as
 *     StatusSnapshot with state="failed" and exitStatus set.
 *   - All timeouts are wall-clock milliseconds.
 *   - `wait()` must not be able to MISS the target state. Prefer the
 *     substrate's native blocking primitive where one exists (the
 *     in-process backend uses an EventEmitter). systemd's CLI has no
 *     wait verb, so its backend polls ground-truth status inside one
 *     bounded exec — sound for terminal targets because terminal
 *     states are absorbing; transient targets are best-effort.
 *   - `journal()` MUST refuse to truncate silently — if the requested
 *     window exceeds maxChars, it throws. Callers narrow the window.
 */

import type { StatusSnapshot } from "./state.ts";

/** What the caller asked for. Substrate-agnostic on purpose: this is
 *  what the agent cares about. The backend translates scope / output
 *  file format / etc. into its own vocabulary. */
export interface LaunchRequest {
	command: string;
	workingDirectory: string;
	timeoutMs?: number;
	/** Path to capture combined stdout to. Backend decides whether
	 *  stderr joins or inherits. */
	outputFile?: string;
	/** "user" by default; "system" requires the matching privilege on
	 *  every substrate that supports it. */
	scope?: "user" | "system";
}

export interface LaunchResult {
	/** Substrate-specific identifier — unit name for systemd, container
	 *  id for docker, a uuid for inproc. Opaque to the abstraction;
	 *  surfaced in tool results for debugging. */
	id: string;
	/** Backend-specific opaque blob. The watcher and tools never look
	 *  inside; tests do. */
	raw: unknown;
}

export interface JournalOptions {
	limit: number;
	maxChars: number;
	since?: string;
	until?: string;
}

export interface JournalChunk {
	lines: string[];
	totalChars: number;
}

/** What the backend can and can't do. Tool prompts use this to avoid
 *  advertising parameters that would no-op on the active backend. */
export interface BackendCapabilities {
	/** True if the backend can scope jobs to the calling user (vs.
	 *  requiring root / system). systemd's --user mode does this. */
	userScope: boolean;
	/** True if the backend can stop a running job. Most are; some
	 *  sandboxed ones aren't. */
	cancellable: boolean;
	/** True if the backend retains the job's log after the job ends.
	 *  systemd journals do; bare inproc jobs do not (they keep what
	 *  was captured to outputFile, if any). */
	persistentJournal: boolean;
}

export interface Backend {
	/** Stable, human-readable identifier (used in tool prompts and
	 *  custom messages). Lowercase, no spaces. */
	readonly id: string;
	readonly capabilities: BackendCapabilities;

	launch(req: LaunchRequest): Promise<LaunchResult>;
	/** Returns undefined when the substrate no longer knows the job
	 *  (e.g. systemd garbage-collected the unit). */
	status(id: string): Promise<StatusSnapshot | undefined>;
	/** Resolves when status reports `state` (or when the timeout
	 *  fires). Returns the final status, or undefined on timeout. */
	wait(id: string, state: import("./state.ts").JobState, timeoutMs: number): Promise<StatusSnapshot | undefined>;
	/** Stop the job. After cancel(), status() should eventually
	 *  report state="cancelled". MUST NOT throw if the job is
	 *  already terminal. */
	cancel(id: string, signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
	/** Bounded journal/log fetch. Throws if the window exceeds
	 *  maxChars (refuses to truncate silently). */
	journal(id: string, opts: JournalOptions): Promise<JournalChunk>;
}
