---
name: ddgs-websearch
description: Web search via the ddgs CLI (DuckDuckGo metasearch). Use when the user asks to search the web, find current information, news, recent events, documentation, facts beyond training data, or to look up library/API versions. Also covers image, video, and book search plus URL content extraction. Use for any query where fresh or unknown web data is needed.
compatibility: Requires the ddgs CLI (v9.x) installed and on PATH. Check with `ddgs version`.
---

# Web Search with ddgs

`ddgs` is a CLI metasearch tool (DuckDuckGo + backends: bing, brave, google, etc.). No API keys required.

## Setup (only if `ddgs` is missing)

```bash
pip install ddgs          # or: pipx install ddgs / uv tool install ddgs
ddgs version              # verify (expects 9.x)
```

## Text Search (default choice)

```bash
ddgs text -q "query" -m 5 -nc
```

| Flag | Meaning |
|------|---------|
| `-q` | search query |
| `-m` | max results (default ~25; keep 5-10 for agent use) |
| `-t` | timelimit: `d` day, `w` week, `m` month, `y` year — use for recent info |
| `-r` | region, e.g. `us-en`, `de-de` |
| `-p` | page number for more results |
| `-b` | backend: `auto`, `duckduckgo`, `bing`, `brave`, `google`, `wikipedia`, `mojeek`, etc. Use a specific backend if `auto` returns poor results |
| `-s` | safesearch: `on`, `moderate`, `off` |

Always pass `-nc` to disable color codes for clean output.

Output is a numbered list of `title` / `href` / `body` (truncated snippet). Cite the `href` URLs in your answer.

### Getting JSON / structured results

**`-o json` writes results to a timestamped file (`text_<query>_<timestamp>.json`), it does NOT print to stdout.** After running with `-o json`, `ls -t` to find the newest file and `read`/`cat` it. `-o csv` behaves the same. Omit `-o` for direct terminal output.

## Page Content Extraction (read a specific URL)

```bash
ddgs extract -u https://example.com -f text_markdown
```

Use this to read a search result in full. Formats: `text_markdown` (default choice — clean markdown), `text_plain`, `text_rich`. Pipe through `head -c` or `sed -n` to limit length on long pages.

## News Search

```bash
ddgs news -q "query" -m 5 -t d -nc    # -t d = last day; also w/m/y
```

Backends for news: `auto`, `duckduckgo`, `bing`, `yahoo`. Results include `date`, `source`, `href`.

## Other Verticals

```bash
ddgs images -q "query" -m 5 -nc                 # add --size, --color, --type_image, --layout, --lic filters
ddgs videos -q "query" -m 5 -nc                 # add --duration short|medium|long, --resolution high
ddgs books -q "query" -m 5 -nc                  # backend: annasarchive
```

Images/videos support `-d` to download files (use sparingly; `-dd <dir>` sets target directory).

## Workflow

1. `ddgs text -q "<query>" -m 5 -nc` (add `-t w` or `-t m` if recency matters)
2. Pick the most relevant results, cite their URLs
3. If a snippet is insufficient, extract the page: `ddgs extract -u <url> -f text_markdown`
4. Refine the query or try another backend if results are poor

## Tips

- Queries are plain language; no special operators needed. Use quotes around the query.
- Rate limits can appear under heavy use — backends are independent, so `-b bing` or `-b brave` is a quick retry path.
