// Owner-facing Work Graph interface. Managed session input is never exposed here.
import { readBody } from '../lib/utils.mjs';
import { executeFactoryCommand, getFactoryCommand, getFactoryWorkItem, listFactoryGoals, listFactoryWorkItems } from './factory-control.mjs';
import { listTeamMessages, sendOwnerTeamMessage, respondToTeamMessage } from './organization-team-messages.mjs';
import { compileFactoryWorkflow, instantiateFactoryWorkflow } from './factory-workflow.mjs';
import { decideFactoryManualAcceptance } from './factory-acceptance.mjs';
import { beginOrganizationLifecycle, getOrganizationLifecycleInfo, beginNodeRebind, finishNodeRebind, cancelNodeRebind } from './organization-session-lifecycle.mjs';
import { getNode } from './organization-store.mjs';
import { replaceManagedSession } from './organization-replan.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { registerFactoryReleasePackage, authorizeFactoryRelease, requestFactoryRelease, getFactoryReleaseOperation } from './factory-release.mjs';
import { setPositionProfile, addTeamRelation, getTeamConfiguration } from './organization-team-configuration.mjs';
import { createFactoryTaskHandoff, getFactoryTaskHandoff } from './factory-task-handoff.mjs';
import { syncFactoryShadow, listFactoryShadow, listFactoryShadowAttempts, getFactoryRolloutReadiness } from './factory-shadow.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';

function mutationSourceAllowed(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(text(req.headers?.['content-type']))) return false;
  const site = text(req.headers?.['sec-fetch-site']);
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = text(req.headers?.origin);
  if (!origin) return true; // Authenticated native transports do not send an Origin.
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return false;
    const trustedOrigins = text(process.env.AGENTOC_FACTORY_TRUSTED_ORIGINS).split(',').map(text).filter(Boolean);
    if (trustedOrigins.some(value => {
      try {
        const allowed = new URL(value);
        return !allowed.username && !allowed.password && allowed.origin === value && ['http:', 'https:'].includes(allowed.protocol) && value === origin;
      } catch { return false; }
    })) return true;
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    return parsed.protocol === protocol && parsed.host.toLowerCase() === text(req.headers?.host).toLowerCase();
  }
  catch { return false; }
}

export async function handleFactoryRoutes({ req, res, pathname, authSession, writeJson }) {
  const response = /^\/api\/sessions\/([^/]+)\/organization\/messages\/([^/]+)\/(ack|reply)$/.exec(String(pathname || ''));
  const acceptance = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/manual-acceptance$/.exec(String(pathname || ''));
  const lifecycle = /^\/api\/organizations\/([^/]+)\/factory\/lifecycle(?:\/([^/]+)\/(finalize|cancel))?$/.exec(String(pathname || ''));
  const nodeRebind = /^\/api\/organizations\/([^/]+)\/factory\/nodes\/([^/]+)\/rebind(?:\/([^/]+)\/(cancel))?$/.exec(String(pathname || ''));
  const release = /^\/api\/organizations\/([^/]+)\/factory\/releases\/(packages|authorizations|requests|operations)(?:\/([^/]+))?$/.exec(String(pathname || ''));
  const team = /^\/api\/organizations\/([^/]+)\/factory\/team(?:\/(profiles|relations))?$/.exec(String(pathname || ''));
  const handoffCreate = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/handoffs$/.exec(String(pathname || ''));
  const handoffRead = /^\/api\/organizations\/([^/]+)\/factory\/handoffs\/([^/]+)$/.exec(String(pathname || ''));
  const shadow = /^\/api\/organizations\/([^/]+)\/factory\/(shadow|readiness)(?:\/(sync))?$/.exec(String(pathname || ''));
  const shadowAttempts = /^\/api\/organizations\/([^/]+)\/factory\/shadow\/([^/]+)\/attempts$/.exec(String(pathname || ''));
  const messages = /^\/api\/organizations\/([^/]+)\/factory\/nodes\/([^/]+)\/messages$/.exec(String(pathname || ''));
  const match = /^\/api\/organizations\/([^/]+)\/factory\/(work-items|goals|commands|status|workflow)(?:\/([^/]+))?$/.exec(String(pathname || ''));
  if (!match && !messages && !response && !acceptance && !lifecycle && !nodeRebind && !release && !team && !handoffCreate && !handoffRead && !shadow && !shadowAttempts) return false;
  if (response) {
    if (req.method !== 'POST' || authSession?.principalKind !== 'run_capability' || authSession?.capabilityOperation !== `organization.message.${response[3]}` || decodeURIComponent(response[1]) !== authSession.sessionId) {
      writeJson(res, 403, { error: 'Scoped message capability required' }); return true;
    }
    if (!mutationSourceAllowed(req)) { writeJson(res, 403, { error: 'Request source or content type is not allowed' }); return true; }
    try {
      const raw = await readBody(req, 16 * 1024);
      let body; try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      const result = await respondToTeamMessage({ messageId: decodeURIComponent(response[2]), action: response[3], body: body?.body, idempotencyKey: body?.idempotencyKey }, authSession);
      writeJson(res, 200, result);
    } catch (error) { writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : (error?.statusCode || 400), { error: error?.message || 'Message response failed', ...(error?.code ? { code: error.code } : {}) }); }
    return true;
  }
  if (authSession?.role !== 'owner' || authSession?.principalKind === 'run_capability') {
    writeJson(res, 403, { error: 'Owner access required' }); return true;
  }
  try {
    if (shadowAttempts) {
      if (req.method!=='GET') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const url=new URL(req.url || pathname,'http://localhost');
      const after=url.searchParams.get('after') || '0';
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) { writeJson(res,400,{error:'Invalid attempt cursor'}); return true; }
      writeJson(res,200,await listFactoryShadowAttempts(decodeURIComponent(shadowAttempts[1]),decodeURIComponent(shadowAttempts[2]),{after:Number(after),limit:Number(url.searchParams.get('limit') || 50)},actor)); return true;
    }
    if (shadow) {
      const organizationId=decodeURIComponent(shadow[1]), actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const url=new URL(req.url || pathname,'http://localhost'), options={cursor:text(url.searchParams.get('cursor')),limit:Number(url.searchParams.get('limit') || 50)};
      if (req.method==='GET' && !shadow[3]) { writeJson(res,200,shadow[2]==='readiness' ? await getFactoryRolloutReadiness(organizationId,actor) : await listFactoryShadow(organizationId,options,actor)); return true; }
      if (req.method!=='POST' || shadow[2]!=='shadow' || shadow[3]!=='sync') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,8192); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      writeJson(res,200,await syncFactoryShadow({organizationId,cursor:text(body.cursor),limit:body.limit},actor)); return true;
    }
    if (team || handoffCreate || handoffRead) {
      const selected=team || handoffCreate || handoffRead, organizationId=decodeURIComponent(selected[1]);
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      await listFactoryWorkItems(organizationId,{limit:1},actor);
      if (req.method==='GET' && team && !team[2]) { writeJson(res,200,await getTeamConfiguration(organizationId,actor)); return true; }
      if (req.method==='GET' && handoffRead) { writeJson(res,200,await getFactoryTaskHandoff(organizationId,decodeURIComponent(handoffRead[2]),actor)); return true; }
      if (req.method!=='POST' || handoffRead || (team && !team[2])) { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,32*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      if (!body || typeof body!=='object' || Array.isArray(body)) { writeJson(res,400,{error:'Request must be an object'}); return true; }
      const input={...body,organizationId};
      const result=handoffCreate ? await createFactoryTaskHandoff({...input,workItemId:decodeURIComponent(handoffCreate[2])},actor)
        : team[2]==='profiles' ? await setPositionProfile(input,actor) : await addTeamRelation(input,actor);
      writeJson(res,200,result); return true;
    }
    if (release) {
      const organizationId=decodeURIComponent(release[1]);
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      await listFactoryWorkItems(organizationId,{limit:1},actor);
      if (req.method==='GET' && release[2]==='operations' && release[3]) { writeJson(res,200,await getFactoryReleaseOperation(organizationId,decodeURIComponent(release[3]),actor)); return true; }
      if (req.method!=='POST' || release[3] || release[2]==='operations') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,32*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const input={...body,organizationId};
      const result=release[2]==='packages' ? await registerFactoryReleasePackage(input,actor)
        : release[2]==='authorizations' ? await authorizeFactoryRelease(input,actor) : await requestFactoryRelease(input,actor);
      writeJson(res,200,result); return true;
    }
    if (nodeRebind) {
      const organizationId=decodeURIComponent(nodeRebind[1]), nodeId=decodeURIComponent(nodeRebind[2]);
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      await listFactoryWorkItems(organizationId,{limit:1},actor);
      if (req.method !== 'POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED !== 'true' && !nodeRebind[4]) { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      if (nodeRebind[4]) { writeJson(res,200,await cancelNodeRebind({organizationId,nodeId,commandId:decodeURIComponent(nodeRebind[3])})); return true; }
      const raw=await readBody(req,16*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const commandId=text(body.commandId), expectedGeneration=body.expectedGeneration;
      const op=await beginNodeRebind({organizationId,nodeId,commandId,actorId:actor.principalId,expectedGeneration});
      if (op.state==='completed') { writeJson(res,200,{commandId,state:op.state,result:op.result,replayed:true}); return true; }
      if (op.state!=='pending') { writeJson(res,409,{error:'Node rebind is not pending'}); return true; }
      const node=await getNode(nodeId); const {getSession}=await import('./session-manager.mjs');
      if (node?.bindingGeneration === expectedGeneration+1 && node.currentSessionId) {
        const current=await getSession(node.currentSessionId);
        if (current?.organizationReplacementKey===commandId && current.organizationId===organizationId && current.organizationNodeId===nodeId) {
          writeJson(res,200,await finishNodeRebind({organizationId,nodeId,commandId,result:{sessionId:node.currentSessionId,bindingGeneration:node.bindingGeneration,reconciled:true}})); return true;
        }
        throw Object.assign(new Error('Binding changed; replacement outcome requires reconciliation'),{statusCode:409});
      }
      const previous=node?.currentSessionId ? await getSession(node.currentSessionId) : null;
      if (!node || node.organizationId!==organizationId || !previous?.templateId || !previous?.tool) throw Object.assign(new Error('Existing node runtime is unavailable; replacement remains pending'),{statusCode:409});
      const result=await replaceManagedSession({organizationId,nodeId,expectedBindingGeneration:expectedGeneration,replacementKey:commandId,rebindCommandId:commandId}, {
        createManagedSession: input => createManagedSessionForNode({ ...input, stableKey:node.stableKey, role:node.nodeRole, sessionClass:node.sessionClass,
          agentId:previous.templateId, roleInstanceId:node.roleInstanceId, parentNodeId:node.parentNodeId, parentSessionId:previous.parentSessionId,
          runtime:{tool:previous.tool,model:previous.model,effort:previous.effort,providerProfile:previous.providerProfile} }),
      });
      writeJson(res,200,await finishNodeRebind({organizationId,nodeId,commandId,result:{sessionId:result.sessionId,bindingGeneration:result.node.bindingGeneration}})); return true;
    }
    if (lifecycle) {
      const organizationId = decodeURIComponent(lifecycle[1]);
      const actor = { kind: 'user', role: 'owner', principalId: text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner' };
      await listFactoryWorkItems(organizationId, { limit: 1 }, actor);
      if (req.method === 'GET' && !lifecycle[2]) { writeJson(res, 200, await getOrganizationLifecycleInfo(organizationId)); return true; }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res, 403, { error: 'Request source or content type is not allowed' }); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED !== 'true' && lifecycle[3] !== 'cancel') { writeJson(res, 503, { code: 'FACTORY_CONTROL_DISABLED', error: 'Factory control is disabled' }); return true; }
      const raw = await readBody(req, 16 * 1024); let body;
      try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      if (!lifecycle[2]) {
        writeJson(res, 200, await beginOrganizationLifecycle({ organizationId,commandId:text(body.commandId),kind:text(body.kind),expectedVersion:body.expectedVersion,targetRootSessionId:text(body.targetRootSessionId),actorId:actor.principalId }));
      } else {
        const { finalizeOrganizationLifecycle } = await import('./session-manager.mjs');
        writeJson(res, 200, await finalizeOrganizationLifecycle({ organizationId,commandId:decodeURIComponent(lifecycle[2]),cancel:lifecycle[3] === 'cancel' }));
      }
      return true;
    }
    if (acceptance) {
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED !== 'true') { writeJson(res, 503, { code: 'FACTORY_CONTROL_DISABLED', error: 'Factory control is disabled' }); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res, 403, { code: 'FACTORY_SOURCE_DENIED', error: 'Request source or content type is not allowed' }); return true; }
      const raw = await readBody(req, 32 * 1024);
      let body; try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      const actor = { kind: 'user', role: 'owner', principalId: text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner' };
      const result = await decideFactoryManualAcceptance({ ...body, organizationId: decodeURIComponent(acceptance[1]), workItemId: decodeURIComponent(acceptance[2]) }, actor);
      writeJson(res, 200, result); return true;
    }
    if (messages) {
      const organizationId = decodeURIComponent(messages[1]), nodeId = decodeURIComponent(messages[2]);
      const actor = { kind: 'user', role: 'owner', principalId: text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner' };
      await listFactoryWorkItems(organizationId, { limit: 1 }, actor);
      if (req.method === 'GET') { writeJson(res, 200, { messages: await listTeamMessages(organizationId,nodeId), asOf: new Date().toISOString(), schemaVersion: 1 }); return true; }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED !== 'true') { writeJson(res, 503, { code: 'FACTORY_CONTROL_DISABLED', error: 'Factory control is disabled' }); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res, 403, { code: 'FACTORY_SOURCE_DENIED', error: 'Request source or content type is not allowed' }); return true; }
      const raw = await readBody(req, 16 * 1024);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      const message = await sendOwnerTeamMessage({ ...body, organizationId, recipientNodeId: nodeId }, actor);
      writeJson(res, 200, { message }); return true;
    }
    const organizationId = decodeURIComponent(match[1]);
    const resource = match[2];
    const id = match[3] ? decodeURIComponent(match[3]) : '';
    const actor = { kind: 'user', role: 'owner', principalId: text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner' };
    const url = new URL(req.url || pathname, 'http://localhost');
    const options = { cursor: text(url.searchParams.get('cursor')), limit: Number(url.searchParams.get('limit') || 50) };
    let result;
    if (req.method === 'GET' && resource === 'status' && !id) {
      // The list call checks the same organization scope as all other reads.
      await listFactoryWorkItems(organizationId, { limit: 1 }, actor);
      const { getFactoryRuntimeStatus } = await import('./factory-runtime.mjs');
      const runtimeStatus = getFactoryRuntimeStatus(organizationId);
      result = { schemaVersion: 1, asOf: new Date().toISOString(), controlEnabled: process.env.AGENTOC_FACTORY_CONTROL_ENABLED === 'true', observationEnabled: true, pauseCancelAvailable: true, ...runtimeStatus, executionReadiness: 'not_verified' };
    }
    else if (req.method === 'GET' && resource === 'work-items') result = id ? await getFactoryWorkItem(organizationId, id, actor) : await listFactoryWorkItems(organizationId, options, actor);
    else if (req.method === 'GET' && resource === 'goals' && !id) result = await listFactoryGoals(organizationId, options, actor);
    else if (req.method === 'GET' && resource === 'commands' && id) result = await getFactoryCommand(organizationId, id, actor);
    else if (req.method === 'POST' && ((resource === 'commands' && !id) || (resource === 'workflow' && ['preview', 'instantiate'].includes(id)))) {
      if (!mutationSourceAllowed(req)) { writeJson(res, 403, { code: 'FACTORY_SOURCE_DENIED', error: 'Request source or content type is not allowed' }); return true; }
      const raw = await readBody(req, 64 * 1024);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { writeJson(res, 400, { error: 'Invalid JSON body' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { writeJson(res, 400, { error: 'Command must be an object' }); return true; }
      if (body.organizationId && body.organizationId !== organizationId) { writeJson(res, 400, { error: 'Organization scope mismatch' }); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED !== 'true' && !(resource === 'commands' && ['RequestPause', 'RequestCancel'].includes(body.type)) && !(resource === 'workflow' && id === 'preview')) {
        writeJson(res, 503, { code: 'FACTORY_CONTROL_DISABLED', error: 'Factory control is disabled' }); return true;
      }
      if (resource === 'workflow' && id === 'preview') {
        await listFactoryGoals(organizationId, { limit: 1 }, actor);
        result = { proposal: compileFactoryWorkflow({ ...body, organizationId }) };
      } else if (resource === 'workflow') result = await instantiateFactoryWorkflow({ ...body, organizationId }, actor);
      else result = await executeFactoryCommand({ ...body, organizationId }, actor);
    } else { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : (error?.statusCode || 400), { error: error?.message || 'Factory request failed', ...(error?.code ? { code: error.code } : {}) });
  }
  return true;
}
