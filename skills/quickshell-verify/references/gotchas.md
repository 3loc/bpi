# Quickshell QML gotchas (hard-won)

Quickshell 0.3.0, Hyprland backend. Docs: https://quickshell.org/docs/v0.3.0/

## Singletons

- File per singleton in the config root, `pragma Singleton` at top, root
  type `Singleton`, and BOTH imports: `import Quickshell` (the `Singleton`
  type) + `import QtQuick` (color etc.). Referenced by bare type name
  (`Theme.base`, `Time.time`) from anywhere in the config.
- A singleton referenced only inside a binding that runs late (or only
  read at print time) may not be instantiated at startup — instantiate it
  eagerly (a startup-time binding) if it owns Timers that must run.

## Bindings and reactive state

- **Function-call bindings don't re-evaluate**: `Hyprland.monitorFor(x)` in
  a binding returns null forever if called before monitors exist. Gate on
  a reactive list so the binding re-runs when state lands:
  `Hyprland.monitors.values.length > 0 ? Hyprland.monitorFor(x) : null`.
- `Hyprland.focusedMonitor` / `focusedWorkspace` update live, but
  `focusedWorkspace` is SESSION-GLOBAL (only one exists). Per-monitor truth
  is `HyprlandMonitor.activeWorkspace` (via `monitorFor(screen)`).
- **ObjectModel** is exposed as `.values` — a real JS array
  (map/filter/find/some). There is no `.count`/`.get()`; calling them
  silently no-ops.

## Layouts

- Items inside `RowLayout`/`ColumnLayout`: use `implicitWidth`/
  `implicitHeight` and `Layout.*`. Never `width`/`height`/`anchors` —
  undefined behavior (qmllint's layout warning here is REAL).

## Pragmas

- `//@ pragma UseQApplication` must be the FIRST line of the root file.
  Without it, platform menus (`QsMenuAnchor.open()` — tray context menus)
  and clipboard integration fail at runtime; the config lints and loads
  fine. Parsed at startup only — needs a full quickshell restart, not a
  reload.

## Clock and formatting

- `SystemClock` (Quickshell) instead of shelling out to `date` every
  second; set `precision: SystemClock.Seconds` ONLY if seconds are
  displayed.
- Qt format tokens: `MM` month, `mm` minutes, `HH` 24h, `AP` am/pm.
  (A lowercase-`mm` "month" shipped once and displayed the minute.)

## Tooling vfs (.qmlls.ini)

quickshell adopts an existing `.qmlls.ini` in the config root and re-points
it into `$XDG_RUNTIME_DIR/quickshell/vfs/<path-id>/` (path-id = hash of the
config path). That vfs copy is what lets qmlls resolve the config's
implicit singletons. It does not exist in a fresh clone, so completions
are degraded until quickshell has run once. Regenerating (quickshell never
creates the file itself):

1. `touch .qmlls.ini` (content is irrelevant; quickshell overwrites)
2. Start the config once (`qs -p .`) — "QML tooling support enabled" in
   the log; `ls -l .qmlls.ini` should show the symlink.

## /proc polling

inotify does not fire on `/proc`, so `FileView { watchChanges: true }` is
useless there. Poll with a `Timer` calling `reload()` (e.g. 2s) and parse
in `onLoaded` via `text()`. CPU% = delta of `/proc/stat` jiffies between
polls (first read is baseline-only); mem% from `/proc/meminfo`
`MemTotal - MemAvailable`.

## Quickshell IPC (`qs ipc call`) — runtime-only, invisible to the ladder

The offscreen load-test passes any config whose QML parses and types,
so a fully-wrong IpcHandler ships silently. The rules below are all
verified against a scratch instance; the regression test for the
specific gotchas is the repo's `scripts/ipc-matrix.txt` driven by the
skill's `scripts/ipc-test.sh`.

- **CLI subcommand names shadow handler functions.** `qs ipc`'s
  subcommands are `show`, `call`, `wait`, `listen`, `prop`. A handler
  function with any of those names is uncallable: the parser matches
  the keyword in the function-name slot too, so
  `qs ipc call overview show all` dies in argparse (rc=109, handler
  never reached). Never name a handler after a `qs ipc` subcommand.
- **Typed parameters enforce EXACT argument counts.** Missing trailing
  args reject the call with rc=0 and stderr
  `"Too few arguments provided"`. Extra args likewise reject with
  `"Too many arguments provided"`. Optional trailing args are
  impossible. The shape that works: one **fixed-arity** function per
  intent (`shot <mode>` vs `shotTo <mode> <dest>`; `open` vs
  `openAll` vs `openOn <screen>`).
- **Untyped parameters unregister the function entirely.** A handler
  declared `function foo(a, b)` (no `: string` annotations) is silently
  not registered — `qs ipc show` will not list it and `call` will say
  `"Function not found"`. Always type your parameters.

## IPC test harness: instance-selection gremlins

The `qs ipc` CLI selects among running instances for a config path by
**PID**, and the default picks the **oldest**. Killed instances leave
their per-pid socket symlink behind (a proper exit removes it; a
SIGTERM at the wrong moment does not). Two failure modes to know:

- **"Not ready to accept queries yet"** almost always means the CLI
  connected to a stale socket of a previously-killed instance. Pass
  `-i <id>` or `--newest` (or wipe the registry dirs as a last
  resort). The skill's `ipc-test.sh` and `qml-selftest.sh` handle this
  for you by waiting on the per-pid symlink and selecting by id.
- **Never `pkill -f "qs -p"`** — the pattern matches the bash process
  running the test block too (its `cmdline` contains the string),
  silently killing the rest of the block mid-flight. Use
  `kill $(pgrep -x qs)`.
