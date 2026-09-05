/**
 * Per-turn accounting for the goal extension.
 *
 * Ports codex-rs/ext/goal/src/accounting.rs to a TypeScript model suited
 * to pi's single-process model. Two facts matter for the goal budget:
 *
 *   tokens   — billable tokens in cumulative assistant Usage, computed as
 *              `input - cacheRead + output` (cacheRead represents tokens
 *              paid upstream and are not charged again here)
 *   time     — wall-clock seconds since the goal was created
 *
 * Both are stored as deltas: we keep a baseline and only advance it,
 * never rewind. This means the total tokens/time used by the goal is the
 * sum of advances, not "now minus start" — a session that's been resumed
 * many times still sums to the true lifetime usage.
 *
 * Concurrency: pi is single-process, but `tool_result` and `message_end`
 * can fire from the same turn out of order. A simple async mutex protects
 * the read-decide-write window so the same delta isn't double-charged.
 *
 * The codex version uses tokio's `Semaphore::new(1)`; pi has no such
 * primitive in this scope, so we model it with a single-slot promise
 * chain. The semantics — "only one holder at a time" — match.
 */

import { billableTokens } from "./utils.ts";
import type { GoalStateSnapshot } from "./persistence.ts";

/** Cumulative Usage fields we care about for token accounting. */
export interface UsageDelta {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

/**
 * Tokens charged to the goal since the last accounting pass, plus the
 * wall-clock seconds since the last pass. If both are zero, the snapshot
 * is "no progress" and the manager tick should not call goal accounting.
 */
export interface GoalProgressSnapshot {
	tokenDelta: number;
	timeDeltaSeconds: number;
}

/**
 * Mutable in-memory accounting state. Mirrors codex's GoalAccountingInner
 * minus the descendant_token_usage / root_accounting_state machinery
 * (which requires in-process sub-threads and does not map to pi's
 * separate-process sub-agent example).
 *
 * The state is *runtime-only* — it is rebuilt from the session entry on
 * `/resume` via `fromSnapshot`. This means we cannot persist an "active
 * mid-turn" state; resume always picks up after the last assistant Usage
 * we saw, which is the same behaviour codex has (it loads from SQLite).
 */
export class GoalAccounting {
	private baseline: UsageDelta | null = null;
	private lastAccountedAtMs: number | null = null;
	/** Wall-clock elapsed seconds; only advances, never rewinds. */
	private elapsedSeconds = 0;
	/** Tokens already charged against the goal budget. */
	private tokensUsed = 0;
	/** Consecutive turns where the `bash` tool failed without any successful tool. */
	private consecutiveExecutionFailures = 0;
	/** Whether the goal currently exists (for budget-related decisions). */
	private hasGoal = false;
	/** Whether the goal is currently `active` (manager should charge tokens). */
	private statusActive = false;

	// Single-slot mutex — see module docstring.
	private mutex: Promise<void> = Promise.resolve();

	async lock<T>(fn: () => T | Promise<T>): Promise<T> {
		const previous = this.mutex;
		let release!: () => void;
		this.mutex = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await previous;
			return await fn();
		} finally {
			release();
		}
	}

	/** Called on goal creation / resume — seeds baselines. */
	start(goal: { statusActive: boolean; tokensUsed: number; timeUsedSeconds: number; lastAccountedUsage: UsageDelta | null; lastAccountedAtMs: number | null }): void {
		this.hasGoal = true;
		this.statusActive = goal.statusActive;
		this.tokensUsed = goal.tokensUsed;
		this.elapsedSeconds = goal.timeUsedSeconds;
		this.baseline = goal.lastAccountedUsage;
		this.lastAccountedAtMs = goal.lastAccountedAtMs;
		this.consecutiveExecutionFailures = 0;
	}

	/** Called on goal clear / terminal status — stops accounting. */
	stop(): void {
		this.hasGoal = false;
		this.statusActive = false;
		this.baseline = null;
		this.lastAccountedAtMs = null;
	}

	setStatusActive(active: boolean): void {
		this.statusActive = active;
	}

	/**
	 * Compute the delta since the last accounting pass. Returns null when
	 * there is no progress to report (both deltas are zero) OR when the
	 * caller should not be charging tokens (no goal / status not active).
	 *
	 * Caller must `lock()` around this call and the subsequent `commit()`.
	 */
	snapshot(currentUsage: UsageDelta, nowMs: number): GoalProgressSnapshot | null {
		if (!this.hasGoal || !this.statusActive) return null;

		let tokenDelta = 0;
		if (this.baseline !== null) {
			const currentBillable = billableTokens(currentUsage);
			const baselineBillable = billableTokens(this.baseline);
			tokenDelta = Math.max(0, currentBillable - baselineBillable);
		}

		let timeDeltaSeconds = 0;
		if (this.lastAccountedAtMs !== null) {
			const elapsedMs = nowMs - this.lastAccountedAtMs;
			if (elapsedMs > 0) timeDeltaSeconds = Math.floor(elapsedMs / 1000);
		}

		if (tokenDelta === 0 && timeDeltaSeconds === 0) return null;

		return { tokenDelta, timeDeltaSeconds };
	}

	/**
	 * Apply a delta to the running totals and advance the baseline.
	 * Caller must `lock()` around `snapshot()` + `commit()`.
	 */
	commit(snapshot: GoalProgressSnapshot, currentUsage: UsageDelta, nowMs: number): void {
		this.tokensUsed += snapshot.tokenDelta;
		this.elapsedSeconds += snapshot.timeDeltaSeconds;
		this.baseline = currentUsage;
		this.lastAccountedAtMs = nowMs;
	}

	/** Reset baseline to the latest assistant usage without charging any delta. */
	seedBaseline(currentUsage: UsageDelta, nowMs: number): void {
		this.baseline = currentUsage;
		this.lastAccountedAtMs = nowMs;
	}

	/** Report an outcome for the just-ended turn. Port of codex's record_tool_outcome. */
	recordTurnToolOutcome(outcome: TurnToolOutcome): void {
		if (!this.hasGoal) return;
		if (outcome.hadSuccessfulTool) {
			this.consecutiveExecutionFailures = 0;
			return;
		}
		if (outcome.failedBashExecution) {
			this.consecutiveExecutionFailures += 1;
		}
	}

	/**
	 * Whether the goal should transition to `blocked` from `active` because
	 * of execution failures. Port of codex's `execution_failure_goal` —
	 * triggered at 3 consecutive turns with a failed bash and no
	 * successful tool call.
	 */
	shouldBlockFromExecutionFailures(): boolean {
		return this.consecutiveExecutionFailures >= 3;
	}

	/** Snapshot for persistence — caller owns the returned object. */
	toSnapshot(): GoalStateSnapshot["lastAccountedUsage"] {
		return this.baseline;
	}

	getLastAccountedAtMs(): number | null {
		return this.lastAccountedAtMs;
	}

	getTokensUsed(): number {
		return this.tokensUsed;
	}

	getElapsedSeconds(): number {
		return this.elapsedSeconds;
	}

	getConsecutiveExecutionFailures(): number {
		return this.consecutiveExecutionFailures;
	}

	getStatusActive(): boolean {
		return this.statusActive;
	}

	hasActiveGoal(): boolean {
		return this.hasGoal && this.statusActive;
	}
}

/** Per-turn tool outcome summary, derived from tool_result events. */
export interface TurnToolOutcome {
	/** True if at least one tool in this turn returned without error. */
	hadSuccessfulTool: boolean;
	/** True if the `bash` tool was called and failed (isError=true). */
	failedBashExecution: boolean;
}