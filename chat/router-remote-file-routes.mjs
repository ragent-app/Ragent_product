import { readBody } from '../lib/utils.mjs';
import { resolveResponsibilityActor } from './responsibility-actor.mjs';
import {
  configureRemoteFileGrant,
  revokeRemoteFileGrant,
  sendRemoteFile,
  resumeRemoteManifestTransfer,
  reconcileRemoteFileTransfer,
  queryRemoteFileFromSource,
  receiveRemoteFile,
  queryRemoteFile,
  signRemoteFileReceipt,
} from './remote-file-transfer.mjs';

function jsonSourceAllowed(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers?.['content-type'] || ''))) return false;
  const site = String(req.headers?.['sec-fetch-site'] || '');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return !u.username && !u.password && u.origin === origin
      && u.protocol === (req.socket?.encrypted ? 'https:' : 'http:')
      && u.host.toLowerCase() === String(req.headers?.host || '').toLowerCase();
  } catch {
    return false;
  }
}

function transferDisabled(res, writeJson) {
  if (process.env.RAGENT_REMOTE_FILE_TRANSFER_ENABLED === '1') return false;
  writeJson(res, 503, { code: 'REMOTE_FILE_TRANSFER_DISABLED', error: 'Remote file transfer is disabled' });
  return true;
}

export async function handleRemoteFileRoutes({ req, res, pathname, authSession, writeJson, requireSessionAccess }) {
  const path = String(pathname || '');
  const config = path === '/api/remote-files/grants';
  const revoke = /^\/api\/remote-files\/grants\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
  const ownerTransfer = /^\/api\/remote-files\/grants\/([A-Za-z0-9_-]+)\/transfers\/([A-Za-z0-9_-]+)\/(send|resume|reconcile|source-status)$/.exec(path);
  const target = /^\/api\/remote-files\/grants\/([A-Za-z0-9_-]+)\/transfers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!config && !revoke && !ownerTransfer && !target) return false;

  try {
    if (target) {
      if (authSession?.principalKind !== 'target_runtime_gateway' || authSession.targetRuntime !== true) {
        writeJson(res, 403, { error: 'Verified target-runtime grant required' });
        return true;
      }
      if (req.method === 'GET') {
        writeJson(res, 200, await signRemoteFileReceipt(await queryRemoteFile(target[1], target[2], authSession)));
        return true;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (transferDisabled(res, writeJson)) return true;
      if (!jsonSourceAllowed(req)) { writeJson(res, 403, { error: 'Request source or content type is not allowed' }); return true; }
      const raw = await readBody(req, 6 * 1024 * 1024);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      writeJson(res, 200, await signRemoteFileReceipt(await receiveRemoteFile({ ...body, grantId: target[1], transferId: target[2] }, authSession)));
      return true;
    }

    if (authSession?.role !== 'owner'
        || ['target_runtime_gateway', 'run_capability', 'temporary_device', 'provisional_device'].includes(authSession?.principalKind)) {
      writeJson(res, 403, { error: 'Instance owner required' });
      return true;
    }
    const actor = await resolveResponsibilityActor(req, authSession);
    if (!actor) { writeJson(res, 403, { error: 'Verified instance owner required' }); return true; }

    if (ownerTransfer?.[3] === 'source-status') {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      writeJson(res, 200, await queryRemoteFileFromSource(ownerTransfer[1], ownerTransfer[2], actor));
      return true;
    }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }

    const requiresEnabledGate = config || ['send', 'resume'].includes(ownerTransfer?.[3] || '');
    if (requiresEnabledGate && transferDisabled(res, writeJson)) return true;

    if (!jsonSourceAllowed(req)) { writeJson(res, 403, { error: 'Request source or content type is not allowed' }); return true; }
    const raw = await readBody(req, config ? 65536 : 16384);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }

    if (config) {
      if (typeof body?.sessionId !== 'string' || !body.sessionId.trim()) {
        writeJson(res, 400, { error: 'Session identity is required' });
        return true;
      }
      if (typeof requireSessionAccess !== 'function') {
        writeJson(res, 503, { error: 'Session authorization is unavailable' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, body.sessionId)) return true;
      writeJson(res, 200, await configureRemoteFileGrant(body, actor));
      return true;
    }
    if (revoke) {
      writeJson(res, 200, await revokeRemoteFileGrant(revoke[1], body?.expectedVersion, actor));
      return true;
    }
    if (ownerTransfer?.[3] === 'reconcile') {
      writeJson(res, 200, await reconcileRemoteFileTransfer(ownerTransfer[1], ownerTransfer[2], actor));
      return true;
    }
    if (ownerTransfer?.[3] === 'resume') {
      writeJson(res, 200, await resumeRemoteManifestTransfer(ownerTransfer[1], ownerTransfer[2], actor, body));
      return true;
    }
    writeJson(res, 200, await sendRemoteFile(ownerTransfer[1], ownerTransfer[2], actor));
    return true;
  } catch (error) {
    writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : (error?.statusCode || 400), {
      error: error?.message || 'Remote file transfer failed',
      ...(error?.code ? { code: error.code } : {}),
    });
    return true;
  }
}
