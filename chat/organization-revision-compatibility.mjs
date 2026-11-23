import { canonicalJson } from './execution-scope.mjs';

// Called inside the caller's existing SQLite transaction. A previous Run can
// survive only a contiguous chain of frozen, append-only revisions; no old
// node, management edge, phase, budget or owner constraint may be rewritten.
export function isAppendOnlyRevisionCompatible(db, organizationId, fromRevision, toRevision) {
  if (!Number.isInteger(fromRevision) || !Number.isInteger(toRevision) || fromRevision < 1 || toRevision < fromRevision) return false;
  if (fromRevision === toRevision) return true;
  const rows = db.prepare('SELECT revision,state,proposal_json,compiled_json,idempotency_key FROM organization_revisions WHERE organization_id=? AND revision>=? AND revision<=? ORDER BY revision').all(organizationId, fromRevision, toRevision);
  if (rows.length !== toRevision - fromRevision + 1 || rows.some((row, index) => row.revision !== fromRevision + index || row.state !== 'frozen')) return false;
  const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
  const keyed = (values, key) => new Map((Array.isArray(values) ? values : []).map((entry) => [key(entry), entry]));
  try {
    for (let i = 1; i < rows.length; i++) {
      if (!['manager-append:', 'owner-report-append:'].some(prefix => String(rows[i].idempotency_key || '').startsWith(prefix))) return false;
      if (String(rows[i].idempotency_key || '').startsWith('owner-report-append:')) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_report_setup_operations'").get()) return false;
        const commandId=String(rows[i].idempotency_key).slice('owner-report-append:'.length);
        if (!db.prepare('SELECT 1 FROM owner_report_setup_operations WHERE command_id=? AND organization_id=? AND revision=?').get(commandId,organizationId,rows[i].revision)) return false;
      }
      const before = JSON.parse(rows[i - 1].compiled_json || '{}');
      const after = JSON.parse(rows[i].compiled_json || '{}');
      const previous = JSON.parse(rows[i - 1].proposal_json || '{}');
      const next = JSON.parse(rows[i].proposal_json || '{}');
      if (!equal(previous.budget ?? null, next.budget ?? null) || !equal(previous.objective ?? null, next.objective ?? null)
          || !equal(previous.reviewPolicy ?? null, next.reviewPolicy ?? null) || !equal(previous.acceptance ?? null, next.acceptance ?? null)) return false;
      const oldNodeKeys = new Set((before.nodes || []).map((node) => node.stableKey));
      const oldEdges = new Set((before.manages || []).map((edge) => `${edge.parentKey}\0${edge.childKey}`));
      if ((after.manages || []).some((edge) => !oldEdges.has(`${edge.parentKey}\0${edge.childKey}`) && oldNodeKeys.has(edge.childKey))) return false;
      for (const [field, key] of [['nodes', e => e.stableKey], ['phases', e => e.phaseId], ['manages', e => `${e.parentKey}\0${e.childKey}`]]) {
        const oldItems = keyed(before[field], key), newItems = keyed(after[field], key);
        if (oldItems.size !== (before[field] || []).length || newItems.size !== (after[field] || []).length) return false;
        for (const [id, entry] of oldItems) if (!id || !newItems.has(id) || !equal(entry, newItems.get(id))) return false;
      }
    }
    return true;
  } catch { return false; }
}
