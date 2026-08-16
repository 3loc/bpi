# Plan Mode Extension

A plan module for the [pi](https://pi.dev) coding agent. Adds a three-phase
workflow on top of pi's normal operation:

| Phase | Tool access | Purpose |
|-------|-------------|---------|
| `idle` | Full | Normal operation |
| `planning` | Read-only (`edit`/`write` disabled, bash allowlisted) | Explore the codebase and draft a numbered plan |
| `executing` | Full | Work through the plan; progress tracked via `[DONE:n]` markers |

## Commands

| Command | Action |
|---------|--------|
| `/plan` | Toggle plan mode |
| `/plan run` | Execute the current plan |
| `/plan show` | Print the current plan |
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
   restored, and the agent works through the steps. Completed steps are
   tracked when the agent includes `[DONE:n]` markers in its responses.
5. Footer status (`▶ plan 2/5`) and a widget above the editor show progress;
   the session is updated when all steps are done.

State is persisted in the session, so plan and progress survive `/resume`
and restarts (including `[DONE:n]` markers that were emitted before the
restart).

## How It Works

- **Planning phase**: a per-turn briefing is injected via
  `before_agent_start`; `edit`/`write` are deactivated with
  `setActiveTools`, and a `tool_call` guard blocks non-allowlisted bash
  commands and mutating tools.
- **Context hygiene**: the `context` event keeps exactly one fresh phase
  briefing in the LLM context and drops stale briefings from the other
  phase.
- **Execution phase**: each turn the remaining steps are re-injected, and
  `turn_end` scans assistant messages for `[DONE:n]` markers.

## Notes & Limitations

- The bash allowlist (`utils.ts`) is a **guardrail, not a sandbox**. A
  determined model can construct commands that slip through an allowlist.
  For hard isolation, run pi in a container.
- `curl` (stdout) is allowed for research; `wget` is limited to
  `wget -O -`. Redirections (`>`, `>>`) are blocked.
- Tools registered by *other* extensions are preserved in plan mode unless
  they are named `edit` or `write`.
- `PLAN.md` is overwritten whenever execution starts.
