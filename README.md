# my-pi

My personal [pi](https://pi.dev) extensions, persisted as a pi package.

## Contents

| Extension | Provides |
|-----------|----------|
| [`extensions/plan-mode`](extensions/plan-mode/README.md) | `/plan`, `/todos`, `Ctrl+Alt+P`, `pi --plan` — three-phase plan workflow (read-only planning → tracked execution with `[DONE:n]` progress) |

## Install

```bash
./install.sh
```

which runs `pi install /path/to/this/repo` at **user scope** (registered in
`~/.pi/agent/settings.json`, active in every project — deliberately not
project-local).

Manual equivalent:

```bash
pi install ~/src/my-pi
```

pi registers the repo **by reference, without copying**: this repository is
the single source of truth. Edits here are picked up by `/reload` or the
next pi start. Verify with `pi list`.

## Uninstall

```bash
./uninstall.sh
```

## Adding a new extension

1. Create `extensions/<name>/index.ts` exporting a default factory:

   ```typescript
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

   export default function (pi: ExtensionAPI) {
     // pi.registerTool(...), pi.registerCommand(...), pi.on(...)
   }
   ```

   (or a single `extensions/<name>.ts` file — both shapes are discovered)

2. Restart pi or run `/reload`.

## Notes

- Peer imports (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`,
  `typebox`) are bundled with pi itself — no `npm install` needed.
- Prefer moving extensions here over dropping files into
  `~/.pi/agent/extensions/`, so everything is versioned in one place.
