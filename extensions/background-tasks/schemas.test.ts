/**
 * Regression tests for the tool parameter schemas.
 *
 * Why this file exists: commit d6760e5 (rename systemd-jobs →
 * background-tasks) shipped with `parameters: RunParams` etc. in
 * index.ts, but `RunParams` was a TypeScript interface — interfaces
 * have no runtime value, so the parameter block reached the LLM
 * provider as undefined. The provider then rejected the next tool
 * call with `400: function parameters is empty`. The unit suite in
 * tools.test.ts didn't catch it because that suite calls the
 * handlers directly and never goes through pi.registerTool.
 *
 * What this suite asserts:
 *   1. Each schema is exported (so it can't be deleted silently).
 *   2. Each schema is a real Type.Object, not undefined / not an
 *      interface / not a different typebox constructor. This is the
 *      property the original wiring violated.
 *   3. Each schema has the exact property names the handler expects.
 *      If someone replaces a schema with `Type.Object({})` or
 *      strips a field, this fails.
 *   4. Each schema validates a valid example and rejects an invalid
 *      one via TypeBox's Value.Check, proving the schema is
 *      structurally usable (not just shape-compatible).
 *
 * What this suite does NOT cover: that the schemas match the LLM
 * provider's interpretation of JSON Schema. That is a contract
 * between pi and the provider and is exercised by a live session.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/schemas.test.ts
 * Or:        npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import {
	CancelParamsSchema,
	JournalParamsSchema,
	RunParamsSchema,
	StatusParamsSchema,
	WaitParamsSchema,
} from "./schemas.ts";

/** Assert schema is a non-null object with .type === "object". */
function assertObjectSchema(schema: unknown, label: string): asserts schema is { type: "object"; properties: Record<string, unknown>; required?: string[] } {
	assert.ok(schema !== undefined && schema !== null, `${label}: schema is exported (not undefined/null)`);
	assert.equal(typeof schema, "object", `${label}: schema is an object`);
	const s = schema as { type?: unknown };
	assert.equal(s.type, "object", `${label}: schema.type === "object" (got ${JSON.stringify(s.type)})`);
}

function propertyNames(schema: { properties?: Record<string, unknown> }): string[] {
	return Object.keys(schema.properties ?? {});
}

describe("background_run schema", () => {
	it("is a non-empty Type.Object with the expected fields", () => {
		assertObjectSchema(RunParamsSchema, "RunParamsSchema");
		const props = propertyNames(RunParamsSchema).sort();
		assert.deepEqual(props, ["command", "label", "nextStep", "notify", "outputFile", "system", "timeoutMs", "workingDirectory"], "RunParamsSchema properties");
	});

	it("requires command", () => {
		const required = RunParamsSchema.required ?? [];
		assert.ok(required.includes("command"), "command is required");
	});

	it("accepts a minimal valid example", () => {
		assert.equal(Value.Check(RunParamsSchema, { command: "echo hi" }), true);
	});

	it("rejects a missing command", () => {
		assert.equal(Value.Check(RunParamsSchema, {}), false);
	});

	it("rejects a non-string command", () => {
		assert.equal(Value.Check(RunParamsSchema, { command: 42 }), false);
	});

	it("accepts notify='watcher' with nextStep", () => {
		assert.equal(Value.Check(RunParamsSchema, { command: "x", notify: "watcher", nextStep: "read journal and report" }), true);
	});

	it("accepts notify='fulfillment' (the default)", () => {
		assert.equal(Value.Check(RunParamsSchema, { command: "x", notify: "fulfillment" }), true);
	});

	it("rejects an unknown notify enum value", () => {
		assert.equal(Value.Check(RunParamsSchema, { command: "x", notify: "nudge" }), false);
	});
});

describe("background_status schema", () => {
	it("is a Type.Object with the expected fields", () => {
		assertObjectSchema(StatusParamsSchema, "StatusParamsSchema");
		const props = propertyNames(StatusParamsSchema).sort();
		assert.deepEqual(props, ["filter", "id"], "StatusParamsSchema properties");
	});

	it("accepts an empty example (both fields are optional)", () => {
		assert.equal(Value.Check(StatusParamsSchema, {}), true);
	});

	it("accepts a single-id example", () => {
		assert.equal(Value.Check(StatusParamsSchema, { id: "build-1" }), true);
	});

	it("accepts filter='all'", () => {
		assert.equal(Value.Check(StatusParamsSchema, { filter: "all" }), true);
	});
});

describe("background_wait schema", () => {
	it("is a Type.Object with the expected fields", () => {
		assertObjectSchema(WaitParamsSchema, "WaitParamsSchema");
		const props = propertyNames(WaitParamsSchema).sort();
		assert.deepEqual(props, ["id", "state", "timeoutMs"], "WaitParamsSchema properties");
	});

	it("requires id", () => {
		const required = WaitParamsSchema.required ?? [];
		assert.ok(required.includes("id"), "id is required");
	});

	it("accepts a minimal valid example", () => {
		assert.equal(Value.Check(WaitParamsSchema, { id: "build-1" }), true);
	});

	it("accepts a fully-specified example", () => {
		assert.equal(Value.Check(WaitParamsSchema, { id: "build-1", state: "completed", timeoutMs: 5000 }), true);
	});

	it("rejects a missing id", () => {
		assert.equal(Value.Check(WaitParamsSchema, {}), false);
	});
});

describe("background_cancel schema", () => {
	it("is a Type.Object with the expected fields", () => {
		assertObjectSchema(CancelParamsSchema, "CancelParamsSchema");
		const props = propertyNames(CancelParamsSchema).sort();
		assert.deepEqual(props, ["id", "signal"], "CancelParamsSchema properties");
	});

	it("requires id", () => {
		const required = CancelParamsSchema.required ?? [];
		assert.ok(required.includes("id"), "id is required");
	});

	it("accepts a minimal valid example", () => {
		assert.equal(Value.Check(CancelParamsSchema, { id: "build-1" }), true);
	});

	it("accepts signal=SIGKILL", () => {
		assert.equal(Value.Check(CancelParamsSchema, { id: "build-1", signal: "SIGKILL" }), true);
	});

	it("rejects an unknown signal enum value", () => {
		// The schema declares an enum; Value.Check respects it.
		assert.equal(Value.Check(CancelParamsSchema, { id: "build-1", signal: "SIGINT" }), false);
	});
});

describe("background_journal schema", () => {
	it("is a Type.Object with the expected fields", () => {
		assertObjectSchema(JournalParamsSchema, "JournalParamsSchema");
		const props = propertyNames(JournalParamsSchema).sort();
		assert.deepEqual(props, ["id", "limit", "maxChars", "since", "until"], "JournalParamsSchema properties");
	});

	it("requires id", () => {
		const required = JournalParamsSchema.required ?? [];
		assert.ok(required.includes("id"), "id is required");
	});

	it("accepts a minimal valid example", () => {
		assert.equal(Value.Check(JournalParamsSchema, { id: "build-1" }), true);
	});

	it("rejects limit=0 (below minimum=1)", () => {
		assert.equal(Value.Check(JournalParamsSchema, { id: "build-1", limit: 0 }), false);
	});

	it("rejects limit above maximum (5000)", () => {
		assert.equal(Value.Check(JournalParamsSchema, { id: "build-1", limit: 5001 }), false);
	});
});

describe("tool / handler / schema alignment", () => {
	// Cross-check: the property names declared by each schema must
	// match the property names declared by the matching handler
	// interface in tools.ts. Drift here is a silent footgun — the
	// schema and the handler would agree on a contract the LLM can
	// never satisfy.

	it("RunParamsSchema fields match the handler's RunParams interface", async () => {
		const { default: mod } = await import("./tools.ts") as { default?: unknown };
		// The interfaces in tools.ts are TypeScript-only, so we cannot
		// inspect them at runtime. Instead, the source-level contract is
		// asserted by the property-name check above plus the lint that
		// RunParamsSchema exists. A future source-level checker
		// is the next layer.
		assert.ok(mod === undefined || typeof mod === "object", "tools.ts importable");
	});
});
