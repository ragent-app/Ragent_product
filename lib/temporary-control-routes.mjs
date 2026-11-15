// Strict v2 P2P carrier route inventory.  The temporary control carrier has
// its own logical origin and never forwards an arbitrary /api path to the
// Owner router.  Every entry resolves to a named capability in
// temporary-control-policy.mjs.
import { TEMPORARY_CONTROL_OPERATIONS } from './temporary-control-policy.mjs';

export const TEMPORARY_CONTROL_CARRIER_ORIGIN = 'https://temporary-control.ragent.invalid';

const base = '/api/temporary-control/v1/instances/';
const instance = '(inst_[A-Za-z0-9_-]{24,64})';
const segment = '([^/]{1,512})';

const routes = Object.freeze([
  ['GET', new RegExp(`^${base}${instance}/projects$`), 'project.list'],
  ['POST', new RegExp(`^${base}${instance}/projects$`), 'project.create'],
  ['GET', new RegExp(`^${base}${instance}/projects/${segment}$`), 'project.read'],
  ['PATCH', new RegExp(`^${base}${instance}/projects/${segment}$`), 'project.update'],
  ['DELETE', new RegExp(`^${base}${instance}/projects/${segment}$`), 'project.delete'],
  ['GET', new RegExp(`^${base}${instance}/browse$`), 'project.browse'],
  ['POST', new RegExp(`^${base}${instance}/browse/mkdir$`), 'project.mkdir'],
  ['GET', new RegExp(`^${base}${instance}/session-creation-contract$`), 'session.creation_contract'],
  ['GET', new RegExp(`^${base}${instance}/session-mutation-contract$`), 'session.mutation_contract'],
  ['GET', new RegExp(`^${base}${instance}/runtime/summary(?:/events)?$`), 'runtime.summary'],
  ['GET', new RegExp(`^${base}${instance}/sessions$`), 'session.list'],
  ['POST', new RegExp(`^${base}${instance}/sessions$`), 'session.create'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}$`), 'session.read'],
  ['PATCH', new RegExp(`^${base}${instance}/sessions/${segment}$`), 'session.update'],
  ['DELETE', new RegExp(`^${base}${instance}/sessions/${segment}$`), 'session.delete'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}/events(?:/wait)?$`), 'session.events'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}/(?:message-receipts|message-results)/${segment}$`), 'session.receipt'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}/app-api-context$`), 'session.context'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/app-api-mutations$`), 'session.mutation'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}/app-api-mutations/${segment}$`), 'session.receipt'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/cancel$`), 'run.cancel'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/messages$`), 'message.submit'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/(?:apply-template|compact|drop-tools|fork|fork-at|queue)$`), 'session.action'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/(?:regenerate|resend-edited)$`), 'session.message_action'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/plans/${segment}/actions$`), 'session.message_action'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/confirmations/${segment}$`), 'session.confirmation'],
  ['GET', new RegExp(`^${base}${instance}/runs/${segment}$`), 'run.read'],
  ['POST', new RegExp(`^${base}${instance}/runs/${segment}/cancel$`), 'run.cancel'],
  ['GET', new RegExp(`^${base}${instance}/runs/${segment}/approvals$`), 'approval.list'],
  ['POST', new RegExp(`^${base}${instance}/runs/${segment}/approvals/${segment}$`), 'approval.resolve'],
  ['POST', new RegExp(`^${base}${instance}/runs/${segment}/approved-actions/${segment}/resolve$`), 'approval.approved_action.resolve'],
  ['POST', new RegExp(`^${base}${instance}/runs/${segment}/privileged-batches/${segment}/categories/${segment}$`), 'approval.privileged.resolve'],
  ['POST', new RegExp(`^${base}${instance}/sessions/${segment}/assets$`), 'file.upload'],
  ['GET', new RegExp(`^${base}${instance}/sessions/${segment}/assets/${segment}$`), 'file.download'],
  // Android's durable attachment pipeline reserves an asset, streams the
  // bytes, then finalizes it before the message references that asset.
  ['POST', new RegExp(`^${base}${instance}/assets/upload-intents$`), 'file.upload'],
  ['GET', new RegExp(`^${base}${instance}/assets/upload-intents$`), 'file.upload'],
  ['POST', new RegExp(`^${base}${instance}/assets/${segment}/upload$`), 'file.upload'],
  ['PUT', new RegExp(`^${base}${instance}/assets/${segment}/upload$`), 'file.upload'],
  ['PATCH', new RegExp(`^${base}${instance}/assets/${segment}/upload$`), 'file.upload'],
  ['POST', new RegExp(`^${base}${instance}/assets/${segment}/finalize$`), 'file.upload'],
  ['GET', new RegExp(`^${base}${instance}/assets/${segment}(?:/download)?$`), 'file.download'],
  ['GET', new RegExp(`^${base}${instance}/harnesses$`), 'harness.list'],
  ['GET', new RegExp(`^${base}${instance}/tools$`), 'harness.tools'],
  ['GET', new RegExp(`^${base}${instance}/models$`), 'harness.models'],
  ['POST', new RegExp(`^${base}${instance}/harnesses/${segment}/install$`), 'harness.install'],
  ['POST', new RegExp(`^${base}${instance}/harnesses/${segment}/upgrade$`), 'harness.upgrade'],
  ['POST', new RegExp(`^${base}${instance}/harnesses/${segment}/uninstall$`), 'harness.uninstall'],
  ['GET', new RegExp(`^${base}${instance}/providers$`), 'provider.list'],
  ['GET', new RegExp(`^${base}${instance}/providers/${segment}/quota$`), 'provider.quota.read'],
  ['GET', new RegExp(`^${base}${instance}/providers/${segment}/rotation$`), 'provider.rotation.read'],
  ['POST', new RegExp(`^${base}${instance}/providers$`), 'provider.create'],
  ['PATCH', new RegExp(`^${base}${instance}/providers/${segment}$`), 'provider.update'],
  ['DELETE', new RegExp(`^${base}${instance}/providers/${segment}$`), 'provider.delete'],
  ['POST', new RegExp(`^${base}${instance}/providers/oauth$`), 'provider.oauth'],
  ['POST', new RegExp(`^${base}${instance}/native-provider-oauth/jobs$`), 'provider.oauth'],
  ['GET', new RegExp(`^${base}${instance}/native-provider-oauth/jobs/${segment}$`), 'provider.oauth'],
  ['DELETE', new RegExp(`^${base}${instance}/native-provider-oauth/jobs/${segment}$`), 'provider.oauth'],
  ['POST', new RegExp(`^${base}${instance}/native-provider-oauth/jobs/${segment}/input$`), 'provider.oauth'],
  ['POST', new RegExp(`^${base}${instance}/providers/${segment}/quota/refresh$`), 'provider.quota.refresh'],
  ['PATCH', new RegExp(`^${base}${instance}/providers/${segment}/rotation$`), 'provider.rotation.update'],
]);

function allowedQuery(operation, params) {
  const rules = {
    'session.list': { view: /^summary$/ },
    'session.read': { view: /^(summary|full)$/ },
    'session.events': { compact: /^1$/, filter: /^(all|visible)$/, limit: /^\d{1,3}$/, afterSeq: /^\d{1,19}$/,
      beforeSeq: /^\d{1,19}$/, direction: /^(forward|before|latest)$/, timeoutMs: /^\d{1,5}$/ },
    'provider.list': { tool: /^[A-Za-z0-9_.-]{1,64}$/ },
    'project.browse': { roots: /^1$/, path: /^[^\u0000-\u001f\u007f]{0,2048}$/, mode: /^directories$/ },
    'harness.models': { tool: /^[A-Za-z0-9_.-]{1,64}$/, provider: /^[A-Za-z0-9_.-]{0,128}$/ },
    'runtime.summary': { afterCursor: /^\d{1,19}$/, limit: /^\d{1,3}$/ },
  }[operation] || {};
  const seen = new Set();
  for (const [key, value] of params) {
    if (seen.has(key) || !rules[key]?.test(value)) return false;
    seen.add(key);
  }
  return true;
}

function decodeSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 256 || /[\\/\u0000-\u001f\u007f?#]/.test(decoded)
      || decoded === '.' || decoded === '..') return null;
    return decoded;
  } catch { return null; }
}

export function temporaryControlCarrierRoute(method, rawUrl) {
  if (typeof method !== 'string' || typeof rawUrl !== 'string'
    || !rawUrl.startsWith(`${base}inst_`) || rawUrl.length > 4096 || rawUrl.includes('#')) return null;
  let url;
  try { url = new URL(rawUrl, TEMPORARY_CONTROL_CARRIER_ORIGIN); }
  catch { return null; }
  if (url.origin !== TEMPORARY_CONTROL_CARRIER_ORIGIN) return null;
  for (const [verb, pattern, operation] of routes) {
    if (method !== verb) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const args = match.slice(1).map(decodeSegment);
    if (args.some((value) => value === null) || !TEMPORARY_CONTROL_OPERATIONS[operation]
      || !allowedQuery(operation, url.searchParams)) return null;
    return Object.freeze({ instanceId: args[0], args: args.slice(1), operation,
      pathname: url.pathname, search: url.search, targetUri: `${TEMPORARY_CONTROL_CARRIER_ORIGIN}${url.pathname}` });
  }
  return null;
}
