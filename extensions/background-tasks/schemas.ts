/**
 * TypeBox parameter schemas for the five background-tasks tools.
 *
 * Why a dedicated module: the schemas are passed to `pi.registerTool`
 * as the `parameters:` field. That field expects a real TypeBox TSchema
 * value — TypeScript interfaces are erased at runtime, so passing one
 * there gives the LLM provider an empty parameter block and the next
 * tool call is rejected with `400: function parameters is empty`.
 * That is exactly what shipped in commit d6760e5 (rename systemd-jobs
 * → background-tasks): the comment in tools.ts claimed these schemas
 * lived in index.ts, but they didn't actually exist anywhere.
 *
 * Why TypeBox specifically: pi's `ToolDefinition.parameters: TParams
 * extends TSchema` is TypeBox-typed and pi's runtime validates
 * tool-call arguments against the schema before invoking `execute`.
 * A hand-rolled JSON Schema object with the right shape would fail the
 * `extends TSchema` constraint and skip validation.
 *
 * Shape contract: each schema mirrors the matching interface in
 * tools.ts (RunParams / StatusParams / WaitParams / CancelParams /
 * JournalParams). The interface documents the contract the handlers
 * accept; this file makes the contract enforceable at the LLM boundary.
 * If you change one, change the other.
 *
 * Tested by: schemas.test.ts (asserts each export is a Type.Object
 * with the expected property names and that Value.Check accepts valid
 * examples + rejects invalid ones). The test is the regression that
 * would have caught the original bug.
 */

import { Type } from "typebox";

/**
 * background_run — launch a command as a background task.
 *
 * `command` is required and is the only field the LLM must supply;
 * everything else has a sensible default.
 *
 * `notify` controls how the completion notification is framed when
 * the watcher fires it back into the model:
 *   - "fulfillment" (default): the job was launched to satisfy the
 *     current request. The notification is framed as "you are
 *     expected to act on this — read the journal, decide what's
 *     next, and continue the task you were working on."
 *   - "watcher": the job is an autonomous background watcher (e.g.
 *     polling for a file, waiting on a remote sync). The
 *     notification is framed as "this may or may not be relevant;
 *     decide whether to act or defer. The next step was specified
 *     via `nextStep` when the job was launched."
 */
export const RunParamsSchema = Type.Object({
	command: Type.String({
		description: "Shell command to run. Interpreted by `sh -c` (systemd) or executed directly (inproc).",
		minLength: 1,
	}),
	label: Type.Optional(Type.String({
		description: "Short human-readable name (≤ 80 chars). Defaults to the first word of the command.",
		maxLength: 80,
	})),
	workingDirectory: Type.Optional(Type.String({
		description: "Directory to run the command in. Relative paths resolve against the agent's cwd.",
	})),
	timeoutMs: Type.Optional(Type.Number({
		description: "Wall-clock budget in milliseconds. The watcher enforces it independently of any backend-side timer.",
		minimum: 0,
	})),
	outputFile: Type.Optional(Type.Union([
		Type.Boolean({ description: "true → capture combined stdout+stderr to ~/.cache/background-tasks/<slug>.log" }),
		Type.String({ description: "Absolute path to write the captured output to." }),
	], { description: "Where to capture combined stdout+stderr. Omit to discard." })),
	system: Type.Optional(Type.Boolean({
		description: "true → run as a transient system unit (PID 1, requires polkit). Default: false (user manager).",
	})),
	notify: Type.Optional(Type.String({
		description: "How the completion notification is framed when the watcher fires it back into the model. 'fulfillment' (default): you launched this to satisfy the current request — act on it. 'watcher': autonomous background job — decide whether to act, defer, or surface to the user; the next step was specified via `nextStep`.",
		enum: ["fulfillment", "watcher"],
	})),
	nextStep: Type.Optional(Type.String({
		description: "Free-form instruction carried into the watcher-mode completion notification. Tells the model what to do when the job finishes (e.g. 'read the journal and report whether the build passed'). Ignored when notify='fulfillment'.",
	})),
});

/**
 * background_status — non-blocking snapshot for one or all jobs.
 *
 * Both fields are optional; the handler returns the full active-or-
 * recent list when both are omitted.
 */
export const StatusParamsSchema = Type.Object({
	id: Type.Optional(Type.String({
		description: "Specific job id (e.g. 'build-1735839200000-1234'). When set, returns that job's snapshot.",
	})),
	filter: Type.Optional(Type.String({
		description: "'active' (default — active jobs + recent terminal within the 5-minute window) or 'all'.",
		enum: ["active", "all"],
	})),
});

/**
 * background_wait — block until a job reaches a target state.
 *
 * `id` is required.
 */
export const WaitParamsSchema = Type.Object({
	id: Type.String({
		description: "Job id to wait on.",
		minLength: 1,
	}),
	state: Type.Optional(Type.String({
		description: "Target state. Default: 'completed'. Any string accepted; the runtime checks it against the known states.",
	})),
	timeoutMs: Type.Optional(Type.Number({
		description: "How long to block before giving up. Default: 24h.",
		minimum: 0,
	})),
});

/**
 * background_cancel — stop a running job.
 */
export const CancelParamsSchema = Type.Object({
	id: Type.String({
		description: "Job id to cancel.",
		minLength: 1,
	}),
	signal: Type.Optional(Type.String({
		description: "Signal to send. 'SIGTERM' (default, gives the backend time for a graceful shutdown) or 'SIGKILL' (immediate).",
		enum: ["SIGTERM", "SIGKILL"],
	})),
});

/**
 * background_journal — read captured output for a known job.
 */
export const JournalParamsSchema = Type.Object({
	id: Type.String({
		description: "Job id whose journal to read.",
		minLength: 1,
	}),
	limit: Type.Optional(Type.Number({
		description: "Maximum number of journal lines to return. Default 200; clamped to [1, 5000].",
		minimum: 1,
		maximum: 5000,
	})),
	since: Type.Optional(Type.String({
		description: "Only return journal entries at or after this timestamp / time spec (format depends on backend).",
	})),
	until: Type.Optional(Type.String({
		description: "Only return journal entries at or before this timestamp / time spec.",
	})),
	maxChars: Type.Optional(Type.Number({
		description: "Maximum total character count of the returned chunk. Default 8000; clamped to [256, 50000].",
		minimum: 256,
		maximum: 50000,
	})),
});
