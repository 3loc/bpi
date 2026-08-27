#!/usr/bin/env bash
# quickshell-verify/scripts/ipc-test.sh — runtime test for IpcHandler
# functions without a compositor.
#
# Boots a scratch config offscreen, waits for its IPC socket to become
# ready (no stale-socket or oldest-vs-newest guesswork — selects the
# instance by PID it started with), then runs each line of a matrix
# file as `qs ipc call <target> <func> [args...]`. Asserts that every
# call (a) parses and matches the handler's typed arity (no stderr),
# and (b) reaches the handler — verified by grepping the instance's
# stdout for an `IPCMARK <target> <function>` line that the extracted
# handler bodies print (see extract-ipc-handlers.py).
#
# Matrix file format: one `<target> <function> [args...]` per line;
# `# comments` and blank lines are skipped.
#
# The caller is responsible for building the scratch config (typically
# with extract-ipc-handlers.py) and ensuring any relative `import`d
# resources (e.g. OverviewModel.js) are alongside shell.qml.
#
# Usage:
#   ipc-test.sh --config <dir> --matrix <file> [--timeout 5]
#
# Exit: 0 = every call parsed AND a marker appeared · 1 = one or more
# calls failed · 2 = tooling/usage error.

set -u

usage() {
	cat <<EOF
Usage: $(basename "$0") --config <dir> --matrix <file> [--timeout 5]

  --config <dir>   scratch config dir (must contain shell.qml)
  --matrix <file>  one call per line: '<target> <func> [args...]'
  --timeout <sec>  boot/wait timeout (default 5)
EOF
}

CONFIG_DIR=""
MATRIX=""
TIMEOUT=5

while [[ $# -gt 0 ]]; do
	case "$1" in
		--config)  CONFIG_DIR="$2"; shift 2 ;;
		--matrix)  MATRIX="$2"; shift 2 ;;
		--timeout) TIMEOUT="$2"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) printf 'unknown arg: %s\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

[[ -d $CONFIG_DIR ]] || { printf 'FAIL: config dir %s not found\n' "$CONFIG_DIR" >&2; exit 2; }
[[ -r $MATRIX ]] || { printf 'FAIL: matrix file %s not readable\n' "$MATRIX" >&2; exit 2; }
command -v qs >/dev/null 2>&1 || { printf 'FAIL: qs not on PATH\n' >&2; exit 2; }

say_ok()   { printf 'ok:   %s\n' "$*"; }
say_warn() { printf 'warn: %s\n' "$*"; }
say_fail() { printf 'FAIL: %s\n' "$*"; }

LOG="$(mktemp -t qs-ipc-test.XXXXXX.log)"
SOCKET_DIR="/run/user/$(id -u)/quickshell"

# --- boot ----------------------------------------------------------------
QT_QPA_PLATFORM=offscreen qs -p "$CONFIG_DIR" >"$LOG" 2>&1 &
QS_PID=$!

cleanup() {
	if kill -0 "$QS_PID" 2>/dev/null; then
		kill "$QS_PID" 2>/dev/null || true
		wait "$QS_PID" 2>/dev/null || true
	fi
	rm -f "$LOG"
}
trap cleanup EXIT

# Wait for the per-pid socket symlink to appear (the instance finished
# registering its IPC). Bounded by --timeout.
deadline=$(( $(date +%s) + TIMEOUT ))
while [[ $(date +%s) -lt $deadline ]]; do
	if [[ -L "$SOCKET_DIR/by-pid/$QS_PID" ]]; then
		break
	fi
	sleep 0.1
done
if [[ ! -L "$SOCKET_DIR/by-pid/$QS_PID" ]]; then
	say_fail "instance did not register IPC within ${TIMEOUT}s"
	printf 'log tail:\n'; tail -20 "$LOG"
	exit 1
fi
INSTANCE_ID="$(readlink "$SOCKET_DIR/by-pid/$QS_PID" | xargs basename)"

# --- run matrix ----------------------------------------------------------
declare -i passed=0 failed=0
while IFS= read -r line || [[ -n $line ]]; do
	# strip comments / blanks
	case "$line" in
		''|\#*) continue ;;
	esac
	# Tokenize: target func [args...]
	read -r target func rest <<<"$line"

	# Each call: rc + stderr captured. Empty rc/stderr is success.
	out="$(qs ipc -i "$INSTANCE_ID" call "$target" "$func" $rest 2>&1)"
	rc=$?

	# Find the matching IPCMARK line (most recent with this target+func).
	# Use tail -n1 to pick the last one (handles multiple calls of the
	# same function if you put it in the matrix twice).
	marker="$(grep -F "IPCMARK $target $func" "$LOG" | tail -n1 || true)"

	if [[ $rc -ne 0 ]]; then
		printf 'FAIL: %s %s %s — rc=%d output=%s\n' "$target" "$func" "$rest" "$rc" "$out"
		(( failed++ ))
	elif [[ -z $out ]]; then
		# Empty stderr AND rc=0: parsed + arity matched. Still need a marker.
		if [[ -n $marker ]]; then
			printf 'ok:   %s %s %s — %s\n' "$target" "$func" "$rest" "$marker"
			(( passed++ ))
		else
			printf 'FAIL: %s %s %s — no IPCMARK in instance log (handler never ran)\n' "$target" "$func" "$rest"
			(( failed++ ))
		fi
	else
		# Has stderr output — likely a parse error or arity mismatch.
		printf 'FAIL: %s %s %s — %s\n' "$target" "$func" "$rest" "$out"
		(( failed++ ))
	fi
done <"$MATRIX"

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
exit 0
