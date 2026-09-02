/**
 * Canonical state types and parsers for background tasks.
 *
 * Pure: no I/O, no time, no side effects. The job of this module is to
 * give every backend (systemd, docker, in-process, …) one place to
 * agree on what a job's lifecycle looks like and how to interpret
 * backend-specific output.
 *
 * The state machine:
 *
 *   starting ──► running ──► completed
 *                       ├─► failed
 *                       ├─► timeout       (caller's deadline, not the job's)
 *                       └─► cancelled     (caller asked to stop it)
 *
 * `starting` and `running` are not terminal — the watcher polls while
 * the job is in either. The other four are terminal and one-way: a
 * terminal job stays terminal for the lifetime of its in-memory entry.
 */

export type JobState = "starting" | "running" | "completed" | "failed" | "timeout" | "cancelled";

export const TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "timeout", "cancelled"];

export function isTerminal(state: JobState): boolean {
	return TERMINAL_STATES.includes(state);
}

/** The in-memory entry the extension manages. Keyed by backend id
 *  (unit name for systemd, container id for docker, …). The state
 *  field is what the watcher maintains; the rest is what the caller
 *  submitted plus what the backend reported on termination. */
export interface Job {
	id: string;
	label: string;
	command: string;
	workingDirectory: string;
	scope: "user" | "system";
	startedAt: number;
	timeoutMs?: number;
	outputFile?: string;
	state: JobState;
	exitStatus?: number;
	result?: string;
	finishedAt?: number;
}

/** Snapshot returned by a backend's status() call. `state` is the
 *  backend's current belief; the watcher maps backend-specific fields
 *  (exit code, result reason) into the abstraction's vocabulary. */
export interface StatusSnapshot {
	state: JobState;
	exitStatus?: number;
	/** Backend-specific result reason (systemd's `Result=` field).
	 *  Kept opaque here — surfaces in the completion notification for
	 *  debugging, not for control flow. */
	result?: string;
}

/* ------------------------------------------------------------------ *
 * systemd show output parser                                         *
 *                                                                    *
 * Lives here (not in backends/systemd.ts) because the parser is the  *
 * canonical source of truth for how a status string maps to a state, *
 * and the integration tests want to exercise it without importing a  *
 * backend. The systemd backend constructs the raw input from        *
 * `systemctl show` and delegates here.                              *
 * ------------------------------------------------------------------ */

/** Parses the subset of `systemctl show <unit>` output the watcher
 *  cares about. Tolerates missing keys (older systemd, garbage-
 *  collected units) by falling back to the safest interpretation. */
export function parseShowOutput(stdout: string): StatusSnapshot {
	const get = (key: string): string | undefined => {
		const re = new RegExp(`^${key}=(.*)$`, "m");
		const m = stdout.match(re);
		return m?.[1];
	};

	const activeState = get("ActiveState");
	const execMainStatus = get("ExecMainStatus");
	const result = get("Result");
	const activeEnterTimestamp = get("ActiveEnterTimestampMonotonic");

	// Unknown active state (empty input, garbage-collected unit) —
	// the safest interpretation is "not terminal, not yet started",
	// so the watcher keeps polling. Treating it as completed would
	// fire a misleading completion notification.
	if (!activeState) {
		return { state: "starting" };
	}

	// Non-terminal states. systemd's `active` is the steady state,
	// `activating`/`reloading` are transitions. We don't distinguish
	// them from the model's point of view — both mean "the job is
	// running or about to run".
	if (activeState === "active" || activeState === "activating" || activeState === "reloading") {
		// Distinguish "queued, not started yet" from "actually running"
		// via ActiveEnterTimestampMonotonic. systemd writes a monotonic
		// microsecond timestamp; zero (or absent) means the active
		// state hasn't been entered yet.
		return {
			state: activeEnterTimestamp && activeEnterTimestamp !== "0" ? "running" : "starting",
		};
	}

	// Terminal: map Result= to the canonical state.
	const resultStr = result ?? "";
	let state: JobState = "completed";
	if (resultStr === "timeout") {
		state = "timeout";
	} else if (
		resultStr === "exit-code" ||
		resultStr === "signal" ||
		resultStr === "resources" ||
		resultStr === "core-dump" ||
		resultStr === "watchdog"
	) {
		state = "failed";
	} else if (activeState === "failed") {
		// Result= not set but ActiveState=failed — older systemd. Treat
		// as failed; the exit status is still informative.
		state = "failed";
	}

	const exit = execMainStatus && execMainStatus !== "" ? Number(execMainStatus) : undefined;
	return { state, exitStatus: exit, result };
}

/* ------------------------------------------------------------------ *
 * Unit-name extraction                                               *
 *                                                                    *
 * The unit-name parsing bug from the systemd-jobs commit lives here. *
 * With --no-block, `systemd-run` prints "Running as unit: <name>"    *
 * on STDERR, not stdout — initial code only read stdout and got an   *
 * empty string. The fix scans both streams.                          *
 * ------------------------------------------------------------------ */

/** Returns the unit name from a systemd-run invocation's combined
 *  stdout+stderr, or undefined if no "Running as unit:" line was
 *  found. Accepts either `.service` or `.scope` units. */
export function extractUnitName(combinedStdoutStderr: string): string | undefined {
	const match = combinedStdoutStderr.match(/Running as unit:\s*([^\s;]+)/);
	const unit = match?.[1];
	if (!unit) return undefined;
	if (!unit.endsWith(".service") && !unit.endsWith(".scope")) return undefined;
	return unit;
}
