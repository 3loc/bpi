---
name: shell-quality
description: Design and review repo-bound shell scripts (`.sh`/`.bash` files, shebang'd extensionless scripts, sourced shell libs) for brittleness: hardcoded lists that should be derived, stale comments that lie about behavior, fragile inline embedding of multi-language programs, awkward escape chains. Use when writing, rewriting, or meaningfully editing a script destined to live in a repo, or when reviewing one for robustness. Complements `shellcheck-repo` (syntax gate) with a design gate. NOT for ad-hoc shell commands.
compatibility: none (no runtime dependency)
---

# Shell script quality

A repo-bound script that *works* today but breaks the moment someone
edits it is worse than one that fails loudly now. Brittle patterns
(hand-maintained lists, inline multi-language programs, comments that
describe behavior that has since changed) survive review, ship, and
rot quietly.

## Triggers — load this skill before any of:

- Writing a new `.sh`/`.bash` file, or a shebang'd extensionless script
- Editing an existing repo script in a way that changes its structure
- Reviewing a script for robustness after a bug or stale-output report

## Process

1. **Read the relevant reference** before writing or reviewing:
   - New structural code → [`references/anti-patterns.md`](references/anti-patterns.md)
     and [`references/improvements.md`](references/improvements.md)
   - Editing existing code → [`references/anti-patterns.md`](references/anti-patterns.md)
     to see whether it already leans on one of these patterns
2. **Apply the improvements that fit.** Don't refactor inherited
   patterns unprompted; new code ships at the better rung.
3. **Gate on shellcheck** — once design is clean, run
   `shellcheck --severity=warning <file>` (see `shellcheck-repo`).
4. **Run the script** end-to-end on a representative input. A script
   that has never been executed is not done.

## Principles (load-bearing)

- **Derive, don't hardcode.** If a list mirrors a directory, a config,
  or a code-emitted value (`registerFlag`, frontmatter, package field),
  read it from the source on every run. The list cannot drift if it
  doesn't exist.
- **Comments must match the code.** Stale comments mislead every
  future edit and every code review. Update or delete on every edit.
- **Inline multi-language literals are fragile.** A multi-line awk,
  sed, or python program inside a bash string will eventually break.
  Prefer a quoted heredoc (`<<'EOF'`) for embedded programs, or
  extract to a companion file (`.awk`, `.py`) when the body grows.
- **Awkward escapes signal the wrong string context.** If you're
  typing `\"` chains or `'\''` repeatedly, the data should leave the
  bash string — via a heredoc, a file, or a separate tool.