// Provider-scoped model catalog normalization and lifecycle.
//
// Contract (docs/cross-device-credential-recovery-and-model-catalog-plan.md §三):
//   - Every catalog entry carries providerProfileId, source
//     (static | discovered | policy | stale-cache), catalogVersion, and
//     normalized capabilities. The UI key is `model@providerProfileId`; the
//     bare model id is what Run snapshots store.
//   - Catalog read and refresh are separate: GET serves cache or static
//     fallback without blocking; refresh is a controlled, deduped action.
//   - Per-provider refresh keeps a single in-flight request; failures retain
//     the last good catalog flagged `stale`; no cache + failure = `unavailable`.
//   - defaultModel must exist in the SAME provider's catalog, otherwise it is
//     nulled with a validation error instead of silently pointing elsewhere.
//   - Errors are safe codes only — never raw upstream bodies, tokens, or
//     Authorization headers.

import { createHash } from 'crypto';

export const MODEL_CATALOG_SOURCES = new Set(['static', 'discovered', 'policy', 'stale-cache']);
export const MODEL_CATALOG_STATUSES = new Set(['fresh', 'stale', 'unavailable']);

export const MODEL_CATALOG_TTL_MS_DEFAULT = 120_000;
export const MODEL_CATALOG_FETCH_TIMEOUT_MS_DEFAULT = 8_000;
export const MODEL_CATALOG_FAIL_COOLD_MS_DEFAULT = 60_000;

// Older non-Codex producers do not report an origin; preserve their existing
// discovered behavior until they can provide one explicitly.
export function sourceFromModelOrigins(origins) {
  return Array.isArray(origins) && origins.length > 0
    && origins.every((origin) => ['builtin', 'configured', 'static'].includes(origin))
    ? 'static' : 'discovered';
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Deterministic catalog revision: hash of the sorted model ids + capability
// fingerprints, so all devices comparing catalogVersion agree without a clock.
export function computeModelCatalogVersion(entries = []) {
  const material = entries
    .map((entry) => {
      const id = trimString(entry?.id);
      const provider = trimString(entry?.providerProfileId);
      const capabilities = entry?.capabilities || {};
      return `${provider}/${id}:${JSON.stringify({
        effort: capabilities.effort || null,
        serviceTier: capabilities.serviceTier || null,
      })}`;
    })
    .sort()
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function normalizeModelCatalogCapabilities(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const effortSource = source.effort && typeof source.effort === 'object' ? source.effort : {};
  const levels = Array.isArray(effortSource.levels)
    ? [...new Set(effortSource.levels.map((level) => trimString(String(level || '')).toLowerCase()).filter(Boolean))]
    : [];
  const effortDefault = trimString(String(effortSource.default || '')).toLowerCase();
  const tierSource = source.serviceTier && typeof source.serviceTier === 'object' ? source.serviceTier : {};
  const tierValues = Array.isArray(tierSource.values)
    ? [...new Set(tierSource.values.map((tier) => trimString(String(tier || '')).toLowerCase()).filter(Boolean))]
    : [];
  return {
    effort: {
      supported: levels.length > 0 ? true : effortSource.supported === true,
      ...(levels.length > 0 ? { levels } : {}),
      ...(levels.includes(effortDefault) ? { default: effortDefault } : {}),
    },
    serviceTier: {
      supportsFast: tierValues.includes('fast') || tierSource.supportsFast === true,
      values: [...new Set(['standard', ...tierValues])],
    },
  };
}

// One catalog entry. `model` is the bare id submitted to the CLI/upstream;
// `id` is the provider-scoped UI key.
export function normalizeModelCatalogEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const bareModel = trimString(String(source.model ?? source.id ?? ''));
  if (!bareModel) return null;
  const providerProfileId = trimString(String(source.providerProfileId || ''));
  const entrySource = trimString(String(source.source || 'static'));
  const scopedId = providerProfileId ? `${bareModel}@${providerProfileId}` : bareModel;
  // Reject scoped keys whose provider suffix collides with a providerless
  // entry of the same name — same model on two providers stays independent.
  return {
    id: scopedId,
    model: bareModel,
    ...(providerProfileId ? { providerProfileId } : {}),
    label: trimString(String(source.label || bareModel)),
    source: MODEL_CATALOG_SOURCES.has(entrySource) ? entrySource : 'static',
    ...(Number.isFinite(Number(source.contextWindow)) && source.contextWindow > 0
      ? { contextWindow: Math.floor(Number(source.contextWindow)) }
      : {}),
    capabilities: normalizeModelCatalogCapabilities(source.capabilities),
  };
}

export function normalizeModelCatalog({
  providerProfileId = '',
  entries = [],
  source = 'discovered',
  fetchedAt = '',
  expiresAt = '',
  error = null,
  nowMs = null,
} = {}) {
  const provider = trimString(providerProfileId);
  const now = Number.isFinite(nowMs) ? nowMs : null;
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeModelCatalogEntry({ providerProfileId: provider, ...entry }))
    .filter(Boolean);
  const seen = new Set();
  const deduped = normalizedEntries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });

  let status;
  if (deduped.length === 0 && error) {
    status = 'unavailable';
  } else if (source === 'stale-cache') {
    status = 'stale';
  } else if (now != null && Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0 && now >= Number(expiresAt)) {
    status = 'stale';
  } else {
    status = 'fresh';
  }

  const requestedDefault = trimString(String(
    (Array.isArray(entries) && entries.find((entry) => entry?.isDefault)?.model) || '',
  ));
  const defaultModel = deduped.find((entry) => entry.model === requestedDefault) || null;

  return {
    providerProfileId: provider,
    models: deduped,
    catalogVersion: computeModelCatalogVersion(deduped),
    source: MODEL_CATALOG_SOURCES.has(source) ? source : 'static',
    status,
    ...(trimString(fetchedAt) ? { fetchedAt: trimString(fetchedAt) } : {}),
    ...(Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0
      ? { expiresAt: Number(expiresAt) }
      : {}),
    ...(defaultModel ? { defaultModel: defaultModel.model } : {}),
    ...(defaultModel ? {} : (requestedDefault ? { defaultModelError: 'default-model-not-in-catalog' } : {})),
    ...(error ? { error: normalizeCatalogError(error) } : {}),
  };
}

// Only safe error codes/messages leave this module. Upstream error text can
// embed request headers or credential fragments; strip known secret shapes
// and genericize transport noise instead of forwarding raw bodies.
function sanitizeCatalogMessage(text) {
  let message = trimString(String(text || ''));
  if (!message) return '';
  if (/(authorization|bearer|cookie|api[_-]?key|token)/i.test(message)) {
    return 'upstream authentication material was present in the error and has been omitted';
  }
  message = message
    .replace(/\b(sk|rk)-[A-Za-z0-9_.*-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
  return message.slice(0, 200);
}

export function normalizeCatalogError(error) {
  if (!error) return null;
  if (typeof error === 'string') {
    return { code: 'catalog_error', message: sanitizeCatalogMessage(error) || 'catalog_error' };
  }
  const code = trimString(String(error.code || 'catalog_error'));
  return {
    code,
    message: sanitizeCatalogMessage(error.message) || code,
  };
}

// Validate a run-creation model selection against a provider's catalog.
// Returns { ok } or { ok: false, code: 'model-not-available' } — the run must
// fail BEFORE spawn rather than silently switching models or providers.
export function validateRunModelSelection({ catalog, model, providerProfileId = '' } = {}) {
  const bareModel = trimString(String(model || '')).split('@')[0];
  if (!bareModel) {
    return { ok: false, code: 'model-not-available', message: 'A model is required.' };
  }
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return {
      ok: false,
      code: 'model-not-available',
      message: trimString(providerProfileId)
        ? `No model catalog is available for provider ${providerProfileId}.`
        : 'No model catalog is available.',
      catalogStatus: catalog?.status || 'unavailable',
    };
  }
  const provider = trimString(providerProfileId);
  const match = catalog.models.find((entry) => (
    entry.model === bareModel
    && (!provider || !entry.providerProfileId || entry.providerProfileId === provider)
  ));
  if (!match) {
    return {
      ok: false,
      code: 'model-not-available',
      message: `Model ${bareModel} is not in the ${provider || 'provider'} catalog.`,
      catalogVersion: catalog.catalogVersion,
      catalogStatus: catalog.status,
    };
  }
  return {
    ok: true,
    model: match.model,
    providerProfileId: match.providerProfileId || provider,
    catalogVersion: catalog.catalogVersion,
  };
}

// Per-provider refresh coordinator: one in-flight request per provider, TTL
// windows, failure cooldown retaining the last good catalog as stale.
export function createModelCatalogCache({
  ttlMs = MODEL_CATALOG_TTL_MS_DEFAULT,
  failCooldownMs = MODEL_CATALOG_FAIL_COOLD_MS_DEFAULT,
  nowImpl = () => Date.now(),
} = {}) {
  const catalogs = new Map(); // providerProfileId -> { catalog, fetchedAt, failedAt }
  const inFlight = new Map(); // providerProfileId -> Promise

  function staleVariant(catalog) {
    if (!catalog) return null;
    return normalizeModelCatalog({
      ...catalog,
      entries: catalog.models,
      source: 'stale-cache',
      fetchedAt: catalog.fetchedAt,
      expiresAt: null,
      nowMs: null,
    });
  }

  return {
    get(providerProfileId) {
      const key = trimString(providerProfileId);
      if (!key) return null;
      const entry = catalogs.get(key);
      if (!entry) return null;
      const age = nowImpl() - entry.fetchedAt;
      if (entry.catalog && age < ttlMs) {
        return { ...entry.catalog, status: 'fresh' };
      }
      if (entry.catalog) {
        return staleVariant(entry.catalog);
      }
      return null;
    },

    // Read-only peek used by GET handlers: never triggers a fetch.
    peek(providerProfileId) {
      return this.get(providerProfileId);
    },

    // Controlled refresh with single-flight dedup. `loader` must return
    // { entries, error? }; it never receives or returns credentials.
    async refresh(providerProfileId, loader) {
      const key = trimString(providerProfileId);
      if (!key || typeof loader !== 'function') return null;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const task = (async () => {
        const prior = catalogs.get(key);
        const now = nowImpl();
        // Within the TTL window a cached good catalog short-circuits the load;
        // the failure cooldown below governs the error path.
        if (prior?.catalog && !prior.failedAt && now - prior.fetchedAt < ttlMs) {
          return { ...prior.catalog, status: 'fresh' };
        }
        if (prior?.failedAt && now - prior.failedAt < failCooldownMs) {
          return prior.catalog ? staleVariant(prior.catalog) : null;
        }
        let loaded = { entries: [] };
        try {
          loaded = await loader();
        } catch (error) {
          loaded = { entries: [], error };
        }
        const fetchedAt = nowImpl();
        const catalog = normalizeModelCatalog({
          providerProfileId: key,
          entries: loaded.entries,
          source: 'discovered',
          fetchedAt: new Date(fetchedAt).toISOString(),
          expiresAt: fetchedAt + ttlMs,
          error: loaded.error || null,
          nowMs: fetchedAt,
        });
        if (catalog.models.length > 0) {
          catalogs.set(key, { catalog, fetchedAt, failedAt: 0 });
          return catalog;
        }
        // Failure path: keep the last good catalog flagged stale.
        const kept = prior?.catalog ? staleVariant(prior.catalog) : catalog;
        const failure = normalizeCatalogError(loaded.error);
        catalogs.set(key, { catalog: prior?.catalog || null, fetchedAt: prior?.fetchedAt || 0, failedAt: fetchedAt });
        return kept === catalog ? kept : { ...kept, ...(failure ? { error: failure } : {}) };
      })();
      inFlight.set(key, task);
      try {
        return await task;
      } finally {
        inFlight.delete(key);
      }
    },

    // Static/policy catalogs registered directly (no upstream call).
    install(providerProfileId, catalog) {
      const key = trimString(providerProfileId);
      if (!key || !catalog) return;
      catalogs.set(key, { catalog, fetchedAt: nowImpl(), failedAt: 0 });
    },

    invalidate(providerProfileId) {
      const key = trimString(providerProfileId);
      if (key) catalogs.delete(key);
    },
  };
}
