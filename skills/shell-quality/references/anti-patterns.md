# Anti-patterns

One entry per pattern. Append a new section; don't reorganize the
existing ones.

## Hardcoded list that mirrors a directory or code-emitted value

**Looks like:** a `for x in foo bar baz` loop over a fixed name list,
where `foo/`/`bar/`/`baz/` also exist on disk, or where each name has
a counterpart emitted by code (`registerFlag("name", ...)`, a
`package.json` field, a SKILL.md `name:` line, etc.).

**Why it's brittle:** the list and the source drift independently.
New entries are silently missing from the script. The drift is
invisible until someone runs the script and gets a wrong answer.

**Fix:** glob or grep the source. Always assert non-empty.

```bash
shopt -s nullglob
items=(./things/*)
[[ ${#items[@]} -gt 0 ]] || { echo "FAIL: nothing to do" >&2; exit 1; }
for x in "${items[@]}"; do ...
```

## Stale comment that describes behavior the code no longer has

**Looks like:** a header comment block listing checks/stages/options
that don't match the code below (renamed functions, removed cases,
added cases). Often left over from a rename or refactor.

**Why it's brittle:** readers trust comments. A wrong comment
misleads every future edit and every code review.

**Fix:** on any structural code edit, search for the old names in
comments and update or delete. Treat comment drift as a bug, not a
doc nit.

## Long inline literal string mixing bash and another language's tokens

**Looks like:** an awk/sed/python program embedded in a single-quoted
bash string spanning many lines, with `#` comments, `$N`, `\"`
escapes, and bash-style substitution mixed with awk-style variable
references inside the body.

**Why it's brittle:** a typo or paste error inside a long literal
string is silent (bash doesn't syntax-check the interior), editors
mishighlight, and any future author who needs a single quote inside
the embedded program has to fight `'\''` escapes.

**Fix:** either wrap the body in a quoted heredoc (`<<'EOF'` —
removes the closing-quote trap and lets you write `'` freely inside);
or extract the embedded program to a companion file (`foo.awk`,
`foo.py`) and invoke it. Companion-file form is strictly better once
the body exceeds ~30 lines or contains comments.

## Awkward escape chain signaling wrong string context

**Looks like:** more than one level of escape nesting inside a string
literal — `"...\\\"foo\\\"..."`, `'a'\''b'\''c'`, mixed backtick and
`$()` nesting.

**Why it's brittle:** each layer is a chance for off-by-one escapes;
readers can't audit the result without expanding it in their head;
the writer usually wanted the data to be in a different context to
begin with.

**Fix:** if the data is a program, put it in a heredoc or a file. If
it's data, write it once with the natural quoting of the destination
(format string, JSON, SQL — whatever consumes it) instead of bash
strings. If it really must stay in bash, prove the unescaped form
with `printf '%q'` and compare against expectations.