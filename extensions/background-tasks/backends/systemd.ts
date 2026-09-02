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

import { extractUnitName, parseShowOutput, type StatusSnapshot } from "../state.ts";
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

	/** Pre-built for `wait` — accepts the JobState enum and translates
	 *  it to the matching systemctl wait target. The abstraction's
	 *  JobState is "the canonical state machine"; systemctl's --state=
	 *  takes "active", "inactive", "failed". This is the one place that
	 *  vocabulary translation happens. */
	async wait(id: string, state: import("../state.ts").JobState, timeoutMs: number): Promise<StatusSnapshot | undefined> {
		const target = mapStateToSystemdWait(state);
		const result = await this.exec(
			"systemctl",
			this.argsFor("wait", id, `--state=${target}`, `--timeout=${Math.ceil(timeoutMs / 1000)}s`),
			{ timeout: timeoutMs + 5_000 },
		);
		if (result.code !== 0) return undefined;
		return this.status(id);
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

/** Translate the canonical state machine into the systemd wait target.
 *  "inactive" is the most useful generic wait — it means "done or
 *  failed, whichever comes first." The abstraction also accepts the
 *  canonical names directly. */
function mapStateToSystemdWait(state: import("../state.ts").JobState): string {
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
