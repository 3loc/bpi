#!/usr/bin/env bash
# quickshell-verify/scripts/qml-selftest.sh — run a pure-QML self-test
# (Timer + assertions + Qt.exit(rc)) offscreen and report its result.
#
# The scratch config's shell.qml is expected to `Qt.exit(0)` on success
# and `Qt.exit(N)` on failure; this script just propagates that exit
# code. With --marker, the log is also required to contain the marker
# string (default "SELFTEST PASS") for the run to count as passed.
#
# The argument may be a config dir (containing shell.qml) or the path
# to a shell.qml file directly — `qs -p` accepts both.
#
# Usage:
#   qml-selftest.sh <config-dir> [--timeout 30] [--marker "PASS"]
#
# Exit: 0 = self-test passed · 1 = failed · 2 = usage/timeout.

set -u

usage() {
	cat <<EOF
Usage: $(basename "$0") <config-dir> [--timeout 30] [--marker "SELFTEST PASS"]
EOF
}

CONFIG_DIR="${1:-}"
shift || true
TIMEOUT=30
MARKER="SELFTEST PASS"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--timeout) TIMEOUT="$2"; shift 2 ;;
		--marker)  MARKER="$2"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) printf 'unknown arg: %s\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done

[[ -d $CONFIG_DIR || ( -f $CONFIG_DIR && $CONFIG_DIR == *.qml ) ]] \
	|| { printf 'FAIL: %s is neither a config dir nor a .qml file\n' "$CONFIG_DIR" >&2; exit 2; }
command -v qs >/dev/null 2>&1 || { printf 'FAIL: qs not on PATH\n' >&2; exit 2; }

LOG="$(mktemp -t qs-selftest.XXXXXX.log)"

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

# Wait for the process to exit naturally (Qt.exit) or for the timeout.
deadline=$(( $(date +%s) + TIMEOUT ))
while kill -0 "$QS_PID" 2>/dev/null && [[ $(date +%s) -lt $deadline ]]; do
	sleep 0.1
done

if kill -0 "$QS_PID" 2>/dev/null; then
	printf 'FAIL: self-test did not exit within %ss\n' "$TIMEOUT"
	tail -30 "$LOG"
	exit 1
fi

wait "$QS_PID"
rc=$?

if [[ $rc -ne 0 ]]; then
	printf 'FAIL: self-test exited rc=%d\n' "$rc"
	grep -E "FAIL" "$LOG" | head -20
	exit 1
fi

if [[ -n $MARKER ]] && ! grep -qF "$MARKER" "$LOG"; then
	printf 'FAIL: marker %q not in log (rc=0 but no pass signal)\n' "$MARKER"
	exit 1
fi

# Count assertions if the self-test used `console.log("ok ...")` /
# `console.log("FAIL ...")` lines. The qs logging pipeline prefixes
# each line with a DEBUG/WARN tag, so we match on substrings.
passes="$(grep -c ' ok ' "$LOG" || true)"
fails="$(grep -c ' FAIL ' "$LOG" || true)"
if [[ $passes -gt 0 || $fails -gt 0 ]]; then
	printf 'ok:   self-test (%d passed, %d failed)\n' "$passes" "$fails"
	[[ $fails -eq 0 ]] || exit 1
else
	printf 'ok:   self-test (rc=0)\n'
fi
exit 0
