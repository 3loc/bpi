---
name: background-tasks
description: Run and monitor long-running commands as background tasks without holding the bash tool hostage. Use when the agent needs to launch a long command, continue working, then react to its completion or timeout (a test suite, a build, a download, a remote sync, anything where the exit status will drive the next decision). The current backend is your user systemd manager; other backends may be added. Covers launching, monitoring, blocking waits, output capture, timeouts, and cancel. Requires the matching `background-tasks` extension to be loaded.
---

# Background tasks

The agent's `bash` tool blocks for the duration of a command. Long
work — a test suite, a build, a download — should not hold the model
hostage. The pattern: hand the work to a **background-task backend**
(currently: transient systemd units under your user manager) and let
it own the lifecycle. The agent owns the decisions.

The matching `background-tasks` extension registers five tools
(`background_run`, `background_status`, `background_wait`,
`background_cancel`, `background_journal`) and a `/jobs` command.
The extension's watcher polls every 2 s and fires a
`background-tasks-result` custom message on the **next turn** when a
job reaches a terminal state, so an agent turn ends promptly after
launching a job and a fresh turn starts when the task finishes.

## When to use this pattern (and when not to)

Use it when the command will take more than a few seconds, the agent
has more useful work to do than wait, and the exit status will drive
the next decision.

Skip it when the command is short, the user is watching the live
stdout (`bash` already streams it), or no backend is reachable.

## Setup (only if the backend is unreachable)

The current backend is systemd. To check:

```bash
ps -p 1 -o comm=                       # expect: systemd
systemctl --user status                # expect: not "Failed to connect to bus"
which systemd-run                      # expect: /usr/bin/systemd-run
```

If `systemctl --user status` says "Failed to connect to bus":

```bash
sudo pacman -S systemd                 # Arch
sudo apt install systemd               # Debian/Ubuntu
# then either reboot, or in a long-lived user session:
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user &
```

If the bus is reachable but the user manager is not running, the user
is most likely not "lingering" — their user manager only runs while
they're logged in. **Don't enable linger yourself** (that's a
system-wide effect that outlives this session and shouldn't be an
agent's unilateral choice); ask the user to run:

```bash
loginctl enable-linger $USER     # they run this themselves
```

then start the user manager (`systemctl --user &` in this shell, or
log out and back in).

No socket, no backend, no pattern. Use plain `bash &` + a manual
poll and tell the user about the trade-off.

## Actor / mechanism (read once, internalize)

A task runs under your **user systemd instance** — the user manager
running as your UID, not as a child of the agent's bash. From the
agent's point of view:

| Layer | Owner | What it controls |
|-------|-------|------------------|
| Bash subprocess | pi's `bash` tool | one-shot commands, captured output |
| User systemd (`--user`) | your UID's systemd instance | transient units / scopes, lifetimes, deps, retries |
| System systemd (`--system`) | PID 1 | system services — avoid by default |

A job launched via `background_run` survives the agent's tool call
returning because the backend, not bash, owns the process. The flip
point is when the backend itself goes down (reboot, container exit)
— then the job goes with it.

## The lifecycle

```
   background_run ─► starting ─► running ─► completed
                                       ├─► failed
                                       ├─► timeout       (caller's deadline)
                                       └─► cancelled     (caller asked to stop)
```

`starting` and `running` are non-terminal. The watcher polls while
the job is in either. The other four are terminal and one-way.

## The tool surface

All five tools share a session-scoped job map. The map persists
across `/reload` (jobs you've already launched are still tracked)
but not across sessions (a new session has no in-memory jobs).

### `background_run`

| Parameter | Default | Notes |
|---|---|---|
| `command` | required | Shell command, joined by `bash -c`. |
| `label` | first argv | Short human-readable name shown in `/jobs` and the completion notification. Truncated to 80 chars. |
| `workingDirectory` | `ctx.cwd` | Relative paths are resolved against `ctx.cwd`. |
| `timeoutMs` | none | The watcher enforces this deadline independently of any backend-side timer. |
| `outputFile` | none | `true` → `${HOME}/.cache/background-tasks/<label>.log`; string → that path. Captures combined stdout+stderr. |
| `system` | `false` | `true` = system scope (root, PID 1). Needs polkit. Avoid unless you've explicitly decided you need it. |

Returns immediately with `{id, label, scope, timeoutMs, outputFile}`.
The id is the substrate's handle (a unit name for systemd).

### `background_status`

| Parameter | Default | Notes |
|---|---|---|
| `id` | none | Omit to list all jobs. |
| `filter` | `"active"` | `"all"` to include older terminal jobs. |

When `id` is given, returns `{state, exit, result}` and reconciles
the in-memory map. Without `id`, returns a table (also what `/jobs`
prints) sorted by start time, with active jobs first.

### `background_wait`

| Parameter | Default | Notes |
|---|---|---|
| `id` | required | Job id to wait for. |
| `state` | `"completed"` | Any JobState name (`starting`, `running`, `completed`, `failed`, `timeout`, `cancelled`). |
| `timeoutMs` | 24h | Override the default wait timeout. |

Race-free (uses the backend's native wait primitive, not a poll).
Updates the in-memory entry on return.

### `background_cancel`

| Parameter | Default | Notes |
|---|---|---|
| `id` | required | |
| `signal` | `"SIGTERM"` | `"SIGTERM"` (graceful) or `"SIGKILL"` (hard). |

Marks the in-memory entry `cancelled` immediately; the watcher's
next tick reconciles. The completion notification arrives with
`state=cancelled`, distinct from a normal failure.

### `background_journal`

| Parameter | Default | Notes |
|---|---|---|
| `id` | required | |
| `limit` | 200 | Max lines (1..5000). |
| `since` | none | Backend time span (e.g. `1h ago`). |
| `until` | none | Same format. |
| `maxChars` | 8000 | Hard cap (256..50000). **Throws** rather than silently truncating — narrow the window with `limit`/`since`/`until`, or rerun `background_run` with `outputFile: true` for megabyte-scale logs. |

## Reading the completion notification

When a job reaches a terminal state, the watcher fires a
`background-tasks-result` custom message with this shape:

```
[background-tasks] <label> (<id>) — <state> — exit=<n> result=<reason> — <duration>

--- last 200 chars of journal ---
<tail>

Full output: <outputFile>      # only if outputFile was set
```

The `details` payload is also structured:

```typescript
{
  id, label, state, exitStatus, result,
  durationMs, startedAt, finishedAt,
}
```

`state` is one of `completed | failed | timeout | cancelled`.
`exitStatus` is the command's exit code (or the signal number +
128, depending on backend). `result` is the backend's reason code
(`success`, `exit-code`, `signal`, `timeout`, `resources`, …).

When the notification arrives, the right next move is usually: read
the journal (`background_journal`), decide based on the result, and
either launch a follow-up job or report success to the user.

## Errors that look like configuration but are policy

- **"Failed to connect to bus"** — the user manager is not running.
  See Setup.
- **"Unit name collides"** — transient units persist for the
  session; append a timestamp or UUID suffix, or `systemctl --user
  reset-failed <id>` and re-use.
- **`ExecMainStatus=203`** — the executable was missing
  (systemd maps EXECVE_ENOENT to 203). Fix the path.
- **`Result=resources`** (systemd 252+) — the cgroup slice hit its
  resource bound (`MemoryMax`, `CPUQuota`). Reduce the ask or raise
  the bound via `-p` properties — see `reference.md`.

## Out of scope

- **Sandboxed / rootless containers without a backend init** — use
  plain `&` + a poll loop and accept lifetime is tied to the
  container.
- **Cross-host orchestration** — this skill assumes "my user
  systemd on this machine." For remote jobs, `systemd-run -H` works
  but the credential story (your manager vs. the remote's) is
  non-trivial.
- **System mode** (`--system`, no `--user`) — deliberately out of
  scope. System mode needs polkit, runs as PID 1, wider failure
  modes. Use `--user` unless you've explicitly decided you need
  system scope.

## Advanced / not wrapped by the tool

For things the abstraction deliberately doesn't wrap — scheduling,
scopes, raw environment-variable passthrough, resource limits, etc.
— see [`reference.md`](./reference.md). It documents the raw
`systemd-run` invocation patterns you can fall back to when the
tool surface isn't enough.
