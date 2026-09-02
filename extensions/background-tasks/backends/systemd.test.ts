/**
 * Unit tests for the systemd backend's pure logic.
 *
 * These tests exercise argument construction and the parse-output path
 * via an injected ExecFn — no real systemd is required. The smoke
 * test against real systemd lives in verify.sh.
 *
 * The original systemd-jobs commit's only real bug (Reading-as-unit
 * on stderr) is now in extractUnitName (state.ts) — the regression
 * test there is the load-bearing one.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/backends/systemd.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SystemdBackend, type ExecFn, type ExecContext } from "./systemd.ts";

function fakeExec(recorded: { cmd?: string; args?: string[]; stdout?: string; stderr?: string; code?: number }[]): ExecFn {
	return async (cmd, args) => {
		const last = recorded.shift() ?? {};
		if (last.cmd !== undefined) assert.equal(cmd, last.cmd, `expected cmd ${last.cmd}, got ${cmd}`);
		if (last.args !== undefined) assert.deepEqual(args, last.args, `unexpected args for ${cmd}`);
		return { code: last.code ?? 0, stdout: last.stdout ?? "", stderr: last.stderr ?? "" };
	};
}

const ctx: ExecContext = { cwd: "/srv/repo", home: "/home/test" };

describe("SystemdBackend.launch", () => {
	it("constructs a --user, --no-block invocation with the working directory", async () => {
		const exec = fakeExec([{ stdout: "Running as unit: run-r1.service\n" }]);
		const b = new SystemdBackend(exec, ctx);
		const r = await b.launch({ command: "make test", workingDirectory: "/srv/repo" });
		assert.equal(r.id, "run-r1.service");
	});

	it("parses the unit name when systemd-run prints it on stderr (the --no-block bug)", async () => {
		const exec = fakeExec([{ stdout: "", stderr: "Running as unit: run-r2.service\n" }]);
		const b = new SystemdBackend(exec, ctx);
		const r = await b.launch({ command: "sleep 1", workingDirectory: "/srv/repo" });
		assert.equal(r.id, "run-r2.service");
	});

	it("throws when systemd-run exits non-zero", async () => {
		const exec = fakeExec([{ code: 1, stderr: "Failed to connect to bus\n" }]);
		const b = new SystemdBackend(exec, ctx);
		await assert.rejects(() => b.launch({ command: "x", workingDirectory: "/" }), /Failed to connect to bus/);
	});

	it("throws when no Running-as-unit line is found", async () => {
		const exec = fakeExec([{ stdout: "starting...\n", stderr: "" }]);
		const b = new SystemdBackend(exec, ctx);
		await assert.rejects(() => b.launch({ command: "x", workingDirectory: "/" }), /unparseable unit name/);
	});

	it("uses --system when scope=system", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "Running as unit: run-sys.service\n", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.launch({ command: "x", workingDirectory: "/", scope: "system" });
		assert.ok(captured.includes("--system"), `expected --system in args, got: ${captured.join(" ")}`);
		assert.ok(!captured.includes("--user"), `expected no --user in args, got: ${captured.join(" ")}`);
	});

	it("emits RuntimeMaxSec with a 5 s grace over the caller's deadline", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "Running as unit: run-t.service\n", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.launch({ command: "x", workingDirectory: "/", timeoutMs: 30_000 });
		const idx = captured.indexOf("RuntimeMaxSec=35s");
		assert.ok(idx !== -1, `expected RuntimeMaxSec=35s in args, got: ${captured.join(" ")}`);
	});

	it("emits StandardOutput=file: when outputFile is given", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "Running as unit: run-f.service\n", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.launch({ command: "x", workingDirectory: "/", outputFile: "/tmp/job.log" });
		assert.ok(captured.includes("StandardOutput=file:/tmp/job.log"), `got: ${captured.join(" ")}`);
		assert.ok(captured.includes("StandardError=inherit"), `got: ${captured.join(" ")}`);
	});

	it("joins -- and bash -c as the last args", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "Running as unit: run-c.service\n", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.launch({ command: "make && echo done", workingDirectory: "/srv/repo" });
		assert.deepEqual(captured.slice(-4), ["--", "bash", "-c", "make && echo done"]);
	});
});

describe("SystemdBackend.status", () => {
	it("returns undefined when systemctl show fails (e.g. unit garbage-collected)", async () => {
		const exec = fakeExec([{ code: 1, stderr: "Unit not found" }]);
		const b = new SystemdBackend(exec, ctx);
		const snap = await b.status("run-gone.service");
		assert.equal(snap, undefined);
	});

	it("parses a completed snapshot", async () => {
		const exec = fakeExec([{ stdout: "ActiveState=inactive\nResult=success\nExecMainStatus=0\n" }]);
		const b = new SystemdBackend(exec, ctx);
		const snap = await b.status("run-done.service");
		assert.equal(snap?.state, "completed");
		assert.equal(snap?.exitStatus, 0);
	});
});

describe("SystemdBackend.cancel", () => {
	it("uses systemctl stop by default (SIGTERM → SIGKILL after TimeoutStopSec)", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.cancel("run-x.service");
		assert.deepEqual(captured, ["--user", "stop", "run-x.service"]);
	});

	it("uses systemctl kill -s SIGKILL when signal=SIGKILL", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.cancel("run-x.service", "SIGKILL");
		assert.deepEqual(captured, ["--user", "kill", "-s", "SIGKILL", "run-x.service"]);
	});
});

describe("SystemdBackend.journal", () => {
	it("returns the journal lines", async () => {
		const exec = fakeExec([{ stdout: "line one\nline two\nline three\n" }]);
		const b = new SystemdBackend(exec, ctx);
		const chunk = await b.journal("run-j.service", { limit: 200, maxChars: 8000 });
		assert.deepEqual(chunk.lines, ["line one", "line two", "line three", ""]);
		assert.equal(chunk.totalChars, "line one\nline two\nline three\n".length);
	});

	it("throws (does not truncate) when content exceeds maxChars", async () => {
		const big = "x".repeat(10_000);
		const exec = fakeExec([{ stdout: big }]);
		const b = new SystemdBackend(exec, ctx);
		await assert.rejects(() => b.journal("run-j.service", { limit: 200, maxChars: 1000 }), /exceeds maxChars=1000/);
	});

	it("passes --since / --until through to journalctl", async () => {
		let captured: string[] = [];
		const exec: ExecFn = async (_cmd, args) => {
			captured = args;
			return { code: 0, stdout: "", stderr: "" };
		};
		const b = new SystemdBackend(exec, ctx);
		await b.journal("run-j.service", { limit: 100, maxChars: 1000, since: "1h ago", until: "2026-09-02 12:00:00" });
		const sinceIdx = captured.indexOf("--since");
		const untilIdx = captured.indexOf("--until");
		assert.ok(sinceIdx !== -1 && captured[sinceIdx + 1] === "1h ago");
		assert.ok(untilIdx !== -1 && captured[untilIdx + 1] === "2026-09-02 12:00:00");
	});
});
