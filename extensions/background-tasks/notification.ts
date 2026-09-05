import type { NotifyMode } from "./state.ts";

export type CompletionDeliveryMode = "steer" | "followUp";

/**
 * Fulfillment results belong to the request already in flight. Deliver them
 * before the agent can settle and present a final answer. Watcher results are
 * intentionally separate work and therefore remain follow-ups.
 */
export function completionDeliveryMode(notify: NotifyMode): CompletionDeliveryMode {
	return notify === "fulfillment" ? "steer" : "followUp";
}
