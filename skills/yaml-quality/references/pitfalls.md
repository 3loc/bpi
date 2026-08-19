# YAML pitfalls

One entry per pattern. Append a new section; don't reorganize the
existing ones.

## Implicit-type footguns (silent parse change)

**Looks like:** A YAML value that *looks* like a string but parses
to a number, boolean, or null. The file loads fine, but the consumer
gets a different type than the author intended.

**Why it's brittle:** `yaml.safe_load`, `gopkg.in/yaml.v3`, and most
consumers do NOT warn about implicit typing. The bug only surfaces
at the consumer, often far from the source. `yamllint` catches *some*
cases (`truthy`, `octal-values`) but not all (especially
sexagesimal-style values, which YAML 1.2 actually treats as strings
but YAML 1.1 treated as numbers).

**Fix:** Quote anything that must be a string:

```yaml
country: "NO"        # NOT `country: NO` — parses as false (Norway problem)
country: "GB"
ratio: "1:30"        # NOT `ratio: 1:30` — parses as 90 in YAML 1.1 (sexagesimal)
ratio: "1/30"
port: "010"          # NOT `port: 010` — parses as octal 8
port: "10"
zip: "07720"         # NOT `zip: 07720` — parses as 511 (octal)
enabled: "true"      # probably fine unquoted, but explicit is safer
```

**Detection:**
- `yamllint` with `truthy: {allowed-values: ['true', 'false']}`
- `yamllint` with `octal-values: enable`
- The `yaml-lint-repo` parse probe does NOT catch this — it only
  confirms the file parses. The *type* check (does it parse as the
  intended type?) is the design-gate's job, not the lint-gate's.

---

## Unquoted colon-space (the parse-time bomb)

**Looks like:** A scalar value that contains `: ` (colon followed by
space) inside an unquoted mapping entry.

**Why it's brittle:** YAML's compact-mapping grammar treats `: ` as a
nested mapping indicator. The parser either errors (strict) or
silently starts a nested mapping (lenient). The bug is invisible
until a future tool change tightens the parser — and the kind of
project that has YAML frontmatter in many files is the kind where
swapping to a stricter parser mid-life is plausible.

**Fix:** Quote the value the moment it contains `: `, or any other
character that would shift the scalar into a different grammar
production (`:`, `#`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`,
`` ` ``).

```yaml
# Bad:
description: foo: bar

# Good:
description: "foo: bar"
```

**Detection:**
- `yamllint` does NOT flag this consistently (depends on the line's
  surrounding context).
- The parse probe in `yaml-lint-repo` will catch it if the parser is
  strict (PyYAML is; mikefarah/yq is more lenient).
- Best defense: quote-on-suspicion, period.

---

## Comments that don't survive the formatter

**Looks like:** A `# comment` that explains *why* a scalar is what
it is, an `# noqa` for a known-false-positive yamllint rule, or a
section divider comment.

**Why it's brittle:** Most YAML serializers treat comments as
disposable:

- `PyYAML` (`yaml.safe_dump` / `yaml.dump`) drops ALL comments
- `prettier` rewrites comments but preserves them
- `yamlfmt` (Google) drops some comments aggressively
- `ruamel.yaml` preserves them (the only commonly-available option
  that does round-trip comment preservation)

A serializer swap in the build pipeline silently erases the
rationale. The next person to edit the file wonders why the value
is that exact number, or what the noqa was for.

**Fix:** Prefer tools that preserve comments. When working in a
pipeline that uses `PyYAML`, never let it round-trip a file with
hand-curated comments — pull the file out of the pipeline, edit it
directly, and re-validate.

**Detection:** Run the file through the format tool and `diff` it
back. Any difference is a comment that won't survive.

---

## Key-order dependency (the warning-less footgun)

**Looks like:** YAML data that relies on keys appearing in a
specific order (e.g. list of patches that must apply in order, init
steps, build stages).

**Why it's brittle:** YAML 1.2 preserves insertion order on load
(`dict` in Python, `object` in JS, `yaml.Node` in Go). JSON also
preserves order in modern specs. BUT:
- Schema validators (kustomize, helm) may not preserve order
- Sorting tools (`yq -s` with `sort_keys`) reorder
- Human editors happily reorder
- A `mikefarah/yq` round-trip may reorder

**Fix:** Don't rely on order for correctness. If order matters, use
an explicit list of single-key maps (`[ {name: a}, {name: b} ]`)
or a list of names plus a parallel lookup table.

---

## Round-trip drift (the gradual rewrite)

**Looks like:** A pipeline that does `yaml.safe_load` → modify →
`yaml.safe_dump` → write. The output file looks "almost the same"
but every comment is gone, quote style has flipped, key order has
shuffled, indentation has changed.

**Why it's brittle:** The diff is huge every time. Reviewers learn
to ignore it. When an actual bug fix is in the diff, it scrolls
off-screen.

**Fix:** For human-edited files, never let the pipeline rewrite them.
For machine-generated files, separate the template from the
generator — and never `yaml.safe_dump` a file a human might edit
later.
