# Plan Mode Extension

A plan module for the [pi](https://pi.dev) coding agent — **manager-driven**:
the extension, not the model, owns the execution workflow. The model executes
one step per directive; the plan manager treats every settled agent run as a
checkpoint and decides what happens next. A model that "just stops" mid-plan
is recovered automatically instead of abandoning the remaining steps.

| Phase | Tool access | Purpose |
|-------|-------------|---------|
| `idle` | Full | Normal operation |
| `planning` | Read-only (`edit`/`write` disabled, bash allowlisted) | Explore the codebase and draft a numbered plan |
| `executing` | Full | Manager sends one step directive per turn and auto-advances on `[DONE:n]` |
| `paused` | Full | Execution halted (user pause/interrupt, `[BLOCKED:n]`, model error, or no progress); `/plan run` resumes |

## Commands

| Command | Action |
|---------|--------|
| `/plan` | Toggle plan mode (from executing/paused: back to planning, draft kept) |
| `/plan run` | Start / resume managed execution |
| `/plan pause` | Halt auto-advance (resumable with `/plan run`) |
| `/plan show` | Print the current plan and progress |
| `/plan save [file]` | Write the plan as a markdown checklist (default `PLAN.md`) |
| `/plan reset` | Discard the plan, return to normal mode |
| `/todos` | Show plan progress |
| `Ctrl+Alt+P` | Toggle plan mode |
| `pi --plan` | Start in plan mode |

## Workflow

1. `/plan` (or `Ctrl+Alt+P`) — pi switches to read-only exploration.
2. Describe the task. The agent investigates with `read`/`grep`/`find`/`ls`
   and read-only bash, then presents a plan under a `Plan:` header:
   ```
   Plan:
   1. Add input validation to the login form
   2. Extract shared helpers into src/validation.ts
   3. Add unit tests
   ```
3. When a plan is drafted you're prompted to **Execute**, **Stay in plan
   mode**, or **Refine** it (you can also run `/plan run` manually later —
   the draft survives toggling plan mode off).
4. On execution the checklist is written to `PLAN.md`, full tool access is
   restored, and the manager begins: it sends a **step directive** naming
   exactly one step, the remaining plan, and the completion contract.
   When the agent ends its reply with `[DONE:n]`, the manager marks the
   step, updates `PLAN.md` / the footer status (`▶ plan 2/5`) / the
   checklist widget, and sends the next directive automatically.
5. When the last step completes, a completion summary is posted and pi
   returns to normal operation.

## The manager loop

The tick runs on `agent_settled` — the event that fires after a run has
fully drained (retries, compaction retries, and queued follow-ups
included). That is the only honest "the run truly stopped" checkpoint, so
a stalled execution is always observed. On each tick:

- All steps done → deliver the completion summary (claim-once: exactly
  one delivery).
- `[BLOCKED:n] <reason>` was reported → **pause** with the reason; a
  human refines or retries.
- Last stop reason was `aborted` (user pressed Esc) → **pause**; the
  manager never fights the user. `/plan run` resumes from the first
  incomplete step.
- Last stop reason was `error` → **pause** (retries already happened).
- 3 consecutive settled runs without a `[DONE:n]` marker → **pause**
  with an explanation, instead of burning tokens forever.
- Otherwise → send the next step directive (the recovery path for a model
  that simply stops mid-plan).

There is deliberately **no time-based watchdog**: progress is accounted
per settled run, so a long legitimate tool run is never falsely treated
as stalled (a pattern borrowed from `pi-herdr-agents`' supervision
design, as is the self-contained-directive rule: a wake-up must carry
the work itself, never a pointer to go look elsewhere).

## Persistence

State is persisted in the session: plan, progress, and phase survive
`/resume` and restarts. A session restored mid-execution comes back
**paused** — the manager never auto-starts a turn at session start; run
`/plan run` to continue.

## How It Works

- **Planning phase**: a per-turn briefing is injected via
  `before_agent_start`; `edit`/`write` are deactivated with
  `setActiveTools`, and a `tool_call` guard blocks non-allowlisted bash
  commands and mutating tools.
- **Context hygiene**: the `context` event keeps exactly one fresh phase
  briefing in the LLM context, drops stale briefings from the other
  phase, and keeps only the most recent step directives (compact
  history; the latest names the work).
- **Execution phase**: directives are custom messages with
  `triggerTurn`; `turn_end` scans assistant messages for `[DONE:n]` and
  `[BLOCKED:n]` markers and checkpoints progress to the session and
  `PLAN.md`.

## Notes & Limitations

- The bash allowlist (`utils.ts`) is a **guardrail, not a sandbox**. A
  determined model can construct commands that slip through an allowlist.
  For hard isolation, run pi in a container.
- `curl` (stdout) is allowed for research; `wget` is limited to
  `wget -O -`. Redirections (`>`, `>>`) are blocked.
- Tools registered by *other* extensions are preserved in plan mode unless
  they are named `edit` or `write`.
- `PLAN.md` is overwritten whenever execution starts or a step completes.
- One directive turn at a time is by design; user messages sent during
  execution are answered within the run, and the manager advances from
  whatever the settled run accomplished.
