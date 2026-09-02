---
name: systemd-jobs
description: Run and monitor background jobs as transient systemd units (the systemd-run / systemctl --user pattern). Use when the agent needs to launch a long-running command and continue working, then react to its completion or timeout — for example a test suite, a build, a download, a remote sync, or any process whose exit status should drive the next decision without holding the bash tool hostage. Covers launching transient services and scopes, polling status, reading journal output, waiting for completion, setting timeouts, and tearing down. Requires systemd (PID 1 = systemd, `systemd-run` and `systemctl` on PATH; user instance reachable via `systemctl --user`).
---

# Background jobs with systemd

The agent's `bash` tool blocks for the duration of a command. Long
work — a test suite, a build, a download — should not hold the model
hostage. The escape hatch is to hand the work to **systemd** (PID 1
on every Linux distro this skill targets) and let it own the
lifecycle. The agent owns the decisions.

The matching `systemd-jobs` extension registers a `systemd_run` tool
and a background watcher that reports completion or timeout back into
the running pi session via `pi.sendMessage` (`triggerTurn: true`,
`deliverAs: "followUp"`), so an agent turn ends promptly after
launching a job and a fresh turn starts when systemd says the job
is done.

## When to use this pattern (and when not to)

Use it when the command will take more than a few seconds, the agent
has more useful work to do than wait, and the exit status will drive
the next decision.

Skip it when the command is short, the user is watching the live
stdout (`bash` already streams it), or systemd is unreachable —
some sandboxes, certain WSL configs, minimal containers without
`/run/systemd/private`.

## Setup (only if systemd is unreachable)

```bash
ps -p 1 -o comm=                       # expect: systemd
systemctl --user status                # expect: not "Failed to connect"
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

If the bus is reachable but the user manager is not running (you'll
see "Failed to connect to bus" only intermittently, or the unit
launches but immediately fails) the user is most likely not
"lingering" — their user manager only runs while they're logged in.
**Don't enable linger yourself** (that's a system-wide effect that
outlives this session and shouldn't be an agent's unilateral
choice); ask the user to run:

```bash
loginctl enable-linger $USER     # they run this themselves
```

and then start the user manager (`systemctl --user &` in this shell,
or just log out and back in).

No socket, no systemd, no pattern. Use plain `bash &` + manual poll
and tell the user about the trade-off.

## Actor / mechanism (read once, internalize)

A transient unit runs under your **user systemd instance** — the user
manager running as your UID, not as a child of the agent's bash. From
the agent's point of view:

| Layer | Owner | What it controls |
|-------|-------|------------------|
| Bash subprocess | pi's `bash` tool | one-shot commands, captured output |
| User systemd (`--user`) | your UID's systemd instance | transient units / scopes, lifetimes, deps, retries |
| System systemd (`--system`) | PID 1 | system services — avoid by default |

A job launched via `systemd-run --user` survives the agent's tool
call returning because systemd, not bash, owns the process. The flip
point is when systemd itself goes down (reboot, container exit) —
then the job goes with it.

## Basic pattern (transient service)

```bash
UNIT=$(systemd-run --user --quiet --no-block \
        --unit=my-job-$(date +%s) \
        bash -c 'make test 2>&1')
echo "$UNIT"        # e.g. "run-u12345.service"
```

`--no-block` makes `systemd-run` return immediately after queueing
the unit. `--user` runs under your user manager; omit only if you
genuinely need system scope and have the privilege.

Capture stdout to a file you can read later (recommended — the
journal has bounded retention):

```bash
systemd-run --user --quiet --no-block \
        -u make-test \
        -p StandardOutput=file:%h/.cache/pi-systemd-jobs/make-test.out \
        -p StandardError=inherit \
        make test
```

`%h` is systemd's specifier for the user's home directory. Pick
*one* of `StandardOutput=journal` (default) or `file:` — splitting
rarely helps.

## Service vs scope

`systemd-run` defaults to **service**. Use `--scope` for
process-tree semantics — the launched process joins an existing
slice but systemd doesn't manage its lifecycle.

| Need | Use |
|------|-----|
| Run a command to completion, capture exit code | service (default) |
| Run a long-lived process that should keep going | `--scope` |
| Run a process and have systemd time it out / restart it | service with `Type=simple` + properties |

The default service behavior already covers "run a command, get its
exit code, log it." `oneshot` is what you want when the command
completes and systemd should mark the unit done; `simple` is for
forking daemons.

## Monitor: status, logs, completion

```bash
# snapshot
systemctl --user status my-job.service
# → Active: activating | active | failed | inactive (dead)
# → Main PID, memory, last few journal lines

# live journal
journalctl --user -u my-job.service -f

# completion check (non-blocking)
systemctl --user is-active my-job.service
# → active / inactive / failed / activating

# blocking wait (race-free, signal-safe)
systemctl --user wait my-job.service --state=inactive
# exits 0 when unit reaches "inactive" (done or failed)
```

`inactive` means the service has stopped (success *or* failure).
To tell them apart, read the exit status (next section) or use
`is-failed`.

## Exit status and result

A `oneshot` service has `SuccessExitStatus=`. It exits 0 if the
command's exit code is 0; otherwise systemd marks it `failed`:

```bash
systemctl --user show my-job.service -p ExecMainStatus --value
# → 0 = success, 1 = your command failed, 200..243 = signal N+128...
```

The systemd-jobs watcher reads `ExecMainStatus` (and `Result=`) on
each tick and surfaces both in the completion notification —
`success / exit=N / time=…`.

## Timeout

systemd's `RuntimeMaxSec=` is the kill timer: after that wall-clock
duration, systemd SIGTERMs then SIGKILLs the unit.

```bash
systemd-run --user --quiet --no-block \
        -u my-job \
        -p RuntimeMaxSec=30min \
        make test
```

When the runtime expires, the unit lands in `failed` with
`Result=timeout`. The watcher reports this as a timeout, not a
regular failure — distinct from `exit=N`.

For a polling-driven timeout (the extension's model), the extension
sets its own deadline in addition to systemd's, so it can emit
"timeout" even when `RuntimeMaxSec` is unset (systemd's default is
`infinity`).

## Cancel / stop

```bash
systemctl --user stop   my-job.service   # SIGTERM → SIGKILL after TimeoutStopSec (default 90s)
systemctl --user kill   my-job.service   # hard kill
systemctl --user reset-failed my-job.service   # clear failed-state
```

The extension exposes cancel via the `systemd_run` tool's
`cancel` parameter or by `/jobs cancel <unit>` from the session.

## Environment, working dir, properties

```bash
systemd-run --user --quiet --no-block \
        -u my-job \
        --setenv=NODE_ENV=test \
        --working-directory=/srv/repo \
        -p Environment=PYTHONUNBUFFERED=1 \
        -p NiceLevel=5 \
        -p CPUWeight=100 \
        -p MemoryMax=2G \
        pytest -x
```

`--working-directory` sets the unit's `WorkingDirectory=` —
different from `bash`'s `cd`; the agent's `cwd` is irrelevant.
`MemoryMax=` cgroups the unit (systemd OOM-kills on hit); without
it the process can grow until the system OOM-killer picks it.

`-p` accepts any unit-file setting. The "long job, capture output,
bound the runtime" pattern uses `-p RuntimeMaxSec=…`,
`-p StandardOutput=file:%h/...`, optionally `-p Restart=on-failure`
with `-p RestartMaxCount=N`.

## Scheduling for later

`--on-active=` / `--on-calendar=` schedule activation. Combine with
`--no-block` so `systemd-run` returns immediately:

```bash
# start in 10 minutes
systemd-run --user --quiet --no-block \
        --on-active=10min \
        --unit=my-later-job \
        bash -c 'echo hello from the future'

# every day at 03:30
systemd-run --user --quiet --no-block \
        --on-calendar='*-*-* 03:30:00' \
        --unit=my-nightly \
        make nightly
```

`--on-active` / `--on-calendar` only work in service mode.

## Errors that look like configuration but are policy

- **"Failed to connect to bus"** — `--user` requires the user manager.
  See Setup.
- **"Unit name collides"** — transient units persist for the session;
  append a timestamp or UUID suffix, or `systemctl --user reset-failed
  <unit>` and re-use.
- **`ExecMainStatus=203`** — the executable was missing
  (systemd maps EXECVE_ENOENT to 203). Fix the path.
- **`Result=resources`** (systemd 252+) — cgroup slice hit its
  resource bound (`MemoryMax`, `CPUQuota`). Reduce the ask or raise
  the bound.

## Out of scope

- **Sandboxed / rootless containers without systemd init** — use
  plain `&` + a poll loop and accept lifetime is tied to the
  container.
- **Cross-host orchestration** — this skill assumes "my user
  systemd on this machine." For remote jobs, see `systemd-run -H`
  but note the credential story (your manager vs. the remote's)
  is non-trivial.
- **System mode** (`--system`, no `--user`) — deliberately out of
  scope. System mode needs polkit, runs as PID 1, and the failure
  modes are wider. Use `--user` unless you've explicitly decided
  you need system scope.

## Reading more journal than the completion notification shows

The matching `systemd-jobs` extension's completion notification only
echoes the last ~200 chars of the journal — enough to see whether
the job ran cleanly, but not enough to debug a failure or read
test output. The extension exposes a `systemd_journal` tool for
that: pass the unit name, get back the last N lines (default 200,
max 5000) bounded by `maxChars` (default 8000). For jobs whose
output is too large for any reasonable journal window — a test
suite that emits megabytes — pass `outputFile: true` (or an explicit
path) to `systemd_run`; the unit's `StandardOutput=file:` redirects
to disk and the completion notification only links to the file.

## Quick-reference one-liners

```bash
# list my transient units (anything run-*.service / *.scope)
systemctl --user --no-legend list-units --type=service,scope --all \
  | awk '$1 ~ /^run-/ || $1 ~ /\.scope$/ {print}'

# a single job's exit status (empty if still running)
systemctl --user show <unit> -p ExecMainStatus --value

# a single job's result (success / exit-code / timeout / resources / …)
systemctl --user show <unit> -p Result --value

# remove a finished transient unit from the tree
systemctl --user reset-failed <unit>
```