/**
 * Mode framework for the pi coding agent.
 *
 * Provides a generic `/mode` command that lists and toggles "modes" —
 * bundles of behavior (tools, briefings, guards) contributed by other
 * extensions. The framework itself is mode-agnostic: it only keeps a
 * registry, persists the active-mode set, renders one status slot, and
 * forwards activation to the mode that owns the name.
 *
 * Communication happens entirely on the shared extension event bus, so
 * the framework never imports mode extensions and modes never import
 * the framework:
 *
 *   mode:query        framework -> modes: "announce yourself now".
 *                     Contract: reply synchronously (no awaits before
 *                     emitting) with mode:register — the bus is a
 *                     synchronous EventEmitter, so replies land before
 *                     mode:query's emit returns.
 *   mode:register     mode -> framework: { name, description }
 *                     (late registrations are fine; the registry updates)
 *   mode:activate     framework -> mode: { name } — apply your behavior.
 *                     Must be idempotent (may arrive while already active,
 *                     e.g. resume re-emits it).
 *   mode:deactivate   framework -> mode: { name } — fully restore normal
 *                     behavior (tools, prompts, guards). Must be idempotent.
 *   mode:activated    mode -> framework: { name } — notification when a
 *                     mode activated itself (e.g. via its own startup
 *                     flag). The framework merges it into the active set.
 *   mode:deactivated  mode -> framework: { name } — same, for self-
 *                     deactivation.
 *
 * Commands:
 *   /mode             list registered modes, marking active ones
 *   /mode <name>      toggle that mode (activate if off, deactivate if on)
 *   /mode off         deactivate every active mode
 *
 * Flag: --modes <a,b> activates the named modes at startup (also serves
 * as the load-proof for pi --help / verify.sh).
 *
 * The active-mode set is persisted to the session (custom entry
 * "mode-state") and re-emitted on session_start, so each mode can
 * rebuild its own richer state from its own persisted entries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "mode-state";

interface ModeInfo {
	name: string;
	description: string;
}

interface ModeState {
	active: string[];
}

export default function modeFrameworkExtension(pi: ExtensionAPI): void {
	const registry = new Map<string, ModeInfo>();
	const active = new Set<string>();
	let currentCtx: ExtensionContext | undefined;

	pi.registerFlag("modes", {
		description: "Activate modes at startup (comma-separated names, e.g. --modes delegate)",
		type: "string",
		default: "",
	});

	// ---- Registry ---------------------------------------------------------

	function announce(): void {
		// Handlers that reply synchronously land before emit() returns
		// (the bus is a synchronous EventEmitter); late replies are
		// picked up by the mode:register listener below.
		pi.events.emit("mode:query", {});
	}

	pi.events.on("mode:register", (data) => {
		const info = data as Partial<ModeInfo>;
		if (typeof info.name === "string" && typeof info.description === "string" && info.name) {
			registry.set(info.name, { name: info.name, description: info.description });
		}
	});

	// ---- Persistence + status ----------------------------------------------

	function persist(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, { active: [...active] } satisfies ModeState);
	}

	function statusText(ctx: ExtensionContext): string {
		return ctx.ui.theme.fg("accent", `◈ ${[...active].join("+")}`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mode", active.size > 0 ? statusText(ctx) : undefined);
	}

	// ---- Activation -----------------------------------------------------------

	function activate(name: string, ctx: ExtensionContext): void {
		if (active.has(name)) return;
		active.add(name);
		pi.events.emit("mode:activate", { name });
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`Mode "${name}" activated.`, "info");
	}

	function deactivate(name: string, ctx: ExtensionContext): void {
		if (!active.has(name)) return;
		active.delete(name);
		pi.events.emit("mode:deactivate", { name });
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`Mode "${name}" deactivated.`, "info");
	}

	function deactivateAll(ctx: ExtensionContext): void {
		if (active.size === 0) {
			ctx.ui.notify("No modes are active.", "info");
			return;
		}
		for (const name of [...active]) deactivate(name, ctx);
	}

	// Modes may activate/deactivate themselves (e.g. via their own startup
	// flag like `pi --delegate`); mirror that into the tracked set.
	pi.events.on("mode:activated", (data) => {
		const name = (data as Partial<ModeInfo>).name;
		if (typeof name !== "string" || !name || active.has(name)) return;
		active.add(name);
		persist();
		if (currentCtx) updateStatus(currentCtx);
	});

	pi.events.on("mode:deactivated", (data) => {
		const name = (data as Partial<ModeInfo>).name;
		if (typeof name !== "string" || !active.has(name)) return;
		active.delete(name);
		persist();
		if (currentCtx) updateStatus(currentCtx);
	});

	// ---- Command -----------------------------------------------------------------

	pi.registerCommand("mode", {
		description: "Modes: /mode [name|off] — list, toggle, or deactivate all",
		getArgumentCompletions: (prefix: string) => {
			announce(); // refresh the registry so completions are current
			const candidates = ["off", ...registry.keys()];
			const items = candidates
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({
					value: name,
					label: name === "off" ? "off — deactivate all modes" : active.has(name) ? `${name} (active)` : name,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				announce();
				if (registry.size === 0) {
					ctx.ui.notify("No modes registered. Extensions can announce modes via the mode:register event.", "info");
					return;
				}
				const lines = [...registry.values()].map(
					(info) => `- ${active.has(info.name) ? "●" : "○"} ${info.name} — ${info.description}`,
				);
				ctx.ui.notify(`Modes (${active.size} active):\n${lines.join("\n")}`, "info");
				return;
			}
			if (name === "off") {
				deactivateAll(ctx);
				return;
			}
			announce();
			if (!registry.has(name)) {
				const known = [...registry.keys()].join(", ") || "none";
				ctx.ui.notify(`Unknown mode "${name}". Registered modes: ${known}`, "warning");
				return;
			}
			if (active.has(name)) deactivate(name, ctx);
			else activate(name, ctx);
		},
	});

	// ---- Startup / resume -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		// Let modes announce themselves.
		announce();

		// Startup flag: --modes a,b
		const flagValue = pi.getFlag("modes");
		if (typeof flagValue === "string" && flagValue.trim()) {
			for (const name of flagValue.split(",").map((s) => s.trim()).filter(Boolean)) {
				if (registry.has(name)) activate(name, ctx);
				else ctx.ui.notify(`--modes: unknown mode "${name}" (not registered)`, "warning");
			}
		}

		// Resume: rebuild the active set from the persisted state entry.
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
			.pop() as { data?: ModeState } | undefined;
		const persisted = stateEntry?.data?.active ?? [];
		for (const name of persisted) {
			if (active.has(name)) continue; // already activated via flag or self-activation
			active.add(name);
			pi.events.emit("mode:activate", { name });
		}

		updateStatus(ctx);
	});
}
