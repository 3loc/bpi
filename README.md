# my-pi

My personal [pi](https://pi.dev) extensions and skills, persisted as a pi package.

## Contents

### Extensions

| Extension | Provides |
|-----------|----------|
| [`extensions/workflow-mode`](extensions/workflow-mode/README.md) | `/workflow`, `/todos`, `Ctrl+Alt+W`, `pi --workflow` — settle-driven, manager-owned workflow execution: read-only drafting → step-by-step execution with a brief review turn after each step (verdict-driven advance, no in-turn marker protocol) |
| [`extensions/sessions`](extensions/sessions/index.ts) | `/sessions [all|switch]`, `pi --sessions` — survey saved sessions with activity status (current / active / recent / inactive), message counts, and previews; `switch` opens a picker |
| [`extensions/local-context`](extensions/local-context/index.ts) | Guarantees a local-directory snapshot (listing, README head, package.json, git state) enters the system prompt before each user command — but **only when no project `AGENTS.md`/`CLAUDE.md` exists in cwd or git root** (native context loading wins) |
| [`extensions/edit-in-editor`](extensions/edit-in-editor/index.ts) | `open_in_editor` tool — opens an arbitrary file in `${EDITOR:-vi}` with full TTY access (the agent's `bash` tool runs without a TTY, so this is the only path that hands the terminal back). Suspends the TUI, returns the saved file contents as the tool result. Used by the `code-review` skill to materialize a review buffer for the user to annotate before a commit |
| [`extensions/context-usage-report`](extensions/context-usage-report/index.ts) | `/context-report [breakdown\|total\|system]`, `pi --context-report` — at startup shows a one-line context size + % of window header; the command (and `--context-report` flag) show a per-category breakdown table (system, project context, skills, conversation by role) with clear attribution: a Provider column (the measured total, once reported) beside a Heuristic column of raw per-category estimates (prose ≈ 4 chars/token, code/JSON ≈ 3.5, CJK ≈ 1.9 — tuned against the real GLM-4.6 tokenizer) |
| [`extensions/minimax-m3-clean`](extensions/minimax-m3-clean/index.ts) | `pi --m3-clean` — routes `minimax / MiniMax-M3` to MiniMax's OpenAI-compatible endpoint (`api.minimax.io/v1`) for passive prompt caching and cleans the stream in flight: inline `<think>…</think>` becomes a proper thinking block (never visible text), duplicated reasoning-field thinking collapses into one block. M2.7 models stay on the Anthropic-compatible endpoint; the stored `minimax` credential keeps working |
| [`extensions/systemd-jobs`](extensions/systemd-jobs/index.ts) | `systemd_run`, `systemd_status`, `systemd_wait`, `systemd_cancel`, `systemd_journal` tools + `/jobs [list\|all\|wait\|cancel]` + `pi --systemd-jobs` — launch commands as transient systemd units and report completion / timeout back into the running pi session via `pi.sendMessage` so a long job doesn't block the bash tool. Background watcher polls every 2 s and fires a `systemd-jobs-result` custom message on the next turn when the unit reaches a terminal state. Default listing shows active + recently-completed jobs only (`/jobs all` for the full table) |

### Skills

| Skill | Provides |
|-------|----------|
| [`skills/code-comments`](skills/code-comments/SKILL.md) | Comment discipline for repo code: default is no comment (names carry the what); why-comments for rationale/constraints/workarounds; what-comments only for genuinely complex logic; never session narration ("changed X", "per request", changelogs, commented-out code). Auto-loads when writing or editing repo code or reviewing comments |
| [`skills/code-review`](skills/code-review/SKILL.md) | Read-only pre-commit review gate: before any commit the user didn't explicitly request, present a structured report (correctness, scope creep, claims vs reality, conventions, gate results) with zero edits, materialize it as a keyed markdown buffer, open it via the `open_in_editor` tool (`$EDITOR`) so the user can answer inline or in a bottom `# Answers` block, then act on the chosen path (fix / commit as-is / commit with amendments / hold). Skipped when the user explicitly asks to commit |
| [`skills/ddgs-websearch`](skills/ddgs-websearch/SKILL.md) | Web/news/image/video/book search and URL content extraction via the `ddgs` CLI (no API keys). Loads automatically when a task needs fresh web info; also usable as `/skill:ddgs-websearch`. Requires `ddgs` on PATH |
| [`skills/git-clone-investigate`](skills/git-clone-investigate/SKILL.md) | Given a repo URL, clone to a scratch dir and investigate with git + file tools (`log`, `blame`, `ls-files`, `rg`, `read`) — never the forge web/API/raw URLs. Auto-loads whenever a repo link needs exploring or answering questions about |
| [`skills/impossibility-scope`](skills/impossibility-scope/SKILL.md) | Discipline for impossibility/"can't happen" claims — forces actor/mechanism/flip-point scoping instead of absolutes. Loads whenever such a claim is written or checked |
| [`skills/quickshell-verify`](skills/quickshell-verify/SKILL.md) | Verification ladder for Quickshell (QML) configs: `scripts/verify.sh` lints (known false positives filtered, config singletons detected) and runs the offscreen `qs -p` load-test, classifying pass/real-failure. References carry qmllint triage and hard-won QML gotchas. Auto-loads for quickshell work; requires `qs` + Qt6 qmllint |
| [`skills/shellcheck-repo`](skills/shellcheck-repo/SKILL.md) | Shellcheck gate for repo-bound shell scripts: run `shellcheck --severity=warning` on every script created/edited for a commit (`.sh`, shebang'd extensionless, sourced libs) before claiming done; no-new-findings rule for legacy scripts. Auto-loads whenever pi writes shell files; ad-hoc shell commands excluded. Requires `shellcheck` on PATH |
| [`skills/shell-quality`](skills/shell-quality/SKILL.md) | Design and review gate for repo-bound shell scripts (complements `shellcheck-repo`): avoid hardcoded lists that should be derived, stale comments, fragile inline multi-language programs, awkward escape chains. Auto-loads when writing or reviewing repo scripts; ad-hoc commands excluded |
| [`skills/yaml-lint-repo`](skills/yaml-lint-repo/SKILL.md) | Yamllint + parse probe (+ optional prettier/yamlfmt format check) for repo-bound YAML files and markdown frontmatter. Complements `yaml-quality` (design review). Uses each tool if installed; absence degrades the gate (warn + skip), it doesn't block the skill |
| [`skills/yaml-quality`](skills/yaml-quality/SKILL.md) | Design and review gate for repo-bound YAML (complements `yaml-lint-repo`): avoid implicit-type footguns (Norway/sexagesimal/octal), unquoted colons, comments that don't survive the formatter, fragile quoting strategy. References cover pitfalls, quoting rules, style, and sub-format conventions. Auto-loads when writing/reviewing repo YAML |
| [`skills/systemd-jobs`](skills/systemd-jobs/SKILL.md) | How to run background jobs as transient systemd units (`systemd-run --user --no-block`), monitor them (`systemctl --user status`, `journalctl -u`, `systemctl wait`), set timeouts (`RuntimeMaxSec=`), capture output, schedule (`--on-active` / `--on-calendar`), and clean up. Loads when the agent needs to launch a long-running command and react to its completion or timeout without holding bash hostage. Requires systemd (PID 1 = systemd, `systemctl --user` reachable) |
## Install

```bash
./install.sh
```

which runs `pi install /path/to/this/repo` at **user scope** (registered in
`~/.pi/agent/settings.json`, active in every project — deliberately not
project-local).

Manual equivalent:

```bash
pi install ~/src/my-pi
```

pi registers the repo **by reference, without copying**: this repository is
the single source of truth. Edits here are picked up by `/reload` or the
next pi start. Verify with `pi list`, or fully with `./verify.sh`.

The settings entry is a path **relative to the settings file's directory**
(e.g. `"../../src/my-pi"`), resolved to the absolute repo path at every
startup — a live link to wherever the repo sits on disk. If the repo is
moved or re-cloned elsewhere, re-run `./install.sh` from the new location.
See `AGENTS.md` for the full implications.

## Local context layering

Two layers guarantee pi is context-aware about the local directory
before actioning commands:

1. **Native (always on):** `AGENTS.md` in the project root — pi loads
   it (and `CLAUDE.md` / `AGENTS.override.md`) from cwd and parent
   directories at startup. This repo carries its own `AGENTS.md` with
   the project rules.
2. **Fallback (`extensions/local-context`):** for directories WITHOUT
   a project context file, the extension appends a directory snapshot
   (entries, README head, package.json summary, git branch/status/log)
   to the system prompt on every user prompt. It deliberately backs
   off when an `AGENTS.md`/`CLAUDE.md` exists in the cwd or git root,
   or when pi already loaded a context file from within the project —
   native context is richer and duplication only burns tokens.

Debug the fallback with `PI_LOCAL_CONTEXT_DEBUG=1` (decision + injected
block on stderr). Disable per run with `--local-context=false`.

## Startup & load order

pi reads this repo at startup, **before** actioning your first command:

1. pi starts → reads `~/.pi/agent/settings.json` → `packages` entry
   points here (path is resolved against the settings file, not cwd,
   so the repo loads no matter where pi is launched)
2. Extensions in `extensions/` execute and register commands/keys
   (extension slash commands are user-facing TUI commands — they are
   not part of the model's context; skills are)
3. Skill descriptions from `skills/` are injected into the system prompt
4. Only then is user input processed

Because of (4), a fresh session can use `/plan` or the `ddgs-websearch`
skill on its very first command — no preload or `/skill:` invocation
needed (the full SKILL.md is read on demand when the task matches).

Rules that keep this true:

- Do **not** copy skills from here into `~/.pi/agent/skills/` — pi keeps
  the first skill found on a name collision, so a stale global copy can
  silently shadow this repo
- Edits here apply on the next pi start or `/reload`
- New machine checklist: clone → `./install.sh` → `./verify.sh`

## Uninstall

```bash
./uninstall.sh
```

## Adding a new extension

1. Create `extensions/<name>/index.ts` exporting a default factory:

   ```typescript
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

   export default function (pi: ExtensionAPI) {
     // pi.registerTool(...), pi.registerCommand(...), pi.on(...)
   }
   ```

   (or a single `extensions/<name>.ts` file — both shapes are discovered)

2. Restart pi or run `/reload`.

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`,
   `description`) — see `skills/ddgs-websearch/SKILL.md` for an example.
2. Restart pi or run `/reload`.

## Notes

- Peer imports (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`,
  `typebox`) are bundled with pi itself — no `npm install` needed.
- Skills are plain markdown (`SKILL.md` + frontmatter), so this package
  has no npm dependencies at all.
- `skills/ddgs-websearch` needs the external `ddgs` CLI at runtime
  (`pip install ddgs`); it self-installs via the Setup section in its
  SKILL.md when missing.
- `skills/quickshell-verify` needs `qs` (quickshell ≥ 0.3.0) and Qt6
  qmllint at runtime; `scripts/verify.sh` degrades to load-test-only when
  qmllint is absent.
- `skills/shellcheck-repo` needs the external `shellcheck` CLI at runtime;
  scripts delivered without a clean/justified gate run must say so.
- `skills/yaml-lint-repo` uses `yamllint` + `prettier`/`yamlfmt` if
  installed; absence only warns (frontmatter is still validated by the
  skill-load check). Scripts delivered without running the gate should
  say so.
- Prefer moving extensions and skills here over dropping files into
  `~/.pi/agent/extensions/` or `~/.pi/agent/skills/`, so everything is
  versioned in one place.
