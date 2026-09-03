// Tool-parameter schema scanner.
//
// Structural lint called for by REGRESSION.md (the d6760e5
// background-tasks bug -- passing TypeScript interfaces as
// `parameters:` to pi.registerTool). The bug class is "the RHS of
// parameters is a TypeScript type-only construct that the runtime
// cannot see"; this text-scan shape catches it within the
// verify.sh / node --test offline runner where adding the
// typescript package (~70 MB) would be disproportionate.
//
// Out of scope: a full TypeScript compiler. With tsc in the loop,
// this text scan becomes redundant -- ship tsc instead. Without it,
// the source-text walker reaches the documented bug class plus
// every pattern REGRESSION.md enumerates.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

export type Severity = "error" | "warning";

export interface Finding {
	file: string;
	line: number;
	severity: Severity;
	message: string;
}

const TOOLS_CHECK_OK = "@tools-check-ok";

export interface CheckResult {
	ok: boolean;
	findings: Finding[];
	scanned: number;
	checked: number;
}

export function findExtensionEntries(rootDir: string): string[] {
	const extDir = join(rootDir, "extensions");
	if (!existsSync(extDir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(extDir).sort()) {
		const candidate = join(extDir, entry, "index.ts");
		if (isFile(candidate)) out.push(candidate);
	}
	return out;
}

export function checkTools(rootDir: string): CheckResult {
	const entries = findExtensionEntries(rootDir);
	const findings: Finding[] = [];
	for (const file of entries) {
		findings.push(...checkFile(file));
	}
	const ok = findings.every((f) => f.severity !== "error");
	return { ok, findings, scanned: entries.length, checked: entries.length };
}

interface ToolCall {
	startLine: number;
	endLine: number;
	body: string;
}

// Find which lines are inside a block comment. We only use this to skip
// lines so a multi-line /* ... */ span doesn't trigger false positives.
function findLinesInBlockComment(source: string): Set<number> {
	const lines = source.split("\n");
	const out = new Set<number>();
	let inBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i]!;
		let j = 0;
		if (!inBlock) {
			// Walk tokens to find a block-comment opener; matters only when
			// we are not already inside.
			while (j < text.length - 1) {
				const ch = text[j]!;
				const next = text[j + 1]!;
				if (ch === "/" && next === "*") {
					inBlock = true;
					j += 2;
					break;
				}
				if (ch === "/" && next === "/") break;
				if (ch === '"' || ch === "'" || ch === "`") {
					j = skipString(text, j, ch);
					continue;
				}
				j++;
			}
			if (!inBlock) continue;
			// fall through to "inside block" handling on this same line
		}
		if (inBlock) {
			out.add(i);
			while (j < text.length - 1) {
				const ch = text[j]!;
				const next = text[j + 1]!;
				if (ch === "*" && next === "/") {
					inBlock = false;
					j += 2;
					break;
				}
				j++;
			}
			if (!inBlock) {
				// block comment closed on this line; remaining text is code
				out.delete(i);
			}
		}
	}
	return out;
}

function skipString(text: string, start: number, quote: string): number {
	let i = start + 1;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === quote) return i + 1;
		i++;
	}
	return text.length;
}

function findCodeRanges(line: string): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	let inTick = false;
	while (i < line.length) {
		const ch = line[i]!;
		const next = line[i + 1];
		if (inSingle) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === "'") inSingle = false;
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === '"') inDouble = false;
			i++;
			continue;
		}
		if (inTick) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === "`") inTick = false;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") break; // line comment eats rest of line
		if (ch === "/" && next === "*") break; // multi-line block comment; skip line outside
		if (ch === "'") {
			inSingle = true;
			i++;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			i++;
			continue;
		}
		if (ch === "`") {
			inTick = true;
			i++;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < line.length && /[A-Za-z0-9_$.]/.test(line[j]!)) j++;
			out.push({ start: i, end: j });
			i = j;
			continue;
		}
		i++;
	}
	return out;
}

// Skips identifier hits inside string literals, line comments, and
// (via findLinesInBlockComment) multi-line /* ... */ comments, so
// descriptions that mention "pi.registerTool" do not register as
// calls.
function findToolCalls(source: string): ToolCall[] {
	const calls: ToolCall[] = [];
	const lines = source.split("\n");
	const skipLines = findLinesInBlockComment(source);
	const hits: { line: number; col: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (skipLines.has(i)) continue;
		const line = lines[i]!;
		const codeRanges = findCodeRanges(line);
		for (const r of codeRanges) {
			if (line.slice(r.start, r.end) === "pi.registerTool") {
				hits.push({ line: i, col: r.start });
			}
		}
	}
	for (const hit of hits) {
		// Confirm the very next non-space character on this line is "(".
		const startLine = lines[hit.line]!;
		let parenFound = false;
		let k = hit.col + "pi.registerTool".length;
		while (k < startLine.length) {
			if (/\s/.test(startLine[k]!)) {
				k++;
				continue;
			}
			if (startLine[k] === "(") parenFound = true;
			break;
		}
		if (!parenFound) continue;
		const open = findOpeningBrace(lines, hit.line);
		if (!open) continue;
		const close = matchBrace(lines, open.line, open.col, "{");
		if (!close) continue;
		const body = lines.slice(hit.line, close.line + 1).join("\n");
		calls.push({ startLine: hit.line, endLine: close.line, body });
	}
	const seen = new Set<number>();
	return calls.filter((c) => (seen.has(c.startLine) ? false : seen.add(c.startLine)));
}

// Exported for unit tests; not part of the public scanner API
// otherwise. Returns null if no parameters field is present.
export function extractParametersRhs(body: string): { rhs: string; line: number } | null {
	const lines = body.split("\n");
	let braceDepth = 0;
	let insideObject = false;
	let foundKey = false;
	let rhsStartLine = -1;
	let rhsStartCol = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		for (let c = 0; c < line.length; c++) {
			const ch = line[c]!;
			if (!insideObject) {
				if (ch === "{") {
					insideObject = true;
					braceDepth = 1;
				}
				continue;
			}
			if (foundKey) {
				if (rhsStartLine === -1) {
					if (/[\s,]/.test(ch)) continue;
					rhsStartLine = i;
					rhsStartCol = c;
					return readRhsFrom(lines, rhsStartLine, rhsStartCol);
				}
				continue;
			}
			if (ch === "{") braceDepth++;
			else if (ch === "}") {
				braceDepth--;
				if (braceDepth === 0) insideObject = false;
				continue;
			}
			if (braceDepth === 1) {
				const m = /^\s*parameters\s*:/.exec(line.slice(c));
				if (m) {
					foundKey = true;
					c += m[0].length - 1;
				}
			}
		}
	}
	return null;
}

// Stops at the next top-level comma, semicolon, or closing brace.
// Returns null if no parameters field is present.
function readRhsFrom(lines: string[], startLine: number, startCol: number): { rhs: string; line: number } | null {
	const rhsLines: string[] = [];
	let depth = 0;
	let started = false;
	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i]!;
		const colStart = i === startLine ? startCol : 0;
		for (let c = colStart; c < line.length; c++) {
			const ch = line[c]!;
			started = true;
			if (depth === 0 && (ch === "," || ch === "}" || ch === ";" || ch === "\n")) {
				const rhs = rhsLines.join("").trim();
				return rhs ? { rhs, line: startLine + 1 } : null;
			}
			if (ch === "(" || ch === "{" || ch === "[") depth++;
			else if (ch === ")" || ch === "}" || ch === "]") {
				depth--;
				if (depth < 0) {
					const rhs = rhsLines.join("").trim();
					return rhs ? { rhs, line: startLine + 1 } : null;
				}
			}
			rhsLines.push(ch);
		}
		if (started && rhsLines.length > 0 && !rhsLines.join("").endsWith(" ")) rhsLines.push(" ");
	}
	const rhs = rhsLines.join("").trim();
	return rhs ? { rhs, line: startLine + 1 } : null;
}

function findOpeningBrace(lines: string[], after: number): { line: number; col: number } | null {
	for (let i = after; i < lines.length; i++) {
		const line = lines[i]!;
		const idx = line.indexOf("{");
		if (idx >= 0) return { line: i, col: idx };
	}
	return null;
}

function matchBrace(lines: string[], line: number, col: number, open: string): { line: number; col: number } | null {
	const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
	const stack: string[] = [pairs[open]!];
	for (let i = line; i < lines.length; i++) {
		const text = lines[i]!;
		const start = i === line ? col + 1 : 0;
		for (let c = start; c < text.length; c++) {
			const ch = text[c]!;
			if (ch === "{" || ch === "(" || ch === "[") {
				stack.push(pairs[ch]!);
				continue;
			}
			if (ch === "}" || ch === ")" || ch === "]") {
				const expected = stack.pop();
				if (ch !== expected) return null;
				if (stack.length === 0) return { line: i, col: c };
			}
		}
	}
	return null;
}

function hasOptOutComment(source: string, line: number): boolean {
	const lines = source.split("\n");
	for (let i = line - 1; i >= 0 && i >= line - 3; i--) {
		const text = lines[i] ?? "";
		if (text.includes(TOOLS_CHECK_OK)) return true;
	}
	const after = lines[line] ?? "";
	if (after.includes(TOOLS_CHECK_OK)) return true;
	return false;
}

interface ResolvedKind {
	kind: "inline-object" | "imported-object" | "imported-bad" | "unresolved";
	detail: string;
}

function resolveRhs(rhs: string, sourceFile: string, sourceLines: string[]): ResolvedKind {
	const text = rhs.trim();
	if (!text) return { kind: "unresolved", detail: "empty" };
	if (text === "undefined" || text === "null") {
		return { kind: "imported-bad", detail: `RHS is ${text}; pi expects a Type.Object schema` };
	}
	if (/^"[^"]*"$/.test(text) || /^'[^']*'$/.test(text)) {
		return { kind: "imported-bad", detail: "RHS is a string literal; pi expects a Type.Object schema, not the string \"Type.Object\"" };
	}
	if (text.startsWith("Type.Object(")) {
		return { kind: "inline-object", detail: "inline Type.Object(...) call" };
	}
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
		return resolveImportedIdentifier(text, sourceFile, sourceLines);
	}
	if (/^Type\.[A-Z][A-Za-z]*$/.test(text) || /^Type\.[A-Z][A-Za-z]*\s*\(/.test(text)) {
		const leaf = text.split(/[(\s]/)[0]!;
		return { kind: "imported-bad", detail: `RHS uses ${leaf}, a leaf schema; tool parameters must be Type.Object(curly-form)` };
	}
	return { kind: "unresolved", detail: `RHS "${truncate(text, 60)}" must be a Type.Object(...) call or an identifier from a sibling schemas module` };
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function resolveImportedIdentifier(name: string, sourceFile: string, sourceLines: string[]): ResolvedKind {
	const source = sourceLines.join("\n");
	// Walk every import { ... } from "..." statement (single and multi-line;
	// also handles leading `type` modifier and inline `type X` modifiers).
	const importRe = /import\s+(?:type\s+)?(?:\{([^{}]+?)\}|(\*)\s+as\s+(\w+)|(\w+))\s+from\s+["']([^"']+)["'];?/g;
	for (const m of source.matchAll(importRe)) {
		const moduleSpec = m[5]!;
		let names: string[] = [];
		if (m[1]) {
			names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
		} else if (m[2] && m[3]) {
			names = [m[3]];
		} else if (m[4]) {
			names = [m[4]];
		}
		const matched = names.find((n) => n === name || n.endsWith(` as ${name}`) || n.startsWith(`${name} `));
		if (!matched) continue;
		const dir = sourceFile.replace(/\/[^/]+$/, "");
		const resolved = resolveImportPath(dir, moduleSpec);
		if (!resolved) {
			return { kind: "unresolved", detail: `cannot resolve import "${moduleSpec}" from ${relativeModulePath(sourceFile)}` };
		}
		return inspectTargetModule(resolved, name);
	}
	// Inline `import { type RunParams }` (per-name type modifier). In ESM this
	// import binding has no runtime value, so it is the same bug class.
	if (new RegExp(`\\bimport\\s*\\{[^}]*\\btype\\s+${name}\\b[^}]*\\}`).test(source)) {
		return {
			kind: "imported-bad",
			detail: `${name} is type-only imported (\`import { type ${name} }\`); a TypeScript type-only import has no runtime value, so the LLM provider would reject tool calls with "function parameters is empty" (400) -- see REGRESSION.md`,
		};
	}
	return { kind: "unresolved", detail: `identifier "${name}" has no import binding in ${relativeModulePath(sourceFile)}` };
}

// Picks whichever extension (.ts, /index.ts) exists on disk; the
// import spec may already carry an extension, in which case the
// literal is tried first.
function resolveImportPath(dir: string, spec: string): string | null {
	const base = resolvePath(dir, spec);
	if (isFile(base)) return base;
	// Spec has no extension; try `.ts` and the implicit `/index.ts`.
	if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(spec)) {
		if (isFile(`${base}.ts`)) return `${base}.ts`;
		if (isFile(`${base}/index.ts`)) return `${base}/index.ts`;
	}
	return null;
}

function inspectTargetModule(modulePath: string, name: string): ResolvedKind {
	let text: string;
	try {
		text = readFileSync(modulePath, "utf8");
	} catch {
		return { kind: "unresolved", detail: `cannot read ${modulePath}` };
	}
	// Re-export: export ... from "...".
	const reExport = /\bexport\s+(?:\*\s+from|\{[^}]+\})\s+from\s+["']([^"']+)["']/g;
	for (const m of text.matchAll(reExport)) {
		const sub = m[1]!;
		const dir = modulePath.replace(/\/[^/]+$/, "");
		const resolved = resolveImportPath(dir, sub);
		if (!resolved) continue;
		const inner = inspectTargetModule(resolved, name);
		if (inner.kind === "inline-object") return inner;
	}
	// Inline export const NAME = Type.Object(...).
	const objectRe = new RegExp(`\\bexport\\s+const\\s+${name}\\b\\s*[:=]\\s*Type\\.Object\\s*\\(`);
	if (objectRe.test(text)) {
		return { kind: "inline-object", detail: `imported identifier ${name} resolves to a Type.Object(...) call` };
	}
	// Bare export const NAME = X (not a Type.Object call) -- bad.
	const anyRe = new RegExp(`\\bexport\\s+const\\s+${name}\\b`);
	if (anyRe.test(text)) {
		return { kind: "imported-bad", detail: `${name} is exported as const, but its RHS is not a Type.Object(...) call; runtime parameter block would be wrong` };
	}
	// export interface NAME or export type NAME = ... -- the original bug.
	if (new RegExp(`\\bexport\\s+(?:interface|type)\\s+${name}\\b`).test(text)) {
		return { kind: "imported-bad", detail: `${name} is a TypeScript type-only export (interface or type alias); runtime value would be undefined and the LLM provider would reject tool calls with "function parameters is empty" (400) -- see REGRESSION.md` };
	}
	return { kind: "unresolved", detail: `identifier "${name}" import binding not satisfied by any export in ${relativeModulePath(modulePath)}` };
}

function relativeModulePath(file: string): string {
	const marker = "/extensions/";
	const idx = file.lastIndexOf(marker);
	if (idx >= 0) return `extensions/${file.slice(idx + marker.length)}`;
	return file;
}

function checkFile(file: string): Finding[] {
	const findings: Finding[] = [];
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (err) {
		findings.push({
			file: relativeModulePath(file),
			line: 0,
			severity: "error",
			message: `cannot read ${file}: ${(err as Error).message}`,
		});
		return findings;
	}
	const sourceLines = source.split("\n");
	const calls = findToolCalls(source);
	for (const call of calls) {
		const extracted = extractParametersRhs(call.body);
		if (!extracted) {
			if (hasOptOutComment(source, call.startLine)) continue;
			findings.push({
				file: relativeModulePath(file),
				line: call.startLine + 1,
				severity: "error",
				message: "pi.registerTool call has no `parameters:` field; the LLM provider would reject tool calls with \"function parameters is empty\" (400)",
			});
			continue;
		}
		if (hasOptOutComment(source, extracted.line - 1)) continue;
		const resolved = resolveRhs(extracted.rhs, file, sourceLines);
		if (resolved.kind === "inline-object" || resolved.kind === "imported-object") continue;
		const severity: Severity = resolved.kind === "imported-bad" ? "error" : "error";
		findings.push({
			file: relativeModulePath(file),
			line: extracted.line,
			severity,
			message: `parameters: ${resolved.detail}`,
		});
	}
	return findings;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
