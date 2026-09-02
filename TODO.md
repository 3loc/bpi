# TODO

Two kinds of items live here:

1. **Code-review follow-ups**: a finding from the `code-review` skill
   that was marked `later`. Each entry is the agent's verbatim quote
   from the review context (file:line + one-line summary), plus a date
   stamp so the list stays scannable.
2. **Out-of-band follow-ups**: anything else worth tracking that doesn't
   fit in a commit message or a README.

Regression risks (issues that already bit us and the structural
defenses the next session should build or harden) live in
[`REGRESSION.md`](REGRESSION.md), not here.

Format:

```
- [YYYY-MM-DD] `path/to/file:LINE` — <one-line summary>
```

Items graduate out by being checked off (`- [x]`) when addressed, then
removed in the next history pass.

## Out-of-band

- [x] [2026-09-02] `extensions/systemd-jobs/index.ts` — Add headless smoke tests for `systemd_run` + watcher using multiple models (minimax/MiniMax-M2.7 caught the unit-name parsing bug that the default model didn't reach). Candidate command pattern: `pi --no-session --model minimax/MiniMax-M2.7 -p "Use systemd_run to launch a 5-second sleep..."`. Add to verify.sh or a new `scripts/test-extensions.sh`. — **Done**: replaced systemd-jobs with `extensions/background-tasks/` (5-layer abstraction: state → backend interface → systemd + inproc implementations → watcher → tools → pi entry); 66 unit + integration tests via `node --test --experimental-strip-types`; the original stderr-parsing bug is locked in by a regression test in `state.test.ts`. Run `npm test` or `./verify.sh` (Check 2e)
- [2026-09-02] `extensions/background-tasks/backends/systemd.ts:147` — `argsFor()` always prepends `--user`, so a job launched with `system=true` cannot be status-checked, waited on, or cancelled (the follow-up calls would hit `systemctl --user show <unit>` and miss the unit). Track scope per-job on the `Job` struct and thread it through `argsFor`. Impact is currently zero: system scope is opt-in and the skill discourages it. Fix when a real workload hits the path.