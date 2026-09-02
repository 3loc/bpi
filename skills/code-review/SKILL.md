---
name: code-review
description: "Read-only review gate before commits: whenever you are about to create a git commit that the user did not explicitly ask for, first present the pending changes as a structured review report (correctness, scope creep, claims vs reality, conventions, gate results) without editing anything — no fixes, no staging — then stop and ask the user to comment on the review and choose the path forward (fix findings, commit as-is, commit with amendments, hold). Skip entirely when the user explicitly asks to commit; that request is pre-authorization."
compatibility: none (no runtime dependency)
---

# Pre-commit code review

A commit is a public artifact — it becomes the default explanation of a
change for everyone who later reads the history. This gate makes sure the
**user**, not the agent that wrote the change, decides when work is ready
for that.

Two hard rules, no exceptions:

1. **The review changes nothing.** No edits, no formatting, no fix-ups,
   no `git add`. Read-only tools only: `git status/diff/show/log`,
   file reads, grep/rg, and gates in check mode (they report; they
   don't repair).
2. **The review ends with a prompt, not a commit.** Do not commit
   until the user has commented on the review and picked a path.

## Triggers — load this skill before any of:

- You are about to run `git commit` (or `--amend`) as part of wrapping
  up a task, and the user did not explicitly ask for a commit
- The user asks you to review / check / look over pending changes

## Skip — do not run the review when:

- **The user explicitly asks to commit** ("commit", "commit this",
  "commit and push", "amend"). The explicit request is pre-authorization:
  proceed straight to committing (repo gates like `./verify.sh` per
  AGENTS.md still apply). One request covers that commit only — the next
  self-initiated wrap-up reviews again.

## Process

1. **Collect the change set** (read-only): `git status --short`,
   `git diff HEAD` for tracked changes, read the untracked files that
   would be committed, `git log --oneline -5` for subject style.
2. **Run the registered gates in check mode.** For this repo:
   `./verify.sh` (mandated by AGENTS.md), plus per-language gates
   matching the changed files (`shellcheck-repo`, `yaml-lint-repo`,
   `quickshell-verify`). Report results; fix nothing.
3. **Review the diff for:**
   - Correctness against the task the user actually asked for
   - Scope creep — changes unrelated to the task
   - Claims vs reality — gates/tests the change claims were run,
     actually were run
   - Conventions — AGENTS.md rules, README/install updates for new
     content, comment hygiene per `code-comments`, commit-message
     style; impossibility claims scoped per `impossibility-scope`
4. **Present the report** — concise, ordered by severity:
   - Verdict line: `ready` / `ready with notes` / `blocked`
   - Findings, each tagged `[blocker]` / `[note]` / `[question]`,
     with `file:line`, what, and why it matters
   - Gate results
   - Proposed commit subject + body (so the user can approve wording)
5. **Materialize the review as a markdown file** at a temp path
   (`mktemp -t code-review-XXXX.md`). The file *is* the prompt: each
   finding becomes a keyed heading followed by a `>`-quoted context
   block and an inline-answer placeholder; an `# Answers` section at
   the bottom mirrors the keys as a fallback. Keys follow the finding
   tag — `BUG-N` for `[blocker]`, `NOTE-N` for `[note]`,
   `QUESTION-N` for `[question]` — and are referenced by both the
   inline placeholder and the bottom line. A `PATH` key carries the
   chosen path forward, with the four options listed in a quote block.

   Inline placeholders are HTML comments (`<!-- Answer KEY here -->`)
   so they render as nothing in markdown previews while remaining
   detectable in source. Inline answers win over bottom answers for
   the same key; blank/missing = "no comment".

   Template:

   ````markdown
   <!--
   Review for: <commit subject>
   Verdict: <ready | ready with notes | blocked>

   How to answer each finding:
     - Inline: delete the <!-- Answer KEY here --> line and write
       your reply right after the quote
     - Bottom: fill the matching KEY: line under # Answers below

   Unanswered findings are recorded as "no comment".
   -->

   ## Findings

   ### BUG-1: <title>

   > `path/to/file:LINE` — <what>
   >
   > <why it matters>

   <!-- Answer BUG-1 here -->

   ## Path forward

   > **(a)** fix findings then commit
   > **(b)** commit as-is with the proposed message
   > **(c)** commit with my amendments
   > **(d)** hold

   <!-- Answer PATH here (a / b / c / d) -->

   ---

   # Answers

   <!-- Used only if the inline placeholder above is still present. -->

   BUG-1:
   PATH:
   ````

6. **Open it via the `open_in_editor` tool** (provided by the
   `edit-in-editor` extension). Pass the temp path. The tool
   suspends the TUI, runs `${EDITOR:-vi} <path>` with full TTY
   access, and returns the saved file contents as the tool result.

   The agent cannot spawn the editor itself — its `bash` tool runs
   in a captured-output subshell without a TTY. The tool is the
   only path that releases the terminal for the user.

   Non-interactive fallback: if the tool returns the
   "non-interactive mode" error (RPC / print / json), fall back to
   plain chat prompting with the same `a/b/c/d` question, and
   otherwise follow the same parsing rules.

7. **Parse the answers** out of the returned text:
   - For each finding key, check the inline placeholder first;
     replaced or removed = user answered inline. Otherwise the
     matching `KEY:` line in `# Answers` is the answer.
     Blank/missing = "no comment".
   - The `PATH` key uses the same rule but expects one of `a`, `b`,
     `c`, `d` (case-insensitive). Unrecognized or blank = **hold**,
     which is the safe default and preserves no-self-approval.

8. **Act on the chosen path.** Apply fixes or amendments, stage,
   and commit (repo gates per AGENTS.md still apply). Don't
   re-review — the editor session is the review.

## Principles (load-bearing)

- **No self-approval.** The agent that wrote the change is not the one
  who decides it ships. The editor session is the review; absent or
  unrecognized `PATH` defaults to hold.
- **Findings, not fixes.** The review names problems and stops. Fixes
  happen only after the user records the chosen path in the file —
  then apply them and commit per their choice, without a second full
  review.
- **Editor via the `open_in_editor` tool, not `bash`.** The agent's
  bash tool runs without a TTY; only the registered tool can
  suspend the TUI and hand the terminal to `$EDITOR`. Skills that
  need user-authored buffers must use the tool — never try to
  spawn `$EDITOR` from bash.
- **Always-prompting.** Even clean reviews open the editor. The gate's
  whole point is the user's explicit sign-off — collapsing a clean
  review into an agent-decided commit would lose that.
- **Explicit commit requests are the exception, not the pattern.**
  Skipping on "commit" is user pre-authorization, not evidence the
  work was reviewed.
- **Honest verdicts.** If findings exist, say `blocked` or
  `ready with notes`; a clean-looking report that hides a failing gate
  is worse than no review.
