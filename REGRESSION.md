# REGRESSION

Issues that already bit us and the structural defenses the next session
should build (or harden) to keep them from coming back.

Format:

```
## YYYY-MM-DD — <one-line title>

### What happened
...

### Why the existing gates didn't catch it
...

### Defensive measure shipped in the same fix (lock-in)
...

### Tooling the next session should build
...
```

---

## 2026-09-02 — Tool `parameters:` passed a TypeScript interface, LLM provider returned 400

### What happened

Commit `d6760e5` (rename systemd-jobs → background-tasks) shipped
five `pi.registerTool({...})` calls in
`extensions/background-tasks/index.ts`, each with
`parameters: RunParams` / `StatusParams` / `WaitParams` /
`CancelParams` / `JournalParams`. The `*Params` names were imported
from `./tools.ts` as **values** (no `type` keyword in the import
line). In `tools.ts` they were declared as TypeScript `interface`s.

TypeScript interfaces have no runtime representation — they're erased
at compile time. So at runtime `parameters: RunParams` evaluated to
`parameters: undefined`. The tool spec reached the LLM provider
without a parameters block; the first time the model tried to call
any of the five tools, the provider returned:

```
400: {"type":"bad_request_error",
      "message":"invalid params, function parameters is empty (2013)",
      "http_code":"400"}
```

and refused to forward the call. The whole extension was effectively
dead from the model's point of view.

### Why the existing gates didn't catch it

- **TypeScript compile**: `tsc --noEmit` is not part of verify.sh.
  Strip-types (Node's `--experimental-strip-types`) doesn't typecheck,
  it only strips type syntax. There was nothing to complain about —
  the code was type-correct; the bug was that the type was the
  wrong kind of thing for the runtime.
- **Comment that claimed it was fine**: `tools.ts` had a banner that
  said "the typebox parameter schemas live in index.ts (typebox is a
  peer dep that only resolves inside pi's loader)". Both halves were
  wrong: typebox resolves here just fine (`edit-in-editor` imports it
  directly), and the schemas didn't actually exist anywhere in
  `index.ts`. Comments that document intent without the artifact
  they describe are worse than no comment — they make a future
  reviewer trust the wrong thing.
- **Handler unit tests** (`tools.test.ts`): exercised the handlers
  directly with hand-built param objects, never went through
  `pi.registerTool`. The mis-wiring was invisible from that layer.
- **Live load test** (verify.sh Check 2b3): runs `pi --no-session -p
  "/jobs"` — which exercises the slash command (loads index.ts,
  registers the flag + the `/jobs` handler), but does not exercise
  the tool-call path. The model never calls the tools in this check.
- **Headless `--help` check** (Check 2): only confirms
  `registerFlag` ran. Doesn't introspect `registerTool` arguments.

### Defensive measure shipped in the same fix (lock-in)

1. **Real TypeBox schemas**: `extensions/background-tasks/schemas.ts`
   exports five `Type.Object({...})` constants
   (`RunParamsSchema`, `StatusParamsSchema`, `WaitParamsSchema`,
   `CancelParamsSchema`, `JournalParamsSchema`). `index.ts` imports
   them and passes each to `parameters:`. The runtime `parameters`
   block is now a real TSchema value the LLM provider accepts.

2. **TypeBox is pinned**: `package.json` adds `"typebox": "1.3.7"`
   as a devDependency (matching the version `@earendil-works/pi-coding-agent`
   pins, so the schemas are evaluated against the exact same runtime
   that loads the extension in production). `npm install` fetches
   it. `node_modules/` was already in `.gitignore`.

3. **Per-schema regression tests**: `schemas.test.ts` asserts each
   schema (a) is exported, (b) has `.type === "object"`, (c) has
   the exact property names the matching handler interface
   declares, and (d) `Value.Check` accepts a valid example +
   rejects an invalid one. If someone replaces a schema with
   `Type.Object({})` (empty), an interface, or `undefined`, the
   tests fail at the import line — the same line that would have
   caught the original bug if the suite had existed.

4. **Comment in `tools.ts` rewritten**: the misleading "schemas live
   in index.ts" banner is gone; the new banner points at
   `./schemas.ts`, names the failure mode (400 from the LLM
   provider), and tells the next reader to run `schemas.test.ts`.

5. **verify.sh Check 2e** detects `node_modules/typebox` and skips
   the test gate with a clear "run `npm install`" message rather
   than failing with `ERR_MODULE_NOT_FOUND` (which is unhelpful
   when the underlying cause is "node_modules/ doesn't exist").

### Structural lint (SHIPPED — see `dev/tools-check/`)

The structural lint called for by this section was built shortly
after the original fix landed. The next session that arrives at this
bug will find:

- A scanner module at `dev/tools-check/check.ts` that walks
  `extensions/*/index.ts`, finds every `pi.registerTool({...})` call,
  extracts the `parameters:` RHS, and rejects:
  - `undefined`, `null`, and literal strings (`"Type.Object"`),
  - identifiers that resolve to a TypeScript `interface` or `type`
    alias in the imported module,
  - `import { type Foo }` (per-name type modifier),
  - leaf schemas (`Type.String`, `Type.Intersect`, etc.),
  - calls without a `parameters:` field.
- A pi extension wrapper at `dev/tools-check/index.ts` exposing the
  scanner as a `/tools-check` slash command and a `--tools-check`
  flag. The extension lives under `dev/` (not `extensions/`) so it
  does **not** enter the global install list per pi's package
  configuration; it is loaded on demand for local testing via
  `pi -e dev/tools-check/index.ts` (or `--no-extensions -e …` for
  isolation).
- A unit-test suite (`dev/tools-check/check.test.ts`) at 22 tests
  today: every failure mode listed above is exercised, the two
  happy-path shapes (inline `Type.Object({...})` and the
  `schemas.ts`-pattern import) are accepted, plus two false-positive
  guards (string literal + multi-line block comment mentions of
  `pi.registerTool(...)` do not register as calls) and the documented
  `@tools-check-ok` opt-out.
- **verify.sh Check 2f** runs the scanner in three layers:
  - **Unit**: `node --test` against the scanner module (the
    load-bearing gate).
  - **Isolation**: `pi --no-extensions -e dev/tools-check/index.ts
    --no-session -p "/tools-check"` — only the lint extension is
    loaded.
  - **Full-context**: `pi -e dev/tools-check/index.ts --no-session
    -p "/tools-check"` — auto-discovered extensions plus the lint,
    matching a real session.
  A failure in isolation is the scanner breaking; a failure in
  full-context that's absent in isolation is an interaction with
  another extension or with AGENTS.md injection.
- `npm test` includes the new suite via
  `node --test --experimental-strip-types extensions/background-tasks/ dev/tools-check/`.
- The lint and the per-schema `Value.Check` test suite in
  `background-tasks/schemas.test.ts` are different layers of the
  same defense: the per-schema suite proves the schemas are
  *correct*; the lint proves no extension registers a tool with a
  *missing or type-only* `parameters:` block. Both must remain green.

If you find yourself adding a new extension that calls
`pi.registerTool({...})`, run `./verify.sh --offline` (which
exercises all three layers) before claiming done; the scanner
catches the documented bug class and the documented REGRESSION.md
failure modes.

### Tooling the next session should build (historical design rationale; the build is above)

The schema test locks in this exact bug. The bigger risk is the
*next* instance of the same shape — any extension in this repo (or
in a future one) that calls `pi.registerTool({...})` and passes
something that's not a TSchema. A future maintainer might add a new
extension, copy the broken pattern from history, and skip the
schema test entirely.

Build a **structural lint** that runs as part of `verify.sh`
(likely Check 2b4 or a new dedicated check). The shipped
implementation in `dev/tools-check/` follows this design:

- **What it scans**: every `extensions/*/index.ts`. For each
  `pi.registerTool({...})` call, find the `parameters:` line.
- **What it asserts**: the right-hand side is one of:
  - a `Type.Object({...})` call (text match: matches
    `Type.Object(`),
  - a name that resolves to a known schema constant — best
    enforced by *importing* the extension's schemas module and
    checking the identifier resolves to an object with
    `.type === "object"`. That's how the schemas test does it.
- **What it rejects**: anything else. Specifically:
  - a value imported from `./tools.ts` (the file that holds the
    handler interfaces — almost certainly a TypeScript interface,
    and the import there is a value import which silently becomes
    `undefined` at runtime),
  - the string `"Type.Object"` (someone forgot the call parens),
  - a `Type.*` call that's not `Type.Object` (e.g. `Type.String`
    is a leaf schema, not an object schema, and won't satisfy
    `extends TSchema` for a tool that takes multiple fields),
  - `null`, `undefined`, an inline JSON literal without
    `type: "object"` (works for `JSON.stringify` but pi validates
    via TypeBox's `Value.Check` and expects the TSchema symbol).
- **Where it should live**: `extensions/lint-tools/` (parallel to
  `extensions/edit-in-editor/` — a real pi extension that
  registers a `lint_tools` command and a `--lint-tools` flag for
  CI use), OR a pure script in `scripts/lint-tools.sh` invoked
  from verify.sh. The pure-script version is simpler; the
  extension version gives the agent a `/lint-tools` command for
  ad-hoc runs. Pick the script unless there's an active need for
  the in-agent command.
- **How it integrates**: verify.sh Check 2 + the existing
  `registerFlag` proof are the model — every extension that
  registers tools MUST register at least one flag, and every
  `parameters:` line MUST resolve to a Type.Object. Make the gate
  fail-loud, like the existing shellcheck / yamllint gates
  (warn-only when the scanner isn't installed, fail when it is
  and finds something).
- **Edge cases to handle**:
  - tools with no parameters at all (`Type.Object({})` is valid;
    an empty schema is different from `undefined` — accept the
    former, reject the latter).
  - tools whose `parameters` is computed at runtime (rare;
    require an explicit `@lint-tools-ok` comment on the line
    above the `parameters:` and the scanner respects it).
  - extensions that import schemas from a sub-module (the
    `schemas.ts` pattern) — the scanner should follow the import,
    not just look at `index.ts`. Easiest: scan every `*.ts` under
    the extension dir, not just `index.ts`.

**Why structural**: type checking, `tsc`, and TypeScript-by-itself
all accept the original code. The bug is a runtime property
("does this identifier evaluate to a TSchema when registered?"),
not a type property. The check has to look at the *value* bound
to `parameters:`, which is exactly what the unit test does and
exactly what a text-rule lint does.

**Why a script and not just more unit tests**: the per-schema
tests in `schemas.test.ts` prove the schemas themselves are
correct, but they only run for `extensions/background-tasks`.
A new extension that forgets to write equivalent tests ships
unguarded. A verify.sh check that scans every extension
catches the regression at the repo level, not the per-extension
level.

### Verification of the original fix

- `npm test`: 113 tests, 0 failures (was 91 before the structural
  lint landed; 22 of those are the new `dev/tools-check/`
  suite that locks the scanner itself).
- `./verify.sh --offline`: all checks pass, including the new
  Check 2f (`tools-check structural lint passed (isolation +
  full-context)`).
- `pi --no-session -p "/jobs"`: command runs headless, returns
  the expected "no jobs" message (proves the extension loads and
  registers the slash command).
- `pi --no-extensions -e dev/tools-check/index.ts --no-session
  -p "/tools-check"`: isolation mode, returns
  `ok: tools-check: scanned N extensions; 0 findings` in the
  current repo.
- `pi -e dev/tools-check/index.ts --no-session -p "/tools-check"`:
  full-context mode, returns the same.
- Code-level smoke: each schema has `.type === "object"` and the
  expected `properties` keys, so `pi.registerTool` will receive a
  valid TSchema instead of `undefined`.
