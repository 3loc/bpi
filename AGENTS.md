# AGENTS.md — rules for working in this repository

This repository (`my-pi`) is a **pi package**: it is the single source of
truth for this machine's pi extensions and skills. It is registered in
`~/.pi/agent/settings.json` under `packages` and loaded by reference.

How the registration works: `pi install` (run by `./install.sh`) stores
the repo as a path **relative to the settings file's directory**
(`~/.pi/agent/`), e.g. `"../../src/my-pi"` — pi resolves it to the
absolute repo path at every startup. Nothing is copied; the settings
entry is a live link to wherever the repo sits on disk. Consequences:

- Moving or renaming the repo (or its parents) silently breaks the
  link — `pi list` then shows a stale path. After relocating or
  freshly cloning, re-run `./install.sh` from the new location (it
  overwrites the entry), then `./verify.sh`.
- `verify.sh` check 1 greps `pi list` for this checkout's absolute
  path, so it fails loudly when the link points elsewhere.

## Hard rules

1. **Never install pi customizations globally.** Do not create or edit
   files under `~/.pi/agent/extensions/`, `~/.pi/agent/skills/`, or
   `~/.agents/skills/`. Extensions and skills belong in this repo:
   `extensions/<name>/index.ts` and `skills/<name>/SKILL.md`.
2. **This repo is loaded at startup.** Skills here are already in the
   system prompt; extension commands are already registered. Nothing
   needs to be copied anywhere for pi to pick it up — `/reload` or the
   next start is enough.
3. **Verify changes with `./verify.sh`** (add a check when adding a new
   extension or skill). It must pass before committing.

## Conventions

- Adding a skill: `skills/<name>/SKILL.md` with `name` + `description`
  frontmatter; mention external runtime dependencies (e.g. the `ddgs`
  CLI for `ddgs-websearch`) in `compatibility` and in a Setup section.
- Adding an extension: `extensions/<name>/index.ts` exporting a default
  factory `(pi: ExtensionAPI) => void`; register a flag when practical
  so `pi --help` + `verify.sh` can prove it loaded.
- Update `README.md` tables and `install.sh` Resources output when the
  contents change.
- `local-context` extension intentionally does nothing in this repo:
  this AGENTS.md exists, so native context loading covers it.
- Commits: short imperative subjects, body lists what/why.
