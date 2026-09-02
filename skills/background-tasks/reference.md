# systemd reference

The `background-tasks` extension's tool surface covers ~95% of what
you'll want — launch, wait, cancel, read output, set a timeout. This
file is for the **5% the abstraction deliberately doesn't wrap**:
advanced `systemd-run` flags that are too niche for the always-on
tool parameter schema but show up in real workloads.

If you find yourself reaching for these often, that's a signal the
extension's tool surface needs a new parameter — open an issue
rather than using raw `bash` repeatedly.

---

## Raw `systemd-run` for advanced cases

When `background_run` doesn't expose a knob you need, you can
launch the unit directly via `bash`. The trick the extension's
`background_run` uses internally — and which you must replicate
when going around it — is to **read stderr as well as stdout** to
recover the unit name (with `--no-block`, `systemd-run` writes
"Running as unit: <name>" to stderr, not stdout):

```bash
UNIT=$(systemd-run --user --no-block \
        --working-directory="$PWD" \
        -p StandardOutput=file:%h/.cache/my-job.log \
        -p StandardError=inherit \
        -p 'NiceLevel=5' \
        -p 'MemoryMax=2G' \
        -p 'Restart=on-failure' \
        -p 'RestartMaxCount=3' \
        -- bash -c 'make test' 2>&1 \
        | grep -oP 'Running as unit:\s*\K\S+')
echo "$UNIT"
```

`%h` is systemd's specifier for the user's home directory.

## Scheduling for later

`--on-active=` / `--on-calendar=` schedule activation. Combine with
`--no-block` so `systemd-run` returns immediately. These don't go
through `background_run` because the abstraction's lifecycle assumes
"the job is currently running"; a scheduled job is *pending*, not
running.

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

## Service vs scope

`systemd-run` defaults to **service**. Use `--scope` for
process-tree semantics — the launched process joins an existing
slice but systemd doesn't manage its lifecycle. The extension
always uses service.

| Need | Use |
|------|-----|
| Run a command to completion, capture exit code | service (default) |
| Run a long-lived process that should keep going | `--scope` |
| Run a process and have systemd time it out / restart it | service with `Type=simple` + properties |

The default service behavior already covers "run a command, get its
exit code, log it." `oneshot` is what you want when the command
completes and systemd should mark the unit done; `simple` is for
forking daemons.

## Resource limits and environment

`-p` accepts any unit-file setting. Common patterns:

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

- `--working-directory` sets the unit's `WorkingDirectory=`,
  different from `bash`'s `cd`; the agent's `cwd` is irrelevant.
- `MemoryMax=` cgroups the unit (systemd OOM-kills on hit);
  without it the process can grow until the system OOM-killer
  picks it.
- `-p Restart=on-failure` + `-p RestartMaxCount=N` is the pattern
  for "retry N times then give up."

## Listing your transient units without the tool

```bash
# everything you (or anyone via --user) launched as a transient
systemctl --user --no-legend list-units --type=service,scope --all \
  | awk '$1 ~ /^run-/ || $1 ~ /\.scope$/ {print}'

# a single job's exit status (empty if still running)
systemctl --user show <unit> -p ExecMainStatus --value

# a single job's result reason
systemctl --user show <unit> -p Result --value

# remove a finished transient unit from the tree
systemctl --user reset-failed <unit>
```

## When the abstraction is the wrong layer

The extension's whole reason to exist is that you don't reach for
`bash` to launch long jobs. If you find yourself reaching for raw
`systemd-run` to do something `background_run` could do with a new
parameter, that's the extension asking for a new parameter — open
an issue rather than working around it.

Three cases where raw `systemd-run` is genuinely the right call:

1. **Scheduling** (`--on-active`, `--on-calendar`) — the abstraction
   assumes "running now," not "run later."
2. **System mode** (`--system`) — the extension allows `system: true`
   but only because it's free; the skill deliberately steers you
   away from it.
3. **Resource limits / env vars / restart policies** that aren't
   covered by the tool surface — these are the knobs above.

For everything else, use `background_run`.
