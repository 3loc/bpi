/**
 * Unit tests for InProcBackend.
 *
 * The in-process backend's contract: launch a real child process
 * (bash -c), watch it, surface the right status, let the caller
 * cancel or wait on it. These tests run real child processes — so
 * they need /bin/sh and a writable tmp dir — but no systemd.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/backends/inproc.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcBackend } from "./inproc.ts";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "bt-inproc-"));
}

describe("InProcBackend.launch", () => {
	it("launches a command and reports it as running", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "sleep 0.2; exit 0", workingDirectory: dir });
			assert.ok(r.id.endsWith(".service"), `id should look systemd-ish: ${r.id}`);
			const snap = await b.status(r.id);
			assert.ok(snap, "should still exist");
			assert.equal(snap?.state, "running");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports completed when the command exits 0", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "exit 0", workingDirectory: dir });
			const final = await b.wait(r.id, "completed", 5_000);
			assert.equal(final?.state, "completed");
			assert.equal(final?.exitStatus, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports failed when the command exits non-zero", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "exit 7", workingDirectory: dir });
			const final = await b.wait(r.id, "failed", 5_000);
			assert.equal(final?.state, "failed");
			assert.equal(final?.exitStatus, 7);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures combined stdout+stderr to outputFile when requested", async () => {
		const dir = tmp();
		try {
			const logPath = path.join(dir, "job.log");
			const b = new InProcBackend();
			const r = await b.launch({ command: "echo hello; echo bye 1>&2", workingDirectory: dir, outputFile: logPath });
			await b.wait(r.id, "completed", 5_000);
			assert.ok(existsSync(logPath));
			const text = readFileSync(logPath, "utf8");
			assert.ok(text.includes("hello"));
			assert.ok(text.includes("bye"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("InProcBackend.wait", () => {
	it("is race-free — resolves when the command finishes, not on a poll loop", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "sleep 0.1; exit 0", workingDirectory: dir });
			const start = Date.now();
			const snap = await b.wait(r.id, "completed", 5_000);
			const elapsed = Date.now() - start;
			// Should resolve in roughly the runtime, not the timeout.
			assert.ok(elapsed < 1_000, `wait took ${elapsed}ms — likely polling`);
			assert.equal(snap?.state, "completed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined on timeout", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "sleep 5; exit 0", workingDirectory: dir });
			const snap = await b.wait(r.id, "completed", 200);
			assert.equal(snap, undefined);
			// Clean up — cancel the still-running job.
			await b.cancel(r.id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("InProcBackend.cancel", () => {
	it("stops a running job and reports cancelled", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "sleep 5; exit 0", workingDirectory: dir });
			await b.cancel(r.id);
			const snap = await b.wait(r.id, "cancelled", 5_000);
			assert.equal(snap?.state, "cancelled");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is a no-op when the job is already terminal", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "exit 0", workingDirectory: dir });
			await b.wait(r.id, "completed", 5_000);
			// Should not throw.
			await b.cancel(r.id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("InProcBackend.journal", () => {
	it("returns captured output as lines", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			const r = await b.launch({ command: "echo alpha; echo beta; echo gamma", workingDirectory: dir });
			await b.wait(r.id, "completed", 5_000);
			const chunk = await b.journal(r.id, { limit: 100, maxChars: 8000 });
			assert.deepEqual(chunk.lines, ["alpha", "beta", "gamma", ""]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws (not truncate) when content exceeds maxChars", async () => {
		const dir = tmp();
		try {
			const b = new InProcBackend();
			// Generate ~100 lines of 10 chars each = 1000 chars.
			const r = await b.launch({ command: "for i in $(seq 100); do echo xxxxxxxxxx; done", workingDirectory: dir });
			await b.wait(r.id, "completed", 10_000);
			await assert.rejects(() => b.journal(r.id, { limit: 200, maxChars: 500 }), /exceeds maxChars=500/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws for an unknown id", async () => {
		const b = new InProcBackend();
		await assert.rejects(() => b.journal("nonexistent.service", { limit: 10, maxChars: 100 }), /No job with id/);
	});
});
