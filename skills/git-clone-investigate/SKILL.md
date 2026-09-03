---
name: git-clone-investigate
description: Use when investigating third-party software from its source, with or without a URL in hand. Triggers include — the user shares a repo link to explore/summarize/review/answer questions about; the user asks how a library/tool/framework works internally, why it errors or misbehaves, or whether a given version supports a feature; debugging a dependency where upstream source is the ground truth. Clone the repo locally and investigate with git and file tools — never the forge web/API/raw URLs. Not for the current project on disk, forge-only facts (issues/PRs/stars/CI), or fresh-web questions (news, comparisons) where websearch fits.
compatibility: Requires only git on PATH (standard everywhere pi runs). No forge account, tokens, or API access needed; package-manager or web lookups to locate an upstream URL are optional conveniences, not requirements.
---

# Clone-and-investigate git repos

When figuring out third-party software, **the local clone is the source
of truth**. Do not learn about the repo from forge pages, forge APIs, or
raw file URLs — clone it and use git plus file tools. This holds even
when training data "knows" the answer: source beats memory, especially
for version-specific behavior.

## When to reach for this

Two triggers, same workflow:

1. **A repo URL is in hand** — the user shared a link. Clone it.
2. **No URL, but the question lives in upstream source** — "how does X
   implement Y", "why does X throw Z", "does X support W in version N".
   Derive the canonical repo URL first, then clone:

   ```bash
   # from the installed package itself
   pip show <pkg> | grep -iE 'home.?page|project.?urls'
   npm view <pkg> repository.url
   # from the current project's manifests / lockfiles / imports
   rg -i 'repository|homepage' package.json pyproject.toml Cargo.toml go.mod
   ```

   A web search to find the canonical repo URL is fine — the rule
   forbids learning repo *content* from the forge, not discovering where
   the repo lives.

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

## Not for

- The current project on disk — read it directly, no clone.
- Forge-only facts (issues, PRs, CI runs, stars, forks) — outside what
  a clone can show; say so instead of guessing or fetching the forge.
- Fresh-web questions — news, release roundups, comparisons. That is
  `ddgs-websearch` territory; come back here once the answer needs
  source-level ground truth.

## Rules

- Cite local file paths and short commit SHAs, not URLs.
- Report where the scratch clone lives; remove it only if the user asks.
