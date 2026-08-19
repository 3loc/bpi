---
name: yaml-lint-repo
description: Run yamllint and a formatter (prettier or yamlfmt) on YAML files destined for a repository — `.yaml`/`.yml` files, kustomize overlays, helm values, CI workflows, docker-compose, and any markdown frontmatter (SKILL.md, package manifests) — before claiming the YAML works or the task is done. NOT for YAML printed by a tool to stdout or embedded in prose.
compatibility: yamllint (>= 1.30) recommended for the lint gate; prettier (>= 3) or yamlfmt (>= 0.16) optional for the format check; PyYAML (any 5.x/6.x) implicit via yamllint for the parse probe. Each tool is checked with `--version` if present; absence degrades the gate (warn + skip), it does not block the skill.
---

# YAML lint + format gate for repo files

**Rule: every YAML file that will live in a repo gets linted and
parse-checked before reporting it as done.** A "works on my machine"
YAML claim is not valid without a clean lint + parse run.

Design quality (comment survivability, quoting strategy, implicit-type
choices, sub-format conventions) lives in `yaml-quality` — this skill
is the **mechanical gate** only.

## When this applies — and when it doesn't

**Applies** (a file will be committed):
- Creating or editing `.yaml` / `.yml` files anywhere in the repo
- Creating or editing markdown frontmatter (`SKILL.md`, package
  manifests) — yes, that is YAML
- Kustomize overlays, helm values, CI workflows, docker-compose,
  GitHub Actions

**Does NOT apply** (throwaway, no file):
- YAML printed by a tool to stdout
- YAML embedded in code blocks or prose
- One-off YAML in chat / CLI examples

If the same YAML is written to a file, the file applies — even if it
was already produced ad hoc.

## Setup (only if tools are missing)

None of these are required. Install what helps; absence just
degrades the gate.

```bash
# yamllint (the lint itself)
sudo pacman -S yamllint
sudo apt install yamllint
sudo dnf install yamllint
# or: pipx install yamllint
yamllint --version

# prettier (multi-language formatter, preserves comments)
npm install -g prettier
prettier --version

# yamlfmt (YAML-only, more aggressive — only if you don't round-trip comments)
go install github.com/google/yamlfmt/cmd/yamlfmt@latest
yamlfmt --version
```

PyYAML is the implicit yamllint dependency, so the parse probe works
whenever yamllint does.

## The gate (run before declaring the file done)

```bash
# 1. Lint (relaxed: no line-length, no doc-start, no comment-indent
#    — those are style choices, not correctness)
yamllint -d default \
  -d "{extends: relaxed, rules: {line-length: disable, document-start: disable, comments-indentation: disable}}" \
  <file>

# 2. Parse probe (catches the unquoted-colon-space bug and other
#    ambiguous scalars that yamllint misses)
python3 -c "import yaml; yaml.safe_load(open('<file>'))"

# 3. Format check (optional — only if prettier or yamlfmt is installed)
prettier --check <file>                  # or: yamlfmt -dry <file>
```

Steps 1 + 2 exit 0 → gate passed. Step 3 is recommended but skipped
silently with a `warn:` if the tool isn't installed.

### Variants

- Tightening the lint: add `truthy: {allowed-values: ['true', 'false']}`
  to surface the Norway problem; add `octal-values: enable` to catch
  `010` parsing as 8
- Prettier-only: drop the yamllint half; you lose implicit-type
  detection. Add it back as soon as you can
- YAML embedded in JSON (a `.json` file with YAML shape): out of
  scope — use `jsonlint`
- Multi-document YAML: yamllint checks each document; the parse
  probe must load all of them

## Common yamllint findings (and what they mean)

- `truthy` — `NO`, `yes`, `off`, `on` parsed as booleans. **Quote them.**
- `octal-values` — `010` parsed as 8. **Quote it.**
- `key-duplicates` — same key twice (last wins silently). **Fix at source.**
- `comments-indentation` — comment column must align with the key
  above. **Reindent.**
- `indentation` — tabs forbidden; 2-space default. **Replace tabs.**
- `document-start` — missing `---` at top of file. **Add it or accept.**
- `empty-lines` / `new-line-at-end-of-file` / `trailing-spaces` —
  formatting. **Trim or accept.**

## Editing pre-existing files

Don't refactor an inherited wall of warnings unprompted. Instead:

1. Run the gate **before** editing — that's the baseline
2. Make the edit
3. Re-run; the file must not have **new** findings versus the baseline

For an existing `truthy`/`octal-values` finding: do not silently "fix"
it before pulling the maintainer — changing `NO: "Norway"` to
`NO: Norway` flips the parse type. New code ships clean; legacy
findings stay until someone owns the cleanup.

## Repo sweep (many YAML files touched, or bootstrapping lint in a repo)

```bash
# tracked .yaml/.yml files
git ls-files -z -- '*.yaml' '*.yml' \
  | xargs -0 -r yamllint -d default \
      -d "{extends: relaxed, rules: {line-length: disable, document-start: disable, comments-indentation: disable}}"

# SKILL.md frontmatter (extract + lint)
for f in skills/*/SKILL.md; do
  awk '/^---$/{c++; next} c==1{print} c==2{exit}' "$f" \
    | yamllint -d default \
        -d "{extends: relaxed, rules: {line-length: disable, document-start: disable, comments-indentation: disable}}"
done
```

Clean (exit 0) → report the sweep as passed.
