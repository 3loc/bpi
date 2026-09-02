---
name: code-comments
description: "Comment discipline for repo code: default is no comment (names and structure carry the what); why-comments for rationale, constraints, workarounds, and references; what-comments only for genuinely complex logic. Never narrate the editing session — no 'changed X', 'per request', changelogs, or commented-out code. Use when writing or editing code destined for a repo, or reviewing its comments. All languages; complements the same-named principle in shell-quality."
compatibility: none (no runtime dependency)
---

# Code comments

Write comments for the reader of the final code, not the reader of your
diff. Most comments written mid-session are session residue — notes about
what was just changed and why *now*. The session ends, the comment stays,
and the next reader trusts a stale narrative.

## Triggers — load this skill before any of:

- Writing new code files destined for a repo
- Adding or editing comments in existing repo code
- Reviewing a diff or PR for comment quality

Not for: commit messages, READMEs, design docs, or documentation files —
only comments living inside code.

## The hierarchy

1. **No comment.** The default. Good names, small functions, and clear
   structure already state what the code does; restating it adds a second
   source of truth that will drift.
2. **Why-comment.** The workhorse. Rationale the code cannot express:
   constraints, non-obvious decisions, workarounds for upstream bugs,
   trade-offs, references to specs/issues/measurements.
3. **What-comment.** Rare. Only when the logic is genuinely complex —
   dense algorithms, bit tricks, subtle regex, concurrency ordering,
   index math. State the invariant or the effect of the block, not a
   line-by-line translation.

## Banned: session commentary

Comments must never reference the editing session, its requests, or its
history:

- "Now we X", "changed to Y", "updated per request", "as discussed"
- Changelogs, edit notes, or timestamps in comments (git history owns these)
- TODO/FIXME scratch residue from the current session
- Commented-out code kept "just in case" (git history owns this too)

The test: would this comment make sense to a reader who has never seen
any earlier version of the file and knows nothing about the session?
If not, delete it.

## Principles (load-bearing)

- **Why over what.** If a comment merely restates the adjacent line,
  delete it or rewrite it as rationale.
- **Complexity earns the what-comment.** Before writing a what-comment,
  try harder names or smaller units once more; comment what remains.
- **Comments are coupled to the code.** On every edit, update or delete
  the affected comments. A stale comment is worse than none — the same
  rule `shell-quality` applies to scripts, generalized to all code.
- **Point at authorities.** Cite the issue/PR/upstream commit for
  workarounds; cite the source or measurement for magic numbers.
- **Prefer deletion over commenting out.** Delete; git remembers.

## Good / bad

Bad — what-restatement plus session residue:

```python
# Increment the counter
i += 1
# Changed: user asked to raise the limit from 10 to 25
LIMIT = 25
```

Good — why, with an authority:

```python
# 25: matches the UI page size; the API rejects anything larger
# (upstream issue #4312 — drop the cap when we're on v3)
LIMIT = 25
```

Bad — narrating what names already carry:

```js
// Loop over users and filter active ones
users.filter((u) => u.status === "active");
```

Good — a what-comment earned by real complexity:

```js
// Rows are stored top-down but the layout engine draws bottom-up;
// without the negation, children render above their parents.
const y = -node.row * ROW_HEIGHT;
```
