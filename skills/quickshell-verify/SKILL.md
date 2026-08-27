---
name: quickshell-verify
description: Verification ladder for Quickshell (QML) shell configs — qmllint triage plus an offscreen `qs -p .` load-test that reproduces exactly the load errors a live session reports, without a compositor. Use when editing, debugging, or verifying any quickshell config (`qs -p` project), especially before claiming a change works, when triaging "Failed to load configuration ... caused by" errors, or when qmllint output looks wrong.
compatibility: Linux with quickshell >= 0.3.0 (`qs` on PATH) and Qt6 qmllint (default /usr/lib/qt6/bin/qmllint; override via QMLLINT env). coreutils `timeout`.
---

# Quickshell Verify

qmllint alone is NOT sufficient — in **both** directions:

- A config that lints "clean" can still fail to load (a real singleton
  error was once misread as a lint false positive and shipped).
- A config with a wall of lint "errors" can load fine: standalone qmllint
  cannot resolve a quickshell config's implicit `qs.*` modules or its
  implicitly registered singletons (no qmldir exists for them).

The authoritative cheap check is the **offscreen load-test**: it runs the
config through the same loader a live session uses, minus the compositor.

## Run it

```bash
<skill-dir>/scripts/verify.sh [config-dir]    # default: .
```

- Exit `0` — ladder passed. Under offscreen the only acceptable failure is
  the compositor backend (`No PanelWindow backend loaded` as the deepest
  `caused by`) or the config running until the timeout.
- Exit `1` — REAL failure: a `Failed to load configuration ... caused by
  @File[lin:col]` chain that does NOT end at the backend line. The live
  session reports the identical chain; fix the deepest cause.
- Exit `2` — tooling missing or unexpected output; read what it printed.

Lint output never changes the exit code (by design — lint is advisory).
Known false positives are filtered out server-side of the report; whatever
remains, triage against [references/lint-triage.md](references/lint-triage.md).

Env overrides: `QS_BIN`, `QMLLINT`, `QS_VERIFY_TIMEOUT` (default 6s).

## The ladder, manually

```sh
# 1. Lint (code issues) — expect qs.*/singleton noise, see triage reference
/usr/lib/qt6/bin/qmllint -I /usr/lib/qt6/qml -I /usr/bin <file>.qml

# 2. Load-test (config-load/type errors — no compositor needed)
QT_QPA_PLATFORM=offscreen timeout 6 qs -p .

# 3. Live run: qs -p . inside the compositor session (agent shells usually
#    can't reach it — rely on 1-2 plus the user)
```

## What the ladder cannot catch

Offscreen never instantiates panel children and has no compositor:

- Runtime-only API requirements — e.g. `QsMenuAnchor.open()` needs
  `//@ pragma UseQApplication` as line 1 of the root file; the config lints
  and loads fine without it, and only *calling* the method (or reading the
  live log) catches it.
- Popup positioning, Hyprland IPC, anything compositor-dependent.
- **`IpcHandler` semantics** — the load-test can't catch a handler
  function shadowed by a `qs ipc` subcommand name, an arity mismatch
  against typed params, or a function silently unregistered because its
  params aren't typed. Verify with `scripts/ipc-test.sh` against a
  matrix of every documented `target func [args]` form (the rules +
  the test harness live in [references/gotchas.md](references/gotchas.md)).

When a change touches such code, verify it with a **scratch config** that
instantiates the object and actually invokes the method (`Timer` +
`console.log` + `Qt.exit(0)`), run offscreen — then hand the rest to the
user for a live run. A scratch test that only *creates* the object is not
enough; this exact gap shipped a broken context menu once.

## Runtime helpers

For IPC and pure-QML runtime checks the skill ships two small scripts
(generic; usable on any quickshell config):

- `scripts/ipc-test.sh --config <dir> --matrix <file>` — boots a
  scratch config offscreen, runs each matrix line as `qs ipc call`,
  asserts parse + arity + handler invocation (via an `IPCMARK`
  console.log injected by `extract-ipc-handlers.py`).
- `scripts/qml-selftest.sh <dir>` — runs a scratch `shell.qml` whose
  last statement is `Qt.exit(rc)`, propagating its exit code.

Both own instance lifecycle (boot, wait on the per-pid IPC socket,
kill by PID, no stale-socket "not ready" surprises) so callers never
hand-roll those steps.

## References

- [references/lint-triage.md](references/lint-triage.md) — false positives
  vs. real warnings, and how singleton failures cascade across files.
- [references/gotchas.md](references/gotchas.md) — hard-won quickshell QML
  rules: singletons, reactive bindings, layouts, ObjectModel, pragmas,
  SystemClock/format tokens, tooling-vfs (.qmlls.ini), /proc polling.
