import { readBody } from '../lib/utils.mjs';
import { resolveResponsibilityActor } from './responsibility-actor.mjs';
import {
  configureRemoteFactoryBinding,
  acceptRemoteFactoryOperation,
  getRemoteFactoryOperation,
  requestRemoteFactoryCancellation,
  signRemoteFactoryReceipt,
  signRemoteFactoryCandidate,
} from './remote-factory-operations.mjs';
import {
  configureRemoteFactorySourceBinding,
  getRemoteFactorySourceOperation,
  reconcileRemoteFactoryOperation,
  rerouteNotDispatchedOperation,
  requestRemoteFactoryCancellationFromSource,
} from './remote-factory-source.mjs';
import {
  recordDeviceHeartbeat,
  listDeviceCapabilities,
  configureDevicePeerAuthorization,
  selectAuthorizedDeviceForTask,
} from './device-capability-registry.mjs';
import { admitRemoteFactoryAttempt, getRemoteFactoryChild, getRemoteFactoryCandidate } from './factory-remote-admission.mjs';
import { getRemoteFactoryEvidence } from './factory-remote-evidence.mjs';

function jsonSourceAllowed(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers?.['content-type'] || ''))) return false;
  const site = String(req.headers?.['sec-fetch-site'] || '');
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = String(req.headers?.origin || '');
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return !url.username && !url.password && url.origin === origin
      && url.protocol === (req.socket?.encrypted ? 'https:' : 'http:')
      && url.host.toLowerCase() === String(req.headers?.host || '').toLowerCase();
  } catch {
    return false;
  }
}

async function requireOwnerActor(req, authSession, res, writeJson) {
  if (authSession?.role !== 'owner'
      || ['target_runtime_gateway', 'run_capability', 'temporary_device', 'provisional_device'].includes(authSession?.principalKind)) {
    writeJson(res, 403, { error: 'Instance owner required' });
    return null;
  }
  const actor = await resolveResponsibilityActor(req, authSession);
  if (!actor) {
    writeJson(res, 403, { error: 'Verified instance owner required' });
    return null;
  }
  return actor;
}

async function readJsonPayload(req, res, writeJson, maxBytes = 65536) {
  if (!jsonSourceAllowed(req)) {
    writeJson(res, 403, { error: 'Request source or content type is not allowed' });
    return null;
  }
  const raw = await readBody(req, maxBytes);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
}

function remoteAdmissionDisabled(res, writeJson) {
  if (process.env.RAGENT_REMOTE_FACTORY_ENABLED === '1') return false;
  writeJson(res, 503, { code: 'REMOTE_FACTORY_DISABLED', error: 'Remote Factory admission is disabled' });
  return true;
}

export async function handleRemoteFactoryRoutes({ req, res, pathname, authSession, writeJson }) {
  const path = String(pathname || '');
  const config = path === '/api/remote-factory/bindings';
  const sourceConfig = path === '/api/remote-factory/source-bindings';
  const devices = path === '/api/remote-factory/devices';
  const deviceHeartbeat = path === '/api/remote-factory/devices/heartbeat';
  const deviceAuth = path === '/api/remote-factory/devices/authorizations';
  const deviceSelect = path === '/api/remote-factory/devices/select';
  const evidence = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/remote-evidence$/.exec(path);
  const sourceOp = /^\/api\/remote-factory\/source-bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)(?:\/(reconcile|cancel|reroute))?$/.exec(path);
  const knowledge = /^\/api\/remote-factory\/source-bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/knowledge\/(n_[A-Za-z0-9_-]{30,100})$/.exec(path);
  const operation = /^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
  const candidate = /^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/candidate$/.exec(path);
  const cancel = /^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/cancel$/.exec(path);

  if (!config && !sourceConfig && !devices && !deviceHeartbeat && !deviceAuth && !deviceSelect
      && !evidence && !sourceOp && !knowledge && !operation && !candidate && !cancel) {
    return false;
  }

  try {
    if (evidence) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      writeJson(res, 200, await getRemoteFactoryEvidence({
        organizationId: decodeURIComponent(evidence[1]),
        workItemId: decodeURIComponent(evidence[2]),
      }, actor));
      return true;
    }

    if (devices) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      const url = new URL(req.url || path, 'http://localhost');
      const list = await listDeviceCapabilities({
        platform: url.searchParams.get('platform') || '',
        status: url.searchParams.get('status') || '',
        includeStale: url.searchParams.get('includeStale') !== 'false',
      });
      writeJson(res, 200, { schemaVersion: 1, devices: list });
      return true;
    }

    if (deviceHeartbeat) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      let principal = null;
      if (authSession?.principalKind === 'target_runtime_gateway' && authSession.targetRuntime === true) {
        principal = authSession;
      } else {
        principal = await requireOwnerActor(req, authSession, res, writeJson);
        if (!principal) return true;
      }
      const body = await readJsonPayload(req, res, writeJson, 65536);
      if (!body) return true;
      writeJson(res, 200, { device: await recordDeviceHeartbeat(body, principal) });
      return true;
    }

    if (deviceSelect) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      const body = await readJsonPayload(req, res, writeJson, 32768);
      if (!body) return true;
      writeJson(res, 200, await selectAuthorizedDeviceForTask(body.taskRequirements || body, {
        ownerPolicy: body.ownerPolicy,
        preferredInstanceId: body.preferredInstanceId,
      }));
      return true;
    }

    if (deviceAuth) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      if (remoteAdmissionDisabled(res, writeJson)) return true;
      const body = await readJsonPayload(req, res, writeJson, 65536);
      if (!body) return true;
      writeJson(res, 200, { policy: await configureDevicePeerAuthorization(body, actor) });
      return true;
    }

    if (sourceOp) {
      const bindingId = sourceOp[1];
      const operationId = sourceOp[2];
      const action = sourceOp[3] || '';
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      if (!action) {
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
        writeJson(res, 200, await getRemoteFactorySourceOperation(bindingId, operationId, actor));
        return true;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (action === 'reroute' && remoteAdmissionDisabled(res, writeJson)) return true;
      const body = await readJsonPayload(req, res, writeJson, 32768);
      if (!body) return true;
      if (action === 'reconcile') {
        writeJson(res, 200, await reconcileRemoteFactoryOperation(bindingId, operationId, actor, body));
        return true;
      }
      if (action === 'cancel') {
        writeJson(res, 200, await requestRemoteFactoryCancellationFromSource(bindingId, operationId, actor, body));
        return true;
      }
      writeJson(res, 200, await rerouteNotDispatchedOperation({
        bindingId,
        operationId,
        newBindingId: body.newBindingId,
        newOperationId: body.newOperationId,
        taskRequirements: body.taskRequirements,
        ownerPolicy: body.ownerPolicy,
        reason: body.reason,
      }, actor));
      return true;
    }

    if (config || sourceConfig) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const actor = await requireOwnerActor(req, authSession, res, writeJson);
      if (!actor) return true;
      if (remoteAdmissionDisabled(res, writeJson)) return true;
      const body = await readJsonPayload(req, res, writeJson, 65536);
      if (!body) return true;
      writeJson(res, 200, await (sourceConfig ? configureRemoteFactorySourceBinding(body, actor) : configureRemoteFactoryBinding(body, actor)));
      return true;
    }

    if (authSession?.principalKind !== 'target_runtime_gateway' || authSession.targetRuntime !== true) {
      writeJson(res, 403, { error: 'Verified target-runtime grant required' });
      return true;
    }
    if (knowledge) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const { readLiveRemoteKnowledge } = await import('./factory-remote-knowledge.mjs');
      res.setHeader('Cache-Control', 'no-store');
      writeJson(res, 200, await readLiveRemoteKnowledge({
        sourceBindingId: knowledge[1],
        operationId: knowledge[2],
        nonce: knowledge[3],
      }, authSession));
      return true;
    }
    if (cancel) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const body = await readJsonPayload(req, res, writeJson, 16384);
      if (!body) return true;
      const { cancelRemoteFactoryChild } = await import('./factory-remote-admission.mjs');
      if (typeof cancelRemoteFactoryChild !== 'function') {
        writeJson(res, 503, { code: 'REMOTE_CANCEL_UNAVAILABLE', error: 'Remote cancellation is unavailable' });
        return true;
      }
      const receipt = await requestRemoteFactoryCancellation({ ...body, bindingId: cancel[1], operationId: cancel[2] }, authSession, { cancel: cancelRemoteFactoryChild });
      writeJson(res, 200, await signRemoteFactoryReceipt(receipt));
      return true;
    }
    if (candidate) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      await getRemoteFactoryOperation(candidate[1], candidate[2], authSession, { candidate: true });
      const envelope = await getRemoteFactoryCandidate(candidate[1], candidate[2]);
      writeJson(res, 200, await signRemoteFactoryCandidate(envelope));
      return true;
    }

    const bindingId = operation[1];
    const operationId = operation[2];
    if (req.method === 'GET') {
      writeJson(res, 200, await signRemoteFactoryReceipt(await getRemoteFactoryOperation(bindingId, operationId, authSession, { queryChild: getRemoteFactoryChild })));
      return true;
    }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    if (remoteAdmissionDisabled(res, writeJson)) return true;
    const body = await readJsonPayload(req, res, writeJson, 65536);
    if (!body) return true;
    writeJson(res, 200, await signRemoteFactoryReceipt(await acceptRemoteFactoryOperation({ ...body, bindingId, operationId }, authSession, { admit: admitRemoteFactoryAttempt })));
    return true;
  } catch (error) {
    writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : (error?.statusCode || 400), {
      error: error?.message || 'Remote Factory request failed',
      ...(error?.code ? { code: error.code } : {}),
    });
    return true;
  }
}
