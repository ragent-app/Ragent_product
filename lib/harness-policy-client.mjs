import { ACCOUNTS_URL } from './config.mjs';
import {
  DEFAULT_HARNESS_POLICY,
  HARNESS_POLICY_CATALOG_REVISION,
  HARNESS_POLICY_SCHEMA_VERSION,
  normalizeHarnessPolicy,
} from './harness-policy.mjs';

let cache = null;
const POLICY_CACHE_TTL_MS = 60_000;
const POLICY_FETCH_TIMEOUT_MS = 5_000;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function builtinPolicy(source = 'builtin') {
  return {
    source,
    schemaVersion: HARNESS_POLICY_SCHEMA_VERSION,
    catalogRevision: HARNESS_POLICY_CATALOG_REVISION,
    revision: `builtin-v${HARNESS_POLICY_SCHEMA_VERSION}`,
    policies: normalizeHarnessPolicy(DEFAULT_HARNESS_POLICY),
  };
}

function policyUrl() {
  const raw = text(process.env.AGENTOC_HARNESS_POLICY_URL) || text(ACCOUNTS_URL);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/harness-policy`;
    url.search = '';
    return url.toString();
  } catch { return ''; }
}

export async function fetchHarnessPolicy({ fetchImpl = globalThis.fetch, force = false } = {}) {
  const url = policyUrl();
  if (!url || typeof fetchImpl !== 'function') return builtinPolicy();
  if (!force && cache?.url === url && Date.now() - cache.at < POLICY_CACHE_TTL_MS) return cache.value;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), POLICY_FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, ...(controller ? { signal: controller.signal } : {}) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (Number(body?.schemaVersion) !== HARNESS_POLICY_SCHEMA_VERSION
      || text(body?.catalogRevision) !== HARNESS_POLICY_CATALOG_REVISION) {
      throw new Error('Harness policy catalog does not match this Ragent adapter release');
    }
    const value = {
      source: 'central',
      schemaVersion: HARNESS_POLICY_SCHEMA_VERSION,
      catalogRevision: HARNESS_POLICY_CATALOG_REVISION,
      revision: text(body?.revision) || 'central-unknown',
      updatedAt: body?.updatedAt || null,
      policies: normalizeHarnessPolicy(body?.policies || body),
    };
    cache = { url, at: Date.now(), value };
    return value;
  } catch {
    const value = builtinPolicy('builtin-fallback');
    // Cache negative results too. A down/unreachable Accounts endpoint must
    // not turn every harness-list request into another blocking network dial.
    cache = { url, at: Date.now(), value };
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function clearHarnessPolicyCache() { cache = null; }
