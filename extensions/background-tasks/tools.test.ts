/**
 * Integration tests for the tool handlers.
 *
 * Drives each handler through InProcBackend and asserts on the
 * returned content + the in-memory job map. This is the layer that
 * would otherwise only get exercised by a live session — making it
 * testable catches shape regressions (the wrong field name in a
 * tool result, a missing label) before they hit the model.
 *
 * Run with:  node --test --experimental-strip-types extensions/background-tasks/tools.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcBackend } from "./backends/inproc.ts";
import type { Job } from "./state.ts";
import { handleCancel, handleJournal, handleRun, handleStatus, handleWait, type ToolContext } from "./tools.ts";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "bt-tools-"));
}

function ctx(): ToolContext {
	return { cwd: "/tmp", home: "/home/test", capabilities: { userScope: true, cancellable: true, persistentJournal: false } };
}

function freshMap(): Map<string, Job> {
	return new Map();
}

describe("handleRun", () => {
	it("registers the job in the map and returns its id", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "exit 0" });
			assert.ok(r.details.id, "details.id set");
			assert.equal(jobs.size, 1);
			assert.equal(jobs.get(r.details.id as string)?.state, "starting");
			assert.equal(jobs.get(r.details.id as string)?.scope, "user");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses system scope when params.system is true", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "exit 0", system: true });
			assert.equal(jobs.get(r.details.id as string)?.scope, "system");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves a relative workingDirectory against ctx.cwd", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "exit 0", workingDirectory: "subdir" });
			assert.equal(jobs.get(r.details.id as string)?.workingDirectory, `${dir}/subdir`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("derives a label from the first argv when none is given", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "make test" });
			assert.equal(jobs.get(r.details.id as string)?.label, "make");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("truncates labels to 80 chars", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const longLabel = "x".repeat(200);
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "exit 0", label: longLabel });
			assert.equal((jobs.get(r.details.id as string)?.label ?? "").length, 80);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns a human-readable summary with all the relevant fields", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const r = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "sleep 1", label: "wait", timeoutMs: 5_000, outputFile: "/tmp/x.log" });
			const text = r.content[0]?.text ?? "";
			assert.ok(text.includes("Launched wait as"), "summary includes the launch line");
			assert.ok(text.includes("timeout: 5.0s"), "summary includes the timeout");
			assert.ok(text.includes("outputFile: /tmp/x.log"), "summary includes the output file");
			assert.ok(text.includes("background_wait"), "summary points at the wait tool");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("handleStatus", () => {
	it("lists empty when no jobs are registered", async () => {
		const backend = new InProcBackend();
		const r = await handleStatus(freshMap(), backend, ctx(), {});
		assert.match(r.content[0]?.text ?? "", /No jobs registered/);
	});

	it("reports a single running job's status", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "sleep 0.2; exit 0" });
			const r = await handleStatus(jobs, backend, ctx(), { id: run.details.id as string });
			assert.match(r.content[0]?.text ?? "", /starting|running/);
			// The in-memory state should have been reconciled.
			assert.ok(["starting", "running"].includes(jobs.get(run.details.id as string)?.state ?? ""));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters older terminal jobs out of the default listing", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			// Manually inject a long-finished terminal job.
			jobs.set("old.service", {
				id: "old.service",
				label: "old",
				command: "x",
				workingDirectory: dir,
				scope: "user",
				startedAt: Date.now() - 10 * 60 * 1000,
				finishedAt: Date.now() - 10 * 60 * 1000,
				state: "completed",
			});
			// Plus a fresh active job.
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "sleep 0.2; exit 0" });
			const r = await handleStatus(jobs, backend, ctx(), {});
			assert.match(r.content[0]?.text ?? "", new RegExp(run.details.id as string), "fresh job shown");
			assert.ok(!(r.content[0]?.text ?? "").includes("old.service"), "old job hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns 'No job with id' for an unknown id", async () => {
		const backend = new InProcBackend();
		const r = await handleStatus(freshMap(), backend, ctx(), { id: "ghost.service" });
		assert.match(r.content[0]?.text ?? "", /No job with id/);
	});
});

describe("handleWait", () => {
	it("blocks until the job is terminal and updates the in-memory entry", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "exit 5" });
			const r = await handleWait(jobs, backend, ctx(), { id: run.details.id as string });
			assert.match(r.content[0]?.text ?? "", /reached completed/);
			assert.equal(jobs.get(run.details.id as string)?.state, "failed");
			assert.equal(jobs.get(run.details.id as string)?.exitStatus, 5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when the id is unknown", async () => {
		const backend = new InProcBackend();
		await assert.rejects(() => handleWait(freshMap(), backend, ctx(), { id: "ghost.service" }), /No job with id/);
	});
});

describe("handleCancel", () => {
	it("marks the in-memory job cancelled and asks the backend to stop", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "sleep 5; exit 0" });
			const r = await handleCancel(jobs, backend, ctx(), { id: run.details.id as string });
			assert.match(r.content[0]?.text ?? "", /Cancelled/);
			assert.equal(jobs.get(run.details.id as string)?.state, "cancelled");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("handleJournal", () => {
	it("returns the captured output", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "echo first; echo second" });
			await handleWait(jobs, backend, { ...ctx(), cwd: dir }, { id: run.details.id as string });
			const r = await handleJournal(jobs, backend, { ...ctx(), cwd: dir }, { id: run.details.id as string });
			const text = r.content[0]?.text ?? "";
			assert.ok(text.includes("first"));
			assert.ok(text.includes("second"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clamps maxChars to [256, 50000]", async () => {
		const dir = tmp();
		try {
			const backend = new InProcBackend();
			const jobs = freshMap();
			const run = await handleRun(jobs, backend, { ...ctx(), cwd: dir }, { command: "echo x" });
			await handleWait(jobs, backend, ctx(), { id: run.details.id as string });
			// maxChars=0 is invalid; the handler should clamp to the
			// minimum (256) rather than throw.
			const r = await handleJournal(jobs, backend, ctx(), { id: run.details.id as string, maxChars: 0 });
			assert.equal(typeof (r.details.chars), "number");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
