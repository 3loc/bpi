import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * local-context
 *
 * Guarantees the agent sees a snapshot of the working directory before
 * actioning any user command, by appending it to the system prompt on
 * every `before_agent_start` (fires after each user prompt, before the
 * agent loop runs).
 *
 * Backs off when native context loading already covers the project:
 * pi loads AGENTS.md / AGENTS.override.md / CLAUDE.md from cwd and all
 * parent directories at startup. If such a file exists in the current
 * working directory or at the git root (or pi already loaded one from
 * within the project), this extension injects nothing — the native
 * mechanism is richer and this one would only duplicate it.
 *
 * The snapshot is cached by content signature so identical directory
 * state produces a byte-identical prompt block (provider-cache friendly).
 */

const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const MAX_SNAPSHOT_CHARS = 4000;
const MAX_DIR_ENTRIES = 40;
const README_HEAD_LINES = 20;
const GIT_TIMEOUT_MS = 3000;
const DEBUG = !!process.env.PI_LOCAL_CONTEXT_DEBUG;

function head(text: string, lines: number): string {
	return text.split("\n").slice(0, lines).join("\n");
}

function findContextFileOnDisk(dir: string): string | undefined {
	for (const name of CONTEXT_FILE_NAMES) {
		const p = join(dir, name);
		try {
			if (existsSync(p) && statSync(p).isFile()) return p;
		} catch {
			/* unreadable — ignore */
		}
	}
	return undefined;
}

export default function localContextExtension(pi: ExtensionAPI): void {
	pi.registerFlag("local-context", {
		description: "Inject local directory context when no project AGENTS.md exists (default: on)",
		type: "boolean",
		default: true,
	});

	// Snapshot cache: identical directory state -> identical injected text
	let lastSignature = "";
	let lastBlock = "";

	const gitOut = async (cwd: string, args: string[]): Promise<string | undefined> => {
		try {
			const r = await pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
			return r.code === 0 ? r.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	};

	const buildSnapshot = async (cwd: string, gitRoot: string | undefined): Promise<string> => {
		const parts: string[] = [];
		parts.push(`cwd: ${cwd}`);
		if (gitRoot) parts.push(`git root: ${gitRoot}`);

		try {
			const entries = readdirSync(cwd)
				.filter((e) => e !== ".git" && e !== "node_modules")
				.sort();
			const shown =
				entries.slice(0, MAX_DIR_ENTRIES).join(", ") +
				(entries.length > MAX_DIR_ENTRIES ? ` (+${entries.length - MAX_DIR_ENTRIES} more)` : "");
			parts.push(`entries: ${shown || "(empty)"}`);
		} catch {
			/* unreadable dir */
		}

		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
			const bits = [pkg.name as string, pkg.version ? `v${pkg.version}` : "", pkg.description as string]
				.filter(Boolean)
				.join(" — ");
			const piKeys = pkg.pi && typeof pkg.pi === "object" ? ` (pi manifest: ${Object.keys(pkg.pi).join(", ")})` : "";
			parts.push(`package.json: ${bits}${piKeys}`);
		} catch {
			/* no/invalid package.json */
		}

		for (const name of ["README.md", "README.mkdn", "README.txt", "README"]) {
			const p = join(cwd, name);
			try {
				if (existsSync(p) && statSync(p).isFile()) {
					parts.push(`${name} (first ${README_HEAD_LINES} lines):\n${head(readFileSync(p, "utf8"), README_HEAD_LINES)}`);
					break;
				}
			} catch {
				/* ignore */
			}
		}

		if (gitRoot) {
			const branch = await gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
			const status = await gitOut(cwd, ["status", "--porcelain"]);
			const log = await gitOut(cwd, ["log", "--oneline", "-3"]);
			if (branch) parts.push(`git branch: ${branch}`);
			if (status !== undefined)
				parts.push(`git status (porcelain):\n${head(status, 10) || "(clean)"}`);
			if (log) parts.push(`recent commits:\n${log}`);
		}

		return parts.join("\n").slice(0, MAX_SNAPSHOT_CHARS);
	};

	pi.on("before_agent_start", async (event, ctx) => {
		if (pi.getFlag("local-context") === false) return;

		const cwd = ctx.cwd ?? event.systemPromptOptions?.cwd ?? process.cwd();

		// Git root (undefined when not a repo / git unavailable)
		const gitRoot = (await gitOut(cwd, ["rev-parse", "--show-toplevel"])) || undefined;
		const projectDirs = [...new Set([cwd, gitRoot].filter(Boolean) as string[])];

		// Back off when native context loading already covers the project.
		// Rule: AGENTS.md (or CLAUDE.md / AGENTS.override.md) present in the
		// cwd or at the git root, OR already loaded by pi from within them.
		for (const dir of projectDirs) {
			const file = findContextFileOnDisk(dir);
			if (file) {
				if (DEBUG) console.error(`[local-context] skip: ${file} exists (native context)`);
				return;
			}
		}
		const loadedFiles = (event.systemPromptOptions?.contextFiles ?? []).map((f: { path: string }) => f.path);
		for (const path of loadedFiles) {
			if (projectDirs.some((d) => path === d || path.startsWith(d + "/") || path.startsWith(d + "\\"))) {
				if (DEBUG) console.error(`[local-context] skip: pi already loaded ${path}`);
				return;
			}
		}

		// Cache by signature: avoid emitting a different prompt block (and
		// breaking provider caches) when nothing on disk changed.
		let signature = "";
		try {
			signature = readdirSync(cwd).sort().join("\x00");
		} catch {
			/* fall through with empty signature */
		}
		if (signature === lastSignature && lastBlock) {
			if (DEBUG) console.error("[local-context] reuse cached block (dir unchanged)");
			return { systemPrompt: event.systemPrompt + lastBlock };
		}

		const snapshot = await buildSnapshot(cwd, gitRoot);
		if (!snapshot) {
			if (DEBUG) console.error("[local-context] skip: empty snapshot");
			return;
		}

		lastSignature = signature;
		lastBlock = `

<local-directory-context>
Auto-injected snapshot of the working directory, refreshed before each response.

${snapshot}
</local-directory-context>

Local workspace rules:
- Treat this directory (and its git root, if any) as the primary workspace. Read the files listed above (README, manifests) before acting.
- Before creating or modifying anything OUTSIDE this directory (global config paths, ~, other projects), first check whether a local equivalent exists here and prefer it.`;

		if (DEBUG) console.error(`[local-context] injecting block (${lastBlock.length} chars)`);
		return { systemPrompt: event.systemPrompt + lastBlock };
	});
}
