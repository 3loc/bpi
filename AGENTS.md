# AGENTS.md — rules for working in this repository

This repository (`bpi`) is a **pi package**: it is the single source of
truth for this machine's pi extensions and skills. It is registered in
`~/.pi/agent/settings.json` under `packages` and loaded by reference.

How development registration works: `pi install` (run by `./install.sh`) stores
the repo as a path **relative to the settings file's directory**
(`~/.pi/agent/`), e.g. `"../../src/bpi"` — pi resolves it to the
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
2. **This repo is loaded at startup — once installed.** The rule
   holds only while the repo is registered in `~/.pi/agent/settings.json`
   (done by `./install.sh` for a development checkout, or by the public
   `pi install git:github.com/3loc/bpi` command). If not installed (e.g. a fresh clone on a
   new machine), pi loads nothing from here: run `./install.sh` and
   `./verify.sh` first — do not work around it by copying files to
   global locations. When registered, skills here are already in the
   system prompt and extension commands are already registered;
   `/reload` or the next start is enough to pick up changes.
3. **Verify changes with `./verify.sh`** — it must pass before
   committing. Extension/skill coverage derives automatically from
   the repo layout (a new extension needs its `registerFlag`, a new
   skill needs valid SKILL.md frontmatter); only bespoke behavior
   needs a hand-written check.

## Conventions

- Adding a skill: `skills/<name>/SKILL.md` with `name` + `description`
  frontmatter; mention external runtime dependencies (e.g. the `ddgs`
  CLI for `ddgs-websearch`) in `compatibility` and in a Setup section.
- Adding an extension: `extensions/<name>/index.ts` exporting a default
  factory `(pi: ExtensionAPI) => void`; register a flag when practical
  so `pi --help` + `verify.sh` can prove it loaded.
- **Skill layering**: when a tool family has both a mechanical gate
  (lint/format/parse) and a design-review dimension, split into two
  skills — `<tool>-repo` for the gate, `<tool>-quality` for the
  design. Lets either be loaded independently and lets the design
  side grow without bloating the gate. Examples: `shellcheck-repo`
  + `shell-quality`; `yaml-lint-repo` + `yaml-quality`. The design
  skill points to the gate in its `Why this is split` section so
  the relationship is not lost.
- Update `README.md` tables and `install.sh` Resources output when the
  contents change.
- `local-context` extension intentionally does nothing in this repo:
  this AGENTS.md exists, so native context loading covers it.
- Commits: short imperative subjects, body lists what/why.
