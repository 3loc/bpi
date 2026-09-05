import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { GoalAccounting, type UsageDelta } from "./accounting.ts";

function usage(input: number, output: number, cacheRead = 0): UsageDelta {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
	};
}

function start(accounting: GoalAccounting, nowMs = 1_000): void {
	accounting.start({
		statusActive: true,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		nowMs,
	});
}

describe("GoalAccounting token usage", () => {
	test("charges the first assistant response in full", () => {
		const accounting = new GoalAccounting();
		start(accounting);

		const current = usage(1_000, 200, 800);
		const snapshot = accounting.snapshot(current, 2_000);

		assert.deepEqual(snapshot, { tokenDelta: 1_200, timeDeltaSeconds: 1 });
	});

	test("charges every response independently even when the next response is smaller", () => {
		const accounting = new GoalAccounting();
		start(accounting);

		const firstUsage = usage(1_000, 200);
		const first = accounting.snapshot(firstUsage, 2_000)!;
		accounting.commit(first, 2_000);

		const secondUsage = usage(400, 50);
		const second = accounting.snapshot(secondUsage, 3_000)!;
		accounting.commit(second, 3_000);

		assert.equal(second.tokenDelta, 450);
		assert.equal(accounting.getTokensUsed(), 1_650);
	});

	test("does not charge while paused", () => {
		const accounting = new GoalAccounting();
		start(accounting);
		accounting.setStatusActive(false, 2_000);

		assert.equal(accounting.snapshot(usage(500, 100), 20_000), null);
	});
});

describe("GoalAccounting active time", () => {
	test("resets the wall-clock anchor on resume", () => {
		const accounting = new GoalAccounting();
		start(accounting);
		accounting.setStatusActive(false, 2_000);
		accounting.setStatusActive(true, 100_000);

		const snapshot = accounting.snapshot(usage(10, 5), 103_500);

		assert.deepEqual(snapshot, { tokenDelta: 15, timeDeltaSeconds: 3 });
	});
});
