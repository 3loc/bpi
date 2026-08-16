#!/usr/bin/env bash
# Verify pi loads this repo (extensions + skills) at startup,
# BEFORE actioning any user command.
#
# Check 1 (offline): repo is registered as a package in pi settings.
# Check 2 (offline): extensions executed at startup — plan-mode
#                    contributes the --plan CLI flag, which pi's help
#                    only shows if the extension ran. (Extension slash
#                    commands like /plan are user-facing TUI commands
#                    and are NOT visible to the model, so we check the
#                    CLI flag instead of asking the model.)
# Check 3 (probe):   a fresh non-interactive pi session launched from
#                    an unrelated cwd must already see the repo's
#                    skills — proving they entered the system prompt
#                    at startup. One small LLM call; skip with
#                    --offline.
set -euo pipefail

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

# Check 2: extensions executed at startup
if pi --help 2>&1 | grep -q -- "--plan"; then
	echo "ok: extensions loaded at startup (--plan flag present)"
else
	echo "FAIL: plan-mode extension did not load (no --plan flag)" >&2
	exit 1
fi

# Check 3: skills reach the system prompt at startup
if [[ $OFFLINE -eq 1 ]]; then
	echo "skip: skill probe (--offline)"
	exit 0
fi

probe="$(cd /tmp && pi -p "List the skills you have. One line. Nothing else." 2>/dev/null || true)"
if grep -qi "ddgs-websearch" <<<"$probe"; then
	echo "ok: skills in system prompt at startup (probe from /tmp saw ddgs-websearch)"
else
	echo "FAIL: startup probe did not see ddgs-websearch" >&2
	echo "hints: run 'pi list', watch pi startup warnings, or /reload" >&2
	exit 1
fi
