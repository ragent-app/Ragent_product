// Only pin the merged catalog if every official account has a fresh
// discovered catalog. Fallback/stale rows must get the shorter retry policy.
export function mayCacheMergedCodexCatalog(officialRows, readEntry, now, ttlMs) {
  return officialRows.every((row) => {
    const entry = readEntry(row.id);
    return Boolean(entry?.at && now - entry.at < ttlMs
      && Array.isArray(entry.models) && entry.models.length > 0
      && entry.models.every((model) => model.catalogSource === 'upstream'));
  });
}

// Never log a provider error verbatim: it may contain URLs or credentials.
export function classifyOfficialCodexDiscoveryFailure(error) {
  const allowedCodes = new Set([
    'CODEX_ACCOUNT_UNVERIFIED', 'CODEX_APP_SERVER_BROKER_ACCESS_DENIED',
    'CODEX_APP_SERVER_BROKER_UNAVAILABLE', 'CODEX_HANDOFF_UNAVAILABLE',
    'HARNESS_RUNTIME_UNAVAILABLE', 'NATIVE_OAUTH_LOCK_TIMEOUT',
    'CODEX_BROKER_PIPE_SECURITY_FAILED', 'CODEX_BROKER_PIPE_SECURITY_INVALID',
  ]);
  const safePrepareReasons = new Set(['credential-missing', 'resolution-failed', 'oauth-persist-unavailable', 'oauth-persist-failed', 'oauth-persist-readback-failed', 'codex-broker-account-changed']);
  if (error?.discoveryStage === 'PREPARE' && safePrepareReasons.has(error?.code)) {
    return `MODEL_LIST_PREPARE_${error.code.toUpperCase().replaceAll('-', '_')}`;
  }
  const classified = error?.cause || error;
  if (allowedCodes.has(classified?.code)) return classified.code;
  if (['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET'].includes(classified?.code)) return `MODEL_LIST_${classified.code}`;
  const message = typeof classified?.message === 'string' ? classified.message.toLowerCase() : '';
  if (message.includes('timed out') || message.includes('timeout')) return 'MODEL_LIST_TIMEOUT';
  if (message.includes('no picker-visible models')) return 'MODEL_LIST_EMPTY';
  if (error?.discoveryStage === 'PREPARE') return 'MODEL_LIST_PREPARE_FAILED';
  if (error?.discoveryStage === 'REQUEST') return 'MODEL_LIST_REQUEST_FAILED';
  return 'MODEL_LIST_FAILED';
}
