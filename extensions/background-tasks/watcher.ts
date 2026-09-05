/**
 * Watcher: the poller that drives state transitions and reports the
 * jobs that just finished.
 *
 * Pure of pi: takes a Backend, a job map, and a "now" clock. Returns
 * the list of jobs that transitioned to terminal on this tick. The
 * extension's index.ts owns the setInterval, the pi.sendMessage call,
 * and session persistence — so the watcher is unit-testable against
 * any backend without a pi runtime.
 *
 * Tick semantics:
 *   - For every non-terminal job, ask the backend for status.
 *   - If terminal, adopt the backend's verdict (exit, result) and
 *     return the job so the caller can fire its notification.
 *   - If non-terminal, promote starting→running based on what the
 *     backend says (a confidence signal in /jobs listings).
 *   - If the wall-clock deadline is past and the job hasn't reported
 *     terminal, force state="timeout" and ask the backend to stop.
 *
 * The timeout enforcement is independent of the backend's native
 * timer. This makes the timeout reliable on any backend, including
 * ones without one.
 */

import type { Backend } from "./backend.ts";
import type { Job } from "./state.ts";
import { isTerminal } from "./state.ts";

export interface TickOutcome {
	/** Jobs that transitioned to terminal during this tick. The caller
	 *  fires a notification for each one and removes it from any
	 *  "active" filters. */
	finished: Job[];
}

export async function tick(jobs: Map<string, Job>, backend: Backend, now: number): Promise<TickOutcome> {
	const finished: Job[] = [];
	// Iterate over a snapshot — the caller may mutate the map (e.g.
	// during notification firing) and we don't want iteration order to
	// depend on whether notifications finished.
	for (const job of [...jobs.values()]) {
		if (isTerminal(job.state)) continue;

		// Timeout first — independent of any backend-side timer.
		if (job.timeoutMs !== undefined && now - job.startedAt >= job.timeoutMs && job.state !== "timeout") {
			job.state = "timeout";
			job.finishedAt = now;
			// Best-effort stop; don't block the tick on it.
			void backend.cancel(job.id, "SIGTERM", job.scope).catch(() => {
				/* ignore — the job will appear terminal in status() on the next tick anyway */
			});
			finished.push(job);
			continue;
		}

		const snap = await backend.status(job.id, job.scope).catch(() => undefined);
		if (!snap) continue; // transient — try again next tick

		if (!isTerminal(snap.state)) {
			// Promote starting → running when the backend confirms the
			// job is in flight.
			if (job.state === "starting" && snap.state === "running") {
				job.state = "running";
			}
			continue;
		}

		// Terminal — adopt the backend's verdict (it may know more
		// than we do about the cause of death).
		job.state = snap.state;
		job.exitStatus = snap.exitStatus;
		job.result = snap.result;
		job.finishedAt = now;
		finished.push(job);
	}
	return { finished };
}
