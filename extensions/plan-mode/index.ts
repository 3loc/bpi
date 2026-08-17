/**
 * Plan mode extension for the pi coding agent — manager-driven edition.
 *
 * Adapted from the supervision patterns of pi-herdr-agents: the extension,
 * not the model, owns the workflow. The model executes ONE step per
 * directive; the manager treats every settled agent run as a checkpoint
 * and decides what happens next:
 *
 *   idle      — normal operation, full tool access
 *   planning  — read-only exploration (edit/write disabled, bash allowlisted)
 *   executing — manager drives step-by-step execution with auto-advance
 *   paused    — execution halted (user interrupt, [BLOCKED:n], model error,
 *               or repeated runs without progress); /plan run resumes
 *
 * Why a manager: a model left to execute a whole checklist in one run
 * reliably stalls after the first step. Here a stalled run is recovered —
 * when the agent settles with steps remaining and nothing abnormal
 * happened, the manager itself sends the next step directive. Guardrails
 * borrowed from pi-herdr-agents:
 *
 *   - directives are self-contained (the wake-up carries the work, not a
 *     pointer to a file)
 *   - explicit terminal states with a claim-once gate (exactly one
 *     completion delivery, no double-firing)
 *   - pause on user abort — the manager never fights the user
 *   - no time-based watchdog: progress is accounted per settled run, so
 *     long legitimate tool runs are never marked "stalled"
 *   - bounded patience: N consecutive runs without a [DONE:n] marker
 *     pause the plan instead of burning tokens forever
 *
 * Commands:
 *   /plan               toggle plan mode on/off (back to planning)
 *   /plan run           start / resume managed execution
 *   /plan pause         halt auto-advance (resumable with /plan run)
 *   /plan show          print the current plan and progress
 *   /plan save [file]   write the plan to markdown (default PLAN.md)
 *   /plan reset         discard the plan and return to normal mode
 *   /todos              show plan progress
 *
 * Also: Ctrl+Alt+P toggles plan mode, and `pi --plan` starts in plan mode.
 * During planning, a drafted "Plan:" section offers Execute / Stay / Refine.
 * Progress shows in the footer status and a checklist widget. State is
 * persisted to the session and rebuilt on /resume (restored runs come back
 * paused — the manager never auto-starts a turn at session start).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	buildStepDirective,
	extractBlockedSteps,
	extractPlanSteps,
	isReadOnlyCommand,
	markCompletedSteps,
	renderPlanMarkdown,
	type TodoItem,
} from "./utils.ts";

// Tools active (or added) per phase. Built-in names only; tools from other
// extensions are always preserved.
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "bash", "edit", "write"];
const MUTATING_TOOLS = new Set(["edit", "write"]);
const MANAGED_TOOLS = new Set([...READONLY_TOOLS, ...FULL_TOOLS]);

const DEFAULT_PLAN_FILE = "PLAN.md";

/** Consecutive settled runs without a [DONE:n] marker before pausing. */
const MAX_NO_PROGRESS = 3;
/** Step directives kept in LLM context (older ones are pruned). */
const KEEP_STEP_DIRECTIVES = 3;

// Custom message types (also used to prune stale context, see "context" handler)
const PLANNING_CONTEXT_TYPE = "plan-mode-planning";
const EXECUTING_CONTEXT_TYPE = "plan-mode-executing";
const STEP_MESSAGE_TYPE = "plan-manager-step";
const COMPLETE_MESSAGE_TYPE = "plan-mode-complete";
const STATE_ENTRY_TYPE = "plan-mode-state";
// Legacy kickoff type from the pre-manager implementation; still recognized
// when rebuilding progress from old sessions.
const LEGACY_KICKOFF_TYPE = "plan-mode-kickoff";

const PLANNING_BRIEF = `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode.

Restrictions:
- The edit and write tools are disabled
- Bash is restricted to an allowlist of read-only commands
- Do NOT attempt to make changes; investigate and analyze only

Explore the codebase with the read-only tools, then present a numbered
implementation plan under a "Plan:" header, for example:

Plan:
1. Add input validation to the login form
2. Extract shared validation helpers into src/validation.ts
3. Add unit tests covering the new helpers

Rules for the plan:
- One concrete, verifiable action per step
- Keep each step to a single sentence
- If requirements are unclear, ask clarifying questions in chat first`;

const EXECUTING_BRIEF = `[PLAN EXECUTION ACTIVE]
You are executing an approved plan, managed step-by-step by the plan
manager. Full tool access is enabled.

- Work ONLY on the step named in the most recent [plan-manager] message.
- When that step is verifiably complete, end your reply with [DONE:n] on
  its own line, then stop. The manager sends the next step automatically.
- If the step is wrong or impossible, end with [BLOCKED:n] <reason>.
- Do not edit ${DEFAULT_PLAN_FILE} — the manager owns that file.`;

type Phase = "idle" | "planning" | "executing" | "paused";

interface PlanModeState {
	phase: Phase;
	todos: TodoItem[];
	toolsBeforePlanMode?: string[];
}

/** Runtime bookkeeping for one managed execution (not persisted). */
interface RunControl {
	lastCompleted: number;
	noProgress: number;
	terminal: boolean;
	blocked?: { step: number; reason: string };
}

function freshRun(completed: number): RunControl {
	return { lastCompleted: completed, noProgress: 0, terminal: false };
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function customTypeOf(message: AgentMessage): string | undefined {
	return (message as AgentMessage & { customType?: string }).customType;
}

function uniqueNames(names: string[]): string[] {
	return [...new Set(names)];
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let phase: Phase = "idle";
	let todos: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	let run = freshRun(0);
	let lastStopReason: AssistantMessage["stopReason"] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ---- Tool management -------------------------------------------------

	function enablePlanTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		const restricted = uniqueNames([
			...toolsBeforePlanMode.filter((name) => !MUTATING_TOOLS.has(name)),
			...READONLY_TOOLS,
		]);
		pi.setActiveTools(restricted);
	}

	function restoreFullTools(): void {
		if (toolsBeforePlanMode !== undefined) {
			pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
			return;
		}
		// No snapshot (e.g. resumed session): rebuild a sane full-access set.
		pi.setActiveTools(
			uniqueNames([
				...FULL_TOOLS,
				...pi.getActiveTools().filter((name) => !MANAGED_TOOLS.has(name)),
			]),
		);
	}

	// ---- UI + persistence --------------------------------------------------

	function persist(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, {
			phase,
			todos,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if ((phase === "executing" || phase === "paused") && todos.length > 0) {
			const completed = todos.filter((item) => item.completed).length;
			const next = todos.find((item) => !item.completed)?.step;
			const color = phase === "executing" ? "accent" : "warning";
			const glyph = phase === "executing" ? "▶" : "⏸";
			const suffix = phase === "paused" ? " paused" : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(color, `${glyph} plan ${completed}/${todos.length}${suffix}`));
			ctx.ui.setWidget(
				"plan-mode",
				todos.map((item) => {
					if (item.completed) {
						return (
							ctx.ui.theme.fg("success", "☑ ") +
							ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
						);
					}
					const marker = phase === "executing" && item.step === next ? "▶ " : "☐ ";
					return ctx.ui.theme.fg("muted", marker) + item.text;
				}),
			);
			return;
		}
		if (phase === "planning") {
			const draft = todos.length > 0 ? ` (draft: ${todos.length} steps)` : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `⏸ plan${draft}`));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		ctx.ui.setWidget("plan-mode", undefined);
	}

	// ---- Manager actions ----------------------------------------------------

	/**
	 * Send the directive for the next incomplete step. Self-contained by
	 * design: the message carries the step, the remaining plan, and the
	 * completion contract, so the model never has to go looking for work.
	 */
	function sendStepDirective(ctx: ExtensionContext): void {
		const note =
			run.noProgress > 0
				? "previous run(s) ended without a [DONE:n] marker — emit the marker as soon as the step is verifiably done"
				: undefined;
		const directive = buildStepDirective(todos, { note });
		if (directive === null) return;
		pi.sendMessage(
			{ customType: STEP_MESSAGE_TYPE, content: directive, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function pauseExecution(ctx: ExtensionContext, reason: string): void {
		if (phase !== "executing") return;
		phase = "paused";
		updateStatus(ctx);
		persist();
		ctx.ui.notify(`Plan paused: ${reason}`, "warning");
	}

	async function writePlanFile(ctx: ExtensionContext): Promise<void> {
		try {
			await writeFile(join(ctx.cwd, DEFAULT_PLAN_FILE), renderPlanMarkdown(todos), "utf8");
		} catch {
			// Non-fatal: execution can proceed without the file.
			ctx.ui.notify(`Note: could not write ${DEFAULT_PLAN_FILE}`, "warning");
		}
	}

	async function beginExecution(ctx: ExtensionContext): Promise<void> {
		if (todos.length === 0) {
			ctx.ui.notify("No plan to execute. Draft one in plan mode first (/plan).", "warning");
			return;
		}
		if (todos.every((item) => item.completed)) {
			ctx.ui.notify("All steps are already complete. Use /plan reset to clear.", "info");
			return;
		}
		if (phase === "executing") {
			showPlan(ctx);
			return;
		}

		const resuming = phase === "paused";
		phase = "executing";
		run = freshRun(todos.filter((item) => item.completed).length);
		lastStopReason = undefined;
		restoreFullTools();
		updateStatus(ctx);
		persist();
		await writePlanFile(ctx);
		ctx.ui.notify(
			resuming
				? `Resuming plan — manager auto-advances ${todos.filter((item) => !item.completed).length} remaining step(s). /plan pause halts.`
				: `Executing plan — manager sends one step at a time and auto-advances. /plan pause halts.`,
			"info",
		);
		sendStepDirective(ctx);
	}

	function finishPlan(ctx: ExtensionContext): void {
		run.terminal = true; // claim-once: exactly one completion delivery
		const summary = todos.map((item) => `- [x] ${item.step}. ${item.text}`).join("\n");
		pi.sendMessage(
			{
				customType: COMPLETE_MESSAGE_TYPE,
				content: `**Plan complete — all ${todos.length} steps done.**\n\n${summary}`,
				display: true,
			},
			{ triggerTurn: false },
		);
		phase = "idle";
		todos = [];
		run = freshRun(0);
		updateStatus(ctx);
		persist();
	}

	// ---- Phase transitions ----------------------------------------------------

	function togglePlanMode(ctx: ExtensionContext): void {
		if (phase === "planning") {
			phase = "idle";
			restoreFullTools();
			ctx.ui.notify("Plan mode off — full tool access restored.", "info");
		} else {
			// From idle, or from executing/paused (abandon execution, keep the draft).
			phase = "planning";
			run = freshRun(0);
			enablePlanTools();
			ctx.ui.notify(
				"Plan mode on — read-only exploration. edit/write disabled, bash limited to read-only commands.",
				"info",
			);
		}
		updateStatus(ctx);
		persist();
	}

	function resetPlan(ctx: ExtensionContext): void {
		phase = "idle";
		todos = [];
		run = freshRun(0);
		restoreFullTools();
		updateStatus(ctx);
		persist();
		ctx.ui.notify("Plan cleared.", "info");
	}

	function showPlan(ctx: ExtensionContext): void {
		if (todos.length === 0) {
			ctx.ui.notify("No plan yet. Enter plan mode with /plan and draft one.", "info");
			return;
		}
		const completed = todos.filter((item) => item.completed).length;
		const list = todos
			.map((item) => `${item.step}. ${item.completed ? "☑" : "☐"} ${item.text}`)
			.join("\n");
		ctx.ui.notify(`Plan (${completed}/${todos.length} done, ${phase}):\n${list}`, "info");
	}

	async function savePlan(ctx: ExtensionContext, target?: string): Promise<void> {
		if (todos.length === 0) {
			ctx.ui.notify("No plan to save. Draft one in plan mode first.", "warning");
			return;
		}
		const file = resolve(ctx.cwd, target ?? DEFAULT_PLAN_FILE);
		try {
			await writeFile(file, renderPlanMarkdown(todos), "utf8");
			ctx.ui.notify(`Plan saved to ${file}`, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to save plan: ${String(error)}`, "error");
		}
	}

	// ---- Commands, shortcut, flag -------------------------------------------

	const SUBCOMMANDS = ["run", "pause", "show", "save", "reset"];

	pi.registerCommand("plan", {
		description: "Plan mode: /plan [run|pause|show|save <file>|reset]",
		getArgumentCompletions: (prefix: string) => {
			const items = SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map((sub) => ({
				value: sub,
				label: sub,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			switch (sub) {
				case "":
					togglePlanMode(ctx);
					break;
				case "run":
					await beginExecution(ctx);
					break;
				case "pause":
					if (phase === "executing") {
						pauseExecution(ctx, "paused by user — /plan run resumes");
					} else {
						ctx.ui.notify("No execution running.", "info");
					}
					break;
				case "show":
					showPlan(ctx);
					break;
				case "save":
					await savePlan(ctx, rest.join(" ") || undefined);
					break;
				case "reset":
					resetPlan(ctx);
					break;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Usage: /plan [run|pause|show|save <file>|reset]`,
						"warning",
					);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => showPlan(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// ---- Guards --------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (phase !== "planning") return;

		if (MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Plan mode: edit/write are disabled. Leave plan mode with /plan to make changes.",
			};
		}

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!isReadOnlyCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: bash is limited to read-only commands.\nBlocked command: ${command}\nLeave plan mode with /plan before making changes.`,
				};
			}
		}
	});

	// ---- Context management ----------------------------------------------------

	// Keep exactly one fresh phase briefing in the LLM context, drop the
	// other phase's stale briefings, and keep only the most recent step
	// directives (they are compact history; the latest names the work).
	pi.on("context", async (event) => {
		const messages = event.messages;
		const lastPlanning = messages.findLastIndex((m) => customTypeOf(m) === PLANNING_CONTEXT_TYPE);
		const lastExecuting = messages.findLastIndex((m) => customTypeOf(m) === EXECUTING_CONTEXT_TYPE);
		const lastStep = messages.findLastIndex((m) => customTypeOf(m) === STEP_MESSAGE_TYPE);
		const managing = phase === "executing" || phase === "paused";
		const filtered = messages.filter((message, index) => {
			const type = customTypeOf(message);
			if (type === PLANNING_CONTEXT_TYPE) return phase === "planning" && index === lastPlanning;
			if (type === EXECUTING_CONTEXT_TYPE) return phase === "executing" && index === lastExecuting;
			if (type === STEP_MESSAGE_TYPE) return managing && lastStep - index < KEEP_STEP_DIRECTIVES;
			return true;
		});
		if (filtered.length !== messages.length) {
			return { messages: filtered };
		}
	});

	pi.on("before_agent_start", async () => {
		if (phase === "planning") {
			return {
				message: { customType: PLANNING_CONTEXT_TYPE, content: PLANNING_BRIEF, display: false },
			};
		}
		if (phase === "executing") {
			return {
				message: { customType: EXECUTING_CONTEXT_TYPE, content: EXECUTING_BRIEF, display: false },
			};
		}
	});

	// ---- Progress tracking ------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		if (isAssistantMessage(event.message)) {
			lastStopReason = event.message.stopReason;
		}
		if (phase !== "executing" || !isAssistantMessage(event.message)) return;
		const text = getTextContent(event.message);
		let changed = markCompletedSteps(text, todos) > 0;
		const blocked = extractBlockedSteps(text)[0];
		if (blocked && run.blocked === undefined) {
			run.blocked = blocked;
			changed = true;
		}
		if (changed) {
			await writePlanFile(ctx);
			updateStatus(ctx);
			persist();
		}
	});

	// ---- The manager tick ---------------------------------------------------

	// agent_settled fires once per user-visible run, after automatic retries,
	// compaction retries, and queued follow-ups have drained. That is the
	// honest "the run truly stopped" checkpoint — exactly where a stalled
	// execution must be recovered instead of abandoned.
	pi.on("agent_settled", async (_event, ctx) => {
		if (phase !== "executing" || todos.length === 0 || run.terminal) return;

		// Something the model (or user) reported that needs a human:
		if (run.blocked) {
			const { step, reason } = run.blocked;
			pauseExecution(
				ctx,
				`step ${step} reported blocked (${reason || "no reason given"}) — refine with /plan or retry with /plan run`,
			);
			return;
		}
		// Never fight the user: an explicit interrupt pauses the plan.
		if (lastStopReason === "aborted") {
			pauseExecution(ctx, "run interrupted — /plan run resumes from the next incomplete step");
			return;
		}
		// Provider errors are explicit evidence; retries already happened.
		if (lastStopReason === "error") {
			pauseExecution(ctx, "model error ended the run — /plan run retries the current step");
			return;
		}

		const completed = todos.filter((item) => item.completed).length;
		if (completed === todos.length) {
			await writePlanFile(ctx);
			finishPlan(ctx);
			return;
		}

		// Progress accounting: no time-based watchdog, only per-run deltas,
		// so long legitimate tool runs are never falsely "stalled".
		if (completed === run.lastCompleted) {
			run.noProgress++;
		} else {
			run.noProgress = 0;
			run.lastCompleted = completed;
		}
		if (run.noProgress >= MAX_NO_PROGRESS) {
			pauseExecution(
				ctx,
				`${MAX_NO_PROGRESS} runs in a row ended without a [DONE:n] marker — inspect the transcript, then /plan run to continue or /plan reset to discard`,
			);
			return;
		}

		// Steps remain and the run ended normally — this is the recovery
		// path for "the model just stopped": advance to the next step.
		persist();
		updateStatus(ctx);
		sendStepDirective(ctx);
	});

	// ---- Draft capture during planning -------------------------------------------

	pi.on("agent_end", async (event, ctx) => {
		if (phase !== "planning") return;

		// Extract a freshly drafted plan from the last assistant message.
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractPlanSteps(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todos = extracted;
			}
		}
		if (todos.length === 0) return;
		persist();
		updateStatus(ctx);

		if (!ctx.hasUI) return;
		const EXECUTE = "Execute the plan (manager advances steps automatically)";
		const STAY = "Stay in plan mode";
		const REFINE = "Refine the plan";
		const choice = await ctx.ui.select("Plan drafted — what next?", [EXECUTE, STAY, REFINE]);

		if (choice === EXECUTE) {
			await beginExecution(ctx);
		} else if (choice === REFINE) {
			const refinement = await ctx.ui.editor("Describe changes to the plan:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// ---- Restore on start / resume ------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
			.pop() as { data?: PlanModeState } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? phase;
			todos = stateEntry.data.todos ?? [];
			toolsBeforePlanMode = stateEntry.data.toolsBeforePlanMode;
		}

		// On resume mid-execution, rebuild completion state by re-scanning
		// assistant messages after the latest step directive (or legacy
		// kickoff marker), then come back paused: the manager never
		// auto-starts a turn at session start.
		if (stateEntry !== undefined && (phase === "executing" || phase === "paused") && todos.length > 0) {
			let kickoffIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const type = (entries[i] as { customType?: string }).customType;
				if (type === STEP_MESSAGE_TYPE || type === LEGACY_KICKOFF_TYPE) {
					kickoffIndex = i;
					break;
				}
			}
			const messages: AssistantMessage[] = [];
			for (let i = kickoffIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry) {
					const message = (entry as { message: AgentMessage }).message;
					if (isAssistantMessage(message)) messages.push(message);
				}
			}
			markCompletedSteps(messages.map(getTextContent).join("\n"), todos);
			if (phase === "executing") {
				phase = "paused";
				ctx.ui.notify("Restored mid-execution — /plan run resumes, /plan show for progress.", "info");
			}
			persist();
		}

		if (phase === "planning") {
			enablePlanTools();
		} else {
			toolsBeforePlanMode = undefined;
		}
		updateStatus(ctx);
	});
}
