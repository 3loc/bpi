/**
 * Tests for the tool-parameter schema scanner.
 *
 * What this locks down:
 *   - `checkTools` accepts the current extensions (sanity check: no
 *     false positives against the existing repo).
 *   - The scanner rejects the original bug class (parameters: <interface>)
 *     and the other type-only failure modes.
 *   - Inline `Type.Object({...})` literals and imported `Type.Object(...)`
 *     bindings both pass — both are the recommended shapes.
 *   - The `@tools-check-ok` opt-out is honored.
 *   - The scanner's brace walker handles multi-line tool calls and
 *     nested expressions.
 *
 * Run:  node --test --experimental-strip-types extensions/tools-check/check.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTools, findExtensionEntries, extractParametersRhs } from "./check.ts";

describe("findExtensionEntries", () => {
	it("returns [] when extensions dir is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "tools-check-"));
		try {
			assert.deepEqual(findExtensionEntries(root), []);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	it("lists every <root>/extensions/*/index.ts", () => {
		const root = mkdtempSync(join(tmpdir(), "tools-check-"));
		try {
			for (const name of ["alpha", "beta"]) {
				mkdirSync(join(root, "extensions", name), { recursive: true });
				writeFileSync(join(root, "extensions", name, "index.ts"), `// ${name}\n`);
			}
			const got = findExtensionEntries(root);
			assert.deepEqual(got.map((p) => p.endsWith("/alpha/index.ts") || p.endsWith("/beta/index.ts")), [true, true]);
			assert.equal(got.length, 2);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
});

describe("extractParametersRhs (multi-line parsing)", () => {
	function body(s: string): string {
		return s;
	}

	it("pulls the literal from a multi-line registerTool", () => {
		const src = body(`pi.registerTool({
	name: "x",
	parameters: Type.Object({
		path: Type.String(),
	}),
});`);
		const got = extractParametersRhs(src);
		assert.ok(got, "extraction succeeded");
		assert.match(got!.rhs, /^Type\.Object\(/);
	});

	it("pulls an imported identifier", () => {
		const src = body(`pi.registerTool({
	name: "x",
	parameters: SomeImportedSchema,
});`);
		const got = extractParametersRhs(src);
		assert.ok(got);
		assert.equal(got!.rhs, "SomeImportedSchema");
	});

	it("trims trailing comma and whitespace", () => {
		const src = body(`pi.registerTool({
	parameters: X ,
});`);
		const got = extractParametersRhs(src);
		assert.ok(got);
		assert.equal(got!.rhs, "X");
	});

	it("returns null when the call has no parameters field", () => {
		const src = body(`pi.registerTool({
	name: "x",
});`);
		assert.equal(extractParametersRhs(src), null);
	});
});

describe("checkTools (file scanner, repo level)", () => {
	const rootRepo = process.cwd();

	it("returns ok for the current repo (no false positives)", () => {
		const result = checkTools(rootRepo);
		if (!result.ok) {
			for (const f of result.findings) {
				console.error(`${f.file}:${f.line} [${f.severity}] ${f.message}`);
			}
		}
		assert.ok(result.ok, `expected no findings, got ${result.findings.length}`);
	});

	it("finds at least one extension to scan", () => {
		const entries = findExtensionEntries(rootRepo);
		assert.ok(entries.length >= 2, `expected at least two extension index.ts files, got ${entries.length}`);
	});
});

describe("checkTools (synthetic fixtures, lock the bug class)", () => {
	function withFixture(name: string, files: Record<string, string>, run: (root: string) => void): void {
		const root = mkdtempSync(join(tmpdir(), `tools-check-${name}-`));
		try {
			mkdirSync(join(root, "extensions", "ext"), { recursive: true });
			for (const [path, body] of Object.entries(files)) {
				const abs = join(root, path);
				mkdirSync(abs.replace(/\/[^/]+$/, ""), { recursive: true });
				writeFileSync(abs, body);
			}
			run(root);
		} finally {
			rmSync(root, { recursive: true });
		}
	}

	it("rejects parameters: Type.Intersect({})... i.e. anything not Type.Object", () => {
		withFixture("not-object", {
			"extensions/ext/index.ts": `import { Type } from "typebox";
export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: Type.Intersect([Type.Object({})]),
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok, "non-Object schema should fail");
			assert.ok(result.findings.length >= 1);
			assert.match(result.findings[0]!.message, /Type\.Intersect/);
		});
	});

	it("rejects parameters: undefined", () => {
		withFixture("undefined-rhs", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: undefined,
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
			assert.match(result.findings[0]!.message, /undefined|empty|leaf/);
		});
	});

	it("rejects parameters: null", () => {
		withFixture("null-rhs", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: null,
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
		});
	});

	it("rejects the string \"Type.Object\" (parens forgotten)", () => {
		withFixture("string-rhs", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: "Type.Object",
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
			assert.match(result.findings[0]!.message, /string literal/);
		});
	});

	it("rejects an identifier imported from a non-schemas module that exports an interface", () => {
		withFixture("interface-import", {
			"extensions/ext/tools.ts": `export interface RunParams { command: string; }
`,
			"extensions/ext/index.ts": `import type { RunParams } from "./tools.ts";
export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: RunParams,
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
			const f = result.findings[0]!;
			assert.match(f.message, /interface|TypeScript type-only/);
		});
	});

	it("rejects a type alias imported and passed as parameters", () => {
		withFixture("type-alias-import", {
			"extensions/ext/tools.ts": `export type RunParams = { command: string };
`,
			"extensions/ext/index.ts": `import { type RunParams } from "./tools.ts";
export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: RunParams,
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
			const f = result.findings[0]!;
			assert.match(f.message, /interface|TypeScript type-only/);
		});
	});

	it("accepts inline Type.Object({...})", () => {
		withFixture("inline-object", {
			"extensions/ext/index.ts": `import { Type } from "typebox";
export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: Type.Object({ path: Type.String() }),
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});

	it("accepts an imported identifier declared as `const X = Type.Object(...)`", () => {
		withFixture("imported-object", {
			"extensions/ext/schemas.ts": `import { Type } from "typebox";
export const RunParams = Type.Object({ command: Type.String() });
`,
			"extensions/ext/index.ts": `import { RunParams } from "./schemas.ts";
export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: RunParams,
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});

	it("rejects a registerTool call that omits parameters entirely", () => {
		withFixture("no-parameters", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		description: "no params",
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
			assert.match(result.findings[0]!.message, /no `parameters:`/);
		});
	});

	it("respects // @tools-check-ok above a registerTool call (no false negative when omitted intentionally)", () => {
		withFixture("opt-out", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	// @tools-check-ok — we intentionally register a tool without parameters; the LLM provides no args
	pi.registerTool({
		name: "x",
		description: "no params",
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});

	it("respects // @tools-check-ok above the parameters: line (unresolvable computed RHS)", () => {
		withFixture("opt-out-params", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		// @tools-check-ok — schema is computed at runtime from another config
		parameters: computeSchema(),
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});

	it("rejects a function call RHS (computeSchema()) without opt-out", () => {
		withFixture("no-opt-out-fn", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	pi.registerTool({
		name: "x",
		parameters: computeSchema(),
	});
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(!result.ok);
		});
	});

	it("ignores pi.registerTool mentions inside string literals (description, docstring)", () => {
		withFixture("in-string", {
			"extensions/ext/index.ts": `export default function (pi: any) {
	// scans every pi.registerTool(...) call for the bug class
	const description = "Scan every extension's pi.registerTool(...) call here";
	pi.registerFlag("tools-check", { type: "boolean", default: false });
	pi.registerCommand("tools-check", { description, handler: async () => {} });
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});

	it("ignores pi.registerTool mentions inside multi-line block comments", () => {
		withFixture("in-block-comment", {
			"extensions/ext/index.ts": `/* The first version of this extension called
 * pi.registerTool({ parameters: SomeInterface }) and that was 400.
 * We now register only a flag + command.
 */
export default function (pi: any) {
	pi.registerFlag("x", { type: "boolean", default: false });
}`,
		}, (root) => {
			const result = checkTools(root);
			assert.ok(result.ok, result.findings.map((f) => f.message).join("\n"));
		});
	});
});
