#!/usr/bin/env bash
# quickshell-verify/scripts/verify.sh — the verification ladder, automated.
#
# Stage 1 (lint):      qmllint every .qml file, dropping records that match
#                      known false positives (standalone qmllint cannot
#                      resolve a config's implicit qs.* modules or its
#                      implicitly registered singletons — no qmldir exists).
# Stage 2 (load-test): QT_QPA_PLATFORM=offscreen qs -p <dir>. A config whose
#                      QML parses/types fine fails only at the compositor
#                      backend; anything deeper in the `caused by` chain is
#                      a real error the live session would also report.
#
# Exit codes: 0 = pass · 1 = real failure · 2 = tooling missing / unexpected.
# Lint output never changes the exit code (lint alone is insufficient by
# design); remaining warnings are printed for triage against
# references/lint-triage.md.
#
# Env overrides: QS_BIN, QMLLINT, QS_VERIFY_TIMEOUT (default 6).
set -u

CONFIG_DIR="${1:-.}"
QS_BIN="${QS_BIN:-qs}"
QMLLINT="${QMLLINT:-/usr/lib/qt6/bin/qmllint}"
QMLLINT_ARGS=(-I /usr/lib/qt6/qml -I /usr/bin)
TIMEOUT_S="${QS_VERIFY_TIMEOUT:-6}"

say_ok()   { printf 'ok:   %s\n' "$*"; }
say_warn() { printf 'warn: %s\n' "$*"; }
say_fail() { printf 'FAIL: %s\n' "$*"; }

[[ -d $CONFIG_DIR ]] || { say_fail "config dir '$CONFIG_DIR' not found"; exit 2; }

# --- tooling ----------------------------------------------------------------
command -v "$QS_BIN" >/dev/null 2>&1 || {
	say_fail "quickshell ('$QS_BIN') not on PATH — cannot load-test"
	exit 2
}
if [[ ! -x $QMLLINT ]]; then
	if command -v qmllint >/dev/null 2>&1; then
		QMLLINT="$(command -v qmllint)"
	else
		QMLLINT=""
	fi
fi

# --- stage 1: lint with known-noise filter -----------------------------------
# qmllint separates multi-line warnings with '---' separator lines; filter
# whole records (header + code frame) so a dropped warning never leaves
# orphaned code frames behind.
lint_filter() {
	local singles="${1:-}"
	awk -v singles="$singles" '
		function flush() {
			if (rec ~ /[^[:space:]]/) {
				keep = 1
				for (i = 1; i <= npat; i++)
					if (index(rec, pat[i]) > 0) { keep = 0; break }
				# unqualified access THROUGH a config-local singleton name is the
				# idiomatic pattern; standalone qmllint cannot resolve the type
				if (keep && index(rec, "Unqualified access") > 0)
					for (i = 1; i <= ns; i++)
						if (index(rec, sa[i] ".") > 0) { keep = 0; break }
				if (keep) printf "%s", rec
			}
			rec = ""
		}
		BEGIN {
			# config-implicit modules and singletons (no qmldir for them)
			pat[++npat] = "Warnings occurred while importing module \"qs."
			pat[++npat] = "Failed to import qs."
			pat[++npat] = "was not found. Did you add all imports and dependencies?"
			pat[++npat] = "declared as singleton in qmldir"
			pat[++npat] = "is not creatable"
			pat[++npat] = "missing required property modelData"
			# qmltypes gaps (quickshell 0.3.0)
			pat[++npat] = "No type found for property \"edges\""
			pat[++npat] = "No type found for property \"gravity\""
			# suggestion block glued to a dropped not-found record
			pat[++npat] = "Info: Did you mean"
			# members of config-local singletons (names passed in)
			ns = split(singles, sa, ",")
			for (i = 1; i <= ns; i++)
				pat[++npat] = "not found on type \"" sa[i] "\""
		}
		/^---[[:space:]]*$/ { flush(); next }
		{ rec = rec $0 "\n" }
		END { flush() }
	'
}

count_headers() { grep -cE '^(Warning|Info|Error): ' || true; }

mapfile -t qml_files < <(find "$CONFIG_DIR" -type f -name '*.qml' -not -path '*/.*' | sort)
if [[ ${#qml_files[@]} -eq 0 ]]; then
	say_fail "no .qml files under $CONFIG_DIR"
	exit 2
fi

if [[ -n $QMLLINT ]]; then
	# Names of the config's own singletons (pragma at top of file) — used to
	# filter `Member "x" not found on type "<Singleton>"` noise generically.
	single_csv=""
	for f in "${qml_files[@]}"; do
		if grep -q '^pragma Singleton' "$f"; then
			single_csv+="${single_csv:+,}$(basename "${f%.qml}")"
		fi
	done
	raw=""
	for f in "${qml_files[@]}"; do
		raw+="$( "$QMLLINT" "${QMLLINT_ARGS[@]}" "$f" 2>&1 || true )"
		raw+=$'\n---\n'
	done
	raw_n="$(printf '%s' "$raw" | count_headers)"
	filtered="$(printf '%s' "$raw" | lint_filter "$single_csv")"
	kept_n="$(printf '%s' "$filtered" | count_headers)"
	say_ok "lint: ${#qml_files[@]} files, $raw_n warnings, $((raw_n - kept_n)) known-false-positive dropped, $kept_n remaining"
	if [[ $kept_n -gt 0 ]]; then
		printf '%s\n' "$filtered"
		printf '     (remaining warnings are advisory — triage against references/lint-triage.md)\n'
	fi
else
	say_warn "qmllint not found — skipping lint stage (load-test is authoritative)"
fi

# --- stage 2: offscreen load-test --------------------------------------------
load_out="$(QT_QPA_PLATFORM=offscreen timeout "$TIMEOUT_S" "$QS_BIN" -p "$CONFIG_DIR" 2>&1)"
load_rc=$?

log_path="$(grep -m1 'Saving logs to' <<<"$load_out" | sed 's/.*Saving logs to //; s/"//g')"

if grep -q 'Failed to load configuration' <<<"$load_out"; then
	deepest="$(grep 'caused by' <<<"$load_out" | tail -n1)"
	if [[ -n $deepest && $deepest == *"backend loaded"* ]]; then
		say_ok "load-test: PASS (parsed/typed fine; only the compositor backend is missing offscreen)"
	elif [[ -z $deepest ]]; then
		say_fail "load-test: config failed to load with no 'caused by' chain (unexpected shape)"
		printf '%s\n' "$load_out"
		exit 2
	else
		say_fail "load-test: REAL load failure — fix the deepest cause:"
		grep -E 'Failed to load configuration|caused by' <<<"$load_out"
		[[ -n $log_path ]] && printf '     full log: %s\n' "$log_path"
		exit 1
	fi
elif [[ $load_rc -eq 124 || $load_rc -eq 0 ]]; then
	say_ok "load-test: PASS (rc=$load_rc — ran until timeout / exited cleanly)"
else
	say_fail "load-test: unexpected exit rc=$load_rc"
	printf '%s\n' "$load_out"
	exit 2
fi

# Advisory: runtime errors that did not abort the load (still a PASS, but
# worth triaging — excludes the expected backend failure chain).
advisory="$(grep -E '(ERROR|WARNING)' <<<"$load_out" | grep -v 'Failed to load configuration' | grep -v 'caused by' || true)"
if [[ -n $advisory ]]; then
	say_warn "runtime errors while running under offscreen (triage):"
	printf '%s\n' "$advisory"
fi

exit 0
