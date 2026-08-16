# my-pi

My personal [pi](https://pi.dev) extensions and skills, persisted as a pi package.

## Contents

### Extensions

| Extension | Provides |
|-----------|----------|
| [`extensions/plan-mode`](extensions/plan-mode/README.md) | `/plan`, `/todos`, `Ctrl+Alt+P`, `pi --plan` — three-phase plan workflow (read-only planning → tracked execution with `[DONE:n]` progress) |

### Skills

| Skill | Provides |
|-------|----------|
| [`skills/ddgs-websearch`](skills/ddgs-websearch/SKILL.md) | Web/news/image/video/book search and URL content extraction via the `ddgs` CLI (no API keys). Loads automatically when a task needs fresh web info; also usable as `/skill:ddgs-websearch`. Requires `ddgs` on PATH |

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
next pi start. Verify with `pi list`, or fully with `./verify.sh`.

## Startup & load order

pi reads this repo at startup, **before** actioning your first command:

1. pi starts → reads `~/.pi/agent/settings.json` → `packages` entry
   points here (path is resolved against the settings file, not cwd,
   so the repo loads no matter where pi is launched)
2. Extensions in `extensions/` execute and register commands/keys
   (extension slash commands are user-facing TUI commands — they are
   not part of the model's context; skills are)
3. Skill descriptions from `skills/` are injected into the system prompt
4. Only then is user input processed

Because of (4), a fresh session can use `/plan` or the `ddgs-websearch`
skill on its very first command — no preload or `/skill:` invocation
needed (the full SKILL.md is read on demand when the task matches).

Rules that keep this true:

- Do **not** copy skills from here into `~/.pi/agent/skills/` — pi keeps
  the first skill found on a name collision, so a stale global copy can
  silently shadow this repo
- Edits here apply on the next pi start or `/reload`
- New machine checklist: clone → `./install.sh` → `./verify.sh`

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

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`,
   `description`) — see `skills/ddgs-websearch/SKILL.md` for an example.
2. Restart pi or run `/reload`.

## Notes

- Peer imports (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`,
  `typebox`) are bundled with pi itself — no `npm install` needed.
- Skills are plain markdown (`SKILL.md` + frontmatter), so this package
  has no npm dependencies at all.
- `skills/ddgs-websearch` needs the external `ddgs` CLI at runtime
  (`pip install ddgs`); it self-installs via the Setup section in its
  SKILL.md when missing.
- Prefer moving extensions and skills here over dropping files into
  `~/.pi/agent/extensions/` or `~/.pi/agent/skills/`, so everything is
  versioned in one place.
