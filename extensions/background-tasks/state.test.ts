/**
 * Unit tests for the canonical state parser and unit-name extractor.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/state.test.ts
 *
 * Why this file gets its own coverage: the original systemd-jobs
 * commit's only real bug lived in extractUnitName() (it missed the
 * stderr case). Both parseShowOutput and extractUnitName are now pure
 * functions — the cheapest place to lock in their behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUnitName, isTerminal, parseShowOutput } from "./state.ts";

describe("isTerminal", () => {
	it("marks starting and running as non-terminal", () => {
		assert.equal(isTerminal("starting"), false);
		assert.equal(isTerminal("running"), false);
	});
	it("marks the four terminal states as terminal", () => {
		assert.equal(isTerminal("completed"), true);
		assert.equal(isTerminal("failed"), true);
		assert.equal(isTerminal("timeout"), true);
		assert.equal(isTerminal("cancelled"), true);
	});
});

describe("parseShowOutput", () => {
	it("returns starting when ActiveState is active but no enter timestamp yet", () => {
		const out = `ActiveState=active
ActiveEnterTimestampMonotonic=0
ExecMainStatus=0
Result=success
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "starting");
		assert.equal(snap.exitStatus, undefined);
	});

	it("returns running when ActiveState is active and the enter timestamp is non-zero", () => {
		const out = `ActiveState=active
ActiveEnterTimestampMonotonic=123456789
ExecMainStatus=0
Result=success
`;
		assert.equal(parseShowOutput(out).state, "running");
	});

	it("treats activating and reloading as running-or-starting, not terminal", () => {
		for (const active of ["activating", "reloading"]) {
			const out = `ActiveState=${active}\nActiveEnterTimestampMonotonic=0\nResult=\n`;
			const snap = parseShowOutput(out);
			assert.equal(snap.state, "starting", `${active} should be starting`);
		}
	});

	it("returns completed when ActiveState is inactive and Result=success", () => {
		const out = `ActiveState=inactive
Result=success
ExecMainStatus=0
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "completed");
		assert.equal(snap.exitStatus, 0);
		assert.equal(snap.result, "success");
	});

	it("returns failed for Result=exit-code with non-zero ExecMainStatus", () => {
		const out = `ActiveState=inactive
Result=exit-code
ExecMainStatus=1
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "failed");
		assert.equal(snap.exitStatus, 1);
		assert.equal(snap.result, "exit-code");
	});

	it("returns timeout for Result=timeout", () => {
		const out = `ActiveState=inactive
Result=timeout
ExecMainStatus=0
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "timeout");
		assert.equal(snap.result, "timeout");
	});

	it("returns failed for Result=signal (e.g. SIGTERM 143 = 128+15)", () => {
		const out = `ActiveState=inactive
Result=signal
ExecMainStatus=143
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "failed");
		assert.equal(snap.exitStatus, 143);
	});

	it("returns failed for Result=resources (cgroup bound hit)", () => {
		const out = `ActiveState=inactive
Result=resources
ExecMainStatus=0
`;
		assert.equal(parseShowOutput(out).state, "failed");
	});

	it("falls back to failed when ActiveState=failed but Result= is empty", () => {
		const out = `ActiveState=failed
Result=
ExecMainStatus=2
`;
		const snap = parseShowOutput(out);
		assert.equal(snap.state, "failed");
		assert.equal(snap.exitStatus, 2);
	});

	it("tolerates missing keys entirely (empty input)", () => {
		const snap = parseShowOutput("");
		// No ActiveState — treat as not-yet-started.
		assert.equal(snap.state, "starting");
	});

	it("captures ExecMainStatus even when Result is success (zero)", () => {
		const out = `ActiveState=inactive\nResult=success\nExecMainStatus=0\n`;
		const snap = parseShowOutput(out);
		assert.equal(snap.exitStatus, 0);
	});
});

describe("extractUnitName", () => {
	it("extracts a .service unit name from stdout", () => {
		const text = `Running as unit: run-u12345.service; invocation ID=abc\n`;
		assert.equal(extractUnitName(text), "run-u12345.service");
	});

	it("extracts a .scope unit name from stdout", () => {
		const text = `Running as unit: run-u12345.scope\n`;
		assert.equal(extractUnitName(text), "run-u12345.scope");
	});

	// Regression: the bug from the systemd-jobs commit. With --no-block,
	// systemd-run writes "Running as unit:" to stderr. The combined
	// stream must catch this.
	it("extracts a unit name that appears only in stderr (the --no-block regression)", () => {
		const stdout = "";
		const stderr = "Running as unit: run-u99999.service\n";
		const combined = `${stdout}\n${stderr}`;
		assert.equal(extractUnitName(combined), "run-u99999.service");
	});

	it("returns undefined when no Running as unit: line is present", () => {
		assert.equal(extractUnitName(""), undefined);
		assert.equal(extractUnitName("Starting... done\n"), undefined);
	});

	it("rejects unit names with the wrong suffix", () => {
		assert.equal(extractUnitName("Running as unit: my-job\n"), undefined);
		assert.equal(extractUnitName("Running as unit: my-job.timer\n"), undefined);
	});

	it("handles the unit name being followed by a semicolon", () => {
		const text = `Running as unit: run-r42.service; invocation ID=deadbeef\n`;
		assert.equal(extractUnitName(text), "run-r42.service");
	});
});
