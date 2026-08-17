# Workflow Mode Extension

A workflow module for the [pi](https://pi.dev) coding agent — **settle-driven, manager-owned**.

The extension runs the workflow; the model executes one step per directive. The plan manager treats every settled agent run as a checkpoint and decides what happens next, and a model that "just stops" mid-workflow is recovered automatically instead of abandoning the remaining steps.

## Why settle-driven

The previous design required the model to emit `[DONE:n]` at the end of every step's execution turn. That marker got lost in the noise of a busy turn — models forget, paraphrase, or bury it. The new design treats **agent_settled** as the unit of completion (the honest "the run truly stopped" signal — retries, compaction retries, and queued follow-ups already drained).

After the execution turn settles, the manager sends a **separate, single-purpose review turn** whose entire job is to audit the previous turn. The review turn uses an EXACTLY-ONE-LINE strict format prompt:

```
[VERIFY:DONE]            — step N is verifiably complete
[VERIFY:CONTINUE: <gap>] — significant work on step N is missing
[VERIFY:BLOCKED: <why>]  — step N is wrong or impossible
```

Models reliably follow strict single-line instructions in a dedicated turn. A marker inside a busy execution turn is fragile; a marker inside a single-purpose review turn is robust.

## Phases

| Phase | Tool access | Purpose |
|-------|-------------|---------|
| `idle` | Full | Normal operation |
| `drafting` | Read-only (`edit`/`write` disabled, bash allowlisted) | Explore the codebase and draft a numbered plan |
| `executing` | Full | Manager sends one step directive per turn, then a review turn |
| `paused` | Full | Execution halted (user pause/interrupt, BLOCKED verdict, repeated CONTINUE verdicts, or model error); `/workflow run` resumes |

## Commands

| Command | Action |
|---------|--------|
| `/workflow` | Toggle workflow mode (from executing/paused: back to drafting, draft kept) |
| `/workflow run` | Start / resume managed execution |
| `/workflow pause` | Halt auto-advance (resumable with `/workflow run`) |
| `/workflow show` | Print the current workflow and progress |
| `/workflow save [file]` | Write the workflow as a markdown checklist (default `PLAN.md`) |
| `/workflow reset` | Discard the workflow, return to normal mode |
| `/todos` | Show workflow progress |
| `Ctrl+Alt+W` | Toggle workflow mode |
| `pi --workflow` | Start in workflow mode |

## Workflow

1. `/workflow` (or `Ctrl+Alt+W`) — pi switches to read-only exploration.
2. Describe the task. The agent investigates with `read`/`grep`/`find`/`ls`
   and read-only bash, then presents a plan under a `Plan:` header:
   ```
   Plan:
   1. Add input validation to the login form
   2. Extract shared helpers into src/validation.ts
   3. Add unit tests
   ```
3. When a plan is drafted you're prompted to **Execute**, **Stay in workflow
   mode**, or **Refine** it (you can also run `/workflow run` manually
   later — the draft survives toggling workflow mode off).
4. On execution the checklist is written to `PLAN.md`, full tool access is
   restored, and the manager begins. It alternates:
   - **step directive** (the model works on one step)
   - **review prompt** (a separate, narrow turn that audits the previous turn)
   - **advance** if the review verdict says DONE, or **re-direct / pause**
     otherwise.

   Each transition updates `PLAN.md`, the footer status (`▶ workflow 2/5`),
   and the checklist widget. The model never emits a marker inside its
   execution turn.
5. When the last step completes, a completion summary is posted and pi
   returns to normal operation.

## The manager loop

The tick runs on `agent_settled` — the event that fires after a run has
fully drained (retries, compaction retries, and queued follow-ups
included). On each tick:

- All steps done → deliver the completion summary (claim-once: exactly
  one delivery).
- `lastStopReason === "aborted"` (user pressed Esc) → **pause**; the
  manager never fights the user. `/workflow run` resumes from the first
  incomplete step.
- `lastStopReason === "error"` → **pause** (retries already happened).
- Pending review turn just settled → **parse verdict**:
  - `[VERIFY:DONE]` → mark complete, advance.
  - `[VERIFY:CONTINUE: <gap>]` → re-send the same-step directive with
    the gap as a note. Bounded: 2 CONTINUE verdicts in a row for the
    same step **pause** with the last gap, instead of burning tokens.
  - `[VERIFY:BLOCKED: <why>]` → **pause** with the reason; a human
    refines or retries.
  - Malformed reply (no marker) → safe default: treat as CONTINUE,
    same bound applies.
- Pending step turn just settled → send the review prompt.
- Otherwise → send the next step directive (the recovery path for a
  model that simply stops mid-workflow).

There is deliberately **no time-based watchdog**: progress is accounted
per settled run, so a long legitimate tool run is never falsely treated
as stalled. The review-turn counter is bounded per step, not per wall-
clock time.

## Persistence

State is persisted in the session: workflow, progress, phase, and saved
toolset survive `/resume` and restarts. A session restored mid-execution
comes back **paused** with an honest warning: settled-driven completion
state cannot be rebuilt from the marker-driven legacy format, so the
manager does not try — run `/workflow run` to start fresh.

## Notes & Limitations

- The bash allowlist (`utils.ts`) is a **guardrail, not a sandbox**. A
  determined model can construct commands that slip through an allowlist.
  For hard isolation, run pi in a container.
- `curl` (stdout) is allowed for research; `wget` is limited to
  `wget -O -`. Redirections (`>`, `>>`) are blocked.
- Tools registered by *other* extensions are preserved in workflow
  mode unless they are named `edit` or `write`.
- `PLAN.md` is overwritten whenever execution starts or a step completes.
- One directive turn at a time is by design; user messages sent during
  execution are answered within the run, and the manager advances from
  whatever the settled run + review verdict accomplished.
- The review turn is small (one line reply) but it is still a model
  turn — it costs tokens. For a 5-step workflow that is ~1–2.5k tokens
  of audit overhead.

## Testing

Pure helpers are unit-tested via `utils.test.ts`:

```
node --experimental-strip-types utils.test.ts
```

Coverage: plan extraction, step directive construction, review prompt
construction, verdict parsing (DONE / CONTINUE / BLOCKED / malformed,
last-occurrence-wins, empty gaps, unclosed markers), bash guardrail,
and markdown rendering.
