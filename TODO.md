# TODO

Two kinds of items live here:

1. **Code-review follow-ups**: a finding from the `code-review` skill
   that was marked `later`. Each entry is the agent's verbatim quote
   from the review context (file:line + one-line summary), plus a date
   stamp so the list stays scannable.
2. **Out-of-band follow-ups**: anything else worth tracking that doesn't
   fit in a commit message or a README.

Format:

```
- [YYYY-MM-DD] `path/to/file:LINE` — <one-line summary>
```

Items graduate out by being checked off (`- [x]`) when addressed, then
removed in the next history pass.

## Out-of-band

- [2026-09-02] `extensions/systemd-jobs/index.ts` — Add headless smoke tests for `systemd_run` + watcher using multiple models (minimax/MiniMax-M2.7 caught the unit-name parsing bug that the default model didn't reach). Candidate command pattern: `pi --no-session --model minimax/MiniMax-M2.7 -p "Use systemd_run to launch a 5-second sleep..."`. Add to verify.sh or a new `scripts/test-extensions.sh`.