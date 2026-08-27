---
name: git-clone-investigate
description: Use when the user shares a link/URL to a git repository (GitHub, GitLab, cgit, any forge or plain git URL) and asks to explore, summarize, review, or answer questions about it. Clone the repo locally and investigate with git and file tools — never query the forge (no web scraping, no forge API, no per-file raw URLs).
compatibility: Requires only git on PATH (standard everywhere pi runs). No forge account, tokens, or API access needed.
---

# Clone-and-investigate git repos

When given a repo URL, **the local clone is the source of truth**. Do not
learn about the repo from forge pages, forge APIs, or raw file URLs —
clone it and use git plus file tools.

## Setup

None beyond git itself (`git --version` to confirm).

## Workflow

1. Clone into a scratch directory, never into the current project:

   ```bash
   REPO="$(mktemp -d /tmp/repo-XXXXXX)/repo"
   git clone <url> "$REPO"
   ```

   Use `--depth 1` only if a full clone is impractically large — history
   is usually part of the investigation.

2. Orient yourself locally:

   ```bash
   git -C "$REPO" log --oneline -20     # recent history
   git -C "$REPO" shortlog -sn          # top authors
   git -C "$REPO" ls-files              # tracked layout
   ls "$REPO"                           # then read README / AGENTS.md / build files
   rg <pattern> "$REPO"                 # search code and docs
   ```

3. Answer questions from the working tree and history: `git log`,
   `git blame`, `git tag`, `git diff`, and the `read` tool.

## Rules

- Forge-only facts (issues, PRs, CI runs, stars, forks) are outside what
  a clone can show — say so instead of guessing or fetching the forge.
- Cite local file paths and short commit SHAs, not URLs.
- Report where the scratch clone lives; remove it only if the user asks.
