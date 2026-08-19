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
