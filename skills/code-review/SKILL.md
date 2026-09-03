---
name: code-review
description: "Read-only review gate before commits: whenever you are about to create a git commit that the user did not explicitly ask for, first present the pending changes as a structured review report (correctness, scope creep, claims vs reality, conventions, gate results) without editing anything — no fixes, no staging — then open that same report text via the open_in_editor tool's context mode ($EDITOR) so the user records one keyed action per finding (fix / ignore / clarify / later / discuss) plus an overall COMMIT yes/hold decision in the buffer's single # Answers block; parse the returned diff and act on the choices. Skip entirely when the user explicitly asks to commit; that request is pre-authorization."
compatibility: needs the `edit-in-editor` extension (open_in_editor tool with context mode); non-interactive sessions fall back to in-chat prompting
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
   until the user has recorded their decisions and explicitly said to
   commit.

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
4. **Present the report as your reply, ending with the answer block.**
   This one text is both the chat report _and_ the editor buffer —
   it exists in context exactly once, so do **not** also write it to a
   file. Concise, ordered by severity:
   - Verdict line: `ready` / `ready with notes` / `blocked`
   - Findings, each tagged `[blocker]` / `[note]` / `[question]`,
     with `file:line`, what, and why it matters
   - Gate results
   - Proposed commit subject + body (so the user can approve wording)
   - The `# Answers` block: one `KEY:` line per finding
     (`BUG-N` for `[blocker]`, `NOTE-N` for `[note]`,
     `QUESTION-N` for `[question]`) plus a single `COMMIT:` line.
     Answers are recorded **only** on these keyed lines — there is no
     inline answering, so findings stay compact prose with no
     per-finding placeholders.

   Template:

   ```markdown
   <!--
   Review for: <commit subject>
   Verdict: <ready | ready with notes | blocked>

   Fill the KEY: lines under # Answers — one action per finding:
     fix      address this before committing
     ignore   accept as-is; recorded in the commit body (blockers)
     clarify  agent explains in chat, then re-asks
     later    capture as a TODO.md entry, then proceed
     discuss  talk it through in chat first
   Blank finding = fix (not waved through). Blank COMMIT = hold.
   -->

   ## Findings

   ### BUG-1: <title>

   > `path/to/file:LINE` — <what>
   >
   > <why it matters>

   # Answers

   BUG-1:
   NOTE-1:
   QUESTION-1:
   COMMIT:
   ```

5. **Open it via `open_in_editor` with `context: "lastAssistant"`** —
   in the same reply, right after the report text (the tool takes the
   text of your most recent assistant message as the buffer; calling
   it in the same message guarantees it is the report). The tool
   materializes the buffer into a temp file itself, suspends the TUI,
   runs `${EDITOR:-vi}` with full TTY access, and returns a unified
   diff of what the user changed.

   The agent cannot spawn the editor itself — its `bash` tool runs
   in a captured-output subshell without a TTY. The tool is the
   only path that releases the terminal for the user.

   Non-interactive fallback: if the tool returns the
   "non-interactive mode" error (RPC / print / json), fall back to
   plain chat prompting with the same per-finding actions and
   overall commit decision, and otherwise follow the same parsing
   rules.

6. **Read the answers from the returned diff.** The tool result is
   either a unified diff of the user's edits, an "unchanged" notice,
   or (only with `full: true`) the whole buffer:
   - From a diff: every added/changed line matching
     `(BUG|NOTE|QUESTION)-N:` or `COMMIT:` records that key's new
     value; `-`-prefixed counterparts are the old blank lines.
   - "Unchanged" (or no key lines in the diff) → every finding is
     no-comment and `COMMIT` is hold.
   - Action parsing: case-insensitive, trim whitespace, accept the
     exact word (`fix` / `ignore` / `clarify` / `later` / `discuss`).
     Anything else = "no comment".
   - `COMMIT` parsing: case-insensitive `yes` or `hold`. Anything
     else (including blank) = **hold**.

   **Per-finding actions:**

   | Action    | Meaning                                                                                                                                                                                                               |
   | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `fix`     | Agent must address this before committing (rewrite code, drop scope, etc.).                                                                                                                                           |
   | `ignore`  | User accepts the finding as-is; do not change the diff on its account. Record the call so the commit history is honest about what was waved through.                                                                  |
   | `clarify` | Agent must explain or quote the relevant code/convention in chat so the user can re-decide. Block commit until the user picks again.                                                                                  |
   | `later`   | Out of scope for this commit. Agent must capture it as a TODO entry in the repo's `TODO.md` file (at the repo root) so it isn't lost, then proceed. Any deviation from that location requires explicit user approval. |
   | `discuss` | User wants to talk it through in chat first. Block commit until resolved.                                                                                                                                             |

   Verdict adjustment driven by the answers:
   - Any blocker left as no-comment / `clarify` / `later` / `discuss`
     → verdict downgrades to `blocked`.
   - A blocker answered `fix` → must be fixed before commit.
   - A blocker answered `ignore` → not actually a blocker; re-label
     `ready with notes` and call it out in the commit body so it's
     on the record.
   - Notes/Questions answered `fix` → must be fixed before commit
     (the user upgraded them to blockers).
   - Notes/Questions left as no-comment → assume `fix` (no-comment
     on a finding means the user didn't wave it through).

   **Overall commit decision** is the separate `COMMIT` key:

   | Value  | Meaning                                                                                    |
   | ------ | ------------------------------------------------------------------------------------------ |
   | `yes`  | Commit after applying all `fix` answers (and resolving `clarify`/`discuss` in chat first). |
   | `hold` | Don't commit. User will come back with edits or further decisions.                         |

   Blank/missing/unrecognized `COMMIT` → **hold**, the safe default
   that preserves no-self-approval.

7. **Resolve the answers.** Before acting, walk through them in chat:
   - For each `fix`: state exactly what you intend to change
     (one line each, file:line where applicable) and pause for
     confirmation only on any change that's non-mechanical or
     could be read two ways.
   - For each `clarify`: quote the relevant code/convention in
     chat, then re-open the **same** buffer via `open_in_editor`
     with `path` (the buffer path is in the earlier tool result)
     so previous answers stay intact — the user re-records only
     the findings whose actions changed, and the new diff shows
     just those lines; combine it with the earlier answers. Only
     if you need the full current answer state verbatim, re-open
     with `full: true`. Do not write a fresh review for a
     `clarify` re-prompt.
   - For each `discuss`: open the discussion, do not commit.
   - For each `later`: show the exact `TODO.md` entry (or other
     follow-up file) you intend to add, get a yes/hold on
     appending it. Default location is the repo-root `TODO.md`;
     any other location needs explicit user approval.
   - For each `ignore`: restate the call. Blocker `ignore`s are
     recorded in the commit body so future readers see the
     conscious wave-through; `ignore` on a non-blocker needs no
     recording — the agent just notes the choice in chat and
     moves on. If a blocker `ignore` doesn't have a natural
     commit-body slot, the agent adds one (e.g. a "Waved
     through" bullet) before committing.
   - If the verdict downgraded (e.g. `ignore` on a blocker → it
     wasn't really a blocker; or unresolved blockers → `blocked`),
     say so explicitly.

8. **Act on the resolved answers.** Apply `fix`es, add the
   `later` follow-up note, then commit if `COMMIT: yes`. Repo
   gates per AGENTS.md still apply. Don't re-review — the editor
   session plus the resolution chat is the review.

## Principles (load-bearing)

- **No self-approval.** The agent that wrote the change is not the one
  who decides it ships. The editor session plus the user's recorded
  actions and commit decision is the review; absent or unrecognized
  `COMMIT` defaults to hold.
- **Findings, not fixes.** The review names problems and stops. Fixes
  happen only after the user records actions for each finding and
  says to commit — then apply them and commit per their choice,
  without a second full review.
- **Per-finding actions, not a global pick.** A blocker can be waved
  through (`ignore`) while a note gets upgraded to a blocker (`fix`).
  A global a/b/c/d hides that. Each finding earns its own decision;
  the overall commit decision is separate.
- **One keyed answer block.** Answers live only on the `KEY:` lines
  under `# Answers` — no inline placeholders under findings, no
  fallback block. One place to write, one place to parse, and the
  returned diff maps 1:1 onto the decisions.
- **The report is written once.** Presenting the report in chat and
  opening it in the editor are the same text: context mode
  (`context: "lastAssistant"`) materializes what you just presented,
  and the diff-first return carries back only the user's answers —
  the report is never duplicated into context.
- **`ignore` is recorded, not silent.** A blocker waved through
  shows up in the commit body so future readers know it was a
  conscious choice, not an oversight.
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
