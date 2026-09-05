/**
 * Persistence helpers for the goal extension.
 *
 * Goal state lives in a single JSON-serializable entry appended to the
 * session's JSONL via `pi.appendEntry`. This keeps the state on the
 * session timeline (so `/resume` and `--fork` see the same goal the user
 * had at fork time) without putting it into the LLM context.
 *
 * The entry is the latest authoritative snapshot. On restore, the most
 * recent goal-state entry wins — earlier entries are overwritten in the
 * sense that they describe a goal the user has since replaced.
 *
 * Three custom entry types exist:
 *
 *   goal-state       — single source of truth for the current goal
 *   goal-removed     — sentinel meaning the goal was cleared; on restore,
 *                      the most recent goal-state entry before this is the
 *                      one that was removed
 *
 * Together they let a /resume'd session reconstruct: "the goal was X, then
 * the user cleared it" → no active goal on resume.
 *
 * The accounting state (tokens used, time used, last-accounted baseline)
 * is part of the same goal-state entry — it survives /resume natively,
 * which mirrors Codex's SQLite-backed goal state surviving the same way.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "./utils.ts";

export const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const GOAL_REMOVED_ENTRY_TYPE = "goal-removed";

/**
 * Snapshot shape — JSON-serializable, mirrors codex's ThreadGoal row.
 * `lastAccountedUsage` is the cumulative assistant Usage at which we last
 * charged tokens to this goal; on resume we continue the delta from there.
 */
export interface GoalStateSnapshot {
	goal: Goal;
	/**
	 * Cumulative Usage at the time we last accounted tokens. Resuming a
	 * session means resuming the delta from this baseline; we never re-
	 * charge tokens that already belong to the goal before the resume.
	 * `null` means "no baseline yet" — the first post-resume accounting
	 * pass will seed it from the latest known assistant message.
	 */
	lastAccountedUsage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
	} | null;
	/** Wall-clock ms timestamp of the last accounting pass; null = no baseline yet. */
	lastAccountedAtMs: number | null;
	/**
	 * Consecutive turn counter for the "execution failure" blocked trigger
	 * (port of codex's consecutive_execution_failure_turns). Resets to 0
	 * on any successful tool call. Triggers `blocked` at 3.
	 */
	consecutiveExecutionFailures: number;
}

/**
 * Walk the session branch and return the most recent snapshot of the
 * goal state, plus the status it had when last seen. The shape returned
 * is `{ state | null, removed: boolean }`:
 *
 *   state = null, removed = false  → no goal has ever existed on this branch
 *   state = X,    removed = false  → current goal is X
 *   state = X,    removed = true   → goal X was active, then cleared (no
 *                                    current goal on this branch)
 */
export function loadGoalState(ctx: ExtensionContext): {
	state: GoalStateSnapshot | null;
	removed: boolean;
} {
	let snapshot: GoalStateSnapshot | null = null;
	let removed = false;

	// Branch entries are in chronological order; the last goal-state entry
	// wins. We iterate once and remember the most recent of each kind.
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom") {
			if (entry.customType === GOAL_STATE_ENTRY_TYPE) {
				const data = entry.data as Partial<GoalStateSnapshot> | undefined;
				if (data && data.goal && typeof data.goal.goalId === "string") {
					snapshot = data as GoalStateSnapshot;
					removed = false;
				}
			} else if (entry.customType === GOAL_REMOVED_ENTRY_TYPE) {
				removed = true;
				snapshot = null;
			}
		}
	}

	return { state: snapshot, removed };
}

/**
 * Read every accounting-relevant data point we need to resume cleanly:
 * the latest assistant message's cumulative Usage (for token delta base),
 * the wall-clock anchor (for time delta base), and the prior consecutive-
 * failure counter.
 */
export function loadResumeAnchor(ctx: ExtensionContext): {
	latestAssistantUsage: GoalStateSnapshot["lastAccountedUsage"];
	latestAssistantAtMs: number | null;
} {
	let latestAssistantUsage: GoalStateSnapshot["lastAccountedUsage"] = null;
	let latestAssistantAtMs: number | null = null;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		// message.usage is the cumulative Usage for the entire assistant
		// response, including all tool rounds in that turn.
		latestAssistantUsage = {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			totalTokens: message.usage.totalTokens,
		};
		latestAssistantAtMs = message.timestamp;
	}

	return { latestAssistantUsage, latestAssistantAtMs };
}