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
echo "Resources (details: README.md):"
shopt -s nullglob
for ext in "$REPO_ROOT"/extensions/*/index.ts; do
	name="$(basename "$(dirname "$ext")")"
	flag="$(sed -n 's/.*registerFlag("\([^"]*\)".*/\1/p' "$ext" | head -n1)"
	if [[ -n $flag ]]; then
		echo "  extensions/$name -> pi --$flag"
	else
		echo "  extensions/$name (no CLI flag)"
	fi
done
for skill_md in "$REPO_ROOT"/skills/*/SKILL.md; do
	name="$(basename "$(dirname "$skill_md")")"
	desc="$(sed -n 's/^description: *//p' "$skill_md" | head -n1)"
	if [[ ${#desc} -gt 100 ]]; then
		desc="${desc:0:100}…"
	fi
	echo "  skills/$name -> $desc"
done
echo "Run 'pi list' to verify, or /reload inside a running session."
echo "Confirm startup loading on this machine: ./verify.sh"
