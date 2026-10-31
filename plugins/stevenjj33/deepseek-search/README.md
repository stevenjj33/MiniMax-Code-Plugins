# deepseek-search

Search the web and read pages through **DeepSeek's own Search and Fetch APIs**, from
inside your coding agent. A dependency-free stdio MCP server exposes two tools, and a
Skill teaches the search operators and the search-then-fetch workflow.

## The problem

Web search inside an agent usually means either a vendor API that needs a key and a
separate SDK, or a scraper that breaks the moment a page is JavaScript-rendered.
DeepSeek publishes Search and Fetch as plain JSON endpoints over the same Bearer
authentication as the rest of its API. This plugin turns them into two ordinary MCP
tools, so the agent can look things up and read pages without any extra dependency.

## Try it

Install this folder, configure the API key, then ask:

```text
Search the web for the latest DeepSeek API release notes
```

**Expected result**: a ranked list of results with title, URL, relevance score, publish
date, site name and a written summary, followed by the page text of the most useful hits
when the agent asks for it.

Direct tool calls:

```text
deepseek_search  {"query": "DeepSeek site:github.com OR site:huggingface.co lang:zh after:2025", "count": 5}
deepseek_fetch   {"url": "https://example.com/article"}
```

## Requirements

- **Node.js 18 or newer** — the server uses the built-in `fetch`. No `npm install`, no
  dependencies of any kind.
- Network access to `https://api.deepseek.com`.
- **A DeepSeek API key.** This package never contains one.
- macOS, Linux or Windows for the server itself. The Keychain route below is macOS-only.

## Install

**MiniMax Code.** Copy this folder into `~/.minimax/plugins/deepseek-search`, or import
it from `/plugins` → **Local**. MiniMax Code rescans the plugins directory on its own;
no restart is needed for the manifest to be picked up.

**Claude Code and other hosts.** The portable Agent Plugins layout of this same plugin is
published in the `main` branch of this repository — point them at that one instead.

Then configure the API key once, using any of the routes below.

## Credential setup

The key is never stored in this package. Three ways to put it in, easiest first.

### 1. Edit a file — no terminal needed

```bash
node server.mjs --setup
```

This creates `~/.config/agents/deepseek.json` and opens it in your text editor with a
placeholder in it. Replace the placeholder with your key, save the file, and the next
tool call uses it. There is nothing else to do, and MiniMax Code does not need to be
restarted.

### 2. One command, masked input

```bash
# paste the key at the prompt, then press Enter
node server.mjs --set-key
```

The key is read from the terminal without echoing, so it never reaches the
shell history, the process list, or the screen. It is also never accepted as a
command line argument.

To remove it again:

```bash
node server.mjs --unset-key
```

### 3. One command, key in the environment

```bash
node server.mjs --env
```

This appends an `export DEEPSEEK_API_KEY='...'` line to your shell profile
(`~/.zshenv` on macOS) in plain text. Pass a path to target a different file.

Two things to know before you use this one:

- a **GUI app** such as the MiniMax Code desktop app does **not** inherit the
  shell environment, so this route covers terminal use only. The desktop app
  needs option 1, 2 or 4;
- the key sits in plain text in a profile file. That is fine on a personal
  machine, but do not commit a dotfiles repository that contains it.

### 4. macOS Keychain

Add a generic password to your login keychain:

- name: `deepseek-search`
- account: `api`
- password: your DeepSeek API key

It is read automatically when no other source is set, and nothing is written to disk in
plain text.

### What the server reads, in order

The server resolves the key in this order, and never writes it to stdout, stderr, or a
tool result:

1. the `DEEPSEEK_API_KEY` environment variable;
2. `api_key_env` in `~/.config/agents/deepseek.json`, naming another environment variable
   to read the key from;
3. `api_key` in the same file — a literal fallback. Keep that file owner-readable only
   (`chmod 600`);
4. the macOS Keychain item `deepseek-search` / `api`.

To check the setup without spending a request:

```bash
node server.mjs --check
```

It prints where the key was found and how long it is, masked.

### If you copied a Claude Code or Cursor setup

Those clients expand `${VAR}` references in an MCP server's `env` block, so a config that
works there reads `"env": { "DEEPSEEK_API_KEY": "${DEEPSEEK_API_KEY}" }`. **MiniMax Code
passes such a value through unchanged**, so the server would receive the literal text
`${DEEPSEEK_API_KEY}`. This server ignores any value shaped like an unexpanded reference
instead of sending it to the API as a credential, and falls through to the next source.
Export the variable in your environment rather than referencing it.

## Package layout

| Path | Read by | Purpose |
| --- | --- | --- |
| `.minimax-plugin/plugin.json` | MiniMax Code, the Marketplace | The package entry point. |
| `deepseek-search.mcp.json` | the same | The MCP server definition (`node ./server.mjs`). |
| `icon.png` | hosts that support one | The DeepSeek mark, 512×512, transparent background. |
| `skills/deepseek-search/SKILL.md` | the same | The Skill, under a directory that matches its `name`. |
| `server.mjs` | the MCP server | The whole implementation. No dependencies. |

This package ships the MiniMax Plugin layout only. The same plugin is also published in
the portable Agent Plugins layout in the `main` branch of this repository, for hosts that
prefer it.

## Reading pages

`deepseek_fetch` reads most pages, but not all. JavaScript-rendered pages and some
`.gov` endpoints are rejected by the extraction service, and the tool returns a clear
error instead of guessing. For those, search with `deepseek_search` and read the page
with a second extractor.

## Data and network

This plugin has **one** outbound destination.

### Direct destination (the server itself)

The server makes a single POST per tool call to the configured DeepSeek base URL:
`POST /v1/tools/search` or `POST /v1/tools/fetch`. The `Authorization` header carries
your DeepSeek API key and travels to that host and nowhere else. Redirects are not
followed, because following one could forward the key to an origin you did not
configure.

### Downstream destinations (DeepSeek, not this server)

- **Search** is served by DeepSeek's own search engine. Your query string, and the
  original question if you pass `ori_question`, are sent to DeepSeek to be matched
  against the index. If a query contains sensitive text, it reaches DeepSeek.
- **Fetch** is performed by DeepSeek, not by this server. The server passes a URL to
  DeepSeek and DeepSeek retrieves the page and returns it as Markdown. This plugin never
  downloads a result URL itself, so a hostile URL cannot reach your machine through it.

### Credentials and data

- The API key is read from the environment, your local config file, or the macOS
  Keychain, and is sent only to DeepSeek.
- No telemetry, no analytics, no third-party service other than DeepSeek.
- Search and Fetch are read-only. The plugin never mutates anything on the DeepSeek side.

## Cost

Search and Fetch are billed per successful request, not per token and not per result:
5 CNY per 1000 successful requests for each API. `count` does not change the price of a
request. Failed requests, searches with no results and timeouts are not billed.

## Rate limits

Account-level limits, applied independently per API: Search 100 QPS, Fetch 25 QPS. The
server retries HTTP 408, 429 and 5xx with backoff and does not retry other 4xx
responses, because an unchanged request would fail the same way.

## License

Apache-2.0

The bundled `icon.png` is the DeepSeek mark (`File:DeepSeek-icon.svg` from Wikimedia
Commons, MIT licence, © DeepSeek).
