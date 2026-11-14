// Owner-facing Work Graph interface. Managed session input is never exposed here.
import { readBody } from '../lib/utils.mjs';
import { executeFactoryCommand, getFactoryCommand, getFactoryWorkItem, listFactoryGoals, listFactoryWorkItems } from './factory-control.mjs';
import { listTeamMessages, sendOwnerTeamMessage, respondToTeamMessage, escalateOverdueTeamMessage } from './organization-team-messages.mjs';
import { compileFactoryWorkflow, instantiateFactoryWorkflow } from './factory-workflow.mjs';
import { decideFactoryManualAcceptance, decideFactoryCheckAcceptance } from './factory-acceptance.mjs';
import { beginOrganizationLifecycle, getOrganizationLifecycleInfo, beginNodeRebind, finishNodeRebind, cancelNodeRebind } from './organization-session-lifecycle.mjs';
import { getNode, getRoleInstance, getRevision } from './organization-store.mjs';
import { normalizeAppId } from './apps.mjs';
import { replaceManagedSession } from './organization-replan.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { registerFactoryReleasePackage, authorizeFactoryRelease, requestFactoryRelease, getFactoryReleaseOperation, reconcileFactoryGithubRelease, resumeFactoryGithubRelease } from './factory-release.mjs';
import { setPositionProfile, addTeamRelation, retireTeamRelation, getTeamConfiguration } from './organization-team-configuration.mjs';
import { createFactoryTaskHandoff, getFactoryTaskHandoff } from './factory-task-handoff.mjs';
import { setFactoryTaskKnowledge } from './factory-task-knowledge.mjs';
import { syncFactoryShadow, listFactoryShadow, listFactoryShadowAttempts, getFactoryRolloutReadiness } from './factory-shadow.mjs';
import { requestFactoryReconciliation, getFactoryReconciliation, resumeFactoryReconciliation, verifyFactoryAcceptedRun, getFactoryBudgetObservation } from './factory-reconciliation.mjs';
import { resolveResponsibilityActor } from './responsibility-actor.mjs';
import { submitFactoryReviewOpinion, reconcileFactoryReviewOpinion } from './factory-review-opinions.mjs';
import { enqueueFactoryIntegration, materializeFactoryIntegration, attachFactoryCombinationValidation, refreshFactoryIntegrationQueue, getFactoryIntegrationQueue, listFactoryIntegrationQueue } from './factory-integration-queue.mjs';
import { registerFactoryCombinationCheck, reconcileFactoryCombinationCheck, registerFactoryCheck, reconcileFactoryCheck } from './factory-checks.mjs';
import { commitFactoryCombination } from './factory-integration.mjs';
import { previewFactoryGoalRevision, reviseFactoryGoalWithImpact, previewFactoryScopedRevision, reviseFactoryScopeWithImpact } from './factory-goal-revision.mjs';
import { submitFactorySteer, getFactorySteer } from './factory-steering.mjs';
import { reconcileFactoryShadow, listFactoryShadowReconciliation } from './factory-shadow-reconciliation.mjs';
import { previewFactoryRetirement, retireFactoryWorkspace } from './factory-evidence-retention.mjs';

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
  const steer = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/steer$/.exec(String(pathname || ''));
  const steerReceipt = /^\/api\/organizations\/([^/]+)\/factory\/steer-commands\/([^/]+)$/.exec(String(pathname || ''));
  const shadowReconciliation = /^\/api\/organizations\/([^/]+)\/factory\/shadow-reconciliation(?:\/(reconcile))?$/.exec(String(pathname || ''));
  const retirement = /^\/api\/organizations\/([^/]+)\/factory\/retirement\/(preview|execute)$/.exec(String(pathname || ''));
  const response = /^\/api\/sessions\/([^/]+)\/organization\/messages\/([^/]+)\/(ack|reply)$/.exec(String(pathname || ''));
  const reviewOpinion = /^\/api\/sessions\/([^/]+)\/factory\/review-opinion$/.exec(String(pathname || ''));
  const reconcile = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/reconcile$/.exec(String(pathname || ''));
  const budget = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/budget$/.exec(String(pathname || ''));
  const taskKnowledge = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/knowledge$/.exec(String(pathname || ''));
  const reconcileResume = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/reconcile\/resume$/.exec(String(pathname || ''));
  const reconcileVerify = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/reconcile\/verify-accepted$/.exec(String(pathname || ''));
  const goalRevision = /^\/api\/organizations\/([^/]+)\/factory\/goals\/([^/]+)\/revision\/(preview|commit)$/.exec(String(pathname || ''));
  const scopedRevision = /^\/api\/organizations\/([^/]+)\/factory\/goals\/([^/]+)\/scoped-revision\/(preview|commit)$/.exec(String(pathname || ''));
  const itemCheck = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/checks\/(register|accept)$/.exec(String(pathname || ''));
  const checkReconcile = /^\/api\/organizations\/([^/]+)\/factory\/checks\/([^/]+)\/reconcile$/.exec(String(pathname || ''));
  const reviewReconcile = /^\/api\/organizations\/([^/]+)\/factory\/review-opinions\/([^/]+)\/reconcile$/.exec(String(pathname || ''));
  const integrationQueue = /^\/api\/organizations\/([^/]+)\/factory\/integration-queue\/(enqueue|materialize|attach-validation|refresh|register-check|reconcile-check|commit)$/.exec(String(pathname || ''));
  const integrationQueueRead = /^\/api\/organizations\/([^/]+)\/factory\/integration-queue\/([^/]+)$/.exec(String(pathname || ''));
  const integrationQueueList = /^\/api\/organizations\/([^/]+)\/factory\/integration-queue$/.exec(String(pathname || ''));
  const acceptance = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/manual-acceptance$/.exec(String(pathname || ''));
  const lifecycle = /^\/api\/organizations\/([^/]+)\/factory\/lifecycle(?:\/([^/]+)\/(finalize|cancel))?$/.exec(String(pathname || ''));
  const nodeRebind = /^\/api\/organizations\/([^/]+)\/factory\/nodes\/([^/]+)\/rebind(?:\/([^/]+)\/(cancel))?$/.exec(String(pathname || ''));
  const release = /^\/api\/organizations\/([^/]+)\/factory\/releases\/(packages|authorizations|requests|operations)(?:\/([^/]+))?$/.exec(String(pathname || ''));
  const releaseReconcile = /^\/api\/organizations\/([^/]+)\/factory\/releases\/operations\/([^/]+)\/(reconcile|resume)$/.exec(String(pathname || ''));
  const team = /^\/api\/organizations\/([^/]+)\/factory\/team(?:\/(profiles|relations|retire-relation))?$/.exec(String(pathname || ''));
  const handoffCreate = /^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/handoffs$/.exec(String(pathname || ''));
  const handoffRead = /^\/api\/organizations\/([^/]+)\/factory\/handoffs\/([^/]+)$/.exec(String(pathname || ''));
  const shadow = /^\/api\/organizations\/([^/]+)\/factory\/(shadow|readiness)(?:\/(sync))?$/.exec(String(pathname || ''));
  const shadowAttempts = /^\/api\/organizations\/([^/]+)\/factory\/shadow\/([^/]+)\/attempts$/.exec(String(pathname || ''));
  const messages = /^\/api\/organizations\/([^/]+)\/factory\/nodes\/([^/]+)\/messages$/.exec(String(pathname || ''));
  const escalateMessage = /^\/api\/organizations\/([^/]+)\/factory\/nodes\/([^/]+)\/messages\/([^/]+)\/escalate$/.exec(String(pathname || ''));
  const match = /^\/api\/organizations\/([^/]+)\/factory\/(work-items|goals|commands|status|workflow)(?:\/([^/]+))?$/.exec(String(pathname || ''));
  if (!match && !messages && !escalateMessage && !response && !reviewOpinion && !reconcile && !budget && !taskKnowledge && !reconcileResume && !reconcileVerify && !goalRevision && !scopedRevision && !itemCheck && !checkReconcile && !reviewReconcile && !integrationQueue && !integrationQueueRead && !integrationQueueList && !acceptance && !lifecycle && !nodeRebind && !release && !releaseReconcile && !team && !handoffCreate && !handoffRead && !shadow && !shadowAttempts && !steer && !steerReceipt && !shadowReconciliation && !retirement) return false;
  if (reviewOpinion) {
    if (req.method !== 'POST' || authSession?.principalKind !== 'run_capability' || authSession?.capabilityOperation !== 'factory.review.submit' || decodeURIComponent(reviewOpinion[1]) !== authSession.sessionId) { writeJson(res,403,{error:'Scoped review Run capability required'}); return true; }
    if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
    try {
      const raw=await readBody(req,16*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const {candidateWorkItemId,candidateDigest,contractRevision,executionEpoch,verdict,reason,idempotencyKey}=body || {};
      writeJson(res,200,await submitFactoryReviewOpinion({candidateWorkItemId,candidateDigest,contractRevision,executionEpoch,verdict,reason,idempotencyKey},authSession));
    } catch(error) { writeJson(res,error?.code==='BODY_TOO_LARGE'?413:(error?.statusCode || 400),{error:error?.message || 'Review opinion failed',...(error?.code?{code:error.code}:{})}); }
    return true;
  }
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
    if(scopedRevision) {
      if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}
      if(scopedRevision[3]==='commit'&&process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') {writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'});return true;}
      const actor=await resolveResponsibilityActor(req,authSession);if(!actor) {writeJson(res,403,{error:'Verified instance owner required'});return true;}
      const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');}catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
      const input={...body,organizationId:decodeURIComponent(scopedRevision[1]),goalId:decodeURIComponent(scopedRevision[2])};
      writeJson(res,200,await (scopedRevision[3]==='preview'?previewFactoryScopedRevision(input,actor):reviseFactoryScopeWithImpact(input,actor)));return true;
    }
    if (taskKnowledge) {
      if(req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if(process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'}); return true; }
      if(!mutationSourceAllowed(req)) { writeJson(res,403,{code:'FACTORY_SOURCE_DENIED',error:'Request source or content type is not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const raw=await readBody(req,16384); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const {expectedVersion,commandId,idempotencyKey,refs}=body || {};
      writeJson(res,200,await setFactoryTaskKnowledge({organizationId:decodeURIComponent(taskKnowledge[1]),workItemId:decodeURIComponent(taskKnowledge[2]),expectedVersion,commandId,idempotencyKey,refs},actor)); return true;
    }
    if (budget) {
      if (req.method !== 'GET') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      const actor = await resolveResponsibilityActor(req,authSession);
      if (!actor) { writeJson(res,403,{error:'Verified instance owner required'}); return true; }
      writeJson(res,200,await getFactoryBudgetObservation({organizationId:decodeURIComponent(budget[1]),workItemId:decodeURIComponent(budget[2])},actor)); return true;
    }
    if (releaseReconcile) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const input={organizationId:decodeURIComponent(releaseReconcile[1]),operationId:decodeURIComponent(releaseReconcile[2])};
      if (releaseReconcile[3]==='resume') {
        if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'}); return true; }
        const raw=await readBody(req,16384); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
        writeJson(res,200,await resumeFactoryGithubRelease({...input,idempotencyKey:body?.idempotencyKey},actor)); return true;
      }
      writeJson(res,200,await reconcileFactoryGithubRelease(input,actor)); return true;
    }
    if (steer || steerReceipt || shadowReconciliation || retirement) {
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const organizationId=decodeURIComponent((steer || steerReceipt || shadowReconciliation || retirement)[1]);
      if (steerReceipt && req.method==='GET') { writeJson(res,200,await getFactorySteer(organizationId,decodeURIComponent(steerReceipt[2]),actor)); return true; }
      if (shadowReconciliation && !shadowReconciliation[2] && req.method==='GET') { writeJson(res,200,await listFactoryShadowReconciliation(organizationId,{},actor)); return true; }
      if (req.method!=='POST' || steerReceipt || (shadowReconciliation && !shadowReconciliation[2])) { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      if ((steer || (retirement && retirement[2]==='execute')) && process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'}); return true; }
      const raw=await readBody(req,16384); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      if (steer) { const {commandId,expectedVersion,executionEpoch,bindingGeneration,text:message}=body || {}; writeJson(res,200,await submitFactorySteer({organizationId,workItemId:decodeURIComponent(steer[2]),commandId,expectedVersion,executionEpoch,bindingGeneration,text:message},actor)); return true; }
      if (shadowReconciliation) { writeJson(res,200,await reconcileFactoryShadow({organizationId,cursor:body?.cursor,limit:body?.limit},actor)); return true; }
      const input={organizationId,kind:body?.kind,targetId:body?.targetId,idempotencyKey:body?.idempotencyKey,previewDigest:body?.previewDigest};
      writeJson(res,200,await (retirement[2]==='preview'?previewFactoryRetirement(input,actor):retireFactoryWorkspace(input,actor))); return true;
    }
    if (itemCheck || checkReconcile) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      if(checkReconcile) {writeJson(res,200,await reconcileFactoryCheck({organizationId:decodeURIComponent(checkReconcile[1]),checkId:decodeURIComponent(checkReconcile[2])},actor));return true;}
      const raw=await readBody(req,16384); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const input={...body,organizationId:decodeURIComponent(itemCheck[1]),workItemId:decodeURIComponent(itemCheck[2])};
      writeJson(res,200,await (itemCheck[3]==='register'?registerFactoryCheck(input,actor):decideFactoryCheckAcceptance(input,actor))); return true;
    }
    if (goalRevision) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      if (goalRevision[3]==='commit' && process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'}); return true; }
      const raw=await readBody(req,65536); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const input={...body,organizationId:decodeURIComponent(goalRevision[1]),goalId:decodeURIComponent(goalRevision[2])};
      writeJson(res,200,await (goalRevision[3]==='preview'?previewFactoryGoalRevision(input,actor):reviseFactoryGoalWithImpact(input,actor))); return true;
    }
    if (integrationQueueList) {
      if (req.method!=='GET') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'},url=new URL(req.url || pathname,'http://localhost');
      writeJson(res,200,await listFactoryIntegrationQueue(decodeURIComponent(integrationQueueList[1]),{cursor:text(url.searchParams.get('cursor')),limit:Number(url.searchParams.get('limit') || 50)},actor)); return true;
    }
    if (integrationQueueRead && req.method==='GET') {
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      writeJson(res,200,await getFactoryIntegrationQueue({organizationId:decodeURIComponent(integrationQueueRead[1]),id:decodeURIComponent(integrationQueueRead[2])},actor)); return true;
    }
    if (integrationQueue) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const action=integrationQueue[2];
      if (!['refresh','reconcile-check'].includes(action) && process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      const organizationId=decodeURIComponent(integrationQueue[1]),actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const raw=await readBody(req,32*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      if (!body || typeof body!=='object' || Array.isArray(body)) { writeJson(res,400,{error:'Request must be an object'}); return true; }
      let result;
      if (action==='enqueue') result=await enqueueFactoryIntegration({organizationId,candidates:body.candidates,idempotencyKey:body.idempotencyKey},actor);
      else if (action==='materialize') result=await materializeFactoryIntegration({organizationId,id:body.queueId},actor);
      else if (action==='attach-validation') result=await attachFactoryCombinationValidation({organizationId,queueId:body.queueId,validationWorkItemId:body.validationWorkItemId,expectedVersion:body.expectedVersion},actor);
      else if (action==='refresh') result=await refreshFactoryIntegrationQueue({organizationId,id:body.queueId},actor);
      else if (action==='register-check') result=await registerFactoryCombinationCheck({organizationId,queueId:body.queueId,actionId:body.actionId},actor);
      else if (action==='reconcile-check') result=await reconcileFactoryCombinationCheck({organizationId,checkId:body.checkId},actor);
      else result=await commitFactoryCombination({organizationId,queueId:body.queueId,expectedHead:body.expectedHead,operationId:body.operationId},actor);
      writeJson(res,200,result); return true;
    }
    if (integrationQueueRead) { writeJson(res,405,{error:'Method not allowed'}); return true; }
    if (reviewReconcile) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      writeJson(res,200,await reconcileFactoryReviewOpinion({organizationId:decodeURIComponent(reviewReconcile[1]),opinionId:decodeURIComponent(reviewReconcile[2])},actor)); return true;
    }
    if (reconcileVerify) {
      if (req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;}
      if (!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;}
      const raw=await readBody(req,8192); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      writeJson(res,200,await verifyFactoryAcceptedRun({organizationId:decodeURIComponent(reconcileVerify[1]),workItemId:decodeURIComponent(reconcileVerify[2]),expectedVersion:body?.expectedVersion,executionEpoch:body?.executionEpoch,leaseGeneration:body?.leaseGeneration,expectedRunId:body?.expectedRunId},actor));return true;
    }
    if (reconcileResume) {
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,8192); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      writeJson(res,200,await resumeFactoryReconciliation({organizationId:decodeURIComponent(reconcileResume[1]),workItemId:decodeURIComponent(reconcileResume[2]),executionEpoch:body?.executionEpoch,expectedVersion:body?.expectedVersion,commandId:body?.commandId},actor)); return true;
    }
    if (reconcile) {
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      const organizationId=decodeURIComponent(reconcile[1]),workItemId=decodeURIComponent(reconcile[2]);
      if (req.method==='GET') { writeJson(res,200,await getFactoryReconciliation({organizationId,workItemId},actor)); return true; }
      if (req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,8192); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      writeJson(res,200,await requestFactoryReconciliation({organizationId,workItemId,expectedVersion:body?.expectedVersion,executionEpoch:body?.executionEpoch,commandId:body?.commandId},actor)); return true;
    }
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
      if (req.method==='GET' && team && !team[2]) { const value=new URL(req.url || pathname,'http://localhost').searchParams.get('relationVersion'); if(value!==null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) { writeJson(res,400,{error:'Invalid relationship version'}); return true; } writeJson(res,200,await getTeamConfiguration(organizationId,actor,value===null?{}:{atRelationVersion:Number(value)})); return true; }
      if (req.method==='GET' && handoffRead) { writeJson(res,200,await getFactoryTaskHandoff(organizationId,decodeURIComponent(handoffRead[2]),actor)); return true; }
      if (req.method!=='POST' || handoffRead || (team && !team[2])) { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if (process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{error:'Factory control is disabled',code:'FACTORY_CONTROL_DISABLED'}); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res,403,{error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,32*1024); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      if (!body || typeof body!=='object' || Array.isArray(body)) { writeJson(res,400,{error:'Request must be an object'}); return true; }
      const input={...body,organizationId};
      const result=handoffCreate ? await createFactoryTaskHandoff({...input,workItemId:decodeURIComponent(handoffCreate[2])},actor)
        : team[2]==='profiles' ? await setPositionProfile(input,actor) : team[2]==='retire-relation' ? await retireTeamRelation(input,actor) : await addTeamRelation(input,actor);
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
      if (!node || node.organizationId!==organizationId || !previous?.tool) throw Object.assign(new Error('Existing node runtime is unavailable; restore the session or cancel the pending replacement'),{statusCode:409});
      const role = node.roleInstanceId ? await getRoleInstance(node.roleInstanceId) : null;
      const revision = await getRevision(organizationId,node.createdRevision);
      const candidates = Array.isArray(revision?.compiled?.nodes) ? revision.compiled.nodes.filter(entry=>entry.stableKey===node.stableKey) : [];
      // Provisioning pins resolver.selectedAgentId; replan add historically
      // pins agentId first. The bound RoleInstance selects the persisted fact.
      const frozenAgents = [text(candidates[0]?.resolver?.selectedAgentId),text(candidates[0]?.agentId)].filter(Boolean);
      const frozenAgent = text(role?.agentId);
      if (revision?.state!=='frozen' || candidates.length!==1 || !frozenAgent || !frozenAgents.includes(frozenAgent) || !role || role.organizationId!==organizationId || role.organizationNodeId!==nodeId || role.organizationRevision!==node.createdRevision || role.stableKey!==node.stableKey || role.role!==node.nodeRole || previous.sessionPlane!=='organization' || previous.organizationId!==organizationId || previous.organizationNodeId!==nodeId || previous.roleInstanceId!==role.id || previous.organizationRevision!==node.createdRevision || (previous.templateId && normalizeAppId(previous.templateId)!==normalizeAppId(frozenAgent))) throw Object.assign(new Error('Managed Agent identity is inconsistent or unavailable; restore the session and frozen role facts or cancel the pending replacement'),{statusCode:409});
      const result=await replaceManagedSession({organizationId,nodeId,expectedBindingGeneration:expectedGeneration,replacementKey:commandId,rebindCommandId:commandId}, {
        createManagedSession: input => createManagedSessionForNode({ ...input, stableKey:node.stableKey, role:node.nodeRole, sessionClass:node.sessionClass,
          agentId:frozenAgent, roleInstanceId:node.roleInstanceId, parentNodeId:node.parentNodeId, parentSessionId:previous.parentSessionId,
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
    if (escalateMessage) {
      const organizationId=decodeURIComponent(escalateMessage[1]), nodeId=decodeURIComponent(escalateMessage[2]);
      const actor={kind:'user',role:'owner',principalId:text(authSession.principalId || authSession.deviceId || authSession.id) || 'local-owner'};
      await listFactoryWorkItems(organizationId,{limit:1},actor);
      if(req.method!=='POST') { writeJson(res,405,{error:'Method not allowed'}); return true; }
      if(process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true') { writeJson(res,503,{code:'FACTORY_CONTROL_DISABLED',error:'Factory control is disabled'}); return true; }
      if(!mutationSourceAllowed(req)) { writeJson(res,403,{code:'FACTORY_SOURCE_DENIED',error:'Request source or content type is not allowed'}); return true; }
      const raw=await readBody(req,16384); let body; try { body=JSON.parse(raw || '{}'); } catch { writeJson(res,400,{error:'Invalid JSON body'}); return true; }
      writeJson(res,200,await escalateOverdueTeamMessage({organizationId,recipientNodeId:nodeId,messageId:decodeURIComponent(escalateMessage[3]),idempotencyKey:body?.idempotencyKey},actor)); return true;
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
