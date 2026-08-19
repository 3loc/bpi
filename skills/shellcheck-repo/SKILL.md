---
name: shellcheck-repo
description: Run shellcheck on shell scripts that are being created, rewritten, or meaningfully edited as files destined for a repository (`.sh` files, shebang'd extensionless scripts in bin/scripts/hooks, sourced shell libs) — before claiming the script works or the task is done. NOT for ad-hoc one-off shell commands typed into the shell tool that are never saved as files.
compatibility: Requires shellcheck (>= 0.9) on PATH. Check with `shellcheck --version`.
---

# Shellcheck for repo scripts

**Rule: every shell script that will live in a repo gets shellchecked
before you report it as done.** A "works on my machine" claim for a
shell script is not valid without a clean (or justified) shellcheck run.

## When this applies — and when it doesn't

**Applies** (a file will be committed):

- Creating any file ending in `.sh` / `.bash` / `.ksh`
- Creating an extensionless file with a shell shebang (`#!/bin/sh`,
  `#!/usr/bin/env bash|sh|zsh|dash`) — e.g. `bin/` tools,
  `.git/hooks/pre-commit`, container entrypoints
- Editing an existing script that has (or gains) a shell shebang —
  including edits made via patch/sed to a script file
- Sourced shell libraries (shebangless files under `lib/`, `env.sh`,
  anything `source`d by a script)

**Does NOT apply** (throwaway execution, no file):

- One-off commands run through the shell tool
- Heredocs piped to `bash <<EOF`, `bash -c` snippets, test probes
- Command examples written in prose/docs/READMEs

If the same logic is written to a file, the file applies — even if the
content was already run ad hoc.

## Setup (only if shellcheck is missing)

```bash
sudo pacman -S shellcheck        # Arch
sudo apt install shellcheck      # Debian/Ubuntu
sudo dnf install shellcheck      # Fedora
# or a prebuilt binary: https://github.com/koalaman/shellcheck/releases
shellcheck --version             # verify
```

If shellcheck genuinely cannot be installed, say so explicitly when
delivering the script — do not silently claim it was verified.

## The gate (run before declaring the script done)

Run from the repo root (so a repo `.shellcheckrc` is honored and
relative `source=` paths in it resolve):

```bash
shellcheck --severity=warning <file>     # exit 0 → gate passed
```

- `error` findings (SC… parse/semantic errors): **always fix.** The
  script is broken or ambiguous.
- `warning` findings: **fix**, or suppress with a line-targeted
  directive and a reason:
  `# shellcheck disable=SC2086 # intentional word splitting: dir list`
- `info`/`style` findings: optional; suppress individually only if
  noisy. Never blanket-disable at the top of a file without a stated
  reason.

Re-run after each fix round. The gate is **exit 0 at
`--severity=warning`**, with every remaining warning carrying its own
inline directive + reason.

### Variants

- No shebang (sourced lib): `shellcheck -s bash <file>`
- Script sources repo files: add `-x`
- Multiple scripts touched: list them, or sweep (below)

## Editing pre-existing scripts

Don't refactor an inherited wall of warnings unprompted. Instead:

1. `shellcheck <file>` **before** editing — that's the baseline
2. Make the edit
3. Re-run; the script must not have **new** findings versus the
   baseline. Fix at least the ones you introduced.

New code ships at zero warnings; legacy warnings stay until someone
owns the cleanup.

## Repo sweep (many scripts touched, or bootstrapping lint in a repo)

```bash
# tracked .sh files
git ls-files -- '*.sh' '*.bash' | xargs -r shellcheck --severity=warning

# shebang'd scripts without a shell extension
git grep -lI -E '^#!(/usr/bin/env )?(ba|z|d|k)?sh([ -]|$)' -- . ':(exclude)*.sh' \
  | xargs -r shellcheck --severity=warning
```

Both clean (exit 0) → report the sweep as passed.

## Common traps behind the usual warnings

- **SC2086** (double-quote to prevent splitting): fix by default;
  intentional splitting gets the disable directive, not quotes
- **SC2155** (`local x="$(cmd)"` masks exit status): split declare and
  assign
- **SC2046** (word-splitting on `$(...)` in loops/args): restructure
  with arrays or `while read -r`
- **SC1090/SC1091** (can't follow source): expected for dynamic or
  non-repo paths — pass `-x` for repo-local sources, suppress the rest
  per line
- Pipes and `set -euo pipefail`: if the script needs it, add the
  preamble — shellcheck can't require it, but repo scripts should have
  it (see this repo's own scripts for the shape)
