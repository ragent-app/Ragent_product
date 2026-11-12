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
  if (allowedCodes.has(error?.code)) return error.code;
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (message.includes('timed out') || message.includes('timeout')) return 'MODEL_LIST_TIMEOUT';
  if (message.includes('no picker-visible models')) return 'MODEL_LIST_EMPTY';
  return 'MODEL_LIST_FAILED';
}
