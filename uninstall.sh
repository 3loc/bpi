#!/usr/bin/env bash
# Remove this repo's pi package registration (user scope).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v pi >/dev/null 2>&1 || {
	echo "error: pi not found on PATH" >&2
	exit 1
}

pi remove "$REPO_ROOT"
echo "Removed: $REPO_ROOT"
