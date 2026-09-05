#!/usr/bin/env bash
# Remove bpi's pi package registration (user scope).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SOURCE="git:github.com/3loc/bpi"

case "${1:---local}" in
	--local) SOURCE="$REPO_ROOT" ;;
	--remote) SOURCE="$REMOTE_SOURCE" ;;
	-h|--help)
		echo "Usage: $0 [--local|--remote]"
		exit 0
		;;
	*)
		echo "error: unknown option: $1" >&2
		exit 2
		;;
esac

command -v pi >/dev/null 2>&1 || {
	echo "error: pi not found on PATH" >&2
	exit 1
}

pi remove "$SOURCE"
echo "Removed: $SOURCE"
