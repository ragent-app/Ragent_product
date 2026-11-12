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
