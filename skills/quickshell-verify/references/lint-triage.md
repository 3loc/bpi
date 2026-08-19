# qmllint triage: signal vs. noise

Standalone qmllint (`qmllint -I /usr/lib/qt6/qml -I /usr/bin file.qml`) has
no qmldir for a quickshell config's implicit modules and singletons, so a
large class of warnings is structural noise. `scripts/verify.sh` filters
these automatically; when linting by hand, apply the same table.

## False positives (expected, ignore)

| Warning | Why |
|---|---|
| `Warnings occurred while importing module "qs.<...>"` / `Failed to import qs.<...>` | The config's own module namespace; qmllint can't resolve it |
| `<Type> was not found. Did you add all imports and dependencies?` | Type defined in the config (`BarWindow`, widgets, ...) |
| `Member "X" not found on type "Audio|Time|Theme|<Singleton>"` | Implicitly registered singleton, no qmldir entry |
| `Type X is not declared as singleton in qmldir` | Same |
| `Type PanelWindow is not creatable` / `missing required property modelData from PanelWindow` | quickshell type registration shape |
| `No type found for property "edges"/"gravity"` (on PopupAnchor) | qmltypes gap in quickshell 0.3.0; loads fine |
| `Unqualified access` on a name that IS a config singleton, while its `qs.*` import also failed | Downstream of the import failure — the type is simply unknown |

## Real warnings (never dismiss)

- `Singleton was not found. Did you add all imports and dependencies?`
  → actually a missing `import Quickshell` in a `pragma Singleton` file
  (the `Singleton` type lives there). This one broke a whole config once.
- `Detected width/height/anchors on an item that is managed by a layout`
  → undefined behavior inside Row/ColumnLayout at runtime.
- `Unqualified access` on anything that is NOT a config singleton.
- Unused imports, `Cannot assign <type> to color`, and anything about
  types quickshell CAN resolve.

## How singleton failures cascade

One broken singleton makes every file that (transitively) touches any
singleton fail with `Type X unavailable`, pointing at files that are fine.
**Read the whole `caused by` chain and fix the deepest one** — the shallow
entries are collateral, and "fixing" them wastes time or breaks working
code.

Rule of thumb: qmllint tells you about QML quality; only the offscreen
load-test (`qs -p .`) tells you whether the config loads. A clean lint is
necessary-ish; it is never sufficient.
