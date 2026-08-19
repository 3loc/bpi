# Repo style conventions

Specific to this repo (`my-pi`). When contributing new YAML, follow
these unless you have a reason to deviate.

## Indentation

- 2 spaces, no tabs. YAML forbids tabs in indentation.
- Block sequences under a key: align continuations with the first
  bullet.

```yaml
# Good:
items:
  - name: foo
  - name: bar

# Avoid (works, but harder to align):
items:
- name: foo
- name: bar
```

## Quote style

- Default: **unquoted** when safe (see `quoting-rules.md`).
- When quoting is needed, prefer single quotes unless the value
  contains a single quote.
- Never use flow style (`{key: value}`) for top-level data; it
  fights line-oriented diffs.

## Document markers

- Top-level files: leading `---` document marker is **optional** in
  this repo (`yamllint` has `document-start: disable` for that reason).
- Multi-document files: every doc gets `---`; the last gets `...`
  (optional but disambiguates).
- Embedded in other files (frontmatter): no `---` needed inside the
  block, but the surrounding fence is the document boundary.

## Key ordering

- Skill / extension metadata: alphabetical by key (the order is
  incidental; alphabetization makes diffs cleaner).
- Lists: as written. Don't sort unless the consumer requires it.
- Mapping fields: as written. Don't sort unless the consumer
  requires it (helm templates sort at render time; kustomize
  preserves).

## Empty values

- Missing → omit the key.
- Null → `null` (lowercase, no quotes).
- Empty string → `""` (explicit, never blank).

## Numbers, booleans, null

- `true` / `false` (lowercase, no quotes) — boolean.
- `null` (lowercase, no quotes) — null.
- `42`, `3.14`, `1e9` — numbers, unquoted.
- `07720` (looks like zip) — **must be quoted** (`"07720"`).
- `country: NO` — **must be quoted** (`country: "NO"`).

## Trailing whitespace + final newline

- No trailing whitespace on any line.
- Exactly one final newline at end of file.
- No blank lines between a key and its first child except for
  visual section breaks.
