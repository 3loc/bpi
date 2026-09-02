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
5. **Prompt and stop.** Ask the user to comment on the review and
   select the path forward, e.g.:

   > Review above. Your comments? Path forward:
   > **(a)** fix findings then commit · **(b)** commit as-is with the
   > proposed message · **(c)** commit with my amendments · **(d)** hold

   Do not pick a path for them; silence is not consent.

## Principles (load-bearing)

- **No self-approval.** The agent that wrote the change is not the one
  who decides it ships.
- **Findings, not fixes.** The review names problems and stops. Fixes
  happen only after the user chooses that path — then apply them and
  commit per their choice, without a second full review.
- **Explicit commit requests are the exception, not the pattern.**
  Skipping on "commit" is user pre-authorization, not evidence the
  work was reviewed.
- **Honest verdicts.** If findings exist, say `blocked` or
  `ready with notes`; a clean-looking report that hides a failing gate
  is worse than no review.
