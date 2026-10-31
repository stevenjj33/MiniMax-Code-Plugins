---
name: deepseek-search
description: Use when the user needs live web results — looking up facts, current events, product or release news, documentation, prices, or any question that should be answered from real web sources instead of from memory. Triggers on "搜索 X", "查一下最新的 Y", "搜一下 Z 的资料", "search for W", "look up the latest on V", "find articles about U". Provides deepseek_search for ranked results and deepseek_fetch to read one page as Markdown, both served by DeepSeek's own Search and Fetch APIs. Do NOT use for local file operations, code edits, or questions answerable from training data alone.
license: Apache-2.0
compatibility: Requires Node.js 18+ (global fetch). Network access to https://api.deepseek.com is required. A DeepSeek API key must be available in DEEPSEEK_API_KEY before any tool call succeeds.
metadata:
  author: stevenjj33
  version: "0.3.0"
---

# deepseek-search

Live web search and page reading through DeepSeek's own search engine, served by the
`deepseek-search` MCP server in this package.

## Tools

### `deepseek_search`

Search the web and return ranked results. Arguments:

| Argument | Type | Notes |
|---|---|---|
| `query` | string, required | 1–128 characters. Supports the operators listed below. |
| `count` | integer | 1–50 results. Default 10. Does not change the price of the request. |
| `ori_question` | string | The original user question, ≤128 characters. Improves intent understanding. |
| `localization` | string | IP address used to prioritize localized results, e.g. `203.0.113.7`. |
| `need_content` | boolean | Return each result's full page text. Default false. |
| `max_content_chars` | integer | Total character budget for page text across all results. Default 20000. |

Each result carries a title, URL, `rerank_score` (0–3, ≥1.5 is a good hit), `authority`
(0–4, ≥3 is very authoritative), publish date, site name, a short `snippet`, a longer
`summary` written for a reader, and the page text when `need_content` is true.

### `deepseek_fetch`

Read one page and return it as Markdown. Arguments:

| Argument | Type | Notes |
|---|---|---|
| `url` | string, required | Absolute http(s) URL with a host, ≤8192 characters, no embedded credentials. |
| `max_chars` | integer | Maximum characters of page text to return. Default 20000. |

## Search operators

Operators are passed to the search service as written and can be combined in one query.

| Operator | Example | Effect |
|---|---|---|
| `site:` | `DeepSeek site:github.com` | Restrict to a site. Combine several with `OR`, e.g. `site:github.com OR site:huggingface.co`. |
| `-site:` | `DeepSeek -site:example.com` | Exclude a site. Several exclusions are space separated. |
| `-` | `DeepSeek -广告` | Exclude pages containing the keyword. |
| `-"..."` | `DeepSeek -"release notes"` | Exclude pages containing the exact phrase. |
| `"..."` | `DeepSeek "精确短语"` | Require the exact phrase. |
| `lang:` | `DeepSeek lang:zh,en` | Restrict to one or more languages. |
| `after:` | `DeepSeek after:2025` or `after:2025-01-01` | Only pages published after the date. |
| `before:` | `DeepSeek before:2026` or `before:2026-06-01` | Only pages published before the date. |

## Default flow

1. **Search** for candidate pages with `deepseek_search`. Start with `need_content` off
   unless the answer clearly depends on page bodies — the summary field usually already
   answers the question and costs far less context.
2. **Rank** by evidence, not by position: prefer `rerank_score` ≥ 1.5 and `authority` ≥ 3.
   When the top hits disagree, search again with a tighter query or an operator
   (`site:`, `"exact phrase"`, `after:`) instead of fetching every URL.
3. **Read** only the pages that matter with `deepseek_fetch`, then answer from what they
   actually say.
4. **Cite** each claim with the URL it came from. If a fetch fails, say which URL failed
   rather than filling the gap from memory.

A single search call is often the whole job. Use `deepseek_fetch` when the user names a
specific URL, or when the summary field is too short to answer the question.

## Choosing the query language

- **Technical topics** (programming, libraries, standards, model releases, infrastructure):
  search in **English** even when the user writes in Chinese. English results are broader
  and more current for technical material. Translate the query, keep the identifiers,
  package names and error strings in their original form.
- **China-specific or local topics** (domestic policy, local prices, local services,
  Chinese-language reporting): search in **Chinese**. Run one English search as well when
  the topic matters internationally, then merge and de-duplicate.
- Keep quoted phrases and operators in the same language as the surrounding query.

## Failure handling

The server retries automatically on HTTP 408, 429 and 5xx (up to two extra attempts with
backoff). Other 4xx responses are returned as errors and are not retried, because
retrying an unchanged request cannot succeed.

| Symptom | Meaning | Action |
|---|---|---|
| `NO_API_KEY` | No key resolved | The error text lists three ways to install one; offer `bash scripts/setup-key.sh` (guided, writes the key without echoing it) or `node server.mjs --setup` (opens a config file to edit). Do not attempt to answer from memory instead. |
| HTTP 401 | Key missing or invalid | Check `DEEPSEEK_API_KEY` or the `api_key_env` entry. |
| HTTP 402 | Account balance too low | Tell the user to top up the DeepSeek account; retry after that. |
| HTTP 403 | Fetch refused by the safety policy | Move on to another source; do not retry unchanged. |
| HTTP 404 | No extractable content for that URL | Try another URL, or search for the content instead. |
| HTTP 429 | Account rate limit | Wait a few seconds, then retry once. |
| HTTP 5xx | DeepSeek side failure | Wait and retry once; if it persists, report it to the user. |

## Cost

Search and Fetch are billed per successful request, not per token or per result:
5 CNY per 1000 successful requests for each API. `count` does not change the price of a
request. Failed requests, searches with no results and timeouts are not billed. Keep the
number of calls small — one well-formed search beats five scattershot ones.

## Credential setup

The key is never stored in this package. The user installs it with one of three
commands, all of which take effect on the next tool call — MiniMax Code does not
need to be restarted:

```bash
node server.mjs --setup       # create the config file and open it in a text editor
node server.mjs --set-key     # paste the key at the prompt, not echoed
node server.mjs --env         # append an export line to the shell profile, plain text
node server.mjs --unset-key   # remove it again
```

`--setup` writes `~/.config/agents/deepseek.json` with a placeholder and opens it in
the platform's text editor; the user replaces the placeholder with the key and saves.
`--set-key` reads the key from the terminal without echoing it — never from a command
line argument, so it stays out of the shell history, the process list, and the screen.
`--env` appends an export line to the shell profile in plain text; it reaches terminal
processes only, because a GUI app does not inherit the shell environment.

Otherwise the server resolves the key in this order:

1. the `DEEPSEEK_API_KEY` environment variable;
2. `api_key_env` in `~/.config/agents/deepseek.json` — the named environment variable is
   then read from the environment;
3. `api_key` in the same file — a literal fallback; keep that file owner-readable only
   (`chmod 600`);
4. the macOS Keychain item `deepseek-search` / `api`, read automatically when no other
   source is set.

A value shaped like an unexpanded variable reference (`${DEEPSEEK_API_KEY}`) is ignored
rather than sent to the API: MiniMax Code does not expand `${VAR}` in a plugin's MCP
`env` block, unlike Claude Code, Cursor and VS Code.

Optional settings, environment first and config file second: `DEEPSEEK_BASE_URL` (default
`https://api.deepseek.com`), `DEEPSEEK_TIMEOUT_MS` (default 30000) and
`DEEPSEEK_MAX_CONTENT_CHARS` (default 20000).

On macOS a GUI app does not inherit the shell environment. Export the variable in the
shell profile and relaunch MiniMax Code, or use `launchctl setenv DEEPSEEK_API_KEY sk-...`
and relaunch the app afterwards.

To verify the setup without spending a request, run `node server.mjs --check` inside the
plugin directory. It prints where the key was found, masked.
