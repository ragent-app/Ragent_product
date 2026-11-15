// Logical HTTPS resource origin carried inside the encrypted PC P2P channel.
// It is never resolved by DNS or accepted as an internet-facing Owner route.
export const TEMPORARY_CARRIER_ORIGIN = 'https://temporary.ragent.invalid';
const base = '/api/temporary/v1/instances/';
const id = '[^/]{1,512}';
const routes = Object.freeze([
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/runtimes$`), 'runtime.list'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions$`), 'session.create'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})$`), 'session.read'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/messages/prepare$`), 'message.prepare'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/messages/preparations/(${id})$`), 'message.preparation'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/messages/(${id})/commit$`), 'message.commit'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/messages/(${id})/receipt$`), 'message.receipt'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets$`), 'upload.create'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/receipts/(${id})$`), 'upload.receipt'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/(${id})/upload$`), 'upload.write'],
  ['PATCH', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/(${id})/upload$`), 'upload.chunk'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/(${id})/upload-checkpoint$`), 'upload.checkpoint'],
  ['DELETE', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/(${id})/upload-checkpoint$`), 'upload.cancel'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/assets/(${id})/finalize$`), 'upload.finalize'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/runs/(${id})$`), 'run.read'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/runs/(${id})/result$`), 'result.read'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/runs/(${id})/exports$`), 'result.export'],
  ['GET', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/runs/(${id})/exports/(${id})$`), 'result.chunk'],
  ['POST', new RegExp(`^${base}(inst_[A-Za-z0-9_-]{24,64})/sessions/(${id})/runs/(${id})/cancel$`), 'run.cancel'],
]);

function segment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 256 || /[\\/\u0000-\u001f\u007f?#]/.test(decoded)
      || decoded === '.' || decoded === '..') return null;
    return decoded;
  } catch { return null; }
}

export function temporaryCarrierRoute(method, rawUrl) {
  if (typeof method !== 'string' || typeof rawUrl !== 'string' || !rawUrl.startsWith(`${base}inst_`)
    || rawUrl.length > 2_048 || rawUrl.includes('#')) return null;
  let url;
  try { url = new URL(rawUrl, TEMPORARY_CARRIER_ORIGIN); }
  catch { return null; }
  if (url.origin !== TEMPORARY_CARRIER_ORIGIN) return null;
  for (const [verb, regex, action] of routes) {
    if (method !== verb) continue;
    const match = regex.exec(url.pathname);
    if (!match) continue;
    const args = match.slice(1).map(segment);
    if (args.some(v => v === null)) return null;
    return Object.freeze({ action, instanceId: args[0], args: args.slice(1), pathname: url.pathname,
      targetUri: `${TEMPORARY_CARRIER_ORIGIN}${url.pathname}`, query: url.searchParams });
  }
  return null;
}
