---
name: yaml-quality
description: "Design and review repo-bound YAML for brittleness: implicit-type footguns (Norway problem, sexagesimal, octal), unquoted colons that break parsing, comments that don't survive the formatter, fragile quoting strategy. Use when writing, editing, or reviewing a YAML file destined for a repo. Complements `yaml-lint-repo` (mechanical gate) with a design gate. NOT for YAML printed by a tool or embedded in prose."
compatibility: none (no runtime dependency; uses judgment, not a tool)
---

# YAML quality

A repo-bound YAML file that *parses today* but breaks the moment
someone edits it, or silently means something different from what
the author wrote, is worse than one that fails loudly now. Brittle
patterns (implicit booleans, unquoted colons, comments the formatter
drops, key-order dependencies) survive review, ship, and rot quietly.

The mechanical lint/format gate lives in `yaml-lint-repo`. This
skill is the **design gate** — the questions lint can't ask.

## Triggers — load this skill before any of:

- Writing a new `.yaml` / `.yml` file, or markdown frontmatter
- Editing an existing repo YAML in a way that changes its structure
- Reviewing YAML for robustness after a bug or stale-output report
- Picking a sub-format convention (kustomize vs helm vs GH Actions
  vs compose) — see `references/sub-formats.md`

## Process

1. **Read the relevant reference** before writing or reviewing:
   - New structural code → [`references/pitfalls.md`](references/pitfalls.md)
     and [`references/quoting-rules.md`](references/quoting-rules.md)
   - Editing existing code → [`references/pitfalls.md`](references/pitfalls.md)
     to see whether it already leans on one of these patterns
   - Sub-format questions → [`references/sub-formats.md`](references/sub-formats.md)
   - Repo style questions → [`references/style.md`](references/style.md)
2. **Apply the improvements that fit.** Don't refactor inherited
   patterns unprompted; new code ships at the better rung.
3. **Gate on `yaml-lint-repo`** — once design is clean, run the
   lint + parse gate.
4. **Round-trip probe** — `yaml.safe_load` the file and check the
   result matches what you wrote (no surprise booleans, no missing
   keys, no string→int coercion).

## Why this is split from `yaml-lint-repo`

YAML covers many sub-formats (kustomize, helm, GH Actions, compose,
argo, flux, ansible, k8s manifests…). Each has its own conventions
and pitfalls; the **design review** side is the one that grows as
we adopt new sub-formats. The **lint gate** (`yaml-lint-repo`) stays
small and focused. Splitting them lets either be loaded independently
and keeps the lint gate from carrying the weight of the design
review. See `AGENTS.md` for the general convention.
