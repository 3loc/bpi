import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completionDeliveryMode } from "./notification.ts";

describe("completionDeliveryMode", () => {
	it("steers fulfillment results into the request already in flight", () => {
		assert.equal(completionDeliveryMode("fulfillment"), "steer");
	});

	it("keeps autonomous watcher results as follow-ups", () => {
		assert.equal(completionDeliveryMode("watcher"), "followUp");
	});
});
