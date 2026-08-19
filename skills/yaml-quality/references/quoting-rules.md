# Quoting rules

The decision tree for "do I quote this scalar, or not?"

## When YAML requires quotes (always quote)

If the scalar contains any of these, YAML *requires* quoting:

- `: ` (colon-space) — the nested-mapping bug (see `pitfalls.md`)
- `#` — starts a comment
- `&`, `*` — anchor/alias indicators
- `!` — tag indicator
- `|`, `>` — block scalar indicators
- `'`, `"` — quote characters
- `%`, `@`, `` ` `` — reserved for future use
- Leading `-`, `?`, `:`, `,`, `[`, `]`, `{`, `}`, `#`, `&`, `*`, `!`,
  `|`, `>`, `'`, `"`, `%`, `@`, `` ` `` — starts a flow indicator
- Trailing whitespace — drop it; YAML trims but the parse-ambiguity
  isn't worth the detective work

Also require quotes when the value *looks like* a bool, int, null,
sexagesimal, or octal (see `pitfalls.md`):

- `yes`, `no`, `Yes`, `No`, `YES`, `NO`, `on`, `off`, `On`, `Off`,
  `ON`, `OFF` — booleans
- `true`, `false`, `True`, `False`, `TRUE`, `FALSE` — booleans (but
  commonly used unquoted)
- `null`, `Null`, `NULL`, `~` — null
- `123`, `0x1A`, `010` — numbers (octal is the trap)
- `1:30`, `1:30:45` — sexagesimal (YAML 1.1 only; 1.2 treats as string)
- `.inf`, `.nan` — special floats

## When quotes are stylistic (pick a default and stick)

For everything else (plain strings, words, paths, identifiers):
pick a project default and apply it consistently. The two sane
defaults:

- **Single-quote everything** — max safety, but ugly JSON-derived
  values, and fights `prettier`'s default double-quote reformatter
- **No quotes by default, quote on suspicion** — readable, but the
  reviewer must be alert to the implicit-type footguns

This repo's default: **selective quoting** — no quotes unless the
scalar would otherwise hit one of the required cases above.
Reviewers should still flag unquoted booleans / sexagesimals / octals
as bugs.

## When to use double vs single quotes

- Use the **opposite** of whatever the value contains most. Single
  quotes inside → double quotes. Double quotes inside → single quotes.
- Avoid backslash escapes. If you're typing `\"` chains, the data
  should leave the YAML string context — via a YAML literal block
  (`|`), a separate file, or a different format.
- YAML 1.2 escapes with single-quote strings are doubled: `''` for
  one `'`. Double-quote strings use `\n`, `\t`, `\"`, `\\`, etc.

## When to use a literal block (`|`) instead of quoted

For multi-line strings (commit messages, regex, HTML, shell scripts
embedded as data), reach for `|` instead of `\n`-laden quotes:

```yaml
# Bad:
message: "line 1\nline 2\nline 3"

# Good:
message: |
  line 1
  line 2
  line 3
```

Variants:
- `|` — final newline kept (most common)
- `|-` — no final newline
- `>+` — folded to single line with spaces (rare; reads worse than
  single-quoted concatenations)

## When to use a folded block (`>`)

For long prose where hard-wrapping isn't significant (a paragraph
of documentation, a sed program that's a single logical line):

```yaml
# Folded: newlines collapse to spaces (final newline preserved)
description: >
  This is one long paragraph that the source wrote
  across multiple lines for readability.
```

Avoid `>` when the value is machine-consumed (e.g. a regex, a
commit-message template) — the parser will collapse the newlines
into spaces and you'll waste an hour debugging why your regex
doesn't match.
