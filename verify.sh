#!/usr/bin/env bash
# Verify pi loads this repo (extensions + skills) at startup,
# BEFORE actioning any user command.
#
# Check 1  (offline): repo is registered as a package in pi settings
#                     (pi list shows this checkout's absolute path).
# Check 1b (offline): every skills/<name>/SKILL.md has valid frontmatter
#                     (name + description) — derived from skills/, so
#                     new skills are covered automatically.
# Check 2  (offline): every extension's registered CLI flag appears in
#                     pi --help — flags only show if the extension ran
#                     (slash commands are TUI-only and not visible
#                     here). Derived from extensions/, so new
#                     extensions are covered automatically.
# Check 2b (offline): a headless /sessions invocation prints the
#                     session list — proving the command is registered
#                     and functional, without any LLM call.
# Check 2c (offline): shellcheck gate over this repo's own shell
#                     scripts (the shellcheck-repo skill's gate,
#                     dogfooded; skipped if shellcheck is missing).
# Check 2d (offline): yamllint gate over this repo's own YAML files
#                     (the yaml-lint-repo skill's gate, dogfooded;
#                     skipped if yamllint is missing; warns but does
#                     not fail when no standalone .yaml/.yml files
#                     exist — frontmatter is already covered by 1b).
# Check 3  (probe):   a fresh non-interactive pi session launched from
#                     an unrelated cwd must already see the repo's
#                     skills — proving they entered the system prompt
#                     at startup. One small LLM call; skip with
#                     --offline.
set -euo pipefail

shopt -s nullglob

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFLINE=0
[[ "${1:-}" == "--offline" ]] && OFFLINE=1

command -v pi >/dev/null 2>&1 || {
	echo "error: pi not found on PATH" >&2
	exit 1
}

# Check 1: package registration
if pi list 2>/dev/null | grep -qF "$REPO_ROOT"; then
	echo "ok: package registered -> $REPO_ROOT"
else
	echo "FAIL: repo not found in 'pi list' — run ./install.sh first" >&2
	exit 1
fi

# Check 1b: skills present with valid frontmatter (name + description)
skill_mds=("$REPO_ROOT"/skills/*/SKILL.md)
if [[ ${#skill_mds[@]} -eq 0 ]]; then
	echo "FAIL: no skills found under $REPO_ROOT/skills" >&2
	exit 1
fi
for skill_md in "${skill_mds[@]}"; do
	skill="$(basename "$(dirname "$skill_md")")"
	if head -n1 "$skill_md" | grep -q '^---$' \
	   && grep -q '^name:' "$skill_md" && grep -q '^description:' "$skill_md"; then
		echo "ok: skill $skill present with valid frontmatter"
	else
		echo "FAIL: skill $skill missing or frontmatter invalid ($skill_md)" >&2
		exit 1
	fi
done

# Check 2: extensions executed at startup — each registers a CLI flag,
# which pi --help only shows if the extension ran. (Extension slash
# commands are user-facing TUI commands and are NOT visible to the
# model, so we check the flags instead.)
exts=("$REPO_ROOT"/extensions/*/index.ts)
if [[ ${#exts[@]} -eq 0 ]]; then
	echo "FAIL: no extensions found under $REPO_ROOT/extensions" >&2
	exit 1
fi
help_out="$(pi --help 2>&1 || true)"
for ext in "${exts[@]}"; do
	name="$(basename "$(dirname "$ext")")"
	flag="$(sed -n 's/.*registerFlag("\([^"]*\)".*/\1/p' "$ext" | head -n1)"
	if [[ -z $flag ]]; then
		echo "warn: $name registers no CLI flag — cannot prove it loaded"
		continue
	fi
	if grep -q -- "--$flag" <<<"$help_out"; then
		echo "ok: $name extension loaded (--$flag flag present)"
	else
		echo "FAIL: $name extension did not load (no --$flag flag)" >&2
		exit 1
	fi
done

# Check 2b: extension command runs headless (no LLM call)
if pi --no-session -p "/sessions" 2>&1 | grep -qi "session"; then
	echo "ok: sessions command runs headless (pi -p \"/sessions\")"
else
	echo "FAIL: sessions command produced no output" >&2
	exit 1
fi

# Check 2b2: context-usage-report command runs headless and lists skills +
# system prompt buckets — proves the command is registered, parses the
# prompt, and reports the expected categories, without any LLM call.
if pi --no-session -p "/context-report system" 2>&1 | grep -qi "skills (metadata)\|project context\|system prompt"; then
	echo "ok: context-usage-report command runs headless (pi -p \"/context-report system\")"
else
	echo "FAIL: context-usage-report command produced no expected output" >&2
	exit 1
fi

# Check 2b3: /jobs command runs headless against the background-tasks
# extension — proves the extension loaded and registered the command,
# without any LLM call.
if pi --no-session -p "/jobs" 2>&1 | grep -qi "background_run"; then
	echo "ok: background-tasks /jobs command runs headless (pi -p \"/jobs\")"
else
	echo "FAIL: /jobs command did not advertise background_run" >&2
	exit 1
fi

# Check 2e: node --test gate over the background-tasks test suite.
# Uses Node's built-in test runner with --experimental-strip-types so
# the tests run against the same TypeScript source pi loads, without
# adding a build step or a new dependency. Skipped on Node < 22.6
# (strip-types was experimental before then); absence of node is a
# warn, not a fail — the gate is a strict improvement, not a baseline.
if command -v node >/dev/null 2>&1; then
	node_major="$(node -p 'process.versions.node.split(".")[0]')"
	node_minor="$(node -p 'process.versions.node.split(".")[1]')"
	if (( node_major >= 23 )) || (( node_major == 22 && node_minor >= 6 )); then
		mapfile -t test_files < <(find "$REPO_ROOT/extensions/background-tasks" \
			-type f -name '*.test.ts' | sort)
		if [[ ${#test_files[@]} -eq 0 ]]; then
			echo "FAIL: no .test.ts files found under extensions/background-tasks" >&2
			exit 1
		fi
		# node --test discovers *.test.ts files in the directory form
		# itself — same shape as `npm test`. New test files get picked
		# up automatically; no list to maintain.
		if (cd "$REPO_ROOT" && node --test --experimental-strip-types \
				extensions/background-tasks/) >/dev/null 2>&1; then
			echo "ok: background-tasks test gate passed (${#test_files[@]} files)"
		else
			echo "FAIL: background-tasks tests failed — run 'npm test' for details" >&2
			(cd "$REPO_ROOT" && node --test --experimental-strip-types \
				extensions/background-tasks/) >&2
			exit 1
		fi
	else
		echo "warn: node $node_major.$node_minor < 22.6 — skipping background-tasks test gate"
	fi
else
	echo "warn: node not installed — skipping background-tasks test gate"
fi

# Check 2c: shellcheck gate on this repo's own shell scripts
if command -v shellcheck >/dev/null 2>&1; then
	mapfile -t sh_scripts < <(find "$REPO_ROOT" -type f -name '*.sh' \
		-not -path '*/.git/*' | sort)
	if [[ ${#sh_scripts[@]} -eq 0 ]]; then
		echo "FAIL: no shell scripts found under $REPO_ROOT" >&2
		exit 1
	fi
	if shellcheck --severity=warning "${sh_scripts[@]}"; then
		echo "ok: shellcheck gate passed (${#sh_scripts[@]} scripts)"
	else
		echo "FAIL: shellcheck findings above — fix, or suppress with a line directive + reason" >&2
		exit 1
	fi
else
	echo "warn: shellcheck not installed — skipping repo script gate"
fi

# Check 2d: yamllint gate on this repo's YAML files (parallel to the
# existing shellcheck pass; SKILL.md frontmatter is already covered
# by Check 1b, so this only sweeps standalone .yaml/.yml files).
if command -v yamllint >/dev/null 2>&1; then
	mapfile -t yaml_files < <(find "$REPO_ROOT" -type f \
		\( -name '*.yaml' -o -name '*.yml' \) \
		-not -path '*/.git/*' -not -path '*/node_modules/*' | sort)
	if [[ ${#yaml_files[@]} -eq 0 ]]; then
		echo "warn: no standalone .yaml/.yml files under $REPO_ROOT — yamllint gate skipped (frontmatter covered by Check 1b)"
	elif yamllint -d default \
		-d "{extends: relaxed, rules: {line-length: disable, document-start: disable, comments-indentation: disable}}" \
		"${yaml_files[@]}"; then
		echo "ok: yamllint gate passed (${#yaml_files[@]} files)"
	else
		echo "FAIL: yamllint findings above — fix, or suppress with a line directive + reason" >&2
		exit 1
	fi
else
	echo "warn: yamllint not installed — skipping repo YAML gate"
fi

# Check 3: skills reach the system prompt at startup
if [[ $OFFLINE -eq 1 ]]; then
	echo "skip: skill probe (--offline)"
	exit 0
fi

probe_skill="$(basename "$(dirname "${skill_mds[0]}")")"
probe="$(cd /tmp && pi -p "List the skills you have. One line. Nothing else." 2>&1 || true)"
if grep -qi "$probe_skill" <<<"$probe"; then
	echo "ok: skills in system prompt at startup (probe from /tmp saw $probe_skill)"
else
	echo "FAIL: startup probe did not see $probe_skill" >&2
	echo "probe output:" >&2
	printf '%s\n' "$probe" >&2
	echo "hints: run 'pi list', watch pi startup warnings, or /reload" >&2
	exit 1
fi
