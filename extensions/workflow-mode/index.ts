/**
 * Workflow mode extension for the pi coding agent — settle-driven edition.
 *
 * Adapted from the supervision patterns of pi-herdr-agents: the extension,
 * not the model, owns the workflow. The model executes ONE step per
 * directive; the manager treats every settled agent run as a checkpoint
 * and decides what happens next.
 *
 *   idle      — normal operation, full tool access
 *   drafting  — read-only exploration (edit/write disabled, bash allowlisted)
 *   executing — manager drives step-by-step execution
 *   paused    — execution halted (user interrupt, BLOCKED verdict, repeated
 *               CONTINUE verdicts, or model error); /workflow run resumes
 *
 * Why settle-driven (and not marker-driven):
 *
 *   The previous design relied on the model emitting `[DONE:n]` at the
 *   end of every step's execution turn. That marker got lost in the noise
 *   of a busy turn — models forget, paraphrase, or bury it. The new
 *   design trusts the agent_settled checkpoint (the honest "the run
 *   truly stopped" signal — retries, compaction retries, and queued
 *   follow-ups included) as the unit of completion. After the execution
 *   turn settles, the manager sends a separate, single-purpose REVIEW
 *   TURN whose entire job is to audit the previous turn and reply with
 *   exactly one of three lines:
 *
 *     [VERIFY:DONE]            — step is verifiably complete
 *     [VERIFY:CONTINUE: <gap>] — significant work is missing
 *     [VERIFY:BLOCKED: <why>]  — step is wrong or impossible
 *
 *   Models reliably follow strict single-line instructions in a
 *   dedicated turn; that is the trick. A marker inside a busy turn is
 *   fragile; a marker inside a single-purpose turn is robust.
 *
 * Other guardrails borrowed from pi-herdr-agents' supervision design:
 *
 *   - step directives are self-contained (the wake-up carries the work,
 *     not a pointer to a file)
 *   - explicit terminal state with a claim-once gate (exactly one
 *     completion delivery)
 *   - pause on user abort — the manager never fights the user
 *   - no time-based watchdog: progress is accounted per settled run, so
 *     long legitimate tool runs are never marked "stalled"
 *   - bounded patience: 2 CONTINUE verdicts in a row for the same step
 *     pause the workflow instead of burning tokens forever
 *
 * Commands:
 *   /workflow              toggle workflow mode on/off (back to drafting)
 *   /workflow run          start / resume managed execution
 *   /workflow pause        halt auto-advance (resumable with /workflow run)
 *   /workflow show         print the current workflow and progress
 *   /workflow save [file]  write the workflow to markdown (default PLAN.md)
 *   /workflow reset        discard the workflow and return to normal mode
 *   /todos                 show workflow progress
 *
 * Also: Ctrl+Alt+W toggles workflow mode, and `pi --workflow` starts in
 * workflow mode. During drafting, a drafted "Plan:" section offers
 * Execute / Stay / Refine. Progress shows in the footer status and a
 * checklist widget. State is persisted to the session and rebuilt on
 * /resume (restored runs come back paused — the manager never
 * auto-starts a turn at session start).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	buildReviewPrompt,
	buildStepDirective,
	extractPlanSteps,
	isReadOnlyCommand,
	parseReviewVerdict,
	renderPlanMarkdown,
	type ReviewVerdict,
	type TodoItem,
} from "./utils.ts";

// Tools active (or added) per phase. Built-in names only; tools from other
// extensions are always preserved.
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const FULL_TOOLS = ["read", "bash", "edit", "write"];
const MUTATING_TOOLS = new Set(["edit", "write"]);
const MANAGED_TOOLS = new Set([...READONLY_TOOLS, ...FULL_TOOLS]);

const DEFAULT_PLAN_FILE = "PLAN.md";

/** CONTINUE verdicts in a row for the same step before pausing. */
const MAX_REVIEW_ROUNDS = 2;
/** Step directives kept in LLM context (older ones are pruned). */
const KEEP_STEP_DIRECTIVES = 3;

// Custom message types (also used to prune stale context, see "context" handler)
const DRAFTING_CONTEXT_TYPE = "workflow-mode-drafting";
const EXECUTING_CONTEXT_TYPE = "workflow-mode-executing";
const STEP_MESSAGE_TYPE = "workflow-manager-step";
const REVIEW_MESSAGE_TYPE = "workflow-manager-review";
const COMPLETE_MESSAGE_TYPE = "workflow-mode-complete";
const STATE_ENTRY_TYPE = "workflow-mode-state";
// Legacy phase value from the marker-driven plan-mode implementation;
// translated to "drafting" via migratePhase() on resume. New code never
// emits it.

const DRAFTING_BRIEF = `[WORKFLOW MODE — DRAFTING]
You are in workflow mode (drafting phase) — a read-only exploration mode.

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

const EXECUTING_BRIEF = `[WORKFLOW MODE — EXECUTING]
You are executing an approved workflow, managed step-by-step by the
workflow manager. Full tool access is enabled.

- Work ONLY on the step named in the most recent [workflow-manager]
  message.
- Do NOT emit a [DONE:n] marker — the manager treats your settled run
  as the unit of completion and sends a separate, brief review turn
  to audit what you did.
- Do not edit ${DEFAULT_PLAN_FILE} — the manager owns that file.`;

type Phase = "idle" | "drafting" | "executing" | "paused";

interface WorkflowState {
	phase: Phase;
	todos: TodoItem[];
	toolsBeforeWorkflowMode?: string[];
}

/** Runtime bookkeeping for one managed execution (not persisted). */
interface RunControl {
	lastCompleted: number;
	reviewRounds: number;
	terminal: boolean;
	blocked?: { step: number; reason: string };
	pending: PendingAction;
}

type PendingAction =
	| "step"
	| "review"
	| "none";

function freshRun(completed: number): RunControl {
	return { lastCompleted: completed, reviewRounds: 0, terminal: false, pending: "none" };
}

/** Translate a legacy persisted phase to the current enum. */
function migratePhase(persisted: string | undefined): Phase {
	if (persisted === "drafting" || persisted === "executing" || persisted === "paused" || persisted === "idle") {
		return persisted;
	}
	// Legacy: the marker-driven plan-mode saved "planning" as the phase name.
	if (persisted === "planning") return "drafting";
	return "idle";
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

function verdictToString(verdict: ReviewVerdict): string {
	switch (verdict.kind) {
		case "done":
			return "[VERIFY:DONE]";
		case "continue":
			return `[VERIFY:CONTINUE: ${verdict.gap || "incomplete"}]`;
		case "blocked":
			return `[VERIFY:BLOCKED: ${verdict.reason || "no reason given"}]`;
		case "malformed":
			return "(malformed review reply)";
	}
}

export default function workflowModeExtension(pi: ExtensionAPI): void {
	let phase: Phase = "idle";
	let todos: TodoItem[] = [];
	let toolsBeforeWorkflowMode: string[] | undefined;
	let run = freshRun(0);
	let lastStopReason: AssistantMessage["stopReason"] | undefined;

	pi.registerFlag("workflow", {
		description: "Start in workflow mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// ---- Tool management -------------------------------------------------

	function enableDraftingTools(): void {
		if (toolsBeforeWorkflowMode === undefined) {
			toolsBeforeWorkflowMode = pi.getActiveTools();
		}
		const restricted = uniqueNames([
			...toolsBeforeWorkflowMode.filter((name) => !MUTATING_TOOLS.has(name)),
			...READONLY_TOOLS,
		]);
		pi.setActiveTools(restricted);
	}

	function restoreFullTools(): void {
		if (toolsBeforeWorkflowMode !== undefined) {
			pi.setActiveTools(toolsBeforeWorkflowMode);
			toolsBeforeWorkflowMode = undefined;
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
			toolsBeforeWorkflowMode,
		} satisfies WorkflowState);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if ((phase === "executing" || phase === "paused") && todos.length > 0) {
			const completed = todos.filter((item) => item.completed).length;
			const next = todos.find((item) => !item.completed)?.step;
			const color = phase === "executing" ? "accent" : "warning";
			const glyph = phase === "executing" ? "▶" : "�";
			const suffix = phase === "paused" ? " paused" : "";
			ctx.ui.setStatus("workflow-mode", ctx.ui.theme.fg(color, `${glyph} workflow ${completed}/${todos.length}${suffix}`));
			ctx.ui.setWidget(
				"workflow-mode",
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
		if (phase === "drafting") {
			const draft = todos.length > 0 ? ` (draft: ${todos.length} steps)` : "";
			ctx.ui.setStatus("workflow-mode", ctx.ui.theme.fg("warning", `⏸ workflow${draft}`));
		} else {
			ctx.ui.setStatus("workflow-mode", undefined);
		}
		ctx.ui.setWidget("workflow-mode", undefined);
	}

	// ---- Manager actions ----------------------------------------------------

	/**
	 * Send the directive for the next incomplete step. Self-contained by
	 * design: the message carries the step, the remaining workflow, and
	 * the contract (no marker, settle = unit of completion).
	 */
	function sendStepDirective(ctx: ExtensionContext): void {
		const current = todos.find((item) => !item.completed);
		if (!current) return;
		const note =
			run.reviewRounds > 0
				? `previous review verdict was CONTINUE — address that gap before moving on`
				: undefined;
		const directive = buildStepDirective(todos, { note });
		if (directive === null) return;
		run.pending = "review";
		pi.sendMessage(
			{ customType: STEP_MESSAGE_TYPE, content: directive, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function sendReviewPrompt(ctx: ExtensionContext): void {
		const current = todos.find((item) => !item.completed);
		if (!current) return;
		const prompt = buildReviewPrompt(todos, current);
		run.pending = "step";
		pi.sendMessage(
			{ customType: REVIEW_MESSAGE_TYPE, content: prompt, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function pauseExecution(ctx: ExtensionContext, reason: string): void {
		if (phase !== "executing") return;
		phase = "paused";
		run.pending = "none";
		updateStatus(ctx);
		persist();
		ctx.ui.notify(`Workflow paused: ${reason}`, "warning");
	}

	async function writePlanFile(ctx: ExtensionContext): Promise<void> {
		try {
			await writeFile(join(ctx.cwd, DEFAULT_PLAN_FILE), renderPlanMarkdown(todos), "utf8");
		} catch {
			// Non-fatal: execution can proceed without the file.
			ctx.ui.notify(`Note: could not write ${DEFAULT_PLAN_FILE}`, "warning");
		}
	}

	function applyVerdict(ctx: ExtensionContext, verdict: ReviewVerdict): void {
		switch (verdict.kind) {
			case "done": {
				const current = todos.find((item) => !item.completed);
				if (current) {
					current.completed = true;
					run.lastCompleted = todos.filter((item) => item.completed).length;
				}
				run.reviewRounds = 0;
				persist();
				updateStatus(ctx);
				void writePlanFile(ctx);
				if (todos.every((item) => item.completed)) {
					finishWorkflow(ctx);
				} else {
					sendStepDirective(ctx);
				}
				return;
			}
			case "continue": {
				run.reviewRounds++;
				const current = todos.find((item) => !item.completed);
				if (run.reviewRounds >= MAX_REVIEW_ROUNDS) {
					pauseExecution(
						ctx,
						`step ${current?.step ?? "?"} got CONTINUE verdicts ${run.reviewRounds} times in a row (last gap: "${verdict.gap || "unspecified"}") — inspect, then /workflow run to continue or /workflow reset to discard`,
					);
					return;
				}
				sendStepDirective(ctx);
				return;
			}
			case "blocked": {
				const current = todos.find((item) => !item.completed);
				run.blocked = { step: current?.step ?? 0, reason: verdict.reason };
				persist();
				pauseExecution(
					ctx,
					`step ${current?.step ?? "?"} reported blocked (${verdict.reason || "no reason given"}) — refine with /workflow or retry with /workflow run`,
				);
				return;
			}
			case "malformed": {
				// Safe default: treat as CONTINUE without a gap; the bounded
				// patience counter will eventually pause if the model keeps
				// failing to follow the strict verdict format.
				run.reviewRounds++;
				const current = todos.find((item) => !item.completed);
				if (run.reviewRounds >= MAX_REVIEW_ROUNDS) {
					pauseExecution(
						ctx,
						`review turn kept producing malformed verdicts ${run.reviewRounds} times — inspect the transcript, then /workflow run to continue or /workflow reset to discard`,
					);
					return;
				}
				ctx.ui.notify(
					`Review reply was malformed (${verdict.raw.replace(/\n/g, " ").slice(0, 60)}…). Treating as CONTINUE.`,
					"warning",
				);
				sendStepDirective(ctx);
				return;
			}
		}
	}

	async function beginExecution(ctx: ExtensionContext): Promise<void> {
		if (todos.length === 0) {
			ctx.ui.notify("No workflow to execute. Draft one in workflow mode first (/workflow).", "warning");
			return;
		}
		if (todos.every((item) => item.completed)) {
			ctx.ui.notify("All steps are already complete. Use /workflow reset to clear.", "info");
			return;
		}
		if (phase === "executing") {
			showWorkflow(ctx);
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
				? `Resuming workflow — manager auto-advances ${todos.filter((item) => !item.completed).length} remaining step(s). /workflow pause halts.`
				: `Executing workflow — manager sends one step at a time and runs a brief review turn after each. /workflow pause halts.`,
			"info",
		);
		sendStepDirective(ctx);
	}

	function finishWorkflow(ctx: ExtensionContext): void {
		run.terminal = true; // claim-once: exactly one completion delivery
		const summary = todos.map((item) => `- [x] ${item.step}. ${item.text}`).join("\n");
		pi.sendMessage(
			{
				customType: COMPLETE_MESSAGE_TYPE,
				content: `**Workflow complete — all ${todos.length} steps done.**\n\n${summary}`,
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

	function toggleWorkflowMode(ctx: ExtensionContext): void {
		if (phase === "drafting") {
			phase = "idle";
			restoreFullTools();
			ctx.ui.notify("Workflow mode off — full tool access restored.", "info");
		} else {
			// From idle, or from executing/paused (abandon execution, keep the draft).
			phase = "drafting";
			run = freshRun(0);
			enableDraftingTools();
			ctx.ui.notify(
				"Workflow mode on — read-only exploration. edit/write disabled, bash limited to read-only commands.",
				"info",
			);
		}
		updateStatus(ctx);
		persist();
	}

	function resetWorkflow(ctx: ExtensionContext): void {
		phase = "idle";
		todos = [];
		run = freshRun(0);
		restoreFullTools();
		updateStatus(ctx);
		persist();
		ctx.ui.notify("Workflow cleared.", "info");
	}

	function showWorkflow(ctx: ExtensionContext): void {
		if (todos.length === 0) {
			ctx.ui.notify("No workflow yet. Enter workflow mode with /workflow and draft one.", "info");
			return;
		}
		const completed = todos.filter((item) => item.completed).length;
		const list = todos
			.map((item) => `${item.step}. ${item.completed ? "☑" : "☐"} ${item.text}`)
			.join("\n");
		ctx.ui.notify(`Workflow (${completed}/${todos.length} done, ${phase}):\n${list}`, "info");
	}

	async function saveWorkflow(ctx: ExtensionContext, target?: string): Promise<void> {
		if (todos.length === 0) {
			ctx.ui.notify("No workflow to save. Draft one in workflow mode first.", "warning");
			return;
		}
		const file = resolve(ctx.cwd, target ?? DEFAULT_PLAN_FILE);
		try {
			await writeFile(file, renderPlanMarkdown(todos, "# Workflow"), "utf8");
			ctx.ui.notify(`Workflow saved to ${file}`, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to save workflow: ${String(error)}`, "error");
		}
	}

	// ---- Commands, shortcut, flag -------------------------------------------

	const SUBCOMMANDS = ["run", "pause", "show", "save", "reset"];

	pi.registerCommand("workflow", {
		description: "Workflow mode: /workflow [run|pause|show|save <file>|reset]",
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
					toggleWorkflowMode(ctx);
					break;
				case "run":
					await beginExecution(ctx);
					break;
				case "pause":
					if (phase === "executing") {
						pauseExecution(ctx, "paused by user — /workflow run resumes");
					} else {
						ctx.ui.notify("No execution running.", "info");
					}
					break;
				case "show":
					showWorkflow(ctx);
					break;
				case "save":
					await saveWorkflow(ctx, rest.join(" ") || undefined);
					break;
				case "reset":
					resetWorkflow(ctx);
					break;
				default:
					ctx.ui.notify(
						`Unknown subcommand "${sub}". Usage: /workflow [run|pause|show|save <file>|reset]`,
						"warning",
					);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show current workflow progress",
		handler: async (_args, ctx) => showWorkflow(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Toggle workflow mode",
		handler: async (ctx) => toggleWorkflowMode(ctx),
	});

	// ---- Guards --------------------------------------------------------------

	pi.on("tool_call", async (event) => {
		if (phase !== "drafting") return;

		if (MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Workflow drafting: edit/write are disabled. Leave workflow mode with /workflow to make changes.",
			};
		}

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!isReadOnlyCommand(command)) {
				return {
					block: true,
					reason: `Workflow drafting: bash is limited to read-only commands.\nBlocked command: ${command}\nLeave workflow mode with /workflow before making changes.`,
				};
			}
		}
	});

	// ---- Context management ----------------------------------------------------

	// Keep exactly one fresh phase briefing in the LLM context, drop the
	// other phase's stale briefings, and keep only the most recent step
	// directives (they are compact history; the latest names the work).
	// Review prompts are pruned too — they are one-shot audit questions and
	// their verdicts are visible in the model's reply.
	pi.on("context", async (event) => {
		const messages = event.messages;
		const lastDrafting = messages.findLastIndex((m) => customTypeOf(m) === DRAFTING_CONTEXT_TYPE);
		const lastExecuting = messages.findLastIndex((m) => customTypeOf(m) === EXECUTING_CONTEXT_TYPE);
		const lastStep = messages.findLastIndex((m) => customTypeOf(m) === STEP_MESSAGE_TYPE);
		const managing = phase === "executing" || phase === "paused";
		const filtered = messages.filter((message, index) => {
			const type = customTypeOf(message);
			if (type === DRAFTING_CONTEXT_TYPE) return phase === "drafting" && index === lastDrafting;
			if (type === EXECUTING_CONTEXT_TYPE) return phase === "executing" && index === lastExecuting;
			if (type === STEP_MESSAGE_TYPE) return managing && lastStep - index < KEEP_STEP_DIRECTIVES;
			if (type === REVIEW_MESSAGE_TYPE) return false;
			return true;
		});
		if (filtered.length !== messages.length) {
			return { messages: filtered };
		}
	});

	pi.on("before_agent_start", async () => {
		if (phase === "drafting") {
			return {
				message: { customType: DRAFTING_CONTEXT_TYPE, content: DRAFTING_BRIEF, display: false },
			};
		}
		if (phase === "executing") {
			return {
				message: { customType: EXECUTING_CONTEXT_TYPE, content: EXECUTING_BRIEF, display: false },
			};
		}
	});

	// ---- The manager tick ---------------------------------------------------

	// agent_settled fires once per user-visible run, after automatic retries,
	// compaction retries, and queued follow-ups have drained. That is the
	// honest "the run truly stopped" checkpoint — exactly where stalled
	// execution must be recovered instead of abandoned.
	pi.on("agent_settled", async (_event, ctx) => {
		if (phase !== "executing" || todos.length === 0 || run.terminal) return;

		// A blocked judgement that survived from a previous settled run still
		// means pause — but on the settle *after* the verdict, we want to
		// advance. Only pause on blocked if the pending action is a review
		// that just produced it (handled in applyVerdict). Keep this guard
		// for the case where run.blocked was set elsewhere.
		if (run.blocked && run.pending !== "step") {
			const { step, reason } = run.blocked;
			pauseExecution(
				ctx,
				`step ${step} reported blocked (${reason || "no reason given"}) — refine with /workflow or retry with /workflow run`,
			);
			return;
		}

		// Never fight the user: an explicit interrupt pauses the workflow.
		if (lastStopReason === "aborted") {
			pauseExecution(ctx, "run interrupted — /workflow run resumes from the next incomplete step");
			return;
		}
		// Provider errors are explicit evidence; retries already happened.
		if (lastStopReason === "error") {
			pauseExecution(ctx, "model error ended the run — /workflow run retries the current step");
			return;
		}

		const completed = todos.filter((item) => item.completed).length;

		// Dispatch on what we were waiting for:
		//   pending="review" → the review turn just settled; parse verdict.
		//   pending="step"   → the execution turn just settled; send review.
		//   pending="none"   → mid-flight; advance to the next step.
		if (run.pending === "review") {
			// Walk back over the just-settled messages to find the last
			// assistant reply in the review turn.
			const lastAssistant = ctx.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && "message" in entry)
				.map((entry) => (entry as { message: AgentMessage }).message)
				.filter(isAssistantMessage)
				.pop();
			if (!lastAssistant) {
				run.pending = "none";
				pauseExecution(ctx, "review turn produced no assistant reply — /workflow run to retry");
				return;
			}
			const verdict = parseReviewVerdict(getTextContent(lastAssistant));
			applyVerdict(ctx, verdict);
			return;
		}

		// All done? Deliver the completion summary exactly once.
		if (completed === todos.length) {
			await writePlanFile(ctx);
			finishWorkflow(ctx);
			return;
		}

		// Default: the execution turn just settled. Send the review turn.
		sendReviewPrompt(ctx);
	});

	// ---- Draft capture during drafting -------------------------------------------

	pi.on("agent_end", async (event, ctx) => {
		if (phase !== "drafting") return;

		// Extract a freshly drafted workflow from the last assistant message.
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
		const EXECUTE = "Execute the workflow (manager advances steps automatically)";
		const STAY = "Stay in workflow mode";
		const REFINE = "Refine the workflow";
		const choice = await ctx.ui.select("Workflow drafted — what next?", [EXECUTE, STAY, REFINE]);

		if (choice === EXECUTE) {
			await beginExecution(ctx);
		} else if (choice === REFINE) {
			const refinement = await ctx.ui.editor("Describe changes to the workflow:", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	// ---- Restore on start / resume ------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("workflow") === true) {
			phase = "drafting";
		}

		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
			.pop() as { data?: WorkflowState } | undefined;

		if (stateEntry?.data) {
			phase = migratePhase(stateEntry.data.phase);
			todos = stateEntry.data.todos ?? [];
			toolsBeforeWorkflowMode = stateEntry.data.toolsBeforeWorkflowMode;
		}

		// On resume mid-execution we *cannot* rebuild completion state from
		// old marker-based sessions (those relied on [DONE:n] emitted during
		// execution turns). The safest path is to come back paused with a
		// honest warning; the user can /workflow run to start fresh.
		if (stateEntry !== undefined && (phase === "executing" || phase === "paused") && todos.length > 0) {
			if (phase === "executing") {
				phase = "paused";
				ctx.ui.notify(
					"Restored mid-execution — settled-driven completion state cannot be rebuilt from this session. /workflow run starts fresh; /workflow show for progress.",
					"warning",
				);
			}
			persist();
		}

		if (phase === "drafting") {
			enableDraftingTools();
		} else {
			toolsBeforeWorkflowMode = undefined;
		}
		updateStatus(ctx);
	});

}
