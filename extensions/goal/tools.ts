/**
 * Tool specifications and shared tool-state for the goal extension.
 *
 * Three tools registered with the LLM, mirroring codex-rs/ext/goal/src/spec.rs:
 *
 *   goal_get    — read-only, returns the current goal with budget summary
 *   goal_set    — creates a new goal OR replaces the current one when complete;
 *                 fails if an unfinished goal exists
 *   goal_update — the model's only way to mark a goal complete or blocked;
 *                 status is a closed enum (complete / blocked)
 *
 * The descriptions are adapted from codex with light tweaks so they read
 * naturally to the model naming the tools "goal_*" (codex uses bare
 * "create_goal" / "update_goal" / "get_goal"). All framing language — the
 * anti-injection note, the blocked-audit threshold, the "do not infer goals
 * from ordinary tasks" guard — is preserved verbatim.
 *
 * The tool specs intentionally live in this module alongside the runtime
 * manager state so the spec, the executor, and the manager that owns the
 * state are colocated. The executor functions take the manager as an
 * argument rather than reading module globals, which keeps the module
 * testable in isolation.
 */

import { Type } from "typebox";
import {
	type Goal,
	type GoalStatus,
	canTransition,
	validateObjective,
	validateTokenBudget,
} from "./utils.ts";

/**
 * Custom message types (also used to prune stale context; see index.ts).
 * These match the pattern in workflow-mode: each injection is a custom
 * message with a stable customType so the context handler can keep only
 * the latest and drop older copies.
 */
export const STEERING_MESSAGE_TYPE = "goal-steering";
export const OBJECTIVE_UPDATED_MESSAGE_TYPE = "goal-objective-updated";

/**
 * Status enum used by the goal_update tool. The full GoalStatus enum has
 * six values, but the *model* can only drive two: complete and blocked.
 * The other four (paused / usage_limited / budget_limited / active) are
 * manager-driven state transitions that happen outside the model's tool
 * calls. Constraining the model's status enum is intentional — it is the
 * exact analogue of codex's `StringEnum(["complete", "blocked"])`.
 */
export const MODEL_STATUSES = ["complete", "blocked"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

// ============================================================================
// Tool parameter schemas
// ============================================================================

export const GoalGetParams = Type.Object({});

export const GoalSetParams = Type.Object({
	objective: Type.String({
		description:
			"Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
		minLength: 1,
	}),
	tokenBudget: Type.Optional(
		Type.Number({
			description:
				"Positive token budget for the new goal. Omit unless explicitly requested.",
			minimum: 1,
		}),
	),
});

export const GoalUpdateParams = Type.Object({
	status: Type.String({
		description:
			"Required. Set to 'complete' only when the objective is achieved and no required work remains. Set to 'blocked' only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
		enum: MODEL_STATUSES,
	}),
});

// ============================================================================
// Tool descriptions (the part the model reads)
// ============================================================================

/**
 * Description for the goal_set tool. Adapted from codex's
 * create_goal tool description.
 *
 * Key behavioural guarantees baked into the description:
 *   - The model should NOT infer goals from ordinary tasks
 *   - The model should set token_budget only when explicitly requested
 *   - The model cannot use this tool to replace an unfinished goal —
 *     it must call goal_update("complete") first (or the user must clear
 *     it). This is enforced by the executor, not just the description.
 */
export const GOAL_SET_DESCRIPTION = [
	"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.",
	"Set token_budget only when an explicit token budget is requested.",
	"Fails if an unfinished goal exists; use goal_update only for status.",
].join(" ");

/**
 * Description for the goal_update tool. Adapted from codex's
 * update_goal tool description with the closed-enum status set to
 * the model-visible MODEL_STATUSES (complete / blocked).
 */
export const GOAL_UPDATE_DESCRIPTION = [
	"Update the existing goal.",
	"Use this tool only to mark the goal achieved or genuinely blocked.",
	"Set status to 'complete' only when the objective has actually been achieved and no required work remains.",
	"Set status to 'blocked' only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.",
	"If the user resumes a goal that was previously marked 'blocked', treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to 'blocked' again.",
	"Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to 'blocked'.",
	"Do not use 'blocked' merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
	"Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.",
	"You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.",
	"When marking a budgeted goal achieved with status 'complete', report the final token usage from the tool result to the user.",
].join(" ");

export const GOAL_GET_DESCRIPTION =
	"Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.";

// ============================================================================
// Tool result shapes (mirroring codex's GoalToolResponse)
// ============================================================================

export interface GoalGetResult {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export interface GoalSetResult {
	goal: Goal;
	replacedExisting: boolean;
}

export interface GoalUpdateResult {
	goal: Goal;
	status: GoalStatus;
}

// ============================================================================
// Executor implementations
// ============================================================================

/** Methods on the manager that the executors call. Narrow interface, kept here. */
export interface GoalManagerForTools {
	getCurrentGoal(): Goal | null;
	createGoal(input: { objective: string; tokenBudget: number | null }): {
		ok: boolean;
		goal?: Goal;
		reason?: string;
	};
	updateGoalStatus(input: { status: GoalStatus }): {
		ok: boolean;
		goal?: Goal;
		reason?: string;
	};
}

/**
 * Execute the goal_get tool. No inputs, returns the current goal + budget
 * summary + (when the goal was complete and budgeted) a completion-budget
 * report the model can echo back to the user.
 */
export function executeGoalGet(manager: GoalManagerForTools): GoalGetResult {
	const goal = manager.getCurrentGoal();
	if (goal === null) {
		return { goal: null, remainingTokens: null, completionBudgetReport: null };
	}

	const remainingTokens =
		goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);

	const completionBudgetReport =
		goal.status === "complete" && (goal.tokenBudget !== null || goal.timeUsedSeconds > 0)
			? [
					"Goal achieved. Report final usage from this tool result's structured goal fields.",
					goal.tokenBudget !== null
						? "Include token usage from goal.tokensUsed and goal.tokenBudget."
						: null,
					goal.timeUsedSeconds > 0
						? "If goal.timeUsedSeconds is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
						: null,
				]
					.filter((line): line is string => line !== null)
					.join(" ")
			: null;

	return { goal, remainingTokens, completionBudgetReport };
}

/**
 * Execute the goal_set tool. Validates objective + budget, calls the
 * manager to create/replace. Mirrors codex's `handle_create`: refuses to
 * create when an unfinished goal exists, and refuses on validation
 * failure. Both errors are surfaced to the model as text results with
 * `isError: true` so the model can recover (call goal_update first, or
 * fix the parameters).
 */
export function executeGoalSet(
	manager: GoalManagerForTools,
	params: { objective: string; tokenBudget?: number | null },
): { ok: boolean; result?: GoalSetResult; error?: string } {
	const objectiveError = validateObjective(params.objective);
	if (objectiveError !== null) {
		return { ok: false, error: objectiveError };
	}
	const budgetError = validateTokenBudget(params.tokenBudget ?? null);
	if (budgetError !== null) {
		return { ok: false, error: budgetError };
	}

	// Capture the prior goal before createGoal mutates currentGoal — the
	// only case where goal_set replaces is when there was already a
	// complete goal, so any other prior state means createGoal will fail
	// and replacedExisting stays false.
	const prior = manager.getCurrentGoal();
	const outcome = manager.createGoal({
		objective: params.objective.trim(),
		tokenBudget: params.tokenBudget ?? null,
	});
	if (!outcome.ok || !outcome.goal) {
		return { ok: false, error: outcome.reason ?? "failed to create goal" };
	}

	return {
		ok: true,
		result: {
			goal: outcome.goal,
			replacedExisting: prior !== null && prior.status === "complete",
		},
	};
}

/**
 * Execute the goal_update tool. The model can only drive complete or
 * blocked; anything else is rejected here even though the schema already
 * constrains the status enum (defence in depth).
 */
export function executeGoalUpdate(
	manager: GoalManagerForTools,
	params: { status: ModelStatus },
): { ok: boolean; result?: GoalUpdateResult; error?: string } {
	const status: GoalStatus = params.status;
	const current = manager.getCurrentGoal();
	if (current === null) {
		return { ok: false, error: "cannot update goal because this thread has no goal" };
	}

	const transitionError = canTransition(current.status, status);
	if (transitionError !== null) {
		return { ok: false, error: transitionError };
	}

	const outcome = manager.updateGoalStatus({ status });
	if (!outcome.ok || !outcome.goal) {
		return { ok: false, error: outcome.reason ?? "failed to update goal" };
	}
	return { ok: true, result: { goal: outcome.goal, status } };
}