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
| `notify` | `"fulfillment"` | How the completion notification is framed. `"fulfillment"` — you launched this to satisfy your current request; act on the result. `"watcher"` — autonomous background job whose relevance you must evaluate when it finishes. See *Two patterns* below. |
| `nextStep` | none | Free-form instruction carried into the watcher-mode notification. Tells the model what to do when the watcher job finishes (e.g. `"read the journal and report whether the build passed"`). Ignored when `notify="fulfillment"`. |

Returns immediately with `{id, label, scope, timeoutMs, outputFile, notify, nextStep}`.
The id is the substrate's handle (a unit name for systemd).

## Two patterns: fulfillment vs watcher

The same `background_run` tool covers two distinct mental modes.
Pick the mode at launch by setting `notify`; the watcher uses it
to frame the completion notification correctly, which is the only
thing that lets the model decide whether to act immediately or
evaluate first.

### Fulfillment — "I'm doing this for the current task"

Use this when you launch a job as part of fulfilling the user's
current request — a build you need to inspect, a test run you
need to summarize, a long download you depend on. The job id is
in your working memory; when it finishes, you are expected to
read the journal and continue.

```typescript
background_run({ command: "make test", timeoutMs: 600_000 })
// notify defaults to "fulfillment"
```

The completion notification arrives framed as:

```
<system-reminder type="background-fulfillment">
A background job you launched to fulfill your current request
has finished. You are expected to act on its result — read the
journal (background_journal), then continue the task you were
working on.
</system-reminder>

[background-tasks] make (run-…) — completed — exit=0 — 32.5s
command: make test
```

Right move: `background_journal`, then continue.

### Watcher — "this is autonomous; tell me when something happens"

Use this when you launch a job whose outcome may or may not be
relevant to your current task — polling for a file, waiting on a
remote sync, watching for a process to exit. Pass `notify:
"watcher"` and, importantly, a `nextStep` that tells the future
you what to do when the notification fires:

```typescript
background_run({
  command: "while [ ! -f /tmp/hello2 ]; do sleep 1; done",
  notify: "watcher",
  nextStep: "report whether /tmp/hello2 appeared and what its contents are",
})
```

The completion notification arrives framed as:

```
<system-reminder type="background-watcher">
A background job you launched asynchronously has finished. This
is not necessarily relevant to your current task — evaluate the
outcome and the user's intent before acting.

Next step specified at launch: report whether /tmp/hello2
appeared and what its contents are

If you decide the job's result is relevant, act on it. If not,
briefly acknowledge and stop.
</system-reminder>

[background-tasks] wait-for-hello2 (run-…) — completed — exit=0 — 28.4s
command: while [ ! -f /tmp/hello2 ]; do sleep 1; done
```

Right move: follow the `nextStep`. If the next step is empty,
decide whether to act, defer, or surface to the user.

### Choosing between them

If the job's output is *the answer to the user's current request*
in any direct sense, use `fulfillment`. If the job is *an event
detector* whose result is metadata about the world, use `watcher`.
When in doubt, default is `fulfillment` — that's the safer mode
because the notification tells the model to act; a watcher
notification that the model misreads as fulfillment causes the
opposite problem (premature action on unverified state).

### The `<system-reminder type="…">` envelope

The completion notification is a `<system-reminder>` whose `type`
attribute is one of `background-fulfillment` or
`background-watcher`. pi core's `convertToLlm` drops this through
as plain text in a user-role message — it is **not** a wire-
protocol instruction, it is a **convention this skill documents**.
Recognise the type, react accordingly. The watcher mode's
`<system-reminder>` also carries the `nextStep` you set at
launch, so you do not need to remember what to do with the
result.

### `background_status`

| Parameter | Default | Notes |
|---|---|---|
| `id` | none | Omit to list all jobs. |
| `filter` | `"active"` | `"all"` to include older terminal jobs. |

When `id` is given, returns `{state, exit, result}` plus the
job's full command (newlines indented — the authoritative readback
of what was started) and reconciles the in-memory map. Without
`id`, returns a table (also what `/jobs` prints) sorted by start
time, with active jobs first; a truncated one-line `command`
column identifies each job without re-reading history.

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
<system-reminder type="background-fulfillment | background-watcher">
...framing text + optional nextStep...
</system-reminder>

[background-tasks] <label> (<id>) — <state> — exit=<n> result=<reason> — <duration>
command: <one-line preview, truncated at 200 chars>

--- last 200 chars of journal ---
<tail>

Full output: <outputFile>      # only if outputFile was set
```

The `<system-reminder type="…">` envelope is what tells you which
of the two patterns the job belongs to; see *Two patterns* above.
React to the envelope first, then to the data line.

The `details` payload is also structured:

```typescript
{
  id, label, command, state, exitStatus, result,
  durationMs, startedAt, finishedAt, notify,
}
```

`state` is one of `completed | failed | timeout | cancelled`.
`exitStatus` is the command's exit code (or the signal number +
128, depending on backend). `result` is the backend's reason code
(`success`, `exit-code`, `signal`, `timeout`, `resources`, …).
`notify` echoes the mode you set at launch.

For more journal context than the 200-char tail, call
`background_journal` (with the `id`). For raw status, call
`background_status`.

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
