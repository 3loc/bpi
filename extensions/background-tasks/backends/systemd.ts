/**
 * systemd backend.
 *
 * Translates the Backend interface into `systemd-run`, `systemctl`,
 * and `journalctl` invocations. The actual subprocess calls go through
 * an injected `exec` function — production code passes `pi.exec`, tests
 * pass a fake. This is what makes the backend unit-testable without a
 * real systemd on the box.
 *
 * Why --user by default: the agent runs as the user, and the user's
 * systemd manager (PID 1's child) owns transient units without
 * requiring root. `--system` mode is opt-in via scope="system" but
 * needs polkit, runs as root, and has wider failure modes — the skill
 * documents this.
 */

import { extractUnitName, isTerminal, parseShowOutput, type JobState, type StatusSnapshot } from "../state.ts";
import type { Backend, BackendCapabilities, JournalChunk, JournalOptions, LaunchRequest, LaunchResult } from "../backend.ts";

/** Minimal subprocess contract — pi.exec in production, a recorder in
 *  tests. Mirrors the bits of pi.exec we actually use. */
export interface ExecFn {
	(cmd: string, args: string[], opts?: { timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Path resolution context — pi passes cwd + HOME; tests pass a stub. */
export interface ExecContext {
	cwd: string;
	home: string;
}

const capabilities: BackendCapabilities = {
	userScope: true,
	cancellable: true,
	persistentJournal: true,
};

export class SystemdBackend implements Backend {
	readonly id = "systemd";
	readonly capabilities = capabilities;

	private readonly exec: ExecFn;
	private readonly ctx: ExecContext;

	constructor(exec: ExecFn, ctx: ExecContext) {
		this.exec = exec;
		this.ctx = ctx;
	}

	async launch(req: LaunchRequest): Promise<LaunchResult> {
		const args: string[] = ["--no-block"];
		if (req.scope === "system") args.push("--system");
		else args.push("--user");
		args.push("--working-directory=" + req.workingDirectory);
		if (req.outputFile) {
			args.push("-p", `StandardOutput=file:${req.outputFile}`);
			args.push("-p", `StandardError=inherit`);
		}
		if (req.timeoutMs !== undefined) {
			// 5 s grace over the watcher deadline so systemd doesn't race
			// the watcher; the watcher wins by 5 s.
			const graceMs = req.timeoutMs + 5_000;
			args.push("-p", `RuntimeMaxSec=${Math.ceil(graceMs / 1000)}s`);
		}
		args.push("--", "bash", "-c", req.command);

		const result = await this.exec("systemd-run", args, { timeout: 10_000 });
		if (result.code !== 0) {
			throw new Error(`systemd-run failed (exit=${result.code}):\n${result.stderr || "(no stderr)"}`);
		}

		// The unit-name parsing bug from the systemd-jobs commit: with
		// --no-block, "Running as unit: <name>" is on STDERR, not stdout.
		// Scan both.
		const unit = extractUnitName(`${result.stdout}\n${result.stderr}`);
		if (!unit) {
			throw new Error(
				`systemd-run produced an unparseable unit name (stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)})`,
			);
		}
		return { id: unit, raw: result };
	}

	async status(id: string): Promise<StatusSnapshot | undefined> {
		const result = await this.exec(
			"systemctl",
			this.argsFor("show", id, "--property=ActiveState,SubState,ExecMainStatus,Result,ActiveEnterTimestampMonotonic,InactiveExitTimestampMonotonic"),
			{ timeout: 5_000 },
		);
		if (result.code !== 0) return undefined;
		return parseShowOutput(result.stdout);
	}

	/** Bounded poll + reconcile. `systemctl` has no wait verb (verified
	 *  against systemd 261: "Unknown command verb 'wait'"), so the native
	 *  blocking primitive this method used to call never existed. A poll
	 *  of ActiveState cannot miss a terminal target because terminal
	 *  states are absorbing — once a unit reads inactive/failed it reads
	 *  that way forever — so polling ground-truth `show` is equivalent
	 *  to a blocking wait for terminal targets. Transient targets
	 *  ("running") are best-effort: a unit that finishes between polls
	 *  reads as inactive and the reconcile step reports "did not reach
	 *  running". The poll runs inside one `timeout`-wrapped exec to
	 *  honor the ExecFn contract (one process that exits on its own);
	 *  the exec-level timeout is a backstop, not the primary bound. */
	async wait(id: string, state: JobState, timeoutMs: number): Promise<StatusSnapshot | undefined> {
		assertShellSafeUnitId(id);
		const accept = mapStateToActiveState(state) === "inactive" ? "inactive|failed" : "active";
		const poll =
			`while :; do ` +
			`s=$(systemctl --user show '${id}' --property=ActiveState --value 2>/dev/null) || exit 1; ` +
			`case "$s" in ${accept}) exit 0;; esac; ` +
			`sleep 0.25; ` +
			`done`;
		await this.exec("timeout", [`${Math.ceil(timeoutMs / 1000)}s`, "bash", "-c", poll], {
			timeout: timeoutMs + 5_000,
		}).catch(() => undefined);
		// The snapshot decides, not the poll's exit code — it is ground
		// truth whether the poll hit, timed out, or failed outright.
		const snap = await this.status(id).catch(() => undefined);
		return snap && waitSatisfied(snap.state, state) ? snap : undefined;
	}

	async cancel(id: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
		const args = signal === "SIGKILL" ? this.argsFor("kill", "-s", "SIGKILL", id) : this.argsFor("stop", id);
		const result = await this.exec("systemctl", args, { timeout: 30_000 });
		if (result.code !== 0) {
			throw new Error(`Cancel failed for ${id} (exit=${result.code}): ${result.stderr}`);
		}
	}

	async journal(id: string, opts: JournalOptions): Promise<JournalChunk> {
		const args = this.argsFor("-u", id, "-n", String(opts.limit), "--no-pager", "-o", "cat");
		if (opts.since) args.push("--since", opts.since);
		if (opts.until) args.push("--until", opts.until);

		const result = await this.exec("journalctl", args, { timeout: 15_000 });
		if (result.code !== 0) {
			throw new Error(`journalctl failed (exit=${result.code}): ${result.stderr}`);
		}
		if (result.stdout.length > opts.maxChars) {
			throw new Error(
				`Journal for ${id} is ${result.stdout.length} chars, exceeds maxChars=${opts.maxChars}. Narrow with limit/since/until, or rerun with outputFile: true.`,
			);
		}
		return { lines: result.stdout.split("\n"), totalChars: result.stdout.length };
	}

	private argsFor(...args: string[]): string[] {
		// Caller passes the action; we prepend --user unless told otherwise.
		// launch() handles the scope itself; this helper exists for
		// status/wait/cancel/journal which assume the same scope as
		// the launch. If a future caller needs cross-scope calls, it
		// should construct its own args array.
		return ["--user", ...args];
	}
}

/** Translate the canonical state machine into the ActiveState value a
 *  wait polls for. "inactive" is the useful generic terminal — it
 *  covers done, failed, timeout, and cancelled; the reconciled
 *  snapshot carries the precise verdict. */
function mapStateToActiveState(state: JobState): "active" | "inactive" {
	switch (state) {
		case "completed":
		case "failed":
		case "timeout":
		case "cancelled":
			return "inactive";
		case "starting":
		case "running":
			return "active";
	}
}

/** A wait for a terminal state is satisfied by any terminal state;
 *  a wait for "active" only by the parsed running state. */
function waitSatisfied(snapState: JobState, target: JobState): boolean {
	return mapStateToActiveState(target) === "inactive" ? isTerminal(snapState) : snapState === "running";
}

/** Unit ids come from our own extractUnitName, but wait() embeds the
 *  id in a shell string — refuse anything outside systemd's unit-name
 *  alphabet as defense in depth. */
const SHELL_SAFE_UNIT_ID = /^[A-Za-z0-9@:_.-]+$/;
function assertShellSafeUnitId(id: string): void {
	if (!SHELL_SAFE_UNIT_ID.test(id)) {
		throw new Error(`Refusing to embed unsafe unit id in a shell command: ${JSON.stringify(id)}`);
	}
}
