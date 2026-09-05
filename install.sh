#!/usr/bin/env bash
# Install bpi as a pi package at USER scope (global, all projects).
#
# By default this registers the current checkout by reference for development.
# Pass --remote to install the public GitHub package into pi's managed git
# package directory instead. NOT project-local by design.
#
# Requires: pi (https://pi.dev)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SOURCE="git:github.com/3loc/bpi"

case "${1:---local}" in
	--local) SOURCE="$REPO_ROOT" ;;
	--remote) SOURCE="$REMOTE_SOURCE" ;;
	-h|--help)
		echo "Usage: $0 [--local|--remote]"
		echo "  --local   register this checkout by reference (default)"
		echo "  --remote  install the public GitHub package"
		exit 0
		;;
	*)
		echo "error: unknown option: $1" >&2
		echo "Usage: $0 [--local|--remote]" >&2
		exit 2
		;;
esac

command -v pi >/dev/null 2>&1 || {
	echo "error: pi not found on PATH" >&2
	exit 1
}

# Optional runtime dependency: ddgs CLI (skills/ddgs-websearch)
if ! command -v ddgs >/dev/null 2>&1; then
	echo "warning: 'ddgs' not found on PATH — the ddgs-websearch skill needs it"
	echo "         install with: pip install ddgs (or pipx/uv tool install ddgs)"
fi

pi install "$SOURCE"

echo
echo "Installed: $SOURCE"
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
if [[ $SOURCE == "$REPO_ROOT" ]]; then
	echo "Confirm startup loading on this machine: ./verify.sh"
else
	echo "Update later with: pi update --extensions"
fi
