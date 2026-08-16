/**
 * Plan mode extension for the pi coding agent.
 *
 * Three phases:
 *   idle      — normal operation, full tool access
 *   planning  — read-only exploration (edit/write disabled, bash allowlisted)
 *   executing — full tool access, plan steps tracked via [DONE:n] markers
 *
 * Commands:
 *   /plan               toggle plan mode on/off
 *   /plan run           execute the current plan
 *   /plan show          print the current plan
 *   /plan save [file]   write the plan to a markdown file (default PLAN.md)
 *   /plan reset         discard the plan and return to normal mode
 *   /todos              show plan progress
 *
 * Also: Ctrl+Alt+P toggles plan mode, and `pi --plan` starts in plan mode.
 *
 * After each planning turn that produces a "Plan:" section, the user is
 * prompted to execute / keep exploring / refine. When execution starts,
 * the checklist is written to PLAN.md and progress is shown in the footer
 * status and a widget above the editor. State is persisted to the session
 * so it survives /resume and restarts.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
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

// Custom message types (also used to prune stale context, see "context" handler)
const PLANNING_CONTEXT_TYPE = "plan-mode-planning";
const EXECUTING_CONTEXT_TYPE = "plan-mode-executing";
const KICKOFF_MESSAGE_TYPE = "plan-mode-kickoff";
const COMPLETE_MESSAGE_TYPE = "plan-mode-complete";
const STATE_ENTRY_TYPE = "plan-mode-state";

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

type Phase = "idle" | "planning" | "executing";

interface PlanModeState {
	phase: Phase;
	todos: TodoItem[];
	toolsBeforePlanMode?: string[];
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
		if (phase === "executing" && todos.length > 0) {
			const completed = todos.filter((item) => item.completed).length;
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("accent", `▶ plan ${completed}/${todos.length}`),
			);
			ctx.ui.setWidget(
				"plan-mode",
				todos.map((item) =>
					item.completed
						? ctx.ui.theme.fg("success", "☑ ") +
							ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
						: ctx.ui.theme.fg("muted", "☐ ") + item.text,
				),
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

	// ---- Actions ------------------------------------------------------------

	function togglePlanMode(ctx: ExtensionContext): void {
		if (phase === "planning") {
			phase = "idle";
			restoreFullTools();
			ctx.ui.notify("Plan mode off — full tool access restored.", "info");
		} else {
			// From idle, or from executing (abandon execution, keep the draft).
			phase = "planning";
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

		phase = "executing";
		restoreFullTools();
		updateStatus(ctx);
		persist();

		// Persist the checklist as a file (pi philosophy: plans live in files).
		try {
			await writeFile(join(ctx.cwd, DEFAULT_PLAN_FILE), renderPlanMarkdown(todos), "utf8");
		} catch {
			// Non-fatal: execution can proceed without the file.
			ctx.ui.notify(`Note: could not write ${DEFAULT_PLAN_FILE}`, "warning");
		}

		const completed = todos.filter((item) => item.completed).length;
		const remaining = todos.filter((item) => !item.completed);
		const remainingList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
		const first = remaining[0];
		pi.sendMessage(
			{
				customType: KICKOFF_MESSAGE_TYPE,
				content: `Executing the plan (${completed}/${todos.length} complete). See ${DEFAULT_PLAN_FILE} for the full checklist.

Remaining steps:
${remainingList}

Start with step ${first.step}: ${first.text}
Immediately after completing step n, include the marker [DONE:n] in your response.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// ---- Commands, shortcut, flag -------------------------------------------

	const SUBCOMMANDS = ["run", "show", "save", "reset"];

	pi.registerCommand("plan", {
		description: "Plan mode: /plan [run|show|save <file>|reset]",
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
						`Unknown subcommand "${sub}". Usage: /plan [run|show|save <file>|reset]`,
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

	// Keep exactly one fresh phase briefing in the LLM context and drop the
	// other phase's stale briefings.
	pi.on("context", async (event) => {
		const messages = event.messages;
		const lastPlanning = messages.findLastIndex((m) => customTypeOf(m) === PLANNING_CONTEXT_TYPE);
		const lastExecuting = messages.findLastIndex((m) => customTypeOf(m) === EXECUTING_CONTEXT_TYPE);
		const filtered = messages.filter((message, index) => {
			const type = customTypeOf(message);
			if (type === PLANNING_CONTEXT_TYPE) return phase === "planning" && index === lastPlanning;
			if (type === EXECUTING_CONTEXT_TYPE) return phase === "executing" && index === lastExecuting;
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
		if (phase === "executing" && todos.length > 0) {
			const remaining = todos.filter((item) => !item.completed);
			if (remaining.length === 0) return;
			const content = `[PLAN EXECUTION ACTIVE]
You are executing an approved plan. Full tool access is enabled.

Remaining steps:
${remaining.map((item) => `${item.step}. ${item.text}`).join("\n")}

Work through the steps in order. Immediately after completing step n, include
the marker [DONE:n] in your response so progress is tracked. If a step turns
out to be wrong or impossible, stop and explain why.`;
			return {
				message: { customType: EXECUTING_CONTEXT_TYPE, content, display: false },
			};
		}
	});

	// ---- Progress tracking ------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "executing" || todos.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todos) > 0) {
			updateStatus(ctx);
		}
		persist();
	});

	pi.on("agent_end", async (event, ctx) => {
		// Execution complete?
		if (phase === "executing" && todos.length > 0) {
			if (todos.every((item) => item.completed)) {
				const summary = todos
					.map((item) => `- [x] ${item.step}. ${item.text}`)
					.join("\n");
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
				updateStatus(ctx);
				persist();
			}
			return;
		}

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
		const EXECUTE = "Execute the plan (track progress)";
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
		// assistant messages after the latest kickoff marker.
		if (stateEntry !== undefined && phase === "executing" && todos.length > 0) {
			let kickoffIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { customType?: string }).customType === KICKOFF_MESSAGE_TYPE) {
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
