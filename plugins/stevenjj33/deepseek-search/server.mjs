#!/usr/bin/env node
/**
 * deepseek-search — an MCP server over DeepSeek's own Search and Fetch APIs.
 *
 * Tools
 *   deepseek_search  POST /v1/tools/search  — ranked web results
 *   deepseek_fetch   POST /v1/tools/fetch   — one page as Markdown
 *
 * Credential resolution (first hit wins)
 *   1. DEEPSEEK_API_KEY environment variable
 *   2. ~/.config/agents/deepseek.json  ->  { "api_key_env": "MY_KEY" }
 *      the named environment variable is then read from the environment
 *   3. ~/.config/agents/deepseek.json  ->  { "api_key": "sk-..." }
 *      a literal fallback; keep that file readable by its owner only
 *
 * No key is stored in this package, and no key is ever written to stdout,
 * stderr, or a tool result.
 *
 * The server makes exactly one outbound destination: the configured
 * DeepSeek base URL (https://api.deepseek.com by default). It never
 * fetches a result URL itself — DeepSeek performs that fetch.
 */

import { createInterface } from 'node:readline';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const SERVER_NAME = 'deepseek-search';
const SERVER_VERSION = '0.1.0';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONTENT_CHARS = 20_000;
const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';

const MAX_QUERY_LENGTH = 128;
const MAX_ORI_QUESTION_LENGTH = 128;
const MAX_FETCH_URL_LENGTH = 8192;
const MAX_COUNT = 50;
const MAX_ATTEMPTS = 3;

/** Placeholder written into a fresh config file by --setup. */
const KEY_PLACEHOLDER = 'PASTE_YOUR_DEEPSEEK_API_KEY_HERE';

/** macOS Keychain item that --setup and the loader agree on. */
const KEYCHAIN_SERVICE = 'deepseek-search';
const KEYCHAIN_ACCOUNT = 'api';

const TOOLS = [
  {
    name: 'deepseek_search',
    description:
      'Search the web through DeepSeek\'s own search engine and return ranked results with title, URL, relevance score, publish date, site name, a long summary, and optionally the full page text. Use it for factual lookups, current events, product or release news, documentation, and any question that should be answered from live web sources.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query, 1-128 characters. Supports operators: site:, -site:, -term, -"phrase", "exact phrase", lang:, after:, before:.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_COUNT,
          description: `Number of results to return (1-${MAX_COUNT}). Default 10. It does not change the price of a request.`,
        },
        ori_question: {
          type: 'string',
          description:
            'The original user question this search answers, 1-128 characters. It helps DeepSeek understand the search intent.',
        },
        localization: {
          type: 'string',
          description:
            'IP address used to prioritize localized results, for example "203.0.113.7". Leave unset for the default region.',
        },
        need_content: {
          type: 'boolean',
          description:
            'Return the full page text of each result in its content field. Default false, which keeps only titles, summaries and links.',
        },
        max_content_chars: {
          type: 'integer',
          minimum: 500,
          description:
            'Total character budget for the page text of all results combined. Default 20000. Ignored when need_content is false.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'deepseek_fetch',
    description:
      'Fetch one web page and return its content as Markdown, together with the page title. Use it to read a specific URL that deepseek_search returned, or any page the user names directly.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Absolute http or https URL including a host, at most 8192 characters, with no embedded username or password.',
        },
        max_chars: {
          type: 'integer',
          minimum: 200,
          description: 'Maximum characters of page text to return. Default 20000.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

/** An error that should be reported to the agent as a tool error. */
class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- config ---

function configPath() {
  if (process.env.DEEPSEEK_CONFIG_PATH) return process.env.DEEPSEEK_CONFIG_PATH;
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'agents', 'deepseek.json');
}

async function readConfigFile() {
  const file = configPath();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file, values: {}, exists: false };
    throw new ToolError(`Cannot read config file ${file}: ${error.message}`, 'CONFIG_UNREADABLE');
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('root must be a JSON object');
    }
    return { file, values: parsed, exists: true };
  } catch (error) {
    throw new ToolError(`Invalid JSON in config file ${file}: ${error.message}`, 'CONFIG_INVALID');
  }
}

/** Write the config file with owner-only permissions. */
async function writeConfigFile(file, values) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Detect a value that is still an unexpanded variable reference.
 *
 * Claude Code, Cursor and VS Code expand `${VAR}` in an MCP server's `env`
 * and `headers` blocks. MiniMax Code passes such a value through verbatim,
 * so a server that reads `DEEPSEEK_API_KEY` would otherwise send the literal
 * text `${DEEPSEEK_API_KEY}` to the API as a credential. Any value shaped
 * like a reference is ignored so the next source gets a chance.
 */
function isUnexpandedReference(value) {
  return typeof value === 'string' && /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}$/.test(value.trim());
}

async function loadConfig() {
  const { file, values } = await readConfigFile();

  const baseUrlCandidate =
    process.env.DEEPSEEK_BASE_URL ||
    (typeof values.base_url === 'string' ? values.base_url : '') ||
    DEFAULT_BASE_URL;
  const baseUrl = isUnexpandedReference(baseUrlCandidate)
    ? DEFAULT_BASE_URL
    : baseUrlCandidate.trim();

  const timeoutMs = positiveInteger(
    process.env.DEEPSEEK_TIMEOUT_MS ?? values.timeout_ms,
    DEFAULT_TIMEOUT_MS,
  );

  const maxContentChars = positiveInteger(
    process.env.DEEPSEEK_MAX_CONTENT_CHARS ?? values.max_content_chars,
    DEFAULT_MAX_CONTENT_CHARS,
  );

  let apiKey = '';
  let keySource = '';

  const direct = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (direct && !isUnexpandedReference(direct)) {
    apiKey = direct;
    keySource = 'environment variable DEEPSEEK_API_KEY';
  }

  if (!apiKey && typeof values.api_key_env === 'string' && values.api_key_env.trim()) {
    const name = values.api_key_env.trim();
    const indirect = (process.env[name] || '').trim();
    if (indirect && !isUnexpandedReference(indirect)) {
      apiKey = indirect;
      keySource = `environment variable ${name} (named by ${file})`;
    }
  }

  if (!apiKey && typeof values.api_key === 'string' && values.api_key.trim()) {
    const literal = values.api_key.trim();
    if (literal !== KEY_PLACEHOLDER && !isUnexpandedReference(literal)) {
      apiKey = literal;
      keySource = `api_key field in ${file}`;
    }
  }

  if (!apiKey) {
    const fromKeychain = await readKeychain();
    if (fromKeychain) {
      apiKey = fromKeychain;
      keySource = `macOS Keychain item "${KEYCHAIN_SERVICE}" (account "${KEYCHAIN_ACCOUNT}")`;
    }
  }

  return { baseUrl, timeoutMs, maxContentChars, apiKey, keySource, configFile: file };
}

/**
 * Read the key from the macOS Keychain, the last-resort source.
 *
 * The service and account names are fixed, so nothing a user can influence
 * reaches the command line. A missing item is not an error: the caller
 * falls through to the "no key configured" message.
 */
async function readKeychain() {
  if (process.platform !== 'darwin') return '';
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: 5000 },
    );
    const value = stdout.trim();
    return value && value !== KEY_PLACEHOLDER ? value : '';
  } catch {
    return '';
  }
}

function missingKeyMessage(config) {
  return [
    'No DeepSeek API key is configured, so no request was sent.',
    '',
    'Pick whichever is easiest for you:',
    '',
    '1. Edit a file (no terminal). Run `node server.mjs --setup` and the',
    '   config file opens in your text editor with a placeholder. Paste your',
    '   key over the placeholder, save, and the next call just works.',
    '',
    '2. One command. Run `node server.mjs --set-key` and paste the key at',
    '   the prompt. The key is read from the terminal, so it never reaches',
    '   the shell history or the process list.',
    '',
    '3. macOS Keychain. Add a generic password named "deepseek-search"',
    '   with account "api" and your key as the password. It is read',
    '   automatically when no other source is set.',
    '',
    'The environment variable DEEPSEEK_API_KEY overrides all of them.',
    `Config file: ${config.configFile}`,
  ].join('\n');
}

/** Replace the active key with a mask so it can never reach the transcript. */
function redact(text, apiKey) {
  if (!text) return text;
  let out = text;
  if (apiKey) out = out.split(apiKey).join('***');
  return out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***');
}

// ----------------------------------------------------------------- http ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt) {
  const base = attempt === 1 ? 1000 : 3000;
  return base + Math.floor(Math.random() * 500);
}

function describeStatus(status, detail) {
  const suffix = detail ? ` (${detail})` : '';
  switch (status) {
    case 400:
      return `DeepSeek rejected the request as invalid${suffix}. Fix the parameters and do not retry unchanged.`;
    case 401:
      return `DeepSeek rejected the API key${suffix}. Check DEEPSEEK_API_KEY or the api_key_env entry in the config file.`;
    case 402:
      return `The DeepSeek account has insufficient balance${suffix}. Top up the account, then retry.`;
    case 403:
      return `DeepSeek refused the fetch because of its safety policy${suffix}. Do not retry unchanged.`;
    case 404:
      return `DeepSeek could not extract usable content from that URL${suffix}. The page may be unavailable, blocked, or not convertible to Markdown.`;
    case 408:
      return `DeepSeek timed out while reading the request${suffix}. Retry shortly.`;
    case 413:
      return `The request body was too large${suffix}. Shorten the request and retry.`;
    case 429:
      return `The DeepSeek rate limit was reached${suffix}. Wait a few seconds and retry.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `DeepSeek returned a server error (${status})${suffix}. Retry shortly.`;
    default:
      return `DeepSeek returned HTTP ${status}${suffix}.`;
  }
}

function isRetryable(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function postJson(url, body, config) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // A redirect could forward the Authorization header to another
        // origin, so treat 3xx as an error instead of following it.
        redirect: 'manual',
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ToolError(`The request to DeepSeek timed out after ${config.timeoutMs} ms.`, 'TIMEOUT');
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new ToolError(`Could not reach ${url}: ${error.message}`, 'NETWORK');
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      throw new ToolError(
        `DeepSeek answered with a redirect (HTTP ${response.status}). Point the request at the final endpoint instead.`,
        'REDIRECT',
      );
    }

    if (response.ok) {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new ToolError('DeepSeek returned a response that is not valid JSON.', 'BAD_RESPONSE');
      }
    }

    let detail = '';
    try {
      const raw = await response.text();
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.message || '';
    } catch {
      detail = '';
    }

    if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new ToolError(describeStatus(response.status, detail), `HTTP_${response.status}`);
  }
}

function endpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/u, '')}${suffix}`;
}

// ---------------------------------------------------------------- tools ----

function formatResult(result, index, budget) {
  const lines = [];
  lines.push(`${index}. ${result.title || '(untitled)'}`);
  lines.push(`   URL: ${result.url || ''}`);
  const facts = [];
  if (typeof result.rerank_score === 'number') facts.push(`score ${result.rerank_score}`);
  if (typeof result.authority === 'number' && result.authority >= 0) facts.push(`authority ${result.authority}`);
  if (result.date) facts.push(`published ${result.date}`);
  if (result.site_name) facts.push(`site ${result.site_name}`);
  if (facts.length) lines.push(`   ${facts.join(' | ')}`);
  if (result.summary) lines.push('', result.summary);
  if (result.snippet && !result.summary) lines.push('', result.snippet);

  const content = typeof result.content === 'string' ? result.content : '';
  if (content) {
    let text = content;
    if (text.length > budget) {
      text = `${text.slice(0, budget)}\n[truncated: ${content.length - budget} more characters]`;
      budget = 0;
    } else {
      budget -= text.length;
    }
    lines.push('', '--- page text ---', text);
  }
  return { text: lines.join('\n'), remaining: budget };
}

async function runSearch(args, config) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new ToolError('The query argument is required.', 'BAD_ARGS');
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ToolError(`The query must be at most ${MAX_QUERY_LENGTH} characters.`, 'BAD_ARGS');
  }

  const count = Number.isInteger(args.count) ? Math.min(Math.max(args.count, 1), MAX_COUNT) : 10;
  const needContent = args.need_content === true;
  const budget = Number.isInteger(args.max_content_chars)
    ? Math.max(args.max_content_chars, 500)
    : config.maxContentChars;

  const body = { query, count, need_content: needContent };
  if (typeof args.ori_question === 'string' && args.ori_question.trim()) {
    body.ori_question = args.ori_question.trim().slice(0, MAX_ORI_QUESTION_LENGTH);
  }
  if (typeof args.localization === 'string' && args.localization.trim()) {
    body.localization = args.localization.trim();
  }

  const payload = await postJson(endpoint(config.baseUrl, SEARCH_PATH), body, config);
  const results = Array.isArray(payload?.results) ? payload.results : [];

  if (results.length === 0) {
    return [
      `DeepSeek search returned no results for "${query}".`,
      'Try broader keywords, drop the operators, or adjust site:, lang:, after: and before:.',
    ].join('\n');
  }

  const header = `# DeepSeek search: ${query}\n${results.length} result(s).`;
  const blocks = [];
  let remaining = needContent ? budget : 0;
  let omittedContent = 0;
  for (const [index, result] of results.entries()) {
    if (needContent && remaining <= 0) {
      omittedContent += 1;
      continue;
    }
    const formatted = formatResult(result, index + 1, remaining);
    remaining = formatted.remaining;
    blocks.push(formatted.text);
  }

  const footer = [];
  if (omittedContent > 0) {
    footer.push(
      `Page text was omitted for ${omittedContent} result(s) because the content budget of ${budget} characters was exhausted. Re-run with a higher max_content_chars or fetch a specific URL with deepseek_fetch.`,
    );
  }
  return [header, '', blocks.join('\n\n'), ...(footer.length ? ['', ...footer] : [])].join('\n');
}

async function runFetch(args, config) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new ToolError('The url argument is required.', 'BAD_ARGS');
  if (url.length > MAX_FETCH_URL_LENGTH) {
    throw new ToolError(`The url must be at most ${MAX_FETCH_URL_LENGTH} characters.`, 'BAD_ARGS');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError('The url must be an absolute http or https URL.', 'BAD_ARGS');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError('Only http and https URLs can be fetched.', 'BAD_ARGS');
  }
  if (!parsed.hostname) throw new ToolError('The url must contain a host.', 'BAD_ARGS');
  if (parsed.username || parsed.password) {
    throw new ToolError('The url must not carry a username or password.', 'BAD_ARGS');
  }

  const limit = Number.isInteger(args.max_chars) ? Math.max(args.max_chars, 200) : config.maxContentChars;
  const payload = await postJson(endpoint(config.baseUrl, FETCH_PATH), { url }, config);

  const title = typeof payload?.title === 'string' ? payload.title : '';
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const clipped = content.length > limit ? `${content.slice(0, limit)}\n\n[truncated: ${content.length - limit} more characters]` : content;

  const header = [`# ${title || url}`, `URL: ${url}`].join('\n');
  if (!clipped) {
    return `${header}\n\nDeepSeek returned this page without extractable Markdown content.`;
  }
  return `${header}\n\n${clipped}`;
}

async function callTool(name, args) {
  const config = await loadConfig();
  if (!config.apiKey) throw new ToolError(missingKeyMessage(config), 'NO_API_KEY');

  if (name === 'deepseek_search') return runSearch(args, config);
  if (name === 'deepseek_fetch') return runFetch(args, config);
  throw new ToolError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL');
}

// -------------------------------------------------------------- protocol ---

async function handle(message) {
  const method = message.method;

  if (method === 'initialize') {
    return {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (method === 'ping') {
    return { result: {} };
  }

  if (method === 'tools/list') {
    return { result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    try {
      const text = await callTool(name, args);
      return { result: { content: [{ type: 'text', text }] } };
    } catch (error) {
      const messageText = error instanceof ToolError ? error.message : `Unexpected failure: ${error.message}`;
      return {
        result: {
          content: [{ type: 'text', text: redact(messageText, '') }],
          isError: true,
        },
      };
    }
  }

  return { error: { code: -32601, message: `Method not found: ${String(method)}` } };
}

/**
 * Read one line from the terminal without echoing it.
 *
 * Falls back to the plain reader when stdin is not a TTY, so piping a key in
 * still works.
 */
async function readMaskedLine(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readKeyFromStdin();

  return new Promise((resolve) => {
    let value = '';
    process.stdout.write(prompt);

    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(result);
    };

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish(value.trim());
          return;
        }
        if (character === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stdout.write('*');
        }
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/**
 * Read a key for --set-key.
 *
 * Piped input wins, then a single line typed at the terminal, then the
 * DEEPSEEK_API_KEY environment variable. The key is never taken from a
 * command line argument, so it does not end up in the shell history or
 * in the process list.
 */
async function readKeyFromStdin() {
  const chunks = [];
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      chunks.push(line);
      break;
    }
    rl.close();
  } else {
    for await (const chunk of process.stdin) chunks.push(chunk);
  }
  const piped = chunks.join('').trim();
  return piped || (process.env.DEEPSEEK_API_KEY || '').trim();
}

async function setKeyMode() {
  const key = await readMaskedLine('DeepSeek API key (not echoed): ');
  if (!key) {
    process.stderr.write('No key received. Pipe one in, type one at the prompt, or set DEEPSEEK_API_KEY.\n');
    process.exit(1);
  }
  const { file, values } = await readConfigFile();
  await writeConfigFile(file, { ...values, api_key: key });
  const warning = key.startsWith('sk-') ? '' : ' The value does not start with "sk-" — check that it is a DeepSeek API key.\n';
  process.stdout.write(
    `Stored the key in ${file} with mode 600.\n` +
      'It is used by the next tool call — MiniMax Code does not need to be restarted.\n' +
      'Prefer the environment variable? Run `node server.mjs --env` to append an export line to your shell profile.\n' +
      warning,
  );
}

/**
 * Append an export line for the key to a shell profile.
 *
 * This is the "one command, key in the environment" route. It writes the
 * key in plain text into a profile file, which is what the user asked for,
 * so the trade-offs are stated plainly when it runs:
 *   - a shell profile only feeds processes started from a terminal; a GUI
 *     application such as the MiniMax Code desktop app does not inherit it;
 *   - profile files are often kept in a git dotfiles repository.
 */
async function envMode(target) {
  const key = await readMaskedLine('DeepSeek API key (not echoed): ');
  if (!key) {
    process.stderr.write('No key received.\n');
    process.exit(1);
  }

  let file = target;
  if (!file) {
    if (process.platform === 'darwin') file = path.join(homedir(), '.zshenv');
    else if (process.platform === 'win32') file = path.join(homedir(), '.profile');
    else file = path.join(homedir(), '.bashrc');
  }
  file = path.resolve(file);

  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const previous = existing.split('\n').filter((line) => /^\s*export\s+DEEPSEEK_API_KEY\s*=/.test(line));
  const marker = '\n# Added by deepseek-search --env\n';
  const body = `${marker}export DEEPSEEK_API_KEY='${key}'\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, body, 'utf8');

  process.stdout.write(
    `Appended the export line to ${file}.\n` +
      (previous.length
        ? `Note: this file already exported DEEPSEEK_API_KEY ${previous.length} time(s). The newest line wins.\n`
        : '') +
      'Open a new terminal for it to take effect.\n' +
      'Two things to know:\n' +
      '  - a GUI app such as the MiniMax Code desktop app does not inherit the\n' +
      '    shell environment, so this covers terminal use only;\n' +
      '  - the key is plain text in this file, which is fine for a personal\n' +
      '    machine but do not commit a dotfiles repository that contains it.\n' +
      'To remove it, delete the export line from that file.\n',
  );
}

async function unsetKeyMode() {
  const { file, values, exists } = await readConfigFile();
  if (!exists || !('api_key' in values)) {
    process.stdout.write(`No api_key field in ${file}; nothing to remove.\n`);
    return;
  }
  const next = { ...values };
  delete next.api_key;
  await writeConfigFile(file, next);
  process.stdout.write(`Removed the api_key field from ${file}.\n`);
}

/** Open a file in the platform's default text editor. */
async function openInEditor(file) {
  const launchers = {
    darwin: ['open', ['-e', file]],
    linux: ['xdg-open', [file]],
    win32: ['cmd', ['/c', 'start', '', file]],
  };
  const launcher = launchers[process.platform];
  if (!launcher) return;
  try {
    await execFileAsync(launcher[0], launcher[1], { timeout: 5000 });
  } catch {
    // Opening an editor is a convenience, never a requirement.
  }
}

/**
 * Create the config file with a placeholder and open it in a text editor.
 *
 * This is the path for someone who would rather paste a key into a normal
 * editor than run a command. The placeholder is ignored by the loader, so
 * an unedited file is treated as "no key yet" instead of a bad credential.
 */
async function setupMode() {
  const { file, values, exists } = await readConfigFile();
  if (!exists) {
    await writeConfigFile(file, { api_key: KEY_PLACEHOLDER });
    process.stdout.write(`Created ${file}\n`);
  } else if (!('api_key' in values)) {
    await writeConfigFile(file, { ...values, api_key: KEY_PLACEHOLDER });
  }
  await openInEditor(file);
  process.stdout.write(
    `Opened ${file} in your text editor.\n` +
      `Replace ${KEY_PLACEHOLDER} with your DeepSeek API key and save the file.\n` +
      'The next tool call picks it up — MiniMax Code does not need to be restarted.\n',
  );
}

async function checkMode() {
  const config = await loadConfig();
  const lines = [
    `server:      ${SERVER_NAME} ${SERVER_VERSION}`,
    `node:        ${process.version}`,
    `base url:    ${config.baseUrl}`,
    `timeout ms:  ${config.timeoutMs}`,
    `content cap: ${config.maxContentChars}`,
    `config file: ${config.configFile}${config.configFile ? '' : ''}`,
  ];
  if (config.apiKey) {
    lines.push(`api key:     found via ${config.keySource} (${config.apiKey.length} characters, masked)`);
  } else {
    lines.push('api key:     NOT FOUND — set DEEPSEEK_API_KEY before use.');
  }
  lines.push('');
  lines.push(`tools:       ${TOOLS.map((tool) => tool.name).join(', ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function startServer() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  input.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;

    Promise.resolve(handle(message))
      .then((response) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`);
      })
      .catch((error) => {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: redact(error.message, '') },
          })}\n`,
        );
      });
  });

  input.on('close', () => process.exit(0));
}

const mode = process.argv.slice(2).find((argument) => argument.startsWith('--'));
if (mode === '--check') {
  checkMode().catch((error) => {
    process.stderr.write(`${redact(error.message, '')}\n`);
    process.exit(1);
  });
} else if (mode === '--set-key') {
  setKeyMode().catch((error) => {
    process.stderr.write(`${redact(error.message, '')}\n`);
    process.exit(1);
  });
} else if (mode === '--setup') {
  setupMode().catch((error) => {
    process.stderr.write(`${redact(error.message, '')}\n`);
    process.exit(1);
  });
} else if (mode === '--env') {
  const target = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  envMode(target).catch((error) => {
    process.stderr.write(`${redact(error.message, '')}\n`);
    process.exit(1);
  });
} else if (mode === '--unset-key') {
  unsetKeyMode().catch((error) => {
    process.stderr.write(`${redact(error.message, '')}\n`);
    process.exit(1);
  });
} else {
  startServer();
}
