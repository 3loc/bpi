/**
 * Integration tests for the watcher.
 *
 * Drives the watcher's tick function against an InProcBackend so we
 * exercise the full state machine (starting → running → terminal,
 * plus the timeout branch) without a real systemd. The extension's
 * index.ts glues this to pi's setInterval; the seam is here.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/watcher.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcBackend } from "./backends/inproc.ts";
import type { Job } from "./state.ts";
import { tick } from "./watcher.ts";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "bt-watcher-"));
}

function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: "unused",
		label: "test",
		command: "true",
		workingDirectory: "/tmp",
		scope: "user",
		startedAt: 0,
		state: "starting",
		...overrides,
	};
}

describe("watcher.tick", () => {
	it("promotes starting → running when the backend reports running", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const r = await backend.launch({ command: "sleep 0.2; exit 0", workingDirectory: dir });
			const jobs = new Map<string, Job>([[r.id, makeJob({ id: r.id, startedAt: Date.now() })]]);

			// First tick should promote (inproc immediately reports running).
			const outcome = await tick(jobs, backend, Date.now());
			assert.equal(outcome.finished.length, 0, "should not be finished yet");
			assert.equal(jobs.get(r.id)?.state, "running", "should be promoted to running");

			await backend.cancel(r.id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the job as finished when it reaches a terminal state", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const r = await backend.launch({ command: "exit 0", workingDirectory: dir });
			const startedAt = Date.now() - 100;
			const jobs = new Map<string, Job>([[r.id, makeJob({ id: r.id, startedAt })]]);

			// Wait for the child to actually finish (it's basically instant).
			await new Promise((res) => setTimeout(res, 100));

			const outcome = await tick(jobs, backend, Date.now());
			assert.equal(outcome.finished.length, 1);
			assert.equal(outcome.finished[0]?.state, "completed");
			assert.equal(outcome.finished[0]?.exitStatus, 0);
			assert.equal(jobs.get(r.id)?.state, "completed", "the in-memory entry is updated too");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records failed when the backend reports failed", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const r = await backend.launch({ command: "exit 7", workingDirectory: dir });
			const jobs = new Map<string, Job>([[r.id, makeJob({ id: r.id, startedAt: Date.now() - 100 })]]);
			await new Promise((res) => setTimeout(res, 100));

			const outcome = await tick(jobs, backend, Date.now());
			assert.equal(outcome.finished[0]?.state, "failed");
			assert.equal(outcome.finished[0]?.exitStatus, 7);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces a wall-clock timeout independent of the backend", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const r = await backend.launch({ command: "sleep 10; exit 0", workingDirectory: dir });
			const startedAt = Date.now() - 5_000; // pretend the job started 5s ago
			const jobs = new Map<string, Job>([[r.id, makeJob({ id: r.id, startedAt, timeoutMs: 1_000 })]]);

			const outcome = await tick(jobs, backend, Date.now());
			assert.equal(outcome.finished[0]?.state, "timeout");
			// And the backend should have been asked to stop (best-effort).
			await backend.cancel(r.id); // belt + suspenders for the test
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips jobs that are already terminal", async () => {
		const backend = new InProcBackend();
		const jobs = new Map<string, Job>([["x.service", makeJob({ id: "x.service", state: "completed", finishedAt: 1 })]]);
		const outcome = await tick(jobs, backend, Date.now());
		assert.equal(outcome.finished.length, 0);
		// And the backend should not have been asked to status() at all
		// — we can't directly observe that, but the test still exercises
		// the short-circuit path.
	});

	it("tolerates a backend.status() that throws", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const r = await backend.launch({ command: "exit 0", workingDirectory: dir });
			const jobs = new Map<string, Job>([[r.id, makeJob({ id: r.id, startedAt: Date.now() - 100 })]]);

			// Wrap backend.status to throw once.
			const origStatus = backend.status.bind(backend);
			let threwOnce = false;
			backend.status = async (id: string) => {
				if (!threwOnce) {
					threwOnce = true;
					throw new Error("transient");
				}
				return origStatus(id);
			};

			await new Promise((res) => setTimeout(res, 100));
			// First call should swallow the error and produce no outcome.
			const o1 = await tick(jobs, backend, Date.now());
			assert.equal(o1.finished.length, 0, "first tick should swallow the throw");
			// Second call should now succeed and report completion.
			const o2 = await tick(jobs, backend, Date.now());
			assert.equal(o2.finished.length, 1);
			assert.equal(o2.finished[0]?.state, "completed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
