# Improvements

One entry per pattern. Append a new section; don't reorganize the
existing ones.

## Derive lists from the tree

Glob the directory, grep the source, or `jq` the manifest — whatever
the source of truth is. Pre-condition: assert non-empty and fail
loudly when the source disappears. Pair with `shopt -s nullglob` so
an empty result isn't silently one missing entry.

## Quoted heredoc for embedded programs

`<<'EOF'` (single-quoted delimiter = no expansion) for any embedded
program spanning more than a few lines, especially if it contains `#`
comments. Same literal-passthrough as `'…'`, but no closing-quote
trap on edits, and `'` is freely usable inside.

## Extract to a companion file when the body grows

Beyond ~30 lines or any complexity worth testing in isolation,
extract `.awk` / `.py` / etc. to a sibling file. Lint it standalone
(`gawk -f foo.awk /dev/null`), test with a fixture, and keep the
bash wrapper minimal (`tool ... | program_runner "$config"`).

## Hoist repeated subprocess calls

If you call `pi --help`, `git status`, `qmllint`, etc. more than once
in a script, capture once into a variable and grep it. Saves time,
avoids divergent output between calls, and makes the intent obvious.

## Update comments with the code they describe

Treat the comment block above a function as part of the function.
On every structural edit, ask "does this comment still match?" and
delete or rewrite the parts that don't. Better to have no comment
than a wrong one.

## Pass caller data via `-v` (or `ARGV`), never by interpolation

For awk specifically: pass shell state in via `awk -v key="$val"`,
not by letting `$val` expand inside the awk source. Keeps the awk
program a literal and removes a class of injection bugs.

## Fail loudly on empty derivations

If a glob returns zero hits or a grep returns no matches, do not
silently proceed — print `FAIL: ...` to stderr and `exit 1`. A
script that reports "0 things processed" without complaint is a
script whose inputs have drifted out from under it.