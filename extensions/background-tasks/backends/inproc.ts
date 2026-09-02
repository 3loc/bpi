/**
 * In-process backend.
 *
 * Not for production — exists for two reasons:
 *   1. Integration tests for the watcher and tools that exercise the
 *      full lifecycle (launch → tick → wait → journal → cancel)
 *      without needing systemd, a bus, or even a Linux box.
 *   2. Environments where systemd is genuinely unreachable (some
 *      sandboxes, minimal containers) and the user accepts that
 *      "background" means "outlive the bash tool call" rather than
 *      "outlive the session". The agent's docs warn this is the
 *      fallback case.
 *
 * Substrate: a map of "fake jobs" keyed by an auto-generated id. The
 * fake job holds a child_process handle. Wait/notify use a per-job
 * EventEmitter so wait() is race-free (it awaits a real event, not a
 * poll).
 */

import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Backend, BackendCapabilities, JournalChunk, JournalOptions, LaunchRequest, LaunchResult } from "../backend.ts";
import { isTerminal, type JobState, type StatusSnapshot } from "../state.ts";

interface FakeJob {
	id: string;
	proc: ChildProcess;
	scope: "user" | "system";
	stdoutChunks: string[];
	stderrChunks: string[];
	outputFile?: string;
	timeoutTimer?: NodeJS.Timeout;
	emitter: EventEmitter;
	finished: boolean;
	finalState: StatusSnapshot;
}

const capabilities: BackendCapabilities = {
	userScope: true,
	cancellable: true,
	persistentJournal: false,
};

export class InProcBackend implements Backend {
	readonly id = "inproc";
	readonly capabilities = capabilities;

	private jobs = new Map<string, FakeJob>();

	launch(req: LaunchRequest): Promise<LaunchResult> {
		const id = `inproc-${randomUUID().slice(0, 8)}.service`;
		const outputFile = req.outputFile;
		if (outputFile) {
			mkdirSync(path.dirname(outputFile), { recursive: true });
		}
		const emitter = new EventEmitter();
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const fake: FakeJob = {
			id,
			scope: req.scope ?? "user",
			proc: undefined!,
			stdoutChunks,
			stderrChunks,
			outputFile,
			emitter,
			finished: false,
			finalState: { state: "starting" },
		};
		this.jobs.set(id, fake);

		const proc = spawn("bash", ["-c", req.command], {
			cwd: req.workingDirectory,
		});
		fake.proc = proc;

		proc.stdout.on("data", (chunk: Buffer) => {
			const s = chunk.toString("utf8");
			stdoutChunks.push(s);
			if (outputFile) appendFileSync(outputFile, s);
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			const s = chunk.toString("utf8");
			stderrChunks.push(s);
			if (outputFile) appendFileSync(outputFile, s);
		});
		proc.on("exit", (code, signal) => {
			const state: JobState = signal === "SIGTERM" || signal === "SIGKILL" ? "cancelled" : code === 0 ? "completed" : "failed";
			const finalState: StatusSnapshot = { state, exitStatus: code ?? undefined, result: signal ? `signal:${signal}` : code === 0 ? "success" : "exit-code" };
			// Wait for stdout/stderr to end before signaling terminal —
			// the journal call that follows wait() expects the captured
			// output to be present. The 'exit' event can fire before
			// all 'data' events have been delivered to listeners,
			// especially under load. readableEnded becomes true only
			// after the stream has consumed all pending data.
			const signalOnce = (): void => {
				if (fake.finished) return;
				fake.finalState = finalState;
				fake.finished = true;
				emitter.emit("terminal", fake.finalState);
			};
			if (proc.stdout.readableEnded && proc.stderr.readableEnded) {
				signalOnce();
				return;
			}
			let pending = 0;
			const maybeSignal = (): void => {
				pending -= 1;
				if (pending === 0) signalOnce();
			};
			if (!proc.stdout.readableEnded) {
				pending += 1;
				proc.stdout.once("end", maybeSignal);
			}
			if (!proc.stderr.readableEnded) {
				pending += 1;
				proc.stderr.once("end", maybeSignal);
			}
			// Safety net: if a stream is in a weird state, fire after
			// a short delay so wait() can never hang forever.
			if (pending === 0) signalOnce();
			else setTimeout(() => signalOnce(), 1_000).unref();
		});
		proc.on("error", (err) => {
			fake.finalState = { state: "failed", result: `spawn-error:${err.message}` };
			fake.finished = true;
			emitter.emit("terminal", fake.finalState);
		});

		// Watcher-driven timeout: this is independent of any systemd
		// RuntimeMaxSec — it's the "polling-driven timeout" the original
		// skill described.
		if (req.timeoutMs !== undefined) {
			fake.timeoutTimer = setTimeout(() => {
				if (!fake.finished) {
					proc.kill("SIGTERM");
					fake.finalState = { state: "timeout", result: "timeout" };
				}
			}, req.timeoutMs);
		}

		return Promise.resolve({ id, raw: fake });
	}

	async status(id: string): Promise<StatusSnapshot | undefined> {
		const fake = this.jobs.get(id);
		if (!fake) return undefined;
		if (fake.finished) return fake.finalState;
		return { state: "running" };
	}

	async wait(id: string, state: JobState, timeoutMs: number): Promise<StatusSnapshot | undefined> {
		const fake = this.jobs.get(id);
		if (!fake) return undefined;
		if (isTerminal(fake.finalState.state) && (state === "inactive" || state === fake.finalState.state)) {
			return fake.finalState;
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), timeoutMs);
			fake.emitter.once("terminal", (snap: StatusSnapshot) => {
				clearTimeout(timer);
				resolve(snap);
			});
		});
	}

	async cancel(id: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
		const fake = this.jobs.get(id);
		if (!fake) return;
		if (fake.finished) return;
		fake.proc.kill(signal);
	}

	async journal(id: string, opts: JournalOptions): Promise<JournalChunk> {
		const fake = this.jobs.get(id);
		if (!fake) throw new Error(`No job with id "${id}".`);
		if (fake.outputFile) {
			try {
				const text = readFileSync(fake.outputFile, "utf8");
				return sliceJournal(text, opts);
			} catch (err) {
				throw new Error(`Failed to read output file ${fake.outputFile}: ${(err as Error).message}`);
			}
		}
		const combined = fake.stdoutChunks.join("") + fake.stderrChunks.join("");
		return sliceJournal(combined, opts);
	}
}

function sliceJournal(text: string, opts: JournalOptions): JournalChunk {
	const lines = text.split("\n");
	const sliced = lines.slice(-opts.limit).join("\n");
	if (sliced.length > opts.maxChars) {
		throw new Error(`Journal is ${sliced.length} chars, exceeds maxChars=${opts.maxChars}. Narrow with limit/since/until.`);
	}
	return { lines: sliced.split("\n"), totalChars: sliced.length };
}
