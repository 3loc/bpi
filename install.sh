#!/usr/bin/env bash
# Install this repo as a pi package at USER scope (global, all projects).
#
# pi registers the repo path in ~/.pi/agent/settings.json without copying:
# this repository stays the single source of truth. Edits here take effect
# after /reload or the next pi start. NOT project-local by design.
#
# Requires: pi (https://pi.dev)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v pi >/dev/null 2>&1 || {
	echo "error: pi not found on PATH" >&2
	exit 1
}

# Optional runtime dependency: ddgs CLI (skills/ddgs-websearch)
if ! command -v ddgs >/dev/null 2>&1; then
	echo "warning: 'ddgs' not found on PATH — the ddgs-websearch skill needs it"
	echo "         install with: pip install ddgs (or pipx/uv tool install ddgs)"
fi

pi install "$REPO_ROOT"

echo
echo "Installed: $REPO_ROOT"
echo "Resources:"
echo "  extensions/workflow-mode -> /workflow, /todos, Ctrl+Alt+W, pi --workflow"
echo "                          settle-driven execution: /workflow run|pause,"
echo "                          review-verdict advance (no in-turn marker)"
echo "  extensions/sessions   ->  /sessions [all|switch], pi --sessions"
echo "                          activity-status session listing"
echo "  skills/ddgs-websearch  ->  web/news/image/video/book search + URL"
echo "                            extraction via ddgs (/skill:ddgs-websearch)"
echo "  skills/shellcheck-repo ->  shellcheck gate for shell scripts written"
echo "                            into repos (ad-hoc commands excluded)"
echo "Run 'pi list' to verify, or /reload inside a running session."
echo "Confirm startup loading on this machine: ./verify.sh"
