/**
 * Goal extension for the pi coding agent.
 *
 * A strict port of OpenAI Codex's `/goal` slash command and supporting
 * thread_goal extension (codex-rs/ext/goal/, ~v0.145+). The shape is:
 *
 *   1. Three custom tools (goal_get, goal_set, goal_update) the LLM can
 *      call to read, create, and update the persistent objective
 *   2. A manager tick on `agent_settled` that re-injects a continuation
 *      steering prompt whenever the goal is `active` and the previous
 *      turn settled, mirroring Codex's `on_thread_idle → continue_if_idle`
 *   3. Token & time budget accounting: the goal has a token budget and
 *      per-turn deltas are charged on each `message_end` for assistant
 *      messages; budget exhaustion flips status to `budget_limited` and
 *      the manager switches to a wrap-up steering prompt
 *   4. Six-state enum (active / paused / blocked / usage_limited /
 *      budget_limited / complete), each with distinct runtime behaviour
 *   5. Session persistence via pi.appendEntry — survives /resume and
 *      is included in JSONL session files
 *
 * What is deliberately NOT ported:
 *
 *   - root_accounting_state / descendant_token_usage — Codex's parent-
 *     child token accounting depends on in-process sub-threads; pi's
 *     sub-agent extension spawns a separate process, so a parent's goal
 *     budget cannot observe child token usage without an explicit IPC
 *     protocol. Sub-agent goals do not propagate.
 *   - update_plan tool integration — Codex's continuation prompt has two
 *     variants depending on whether the model has an update_plan tool;
 *     pi does not have that tool.
 *   - Fork-flush protocol — Codex explicitly flushes in-flight goal
 *     accounting before forking. pi's /fork copies the JSONL up to the
 *     fork point, which carries the goal state forward naturally; if
 *     the user wants to drop the goal at fork time they can clear it.
 *   - MAX_GOAL_TOKEN_BUDGET config — Codex's per-org cap has no pi
 *     equivalent; users set their own per-goal budget.
 *
 * Commands:
 *
 *   /goal <objective>          create a goal and start pursuing it
 *   /goal [show|status]        print the current goal
 *   /goal clear                remove the goal (no auto-continuation)
 *   /goal pause                pause auto-continuation
 *   /goal resume               re-activate a paused/blocked goal
 *
 * Flag: pi --goal "<objective>" → start a session with the goal already set
 * (TUI mode prints the goal once at startup; the manager is otherwise idle
 * until the first user prompt).
 */

import type {
	AgentMessage,
	AssistantMessage,
	TextContent,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Static } from "typebox";

import { GoalAccounting, type TurnToolOutcome, type UsageDelta } from "./accounting.ts";
import {
	GOAL_REMOVED_ENTRY_TYPE,
	GOAL_STATE_ENTRY_TYPE,
	loadGoalState,
	loadResumeAnchor,
	type GoalStateSnapshot,
} from "./persistence.ts";
import {
	buildBudgetLimitPrompt,
	buildContinuationPrompt,
} from "./steering.ts";
import {
	GoalGetParams,
	GoalSetParams,
	GoalUpdateParams,
	GOAL_GET_DESCRIPTION,
	GOAL_SET_DESCRIPTION,
	GOAL_UPDATE_DESCRIPTION,
	STEERING_MESSAGE_TYPE,
	executeGoalGet,
	executeGoalSet,
	executeGoalUpdate,
} from "./tools.ts";
import {
	billableTokens,
	canTransition,
	isAutoContinuing,
	isWrappingUp,
	newGoalId,
	validateObjective,
	validateTokenBudget,
	type Goal,
	type GoalStatus,
} from "./utils.ts";

// ============================================================================
// Constants
// ============================================================================

/** How many recent steering messages to keep in the LLM context. */
const KEEP_STEERING_MESSAGES = 2;
/** Consecutive turns with no progress before we treat the goal as stalled. */
const MAX_NO_PROGRESS_TURNS = 5;

// ============================================================================
// Helpers
// ============================================================================

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function customTypeOf(message: AgentMessage): string | undefined {
	return (message as AgentMessage & { customType?: string }).customType;
}

function formatUsageForDelta(usage: AssistantMessage["usage"]): UsageDelta {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
	};
}

function formatGoalForDisplay(goal: Goal | null): string {
	if (goal === null) {
		return "No active goal. Set one with `/goal <objective>`.";
	}
	const lines: string[] = [];
	lines.push(`Goal: ${goal.objective}`);
	lines.push(`Status: ${goal.status}`);
	lines.push(`Created: ${new Date(goal.createdAt).toISOString()}`);
	if (goal.tokenBudget !== null) {
		const remaining = Math.max(0, goal.tokenBudget - goal.tokensUsed);
		lines.push(
			`Tokens used: ${goal.tokensUsed} / ${goal.tokenBudget} (${remaining} remaining)`,
		);
	} else {
		lines.push(`Tokens used: ${goal.tokensUsed} (no budget)`);
	}
	const elapsedMin = Math.floor(goal.timeUsedSeconds / 60);
	const elapsedSec = goal.timeUsedSeconds - elapsedMin * 60;
	lines.push(`Time spent: ${elapsedMin}m ${elapsedSec}s`);
	return lines.join("\n");
}

// ============================================================================
// The extension
// ============================================================================

export default function goalExtension(pi: ExtensionAPI): void {
	// ---- In-memory runtime state ----------------------------------------
	const accounting = new GoalAccounting();
	let currentGoal: Goal | null = null;
	let pendingStatusTransition: GoalStatus | null = null;
	let lastStopReason: AssistantMessage["stopReason"] | undefined;
	let noProgressTurns = 0;
	let startedThisSession = false;
	/**
	 * The most recent ctx.mode we've observed. The manager tick fires from
	 * event handlers that always have a ctx, but helper functions like
	 * `transitionToBudgetLimited` do not. We mirror ctx.mode on every
	 * event/command so those helpers can decide whether steering injections
	 * should request a follow-up turn.
	 */
	let lastMode: string | undefined;

	// Register the CLI flag so verify.sh can prove we loaded.
	pi.registerFlag("goal", {
		description: "Start with an active goal (provide the objective as the flag value)",
		type: "string",
		default: undefined,
	});

	// ---- Tool implementations (used by executors via closures) ----
	function createGoalInternal(input: { objective: string; tokenBudget: number | null }): {
		ok: boolean;
		goal?: Goal;
		reason?: string;
	} {
		if (currentGoal !== null) {
			// Only a `complete` goal can be replaced — anything else means
			// the model is trying to silently swap goals while work is in
			// flight, which codex explicitly forbids. The model must call
			// goal_update("complete") first (or the user must /goal clear).
			if (currentGoal.status !== "complete") {
				return {
					ok: false,
					reason:
						"cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
				};
			}
		}

		const now = Date.now();
		const goal: Goal = {
			goalId: newGoalId(),
			objective: input.objective,
			status: "active",
			tokenBudget: input.tokenBudget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		currentGoal = goal;
		startedThisSession = true;
		accounting.start({
			statusActive: true,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			lastAccountedUsage: null,
			lastAccountedAtMs: null,
		});
		persist(goal);
		// The flag at the bottom of the slash command handler in codex
		// triggers a "kick the goal forward" continuation prompt; we do
		// the same by injecting the continuation prompt right after the
		// create_goal tool result via sendMessage in tool_call handlers
		// (see below) — so no extra work needed here.
		return { ok: true, goal };
	}

	function updateGoalStatusInternal(input: { status: GoalStatus }): {
		ok: boolean;
		goal?: Goal;
		reason?: string;
	} {
		if (currentGoal === null) {
			return { ok: false, reason: "no goal exists on this thread" };
		}
		const transitionError = canTransition(currentGoal.status, input.status);
		if (transitionError !== null) {
			return { ok: false, reason: transitionError };
		}

		const previousStatus = currentGoal.status;
		currentGoal = {
			...currentGoal,
			status: input.status,
			updatedAt: Date.now(),
		};

		if (input.status === "complete") {
			// Final accounting flush: write the totals to the entry, stop
			// the accounting so the manager no longer ticks.
			if (previousStatus === "active" && accounting.getStatusActive()) {
				// One final commit so tokensUsed reflects the just-finished
				// turn. We don't have a Usage here — that's done by the
				// caller via message_end — but if accounting has any
				// pending delta it would have been committed already.
				pendingStatusTransition = "complete";
			}
			accounting.stop();
		} else if (input.status === "blocked") {
			accounting.setStatusActive(false);
		} else if (input.status === "active") {
			accounting.setStatusActive(true);
		} else if (input.status === "paused") {
			accounting.setStatusActive(false);
		} else if (input.status === "budget_limited") {
			// Model cannot directly drive this; defend in depth.
			return { ok: false, reason: "budget_limited is manager-driven" };
		} else if (input.status === "usage_limited") {
			return { ok: false, reason: "usage_limited is manager-driven" };
		}

		if (currentGoal !== null) {
			persist(currentGoal);
		}
		return { ok: true, goal: currentGoal };
	}

	const manager = {
		getCurrentGoal: () => currentGoal,
		createGoal: createGoalInternal,
		updateGoalStatus: updateGoalStatusInternal,
	};

	// ---- Persistence ----------------------------------------------------

	function persist(goal: Goal): void {
		const snapshot: GoalStateSnapshot = {
			goal,
			lastAccountedUsage: accounting.toSnapshot(goal) ?? null,
			lastAccountedAtMs: accounting.getLastAccountedAtMs(),
			consecutiveExecutionFailures: accounting.getConsecutiveExecutionFailures(),
		};
		pi.appendEntry(GOAL_STATE_ENTRY_TYPE, snapshot);
	}

	function clearGoal(): void {
		currentGoal = null;
		accounting.stop();
		pi.appendEntry(GOAL_REMOVED_ENTRY_TYPE, { removedAt: Date.now() });
	}

	// ---- Manager actions ------------------------------------------------

	/**
	 * Inject a steering custom message. The `triggerTurn` argument names
	 * the caller intent — we suppress it in non-interactive modes where
	 * `_runAgentPrompt` would invalidate the runtime. `tui` and `rpc`
	 * modes keep the agent loop running, so the message becomes the next
	 * turn's input.
	 */
	function injectSteering(customType: string, content: string, triggerTurn: boolean): void {
		const effectiveTrigger = triggerTurn && (lastMode === "tui" || lastMode === "rpc");
		pi.sendMessage(
			{ customType, content, display: true },
			{ triggerTurn: effectiveTrigger, deliverAs: "followUp" },
		);
	}

	function injectContinuationIfNeeded(): void {
		if (currentGoal === null) return;
		if (isAutoContinuing(currentGoal.status)) {
			injectSteering(
				STEERING_MESSAGE_TYPE,
				buildContinuationPrompt(currentGoal),
				/*triggerTurn*/ true,
			);
		} else if (isWrappingUp(currentGoal.status)) {
			injectSteering(
				STEERING_MESSAGE_TYPE,
				buildBudgetLimitPrompt(currentGoal),
				/*triggerTurn*/ true,
			);
		}
	}

	function transitionToBudgetLimited(): void {
		if (currentGoal === null || currentGoal.status !== "active") return;
		const transitionError = canTransition(currentGoal.status, "budget_limited");
		if (transitionError !== null) return;
		currentGoal = { ...currentGoal, status: "budget_limited", updatedAt: Date.now() };
		accounting.setStatusActive(false);
		persist(currentGoal);
		injectSteering(
			STEERING_MESSAGE_TYPE,
			buildBudgetLimitPrompt(currentGoal),
			/*triggerTurn*/ true,
		);
	}

	function transitionToBlockedFromExecutionFailures(): void {
		if (currentGoal === null || currentGoal.status !== "active") return;
		currentGoal = { ...currentGoal, status: "blocked", updatedAt: Date.now() };
		accounting.setStatusActive(false);
		persist(currentGoal);
	}

	// ---- /goal slash command --------------------------------------------

	const SUBCOMMANDS = ["show", "status", "clear", "pause", "resume"];

	pi.registerCommand("goal", {
		description: "/goal <objective> | show | clear | pause | resume",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({
				value: sub,
				label: sub,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			lastMode = ctx.mode;
			const emit = (text: string, _level: "info" | "warning" | "error") => {
				if (ctx.mode === "print") console.log(text);
				else ctx.ui.notify(text, _level);
			};
			const trimmed = args.trim();
			if (trimmed === "" || trimmed === "show" || trimmed === "status") {
				const out = formatGoalForDisplay(currentGoal);
				if (ctx.mode === "print") console.log(out);
				else ctx.ui.notify(out, "info");
				return;
			}
			if (trimmed === "clear") {
				if (currentGoal === null) {
					emit("No goal to clear.", "info");
					return;
				}
				clearGoal();
				emit("Goal cleared.", "info");
				return;
			}
			if (trimmed === "pause") {
				if (currentGoal === null) {
					emit("No goal to pause.", "warning");
					return;
				}
				const result = updateGoalStatusInternal({ status: "paused" });
				if (!result.ok) {
					emit(result.reason ?? "Failed to pause goal.", "error");
					return;
				}
				emit("Goal paused. Use `/goal resume` to re-activate.", "info");
				return;
			}
			if (trimmed === "resume") {
				if (currentGoal === null) {
					emit("No goal to resume.", "warning");
					return;
				}
				const result = updateGoalStatusInternal({ status: "active" });
				if (!result.ok) {
					emit(result.reason ?? "Failed to resume goal.", "error");
					return;
				}
				// Reset the consecutive-execution-failures counter so the
				// fresh blocked-audit cycle begins.
				accounting.recordTurnToolOutcome({ hadSuccessfulTool: true, failedBashExecution: false });
				emit("Goal resumed.", "info");
				injectContinuationIfNeeded();
				return;
			}

			// Treat the rest as a new objective. Validate.
			const objectiveError = validateObjective(trimmed);
			if (objectiveError !== null) {
				emit(objectiveError, "error");
				return;
			}
			if (currentGoal !== null) {
				// If the existing goal is complete, replace it. Otherwise
				// reject — the user must explicitly clear or finish the
				// current goal first, mirroring codex's failure mode.
				if (currentGoal.status !== "complete") {
					emit(
						"Cannot set a new goal when an unfinished goal exists. Use `/goal clear` first.",
						"warning",
					);
					return;
				}
			}
			const result = createGoalInternal({ objective: trimmed, tokenBudget: null });
			if (!result.ok || !result.goal) {
				emit(result.reason ?? "Failed to set goal.", "error");
				return;
			}
			emit(`Goal set: ${trimmed}`, "info");
			// Inject the continuation prompt so the manager starts working
			// toward the objective immediately (matching codex's
			// `start_turn_if_idle` after goal creation).
			injectSteering(
				STEERING_MESSAGE_TYPE,
				buildContinuationPrompt(result.goal),
				/*triggerTurn*/ true,
			);
		},
	});

	// ---- Custom tools for the LLM ---------------------------------------

	pi.registerTool({
		name: "goal_get",
		label: "goal_get",
		description: GOAL_GET_DESCRIPTION,
		parameters: GoalGetParams,
		async execute() {
			const result = executeGoalGet(manager);
			return {
				content: [{ type: "text", text: result.goal === null ? "No goal." : JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "goal_set",
		label: "goal_set",
		description: GOAL_SET_DESCRIPTION,
		parameters: GoalSetParams,
		async execute(_toolCallId, params) {
			const typed = params as Static<typeof GoalSetParams>;
			const result = executeGoalSet(manager, {
				objective: typed.objective,
				tokenBudget: typed.tokenBudget ?? null,
			});
			if (!result.ok || !result.result) {
				return {
					content: [{ type: "text", text: `error: ${result.error ?? "unknown"}` }],
					isError: true,
				};
			}
			const goal = result.result.goal;
			// After creation, inject the continuation prompt so the model
			// gets the bookkeeping on the next turn. This mirrors codex's
			// `inject_active_turn_steering` path on goal create.
			injectSteering(
				STEERING_MESSAGE_TYPE,
				buildContinuationPrompt(goal),
				/*triggerTurn*/ true,
			);
			return {
				content: [{ type: "text", text: JSON.stringify({ goal }) }],
				details: result.result,
			};
		},
	});

	pi.registerTool({
		name: "goal_update",
		label: "goal_update",
		description: GOAL_UPDATE_DESCRIPTION,
		parameters: GoalUpdateParams,
		async execute(_toolCallId, params) {
			const typed = params as Static<typeof GoalUpdateParams>;
			const result = executeGoalUpdate(manager, { status: typed.status });
			if (!result.ok || !result.result) {
				return {
					content: [{ type: "text", text: `error: ${result.error ?? "unknown"}` }],
					isError: true,
				};
			}
			const goal = result.result.goal;
			// Mirror the budget-aware completion text the model would get
			// from goal_get's completionBudgetReport, so the same budgeted
			// goal marked complete via either tool yields a consistent
			// reply.
			let text: string;
			if (result.result.status === "complete") {
				const parts: string[] = ["Goal achieved."];
				if (goal.tokenBudget !== null) {
					parts.push(`Tokens used: ${goal.tokensUsed} / ${goal.tokenBudget}.`);
				}
				if (goal.timeUsedSeconds > 0) {
					const min = Math.floor(goal.timeUsedSeconds / 60);
					const sec = goal.timeUsedSeconds - min * 60;
					parts.push(`Time spent: ${min}m ${sec}s.`);
				}
				text = parts.join(" ");
			} else {
				text = `Goal status: ${result.result.status}.`;
			}
			return {
				content: [{ type: "text", text }],
				details: result.result,
			};
		},
	});

	// ---- Tool-result accounting (execution-failure detection) ------------
	// Tracks whether the just-ended turn had any successful tool, and
	// whether the bash tool was called and failed. Mirrors codex's
	// record_tool_outcome. After each settled turn we ask the accounting
	// state whether the goal should transition to blocked (3x failures).

	const turnOutcome: TurnToolOutcome = {
		hadSuccessfulTool: false,
		failedBashExecution: false,
	};

	pi.on("tool_result", async (event) => {
		if (currentGoal === null) return;
		if (event.isError) {
			if (event.toolName === "bash") {
				turnOutcome.failedBashExecution = true;
			}
		} else {
			turnOutcome.hadSuccessfulTool = true;
		}
	});

	// ---- Message accounting (token + time deltas) -------------------------

	pi.on("message_end", async (event, ctx) => {
		lastMode = ctx.mode;
		const message = event.message;
		if (message.role !== "assistant") return;
		if (currentGoal === null) return;

		const usage = formatUsageForDelta(message.usage);
		const nowMs = message.timestamp;

		await accounting.lock(() => {
			// Seed baseline on the first post-start assistant turn.
			if (accounting.toSnapshot(currentGoal!) === null) {
				accounting.seedBaseline(usage, nowMs);
			}
			const snap = accounting.snapshot(usage, nowMs);
			if (snap === null) return;
			accounting.commit(snap, usage, nowMs);

			// Update goal tokensUsed inline; do NOT mutate status here —
			// budget-exhaustion is decided by comparing against the budget
			// after commit so the threshold check sees the new total.
			if (currentGoal !== null) {
				currentGoal = {
					...currentGoal,
					tokensUsed: currentGoal.tokensUsed + snap.tokenDelta,
					timeUsedSeconds: currentGoal.timeUsedSeconds + snap.timeDeltaSeconds,
					updatedAt: nowMs,
				};
				// Budget check.
				if (
					currentGoal.tokenBudget !== null &&
					currentGoal.tokensUsed >= currentGoal.tokenBudget &&
					currentGoal.status === "active"
				) {
					persist(currentGoal);
					transitionToBudgetLimited();
				} else {
					persist(currentGoal);
				}
			}
		});

		// Track no-progress: if the assistant reply contains no tool calls
		// and no body text (only thinking), the turn was empty.
		const reply = getTextContent(message);
		const hadToolCalls = message.content.some((c) => c.type === "toolCall");
		if (!hadToolCalls && reply.trim().length === 0) {
			noProgressTurns++;
		} else {
			noProgressTurns = 0;
		}

		lastStopReason = message.stopReason;
	});

	// ---- Context pruning --------------------------------------------------
	// Keep the most recent KEEP_STEERING_MESSAGES goal steering messages
	// in the LLM context; drop older ones. Without this, a long goal
	// accumulates stale continuation text in every turn.

	pi.on("context", async (event) => {
		const messages = event.messages;
		const allIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			const type = customTypeOf(messages[i]!);
			if (type === STEERING_MESSAGE_TYPE) {
				allIndices.push(i);
			}
		}
		if (allIndices.length <= KEEP_STEERING_MESSAGES) return;
		const dropFrom = allIndices.length - KEEP_STEERING_MESSAGES;
		const dropSet = new Set(allIndices.slice(0, dropFrom));
		const filtered = messages.filter((_, idx) => !dropSet.has(idx));
		if (filtered.length !== messages.length) {
			return { messages: filtered };
		}
	});

	// ---- Manager tick (settle-driven) ------------------------------------
	// agent_settled is the honest "the run truly stopped" signal — retries,
	// compaction retries, and queued follow-ups have all drained. This is
	// where we decide whether to re-inject the continuation prompt.

	pi.on("agent_settled", async (_event, ctx) => {
		lastMode = ctx.mode;
		if (currentGoal === null) return;

		// `lastStopReason` is set by the message_end handler above from
		// the assistant message that produced the just-settled turn. If
		// agent_settled fires before any assistant message has been
		// observed (e.g., a tool-only cycle that never reached the LLM),
		// lastStopReason is undefined and the abort/error branches below
		// no-op — they only act on a real assistant stop reason. The goal
		// is also `null` in that case, so this handler short-circuits
		// above; the two guards combine safely.

		// User abort — pause, never fight the user.
		if (lastStopReason === "aborted") {
			if (currentGoal.status === "active") {
				updateGoalStatusInternal({ status: "paused" });
				ctx.ui.notify(
					"Goal paused (run interrupted). Use `/goal resume` to re-activate.",
					"warning",
				);
			}
			return;
		}

		// Provider error — pause; retries already happened.
		if (lastStopReason === "error") {
			if (currentGoal.status === "active") {
				updateGoalStatusInternal({ status: "paused" });
				ctx.ui.notify(
					"Goal paused (model error). Use `/goal resume` to retry.",
					"warning",
				);
			}
			return;
		}

		// Record turn outcome and check the 3x execution-failure trigger.
		accounting.recordTurnToolOutcome(turnOutcome);
		// Reset for the next turn.
		turnOutcome.hadSuccessfulTool = false;
		turnOutcome.failedBashExecution = false;
		if (accounting.shouldBlockFromExecutionFailures()) {
			transitionToBlockedFromExecutionFailures();
			ctx.ui.notify(
				"Goal marked blocked (3 consecutive turns with failed execution and no successful tool). Use `/goal resume` to retry with a fresh audit.",
				"warning",
			);
			return;
		}

		// No-progress watchdog — distinct from execution-failure block. If
		// the model has been replying with empty turns for MAX_NO_PROGRESS_TURNS
		// consecutive settlements, pause so the user can intervene.
		if (noProgressTurns >= MAX_NO_PROGRESS_TURNS && currentGoal.status === "active") {
			updateGoalStatusInternal({ status: "paused" });
			ctx.ui.notify(
				`Goal paused (${MAX_NO_PROGRESS_TURNS} consecutive empty turns). Use \`/goal resume\` to continue.`,
				"warning",
			);
			return;
		}

		// Handle a deferred complete transition (set by goal_update during
		// a turn). The next settled run is the right place to finalize.
		if (pendingStatusTransition === "complete") {
			pendingStatusTransition = null;
			// Already terminal; no need to inject more.
			return;
		}

		injectContinuationIfNeeded();
	});

	// ---- Session lifecycle: restore state and apply --goal flag -----------

	pi.on("session_start", async (_event, ctx) => {
		lastMode = ctx.mode;
		const flagValue = pi.getFlag("goal");
		if (typeof flagValue === "string" && flagValue.trim().length > 0 && !startedThisSession) {
			// --goal "<objective>" at startup
			const trimmed = flagValue.trim();
			const objectiveError = validateObjective(trimmed);
			if (objectiveError === null) {
				createGoalInternal({ objective: trimmed, tokenBudget: null });
				injectSteering(
					STEERING_MESSAGE_TYPE,
					buildContinuationPrompt(currentGoal!),
					/*triggerTurn*/ false,
				);
			}
		}

		const restored = loadGoalState(ctx);
		if (restored.state !== null && currentGoal === null) {
			const goal = restored.state.goal;
			const { latestAssistantUsage, latestAssistantAtMs } = loadResumeAnchor(ctx);
			currentGoal = goal;
			accounting.start({
				statusActive: goal.status === "active",
				tokensUsed: goal.tokensUsed,
				timeUsedSeconds: goal.timeUsedSeconds,
				lastAccountedUsage: latestAssistantUsage ?? restored.state.lastAccountedUsage,
				lastAccountedAtMs: latestAssistantAtMs ?? restored.state.lastAccountedAtMs,
			});
			accounting.recordTurnToolOutcome({
				hadSuccessfulTool: true,
				failedBashExecution: false,
			}); // reset consecutive-execution-failures counter on resume
			startedThisSession = true;
		}
	});
}