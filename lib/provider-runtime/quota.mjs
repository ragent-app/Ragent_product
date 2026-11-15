// Provider quota/balance projection.
//
// This module deliberately uses fixed, server-owned adapters.  A provider
// profile may select an adapter, but it can never upload or execute a quota
// script.  Credentials are resolved only for the outbound request and are
// never included in a snapshot, error, or log.

import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { buildPlatformSpawnSpec, resolveExecutableCommandPathAsync } from '../executable-resolution.mjs';
import {
  PROVIDER_QUOTA_ADAPTERS,
  PROVIDER_QUOTA_MODES,
  normalizeQuotaPolicy,
} from './registry.mjs';
import {
  AGY_AUTH_RELATIVE_PATH,
  buildAgyRuntimeEnv,
  buildAgyRuntimeLaunchSpec,
} from '../agy-runtime.mjs';
import {
  spawnManagedProviderProcess,
  terminateProviderProcessTree,
} from '../windows-managed-spawn.mjs';

export const PROVIDER_QUOTA_SCHEMA_VERSION = 1;
const QUOTA_STORE_FILE = 'quota-snapshots.json';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_AGY_QUOTA_OUTPUT_BYTES = 2 * 1024 * 1024;
// `agy` (Antigravity CLI) owns its OAuth credential at
// ~/.gemini/antigravity-cli/antigravity-oauth-token.  The quota adapter runs
// against a short-lived private HOME materialized from the selected
// ProviderProfile's SecretStore entry; it never uses the legacy agy-control
// directory or the terminal user's HOME.
const AGY_QUOTA_TIMEOUT_MS = 30_000;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clampPercent(value) {
  const number = numberValue(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

function percentValue(value, { fraction = false } = {}) {
  const number = numberValue(value);
  if (number === null) return null;
  return clampPercent(fraction ? number * 100 : number);
}

function isoFromTimestamp(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const number = numberValue(value);
  if (number === null || number <= 0) return null;
  const millis = number < 1_000_000_000_000 ? number * 1000 : number;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function windowIdFromDuration(seconds, fallback = '') {
  const value = numberValue(seconds);
  if (value === 18_000) return 'five_hour';
  if (value === 604_800) return 'weekly';
  if (value === 2_592_000) return 'monthly';
  if (value && value > 0) {
    const days = value / 86_400;
    if (Number.isInteger(days) && days >= 1) return `${days}_day`;
    const hours = value / 3_600;
    if (Number.isInteger(hours) && hours >= 1) return `${hours}_hour`;
  }
  return fallback || 'unknown';
}

function canonicalWindowId(value, fallback = '') {
  const normalized = trim(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return fallback || 'unknown';
  if (['session', '5h', 'fivehour', 'five_hour', 'rolling_5h', 'interval'].includes(normalized)) {
    return 'five_hour';
  }
  if (['week', 'weekly', '7d', 'seven_day', 'weekly_limit'].includes(normalized)) return 'weekly';
  if (['month', 'monthly', '30d', 'thirty_day'].includes(normalized)) return 'monthly';
  if (normalized === 'seven_day_opus') return 'weekly_opus';
  if (normalized === 'seven_day_sonnet') return 'weekly_sonnet';
  return normalized;
}

function buildWindow({
  id,
  label,
  group,
  usedPercent,
  remainingPercent,
  resetsAt,
  total,
  used,
  remaining,
  unit,
} = {}) {
  let usedPct = percentValue(usedPercent);
  let remainingPct = percentValue(remainingPercent);
  if (usedPct === null && remainingPct !== null) usedPct = 100 - remainingPct;
  if (remainingPct === null && usedPct !== null) remainingPct = 100 - usedPct;
  if (usedPct === null && remainingPct === null) return null;
  return {
    id: canonicalWindowId(id),
    usedPercent: usedPct,
    remainingPercent: remainingPct,
    ...(trim(label) ? { label: trim(label) } : {}),
    ...(trim(group) ? { group: trim(group) } : {}),
    ...(isoFromTimestamp(resetsAt) ? { resetsAt: isoFromTimestamp(resetsAt) } : {}),
    ...(numberValue(total) !== null ? { total: numberValue(total) } : {}),
    ...(numberValue(used) !== null ? { used: numberValue(used) } : {}),
    ...(numberValue(remaining) !== null ? { remaining: numberValue(remaining) } : {}),
    ...(trim(unit) ? { unit: trim(unit) } : {}),
  };
}

function appendWindow(windows, window) {
  if (!window) return;
  const existing = windows.find((entry) => entry.id === window.id);
  if (!existing) {
    windows.push(window);
    return;
  }
  // If an upstream returns the same bucket twice, keep the most informative
  // representation while avoiding duplicate Android cards.
  Object.assign(existing, Object.fromEntries(
    Object.entries(window).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  ));
}

function createSnapshot({
  providerId,
  mode,
  adapter,
  status = 'ok',
  checkedAt,
  fetchedAt = checkedAt,
  planName = null,
  windows = [],
  balance = null,
  balances = null,
  extraUsage = null,
  error = null,
} = {}) {
  return {
    schemaVersion: PROVIDER_QUOTA_SCHEMA_VERSION,
    providerId: trim(providerId),
    mode: mode || null,
    adapter: adapter || null,
    status,
    checkedAt: checkedAt || null,
    fetchedAt: fetchedAt || null,
    ...(planName ? { planName } : {}),
    windows: Array.isArray(windows) ? windows : [],
    ...(balance && typeof balance === 'object' ? { balance } : {}),
    ...(Array.isArray(balances) && balances.length > 1 ? { balances } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    ...(error ? { error } : {}),
  };
}

function errorSnapshot({ providerId, mode, adapter, status = 'error', checkedAt, code, message }) {
  return createSnapshot({
    providerId,
    mode,
    adapter,
    status,
    checkedAt,
    error: { code, message },
  });
}

function inferAdapterFromBaseUrl(baseUrl) {
  const value = trim(baseUrl).toLowerCase();
  if (value.includes('api.kimi.com/coding')) return 'kimi';
  if (value.includes('bigmodel.cn') || value.includes('api.z.ai')) return 'zhipu';
  if (value.includes('api.minimaxi.com') || value.includes('api.minimax.io')) return 'minimax';
  if (value.includes('zenmux')) return 'zenmux';
  if (value.includes('api.deepseek.com')) return 'deepseek';
  if (value.includes('api.stepfun.ai') || value.includes('api.stepfun.com')) return 'stepfun';
  if (value.includes('api.siliconflow.cn') || value.includes('api.siliconflow.com')) return 'siliconflow';
  if (value.includes('openrouter.ai')) return 'openrouter';
  if (value.includes('api.novita.ai')) return 'novita';
  return '';
}

export function inferProviderQuotaPolicy(provider = {}) {
  const adapter = inferAdapterFromBaseUrl(provider.baseUrl);
  if (!adapter) return null;
  const codingPlanAdapters = new Set(['kimi', 'zhipu', 'minimax', 'zenmux']);
  return {
    mode: codingPlanAdapters.has(adapter) ? 'coding_plan' : 'payg_balance',
    adapter,
  };
}

function normalizePolicy(provider = {}) {
  const explicit = normalizeQuotaPolicy(provider.quotaPolicy);
  if (explicit?.mode && PROVIDER_QUOTA_MODES.has(explicit.mode)) {
    return {
      mode: explicit.mode,
      adapter: explicit.adapter || inferAdapterFromBaseUrl(provider.baseUrl),
    };
  }
  return inferProviderQuotaPolicy(provider);
}

async function requestJson(url, { headers = {}, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, kind: 'network', message: 'fetch is unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const status = Number(response?.status || 0);
    if (!response || !Number.isInteger(status)) {
      return { ok: false, kind: 'network', message: 'invalid quota response' };
    }
    let body;
    try {
      body = typeof response.json === 'function'
        ? await response.json()
        : JSON.parse(await response.text());
    } catch {
      return { ok: false, kind: 'invalid_response', status, message: 'quota response is not valid JSON' };
    }
    if (status === 401 || status === 403) {
      return { ok: false, kind: 'auth_failed', status, message: 'provider authentication was rejected' };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, kind: 'http_error', status, message: `provider quota request failed (HTTP ${status})` };
    }
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      kind: error?.name === 'AbortError' ? 'timeout' : 'network',
      message: error?.name === 'AbortError' ? 'provider quota request timed out' : 'provider quota request was unavailable',
    };
  } finally {
    clearTimeout(timer);
  }
}

function requestFailure({ providerId, mode, adapter, checkedAt }, result) {
  return errorSnapshot({
    providerId,
    mode,
    adapter,
    checkedAt,
    code: result.kind,
    message: result.message,
  });
}

function authToken(secret) {
  return trim(secret?.token || secret?.tokens?.access_token || secret?.tokens?.accessToken);
}

function authHeaders(adapter, apiKey) {
  return {
    Authorization: adapter === 'zhipu' ? apiKey : `Bearer ${apiKey}`,
  };
}

function parseCodexUsage(body, context) {
  const rateLimit = body?.rate_limit || body?.rateLimits || {};
  const windows = [];
  for (const [fallbackId, value] of [
    ['five_hour', rateLimit.primary_window || rateLimit.primary],
    ['weekly', rateLimit.secondary_window || rateLimit.secondary],
  ]) {
    if (!value || typeof value !== 'object') continue;
    appendWindow(windows, buildWindow({
      id: windowIdFromDuration(
        value.limit_window_seconds || (numberValue(value.windowDurationMins) || 0) * 60,
        fallbackId,
      ),
      usedPercent: value.used_percent ?? value.usedPercent,
      resetsAt: value.reset_at ?? value.resetAt,
    }));
  }
  const credits = body?.credits && typeof body.credits === 'object' ? body.credits : null;
  const extraUsage = credits ? {
    hasCredits: typeof credits.has_credits === 'boolean' ? credits.has_credits : credits.hasCredits,
    ...(typeof credits.unlimited === 'boolean' ? { unlimited: credits.unlimited } : {}),
    ...(numberValue(credits.balance) !== null ? { balance: numberValue(credits.balance) } : {}),
  } : null;
  return createSnapshot({
    ...context,
    status: 'ok',
    planName: trim(body?.plan_type || body?.planType),
    windows,
    extraUsage,
  });
}

function parseClaudeUsage(body, context) {
  const windows = [];
  const extraUsageRaw = body?.extra_usage;
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (key === 'extra_usage' || !value || typeof value !== 'object') continue;
      const utilization = numberValue(value.utilization);
      if (utilization === null) continue;
      appendWindow(windows, buildWindow({
        id: canonicalWindowId(key),
        usedPercent: utilization,
        resetsAt: value.resets_at ?? value.resetAt,
      }));
    }
  }
  const extraUsage = extraUsageRaw && typeof extraUsageRaw === 'object'
    ? {
      ...(typeof extraUsageRaw.is_enabled === 'boolean' ? { isEnabled: extraUsageRaw.is_enabled } : {}),
      ...(numberValue(extraUsageRaw.monthly_limit) !== null ? { monthlyLimit: numberValue(extraUsageRaw.monthly_limit) } : {}),
      ...(numberValue(extraUsageRaw.used_credits) !== null ? { used: numberValue(extraUsageRaw.used_credits) } : {}),
      ...(numberValue(extraUsageRaw.utilization) !== null ? { usedPercent: percentValue(extraUsageRaw.utilization) } : {}),
      ...(trim(extraUsageRaw.currency) ? { currency: trim(extraUsageRaw.currency) } : {}),
    }
    : null;
  if (extraUsage?.monthlyLimit !== undefined && extraUsage.used !== undefined) {
    extraUsage.remaining = Math.max(0, extraUsage.monthlyLimit - extraUsage.used);
  }
  return createSnapshot({ ...context, status: 'ok', windows, extraUsage });
}

function parseKimiUsage(body, context) {
  const windows = [];
  for (const item of Array.isArray(body?.limits) ? body.limits : []) {
    const detail = item?.detail;
    if (!detail || typeof detail !== 'object') continue;
    const total = numberValue(detail.limit);
    const remaining = numberValue(detail.remaining);
    const used = total !== null && remaining !== null ? Math.max(0, total - remaining) : null;
    const usedPercent = total && used !== null ? (used / total) * 100 : null;
    appendWindow(windows, buildWindow({
      id: 'five_hour',
      usedPercent,
      resetsAt: detail.resetTime,
      total,
      used,
      remaining,
      unit: 'tokens',
    }));
  }
  const usage = body?.usage;
  if (usage && typeof usage === 'object') {
    const total = numberValue(usage.limit);
    const remaining = numberValue(usage.remaining);
    const used = total !== null && remaining !== null ? Math.max(0, total - remaining) : null;
    appendWindow(windows, buildWindow({
      id: 'weekly',
      usedPercent: total && used !== null ? (used / total) * 100 : null,
      resetsAt: usage.resetTime,
      total,
      used,
      remaining,
      unit: 'tokens',
    }));
  }
  return createSnapshot({ ...context, status: 'ok', windows });
}

function parseZhipuUsage(body, context) {
  const windows = [];
  const fallback = [];
  const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
  for (const item of limits) {
    const type = trim(item?.type).toLowerCase();
    if (!['tokens_limit', 'credit_limit'].includes(type)) continue;
    const entry = {
      usedPercent: numberValue(item?.percentage),
      resetsAt: item?.nextResetTime,
    };
    const unit = numberValue(item?.unit);
    if (unit === 3) appendWindow(windows, buildWindow({ id: 'five_hour', ...entry }));
    else if (unit === 6) appendWindow(windows, buildWindow({ id: 'weekly', ...entry }));
    else fallback.push(entry);
  }
  for (const entry of fallback) {
    if (!windows.some((window) => window.id === 'five_hour')) appendWindow(windows, buildWindow({ id: 'five_hour', ...entry }));
    else if (!windows.some((window) => window.id === 'weekly')) appendWindow(windows, buildWindow({ id: 'weekly', ...entry }));
  }
  return createSnapshot({
    ...context,
    status: body?.success === false ? 'error' : 'ok',
    planName: trim(body?.data?.level),
    windows,
    ...(body?.success === false ? { error: { code: 'provider_error', message: 'provider returned a quota error' } } : {}),
  });
}

function parseMinimaxUsage(body, context) {
  const windows = [];
  const item = Array.isArray(body?.model_remains)
    ? body.model_remains.find((entry) => entry?.model_name === 'general')
    : null;
  if (item) {
    appendWindow(windows, buildWindow({
      id: 'five_hour',
      remainingPercent: item.current_interval_remaining_percent,
      resetsAt: item.end_time,
    }));
    if (numberValue(item.current_weekly_status) === 1) {
      appendWindow(windows, buildWindow({
        id: 'weekly',
        remainingPercent: item.current_weekly_remaining_percent,
        resetsAt: item.weekly_end_time,
      }));
    }
  }
  return createSnapshot({ ...context, status: 'ok', windows });
}

function parseZenmuxUsage(body, context) {
  const windows = [];
  const data = body?.data || {};
  for (const [id, key] of [['five_hour', 'quota_5_hour'], ['weekly', 'quota_7_day']]) {
    const value = data?.[key];
    if (!value || typeof value !== 'object') continue;
    appendWindow(windows, buildWindow({
      id,
      usedPercent: percentValue(value.usage_percentage, { fraction: true }),
      resetsAt: value.resets_at,
      used: value.used_value_usd,
      total: value.max_value_usd,
      unit: 'USD',
    }));
  }
  return createSnapshot({
    ...context,
    status: body?.success === false ? 'error' : 'ok',
    planName: trim(data?.plan?.tier),
    windows,
    ...(body?.success === false ? { error: { code: 'provider_error', message: 'provider returned a quota error' } } : {}),
  });
}

function parseBalance(body, context, { adapter }) {
  let balances = [];
  if (adapter === 'deepseek') {
    balances = (Array.isArray(body?.balance_infos) ? body.balance_infos : []).map((item) => ({
      remaining: numberValue(item?.total_balance),
      currency: trim(item?.currency) || 'CNY',
    })).filter((item) => item.remaining !== null);
  } else if (adapter === 'stepfun') {
    const remaining = numberValue(body?.balance);
    if (remaining !== null) balances = [{ remaining, currency: 'CNY' }];
  } else if (adapter === 'siliconflow') {
    const data = body?.data || {};
    const remaining = numberValue(data?.totalBalance);
    if (remaining !== null) balances = [{ remaining, currency: 'CNY' }];
  } else if (adapter === 'openrouter') {
    const data = body?.data || body || {};
    const total = numberValue(data?.total_credits);
    const used = numberValue(data?.total_usage);
    if (total !== null || used !== null) balances = [{
      remaining: Math.max(0, (total || 0) - (used || 0)),
      ...(total !== null ? { total } : {}),
      ...(used !== null ? { used } : {}),
      currency: 'USD',
    }];
  } else if (adapter === 'novita') {
    const available = numberValue(body?.availableBalance);
    if (available !== null) balances = [{ remaining: available / 10_000, currency: 'USD' }];
  }
  const normalized = balances.map((entry) => ({
    remaining: entry.remaining,
    ...(entry.total !== undefined ? { total: entry.total } : {}),
    ...(entry.used !== undefined ? { used: entry.used } : {}),
    currency: entry.currency,
    unit: entry.currency,
  }));
  return createSnapshot({
    ...context,
    status: 'ok',
    balance: normalized[0] || null,
    balances: normalized,
  });
}

function agyWindowId(groupName, window) {
  const group = trim(groupName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const bucketWindow = canonicalWindowId(window);
  if (!group) return bucketWindow;
  return `${group}_${bucketWindow}`;
}

function parseAgyUsage(body, context) {
  const groups = Array.isArray(body?.command?.data?.groups) ? body.command.data.groups : [];
  if (groups.length === 0) {
    return errorSnapshot({
      ...context,
      status: 'error',
      code: 'invalid_response',
      message: 'agy quota response contained no groups',
    });
  }
  const windows = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const groupName = trim(group.name);
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!bucket || typeof bucket !== 'object') continue;
      const remainingFraction = numberValue(bucket.remaining_fraction);
      appendWindow(windows, buildWindow({
        id: agyWindowId(groupName, bucket.window),
        label: trim(bucket.name) || trim(bucket.window),
        group: groupName,
        usedPercent: remainingFraction === null ? null : 100 - remainingFraction * 100,
        resetsAt: bucket.reset_time,
      }));
    }
  }
  if (windows.length === 0) {
    return errorSnapshot({
      ...context,
      status: 'error',
      code: 'invalid_response',
      message: 'agy quota response contained no usable buckets',
    });
  }
  return createSnapshot({ ...context, status: 'ok', windows });
}

function defaultAgySpawn(file, args, options = {}) {
  return spawnManagedProviderProcess({
    file,
    args,
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  }, {
    detached: options.detached === true,
    stdio: options.stdio,
  });
}

async function resolveAgyCommand() {
  return resolveExecutableCommandPathAsync('agy');
}

async function runAgyQuotaCommand({
  spawnImpl = defaultAgySpawn,
  resolveCommand = resolveAgyCommand,
  timeoutMs = AGY_QUOTA_TIMEOUT_MS,
  agyHomeDir = '',
} = {}) {
  const command = await Promise.resolve(resolveCommand()).catch(() => null);
  if (!command) {
    return { ok: false, kind: 'not_configured', message: 'agy CLI is not installed' };
  }
  const args = ['-p', '/quota', '--output-format', 'json', '--print-timeout', '25s'];
  const spec = spawnImpl === defaultAgySpawn
    ? buildAgyRuntimeLaunchSpec({
      command,
      args,
      env: await buildAgyRuntimeEnv(process.env, { homeDir: agyHomeDir, control: false }),
    })
    : buildPlatformSpawnSpec(command, args, {
      env: { ...process.env },
    });
  const childLaunch = spawnImpl(spec.file, spec.args, {
    env: spec.env,
    shell: spec.shell,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The Windows Job Object contract resolves asynchronously, while the
  // injected POSIX/test spawns return a ChildProcess synchronously. Preserve
  // synchronous listener registration so a short-lived child cannot emit
  // `close` before the quota observer is attached.
  const child = childLaunch && typeof childLaunch.then === 'function'
    ? await childLaunch
    : childLaunch;
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const appendBounded = (current, chunk, stream) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
    const bytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, MAX_AGY_QUOTA_OUTPUT_BYTES - bytes);
    if (buffer.byteLength > remaining) outputTruncated = true;
    const retained = buffer.subarray(0, remaining).toString('utf8');
    if (stream === 'stdout') stdoutBytes += Buffer.byteLength(retained, 'utf8');
    else stderrBytes += Buffer.byteLength(retained, 'utf8');
    return `${current}${retained}`;
  };
  child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, 'stdout'); });
  child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, 'stderr'); });
  child.stdin?.on?.('error', () => {});
  const { code, signal } = await new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateProviderProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) {
          terminateProviderProcessTree(child, 'SIGKILL');
        }
        // A broken child facade may not emit close after kill. The quota
        // projection is best-effort, so bound this wait and return a timeout
        // instead of pinning the control-plane request forever.
        finish({ code: null, signal: 'SIGKILL' });
      }, 2_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => finish({ code: null, signal: '', error }));
    child.on('close', (exitCode, exitSignal) => finish({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 0) {
    return {
      ok: false,
      kind: signal === 'SIGKILL' ? 'timeout' : 'process_error',
      message: signal === 'SIGKILL'
        ? 'agy quota command timed out'
        : `agy quota command failed (exit ${code ?? 'error'}${stderr ? `: ${stderr.slice(-300)}` : ''}${outputTruncated ? '; output truncated' : ''})`,
    };
  }
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    return { ok: false, kind: 'invalid_response', message: 'agy quota output contained no JSON object' };
  }
  try {
    return { ok: true, body: JSON.parse(stdout.slice(jsonStart)) };
  } catch {
    return { ok: false, kind: 'invalid_response', message: 'agy quota output is not valid JSON' };
  }
}

async function createAgyQuotaHome(secret) {
  const tokenFile = trim(secret?.tokens?.tokenFile);
  if (!tokenFile) return null;
  const homeDir = await mkdtemp(join(tmpdir(), 'ragent-agy-quota-'));
  const authFile = join(homeDir, AGY_AUTH_RELATIVE_PATH);
  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
  await chmod(homeDir, 0o700).catch(() => {});
  await chmod(dirname(authFile), 0o700).catch(() => {});
  await writeFile(authFile, tokenFile, { mode: 0o600 });
  await chmod(authFile, 0o600).catch(() => {});
  return { homeDir, cleanup: async () => { await rm(homeDir, { recursive: true, force: true }).catch(() => {}); } };
}

async function queryOfficial({ provider, secret, context, fetchImpl, spawnImpl, resolveCommand }) {
  if (provider.agentType === 'agy') {
    const quotaHome = await createAgyQuotaHome(secret);
    if (!quotaHome) {
      return errorSnapshot({
        ...context,
        status: 'not_configured',
        code: 'access_token_missing',
        message: 'AgY credential is unavailable',
      });
    }
    try {
      const result = await runAgyQuotaCommand({
        spawnImpl,
        resolveCommand,
        agyHomeDir: quotaHome.homeDir,
      });
      return result.ok ? parseAgyUsage(result.body, context) : requestFailure(context, result);
    } finally {
      await quotaHome.cleanup();
    }
  }
  const accessToken = authToken(secret);
  if (!accessToken) return errorSnapshot({ ...context, status: 'not_configured', code: 'access_token_missing', message: 'official account access token is unavailable' });
  if (provider.agentType === 'codex') {
    const accountId = trim(context.accountId);
    const result = await requestJson('https://chatgpt.com/backend-api/wham/usage', {
      fetchImpl,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'codex-cli',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
    });
    return result.ok ? parseCodexUsage(result.body, context) : requestFailure(context, result);
  }
  if (provider.agentType === 'claude') {
    const result = await requestJson('https://api.anthropic.com/api/oauth/usage', {
      fetchImpl,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    return result.ok ? parseClaudeUsage(result.body, context) : requestFailure(context, result);
  }
  return errorSnapshot({ ...context, status: 'unsupported', code: 'official_adapter_unsupported', message: 'official quota adapter is unavailable for this provider' });
}

async function queryApi({ provider, secret, mode, adapter, context, fetchImpl }) {
  const apiKey = trim(secret?.apiKey);
  if (!apiKey) return errorSnapshot({ ...context, status: 'not_configured', code: 'api_key_missing', message: 'provider API key is unavailable' });
  let url = trim(provider.baseUrl);
  let headers = authHeaders(adapter, apiKey);
  if (mode === 'coding_plan') {
    if (adapter === 'kimi') url = 'https://api.kimi.com/coding/v1/usages';
    else if (adapter === 'zhipu') url = trim(provider.baseUrl).toLowerCase().includes('bigmodel.cn')
      ? 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
      : 'https://api.z.ai/api/monitor/usage/quota/limit';
    else if (adapter === 'minimax') url = trim(provider.baseUrl).toLowerCase().includes('api.minimax.io')
      ? 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains'
      : 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains';
    else if (adapter === 'zenmux') url = trim(provider.baseUrl);
    else return errorSnapshot({ ...context, status: 'unsupported', code: 'coding_plan_adapter_unsupported', message: 'coding plan adapter is unavailable for this provider' });
  } else if (mode === 'payg_balance') {
    if (adapter === 'deepseek') url = 'https://api.deepseek.com/user/balance';
    else if (adapter === 'stepfun') url = 'https://api.stepfun.com/v1/accounts';
    else if (adapter === 'siliconflow') {
      url = trim(provider.baseUrl).toLowerCase().includes('siliconflow.com')
        ? 'https://api.siliconflow.com/v1/user/info'
        : 'https://api.siliconflow.cn/v1/user/info';
    } else if (adapter === 'openrouter') url = 'https://openrouter.ai/api/v1/credits';
    else if (adapter === 'novita') url = 'https://api.novita.ai/v3/user/balance';
    else return errorSnapshot({ ...context, status: 'unsupported', code: 'payg_adapter_unsupported', message: 'pay-as-you-go balance adapter is unavailable for this provider' });
  } else {
    return errorSnapshot({ ...context, status: 'unsupported', code: 'quota_mode_unsupported', message: 'quota mode is not supported for API-key providers' });
  }
  const result = await requestJson(url, { fetchImpl, headers });
  if (!result.ok) return requestFailure(context, result);
  if (mode === 'coding_plan') {
    const parser = { kimi: parseKimiUsage, zhipu: parseZhipuUsage, minimax: parseMinimaxUsage, zenmux: parseZenmuxUsage }[adapter];
    return parser ? parser(result.body, context) : errorSnapshot({ ...context, status: 'unsupported', code: 'coding_plan_adapter_unsupported', message: 'coding plan adapter is unavailable for this provider' });
  }
  return parseBalance(result.body, context, { adapter });
}

export async function queryProviderQuota({
  provider,
  authProfile,
  secretStore,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  resolveCommand,
  now = () => new Date().toISOString(),
} = {}) {
  const checkedAt = now();
  const policy = normalizePolicy(provider);
  const claudeOAuthRemoved = provider?.agentType === 'claude' && authProfile?.authType === 'oauth';
  const context = {
    providerId: provider?.id,
    mode: claudeOAuthRemoved || ['oauth', 'oauth-token'].includes(authProfile?.authType)
      ? 'official_subscription'
      : policy?.mode || null,
    adapter: claudeOAuthRemoved || ['oauth', 'oauth-token'].includes(authProfile?.authType)
      ? provider?.agentType || null
      : policy?.adapter || null,
    accountId: trim(authProfile?.accountMetadata?.accountId),
    checkedAt,
  };
  if (claudeOAuthRemoved) {
    return errorSnapshot({
      ...context,
      status: 'not_configured',
      code: 'claude_oauth_removed',
      message: 'Claude normal OAuth was removed; migrate this provider to claude setup-token.',
    });
  }
  if (!provider || !authProfile) {
    return errorSnapshot({ ...context, status: 'not_configured', code: 'provider_not_configured', message: 'provider or auth profile is unavailable' });
  }
  if (!PROVIDER_QUOTA_ADAPTERS.has(context.adapter)) {
    return errorSnapshot({ ...context, status: 'unsupported', code: 'quota_adapter_unsupported', message: 'no fixed quota adapter is available for this provider' });
  }
  const secret = await secretStore?.resolveSecret(authProfile.storageRef);
  if (!secret?.ok) {
    return errorSnapshot({ ...context, status: 'not_configured', code: 'credential_unavailable', message: 'provider credential is unavailable' });
  }
  if (provider.agentType === 'agy') {
    return queryOfficial({ provider, secret, context, fetchImpl, spawnImpl, resolveCommand });
  }
  if (['oauth', 'oauth-token'].includes(authProfile.authType)) {
    return queryOfficial({ provider, secret, context, fetchImpl, spawnImpl, resolveCommand });
  }
  if (authProfile.authType === 'api-key') {
    if (!policy?.mode) {
      return errorSnapshot({ ...context, status: 'not_configured', code: 'quota_policy_missing', message: 'API provider quota policy is not configured' });
    }
    return queryApi({ provider, secret, mode: policy.mode, adapter: policy.adapter, context, fetchImpl });
  }
  return errorSnapshot({ ...context, status: 'unsupported', code: 'auth_type_unsupported', message: 'provider auth type has no quota adapter' });
}

export function createProviderQuotaStore({
  configDir,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
} = {}) {
  const storeDir = join(configDir, 'native-provider-runtime');
  const storeFile = join(storeDir, QUOTA_STORE_FILE);

  async function readStore() {
    try {
      const parsed = JSON.parse(await readFileImpl(storeFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeStore(payload) {
    await mkdirImpl(storeDir, { recursive: true, mode: 0o700 });
    const temp = `${storeFile}.${process.pid}.tmp`;
    await writeFileImpl(temp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    await renameImpl(temp, storeFile);
  }

  async function get(providerId) {
    const id = trim(providerId);
    if (!id) return null;
    const store = await readStore();
    return store[id] && typeof store[id] === 'object' ? store[id] : null;
  }

  async function put(providerId, snapshot) {
    const id = trim(providerId);
    if (!id || !snapshot || typeof snapshot !== 'object') return null;
    const store = await readStore();
    store[id] = snapshot;
    await writeStore(store);
    return snapshot;
  }

  return { get, put };
}

function hasUsableQuotaData(snapshot) {
  return Array.isArray(snapshot?.windows) && snapshot.windows.length > 0 || !!snapshot?.balance || !!snapshot?.extraUsage;
}

export async function refreshProviderQuota({ quotaStore, ...options } = {}) {
  const current = await queryProviderQuota(options);
  const providerId = trim(options.provider?.id);
  const previous = await quotaStore?.get(providerId);
  let snapshot = current;
  if (previous && ['error', 'not_configured'].includes(current.status) && hasUsableQuotaData(previous)) {
    snapshot = {
      ...current,
      status: 'stale',
      fetchedAt: previous.fetchedAt || null,
      windows: previous.windows || [],
      ...(previous.balance ? { balance: previous.balance } : {}),
      ...(previous.balances ? { balances: previous.balances } : {}),
      ...(previous.extraUsage ? { extraUsage: previous.extraUsage } : {}),
      ...(previous.planName ? { planName: previous.planName } : {}),
    };
  }
  if (quotaStore && providerId) await quotaStore.put(providerId, snapshot);
  return snapshot;
}
