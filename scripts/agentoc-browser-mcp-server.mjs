#!/usr/bin/env node
// Run-scoped browser MCP. The browser is an execution surface, not a policy
// authority: reads can run directly, while interaction and export tools first
// obtain a durable AgentoC confirmation.

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ragent-browser';
const SERVER_VERSION = '1.0.0';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function flag(value) {
  return ['1', 'true', 'yes', 'on'].includes(text(value).toLowerCase());
}

function bounded(value, max = MAX_RESULT_BYTES) {
  const output = String(value ?? '');
  return output.length > max ? `${output.slice(0, max)}\n[truncated]` : output;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(value, isError = false, extraContent = []) {
  const content = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  return { content: [...content, ...extraContent], isError };
}

function browserTools() {
  return [
    {
      name: 'ragent_browser_navigate',
      description: 'Open an http(s) URL in the run-scoped browser. javascript:, data:, file:, and local-control URLs are rejected.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } },
        required: ['url'],
      },
    },
    {
      name: 'ragent_browser_snapshot',
      description: 'Read the current page URL, title, and bounded visible text.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'ragent_browser_click',
      description: 'Click a page element after the owner approves the exact selector and action.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          selector: { type: 'string', minLength: 1, maxLength: 1000 },
          button: { type: 'string', enum: ['left', 'middle', 'right'] },
          clickCount: { type: 'integer', minimum: 1, maximum: 3 },
        },
        required: ['selector'],
      },
    },
    {
      name: 'ragent_browser_fill',
      description: 'Fill a page field after the owner approves the exact selector. Field values are never included in the approval text or logs.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          selector: { type: 'string', minLength: 1, maxLength: 1000 },
          value: { type: 'string', maxLength: 16000 },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'ragent_browser_press',
      description: 'Press a key on a page element after the owner approves the exact selector and key.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          selector: { type: 'string', minLength: 1, maxLength: 1000 },
          key: { type: 'string', minLength: 1, maxLength: 120 },
        },
        required: ['selector', 'key'],
      },
    },
    {
      name: 'ragent_browser_select_option',
      description: 'Select an option after the owner approves the exact selector and values.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          selector: { type: 'string', minLength: 1, maxLength: 1000 },
          values: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 500 } },
        },
        required: ['selector', 'values'],
      },
    },
    {
      name: 'ragent_browser_screenshot',
      description: 'Capture the current page as a run artifact and return a visual preview.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    {
      name: 'ragent_browser_download',
      description: 'Click an approved export/download control and save the downloaded file as a run artifact.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { selector: { type: 'string', minLength: 1, maxLength: 1000 } },
        required: ['selector'],
      },
    },
  ];
}

function readConfig(environment = process.env) {
  const endpoint = text(environment.AGENTOC_BROWSER_CONFIRMATION_ENDPOINT)
    || 'http://127.0.0.1:7690/api/internal/browser/confirmations';
  const root = text(environment.AGENTOC_BROWSER_ARTIFACT_DIR);
  return {
    enabled: flag(environment.AGENTOC_BROWSER_MCP_ENABLED),
    endpoint,
    token: text(environment.AGENTOC_BROWSER_TOKEN),
    sessionId: text(environment.AGENTOC_BROWSER_SESSION_ID),
    runId: text(environment.AGENTOC_BROWSER_RUN_ID),
    turnId: text(environment.AGENTOC_BROWSER_TURN_ID),
    profileDir: text(environment.AGENTOC_BROWSER_PROFILE_DIR),
    artifactDir: root ? resolve(root) : '',
    approvalTimeoutMs: Number.isInteger(Number(environment.AGENTOC_BROWSER_APPROVAL_TIMEOUT_MS))
      ? Math.max(5_000, Math.min(10 * 60_000, Number(environment.AGENTOC_BROWSER_APPROVAL_TIMEOUT_MS)))
      : DEFAULT_APPROVAL_TIMEOUT_MS,
    headless: environment.AGENTOC_BROWSER_HEADLESS === undefined
      ? true
      : !['0', 'false', 'no'].includes(text(environment.AGENTOC_BROWSER_HEADLESS).toLowerCase()),
  };
}

function assertConfig(config) {
  if (!config.enabled) throw new Error('Ragent browser capability is unavailable for this runtime');
  if (!config.token || !config.sessionId || !config.runId || !config.turnId) {
    throw new Error('Ragent browser capability is not bound to an active Run');
  }
}

function approvalId(config, operation, payload) {
  const canonical = JSON.stringify({
    runId: config.runId,
    turnId: config.turnId,
    operation,
    selector: text(payload.selector),
    key: text(payload.key),
    values: Array.isArray(payload.values) ? payload.values.map(text) : undefined,
    // Bind approval to the exact fill without exposing the value to the
    // control plane or any diagnostic/approval event.
    valueDigest: operation === 'browser.fill'
      ? createHash('sha256').update(String(payload.value ?? ''), 'utf8').digest('hex')
      : undefined,
  });
  return `browser_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32)}`;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  if (!response.ok) throw new Error(text(parsed.error) || `Browser control request failed (${response.status})`);
  return parsed;
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  if (!response.ok) throw new Error(text(parsed.error) || `Browser control request failed (${response.status})`);
  return parsed;
}

function controlHeaders(config) {
  return {
    'x-agentoc-browser-token': config.token,
    'x-agentoc-browser-session-id': config.sessionId,
    'x-agentoc-browser-run-id': config.runId,
    'x-agentoc-browser-turn-id': config.turnId,
  };
}

async function requestApproval(config, operation, payload) {
  const id = approvalId(config, operation, payload);
  const response = await postJson(config.endpoint, {
    approvalId: id,
    sessionId: config.sessionId,
    runId: config.runId,
    turnId: config.turnId,
    operation,
    requestKey: id,
    title: 'Browser action needs approval',
    reason: `${operation} on selector ${text(payload.selector) || '(current page)'}. Review the exact browser action before allowing it.`,
  }, controlHeaders(config));
  if (response.state === 'approved') return id;
  const statusUrl = `${config.endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
  const deadline = Date.now() + config.approvalTimeoutMs;
  while (Date.now() < deadline) {
    const status = await getJson(statusUrl, controlHeaders(config));
    if (status.state === 'approved') return id;
    if (status.state === 'denied') throw new Error('Owner denied this browser action');
    if (status.state === 'not_found') throw new Error('Browser approval request was not found');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Timed out waiting for owner approval of browser action');
}

function safeUrl(value) {
  let parsed;
  try { parsed = new URL(text(value)); } catch { throw new Error('browser navigation requires an absolute URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('browser navigation only allows http(s) URLs');
  if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
    && parsed.port === '7690'
    && parsed.pathname.startsWith('/api/internal/')) {
    throw new Error('browser navigation to local control-plane URLs is not allowed');
  }
  return parsed.toString();
}

function safeFilename(value, fallback) {
  const normalized = basename(text(value)).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
  return normalized || fallback;
}

async function ensureArtifactDir(config) {
  if (!config.artifactDir) throw new Error('browser artifact directory is not configured for this Run');
  await mkdir(config.artifactDir, { recursive: true, mode: 0o700 });
  return config.artifactDir;
}

async function artifactInfo(path, kind) {
  const content = await readFile(path);
  const details = await stat(path);
  return {
    artifactId: `browser_${createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 24)}`,
    kind,
    path,
    sizeBytes: details.size,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function loadBrowser(config, state) {
  assertConfig(config);
  if (state.page) return state.page;
  if (!config.profileDir) throw new Error('browser profile directory is not configured for this Run');
  const { chromium } = await import('playwright');
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  state.context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    acceptDownloads: true,
  });
  state.page = state.context.pages()[0] || await state.context.newPage();
  return state.page;
}

async function callBrowserTool(name, args, config, state) {
  const page = await loadBrowser(config, state);
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'ragent_browser_navigate') {
    const url = safeUrl(input.url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { url: page.url(), title: await page.title() };
  }
  if (name === 'ragent_browser_snapshot') {
    return {
      url: page.url(),
      title: await page.title(),
      text: bounded(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')),
    };
  }
  if (name === 'ragent_browser_screenshot') {
    const artifactDir = await ensureArtifactDir(config);
    const path = join(artifactDir, `browser-${Date.now()}.png`);
    const buffer = await page.screenshot({ path, type: 'png', fullPage: false });
    const info = await artifactInfo(path, 'screenshot');
    const extraContent = buffer.length <= 4 * 1024 * 1024
      ? [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }]
      : [];
    return { value: info, extraContent };
  }
  if (name === 'ragent_browser_click') {
    await requestApproval(config, 'browser.click', input);
    await page.locator(text(input.selector)).click({
      ...(text(input.button) ? { button: text(input.button) } : {}),
      ...(Number.isInteger(input.clickCount) ? { clickCount: input.clickCount } : {}),
    });
    return { clicked: text(input.selector), url: page.url() };
  }
  if (name === 'ragent_browser_fill') {
    await requestApproval(config, 'browser.fill', input);
    await page.locator(text(input.selector)).fill(typeof input.value === 'string' ? input.value : '');
    return { filled: text(input.selector) };
  }
  if (name === 'ragent_browser_press') {
    await requestApproval(config, 'browser.press', input);
    await page.locator(text(input.selector)).press(text(input.key));
    return { pressed: text(input.key), selector: text(input.selector) };
  }
  if (name === 'ragent_browser_select_option') {
    const values = Array.isArray(input.values) ? input.values.map(text).filter(Boolean) : [];
    await requestApproval(config, 'browser.select_option', { ...input, values });
    await page.locator(text(input.selector)).selectOption(values);
    return { selected: values, selector: text(input.selector) };
  }
  if (name === 'ragent_browser_download') {
    await requestApproval(config, 'browser.download', input);
    const artifactDir = await ensureArtifactDir(config);
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator(text(input.selector)).click();
    const download = await downloadPromise;
    const path = join(artifactDir, safeFilename(download.suggestedFilename(), `browser-download-${Date.now()}`));
    await download.saveAs(path);
    return artifactInfo(path, 'download');
  }
  throw new Error(`Unknown browser tool: ${name}`);
}

async function handleRequest(request, config, state) {
  const id = request.id;
  if (request.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (request.method === 'ping') return jsonRpcResult(id, {});
  if (request.method === 'tools/list') {
    return jsonRpcResult(id, { tools: config.enabled && config.token && config.sessionId && config.runId && config.turnId ? browserTools() : [] });
  }
  if (request.method === 'tools/call') {
    // Accept calls already issued using a cached pre-migration tool list.
    const name = text(request.params?.name).replace(/^agentoc_browser_/, 'ragent_browser_');
    if (!browserTools().some((tool) => tool.name === name)) return jsonRpcResult(id, toolResult(`Unknown or unavailable browser tool: ${name}`, true));
    try {
      const result = await callBrowserTool(name, request.params?.arguments || {}, config, state);
      const value = result && typeof result === 'object' && Object.hasOwn(result, 'value')
        ? result.value
        : result;
      const extraContent = result && typeof result === 'object' && Array.isArray(result.extraContent)
        ? result.extraContent
        : [];
      return jsonRpcResult(id, toolResult(value, false, extraContent));
    } catch (error) {
      return jsonRpcResult(id, toolResult(String(error?.message || error), true));
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
}

export { browserTools, readConfig, safeUrl, approvalId, callBrowserTool };

const config = readConfig();
const state = { context: null, page: null };
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const value = text(line);
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BYTES) return;
  let request;
  try { request = JSON.parse(value); } catch {
    process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))}\n`);
    return;
  }
  if (request.id === undefined || request.id === null) return;
  void handleRequest(request, config, state).then((response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
});

async function closeBrowser() {
  try { await state.context?.close(); } catch {}
}
let shutdownPromise = null;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = closeBrowser().finally(() => process.exit(0));
  return shutdownPromise;
}
// A stdio MCP server is normally retired by closing stdin after the provider
// exits. Close the persistent browser context as part of that lifecycle so a
// detached Run cannot retain Chromium processes after its tool is done.
rl.once('close', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
