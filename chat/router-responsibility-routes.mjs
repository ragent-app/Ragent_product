import { readBody } from '../lib/utils.mjs';
import { read } from './responsibility-store.mjs';
import { createResponsibility, listResponsibilities, getResponsibility, updateResponsibility, setResponsibilityLifecycle, listResponsibilityActivity, listResponsibilityWorkLinks } from './responsibility-service.mjs';
import { wakeResponsibility } from './responsibility-events.mjs';
import { assembleResponsibilityContext } from './responsibility-context.mjs';
import { getRun } from './runs.mjs';
import { getSession } from './session-manager.mjs';
import { sanitizeEmailCompletionTargets, recordEmailDeliveryReview } from '../lib/agent-mail-completion-targets.mjs';
import { observeGithubFailure } from './github-ci-observer.mjs';
import { proposeResponsibilityIntent } from './responsibility-intent.mjs';
import { resolveResponsibilityActor } from './responsibility-actor.mjs';
import { getResponsibilitySessionContext, setResponsibilitySessionContext } from './responsibility-session-context.mjs';
import {
  previewResponsibilityMemory,
  reviseResponsibilityMemory,
  listResponsibilityMemoryConflicts,
  previewResponsibilityMemoryConflict,
  commitResponsibilityMemoryConflict,
  listOwnerUserMemory,
  getOwnerUserMemoryFact,
  createOwnerUserMemoryFact,
  previewUserMemoryRevision,
  commitUserMemoryRevision,
  listOwnerEpisodicMemory,
  listResponsibilityMemoryAudit,
} from './responsibility-memory.mjs';
import { getResponsibilityCapabilities } from './responsibility-capabilities.mjs';
import { captureResponsibilityCodeBaseline } from './responsibility-code-baseline.mjs';
import { listResponsibilityPlans, approveResponsibilityPlan } from './responsibility-plans.mjs';
import { registerResponsibilityNotificationSubscription, revokeResponsibilityNotificationSubscription, getResponsibilityNotificationSettings, setResponsibilityNotificationSettings } from './responsibility-notifications.mjs';
import { createResponsibilityTrigger, listResponsibilityTriggers, changeResponsibilityTrigger } from './responsibility-trigger-bridge.mjs';
import { recordExternalResourceWatermark, listExternalResourceWatermarks } from './responsibility-git-observation.mjs';
import { listProducerTriggerEvents } from './responsibility-trigger-events.mjs';
import { getFactoryGoalRevisionArtifacts } from './factory-goal-revision.mjs';

async function loadResponsibilityStage2Summary(responsibility, actor) {
  const [watermarks, links] = await Promise.all([
    listExternalResourceWatermarks(responsibility.id),
    listResponsibilityWorkLinks(responsibility.id, actor).catch(() => ({ links: [] })),
  ]);
  const dbSummary = await read(db => {
    const org = db.prepare('SELECT root_session_id FROM organizations WHERE id=?').get(responsibility.organizationId);
    const rootSessionId = org?.root_session_id || '';
    const latestObs = db.prepare('SELECT * FROM responsibility_change_observations WHERE responsibility_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(responsibility.id);
    const skipCount = db.prepare("SELECT COUNT(*) AS n FROM responsibility_change_observations WHERE responsibility_id=? AND outcome='no_change_skipped'").get(responsibility.id).n;
    const producerCount = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(sequence),0) AS max_seq FROM responsibility_producer_events WHERE organization_id=? OR session_id=?').get(responsibility.organizationId, rootSessionId);
    const retention = db.prepare('SELECT min_available_sequence,max_pruned_occurred_at,pruned_count,last_pruned_at FROM responsibility_producer_event_retention WHERE id=1').get();
    return {
      rootSessionId,
      latestObservation: latestObs ? {
        wakeId: latestObs.wake_id,
        outcome: latestObs.outcome,
        baselineWakeId: latestObs.baseline_wake_id || null,
        fingerprintDigest: latestObs.fingerprint_digest,
        gitDigest: latestObs.git_digest || null,
        workspaceDigest: latestObs.workspace_digest || null,
        externalDigest: latestObs.external_digest || null,
        details: JSON.parse(latestObs.details_json || '{}'),
        createdAt: latestObs.created_at,
      } : null,
      noChangeSkipCount: Number(skipCount || 0),
      producerEvents: {
        totalCount: Number(producerCount?.n || 0),
        latestSequence: Number(producerCount?.max_seq || 0),
        retention: retention ? {
          minAvailableSequence: Number(retention.min_available_sequence || 0),
          maxPrunedOccurredAt: retention.max_pruned_occurred_at || null,
          prunedCount: Number(retention.pruned_count || 0),
          lastPrunedAt: retention.last_pruned_at || null,
        } : { minAvailableSequence: 0, maxPrunedOccurredAt: null, prunedCount: 0, lastPrunedAt: null },
      },
    };
  });
  const goalIds = [...new Set((links.links || []).map(l => l.goalId).filter(Boolean))];
  const goals = [];
  for (const goalId of goalIds) {
    try {
      const info = await getFactoryGoalRevisionArtifacts({ organizationId: responsibility.organizationId, goalId }, actor);
      goals.push({
        goalId: info.goal.id,
        goalRevision: info.goal.revision,
        invalidatedCount: info.invalidatedItems.length,
        reusableArtifactCount: info.reusableArtifacts.length,
        reusableWorkItemIds: info.reusableArtifacts.map(a => a.workItemId),
      });
    } catch {}
  }
  return {
    changeObservation: {
      latest: dbSummary.latestObservation,
      noChangeSkipCount: dbSummary.noChangeSkipCount,
      externalWatermarkCount: watermarks.length,
      externalWatermarks: watermarks,
    },
    producerEvents: dbSummary.producerEvents,
    goalRevisionSummary: {
      goals,
      totalInvalidatedItems: goals.reduce((n, g) => n + g.invalidatedCount, 0),
      totalReusableArtifacts: goals.reduce((n, g) => n + g.reusableArtifactCount, 0),
    },
    rootSessionId: dbSummary.rootSessionId,
  };
}

function mutationSourceAllowed(req) {
  if(!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers?.['content-type']||''))) return false;
  const site=String(req.headers?.['sec-fetch-site']||''); if(site && !['same-origin','none'].includes(site)) return false;
  const origin=String(req.headers?.origin||''); if(!origin) return true;
  try { const url=new URL(origin); return !url.username && !url.password && url.origin===origin && url.protocol===(req.socket?.encrypted?'https:':'http:') && url.host.toLowerCase()===String(req.headers?.host||'').toLowerCase(); } catch { return false; }
}
async function readJsonBodyOrRespond(req, res, writeJson, maxBytes = 65536) {
  const raw = await readBody(req, maxBytes);
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(res, 400, { error: 'Body must be a JSON object' });
      return null;
    }
    return parsed;
  } catch {
    writeJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
}

export async function handleResponsibilityRoutes({req,res,pathname,authSession,writeJson,requireSessionAccess}) {
  const match=/^\/api\/responsibilities(?:\/([^/]+)(?:\/(pause|resume|complete|cancel|archive|wake|activity|context|memory|notifications|github-event|code-baseline|observations|external-watermarks|producer-events|goal-revisions))?)?$/.exec(String(pathname||''));
  const memoryRevision=/^\/api\/responsibilities\/([^/]+)\/memory\/facts\/([^/]+)\/(preview|correct|retract|supersede|valid-until)$/.exec(String(pathname||''));
  const memoryConflicts=/^\/api\/responsibilities\/([^/]+)\/memory\/conflicts(?:\/(preview|commit))?$/.exec(String(pathname||''));
  const ownerUserMemory=/^\/api\/responsibilities\/user-memory(?:\/([^/]+)(?:\/(preview|revise|correct|retract|supersede|valid-until))?)?$/.exec(String(pathname||''));
  const ownerEpisodicMemory=/^\/api\/responsibilities\/episodic-memory$/.exec(String(pathname||''));
  const scopedUserMemory=/^\/api\/responsibilities\/([^/]+)\/memory\/user(?:\/([^/]+)(?:\/(preview|revise|correct|retract|supersede|valid-until))?)?$/.exec(String(pathname||''));
  const scopedEpisodicMemory=/^\/api\/responsibilities\/([^/]+)\/memory\/(episodes|episodic)$/.exec(String(pathname||''));
  const scopedMemoryAudit=/^\/api\/responsibilities\/([^/]+)\/memory\/audit$/.exec(String(pathname||''));
  const review=/^\/api\/runs\/([^/]+)\/email-targets\/([^/]+)\/manual-review$/.exec(String(pathname||''));
  const sessionContext=/^\/api\/sessions\/([^/]+)\/responsibility-context$/.exec(String(pathname||''));
  const plans=/^\/api\/responsibilities\/([^/]+)\/plans(?:\/([^/]+)\/(approve))?$/.exec(String(pathname||''));
  const triggerBinding=/^\/api\/responsibilities\/([^/]+)\/trigger-bindings(?:\/([^/]+)\/(revoke|recover))?$/.exec(String(pathname||''));
  const notificationBinding=/^\/api\/responsibilities\/notification-subscriptions(?:\/([a-f0-9]{64})\/(revoke))?$/.exec(String(pathname||'')); if(!match&&!review&&!sessionContext&&!memoryRevision&&!memoryConflicts&&!ownerUserMemory&&!ownerEpisodicMemory&&!scopedUserMemory&&!scopedEpisodicMemory&&!scopedMemoryAudit&&!plans&&!notificationBinding&&!triggerBinding) return false;
  if(authSession?.role!=='owner'||['run_capability','target_runtime_gateway','temporary_device','provisional_device'].includes(authSession?.principalKind)) {writeJson(res,403,{error:'Owner access required'});return true;}
  const actor=await resolveResponsibilityActor(req,authSession);
  if(!actor) {writeJson(res,403,{code:'RESPONSIBILITY_OWNER_UNAVAILABLE',error:'Verified instance owner identity is unavailable'});return true;}
  try {
    if(ownerUserMemory || scopedUserMemory) {
      const responsibilityId = scopedUserMemory ? decodeURIComponent(scopedUserMemory[1]) : '';
      const factId = decodeURIComponent((scopedUserMemory ? scopedUserMemory[2] : ownerUserMemory[1]) || '');
      const action = (scopedUserMemory ? scopedUserMemory[3] : ownerUserMemory[2]) || '';
      const reqUrl = new URL(req.url || pathname, 'http://localhost');
      if (!action && req.method === 'GET') {
        if (factId) {
          if (responsibilityId) await getResponsibility(responsibilityId, actor);
          writeJson(res, 200, await getOwnerUserMemoryFact(factId, actor, { includeHistory: reqUrl.searchParams.get('includeHistory') !== '0' }));
          return true;
        }
        writeJson(res, 200, await listOwnerUserMemory({
          responsibilityId,
          projectId: reqUrl.searchParams.get('projectId') || '',
          scopeType: reqUrl.searchParams.get('scopeType') || '',
          exactScopeOnly: reqUrl.searchParams.get('exactScopeOnly') === '1',
          category: reqUrl.searchParams.get('category') || '',
          sourceType: reqUrl.searchParams.get('sourceType') || '',
          status: reqUrl.searchParams.get('status') || '',
          includeInactive: reqUrl.searchParams.get('includeInactive') === '1',
          includeExpired: reqUrl.searchParams.get('includeExpired') === '1',
          includeUntrusted: reqUrl.searchParams.get('includeUntrusted') !== '0',
          keywords: reqUrl.searchParams.get('keywords') || '',
          limit: Number(reqUrl.searchParams.get('limit') || 100),
        }, actor));
        return true;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (!mutationSourceAllowed(req)) { writeJson(res, 403, { error: 'Owner JSON request required' }); return true; }
      if (action !== 'preview' && process.env.RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED !== '1') {
        writeJson(res, 503, { code: 'MEMORY_REVISION_DISABLED', error: 'Memory revision is disabled' });
        return true;
      }
      const body = await readJsonBodyOrRespond(req, res, writeJson, 65536);
      if (!body) return true;
      if (!factId && !action) {
        writeJson(res, 200, await createOwnerUserMemoryFact({ ...body, ...(responsibilityId ? { responsibilityId } : {}) }, actor));
        return true;
      }
      if (!factId || !action) { writeJson(res, 400, { error: 'Fact ID and action are required' }); return true; }
      if (action === 'preview') {
        writeJson(res, 200, await previewUserMemoryRevision(factId, body, actor, { responsibilityId }));
        return true;
      }
      writeJson(res, 200, await commitUserMemoryRevision(factId, action, body, actor, { responsibilityId }));
      return true;
    }
    if (ownerEpisodicMemory || scopedEpisodicMemory) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const reqUrl = new URL(req.url || pathname, 'http://localhost');
      const responsibilityId = scopedEpisodicMemory ? decodeURIComponent(scopedEpisodicMemory[1]) : (reqUrl.searchParams.get('responsibilityId') || '');
      writeJson(res, 200, await listOwnerEpisodicMemory({
        responsibilityId,
        projectId: reqUrl.searchParams.get('projectId') || '',
        outcome: reqUrl.searchParams.get('outcome') || '',
        sourceType: reqUrl.searchParams.get('sourceType') || '',
        includeExpired: reqUrl.searchParams.get('includeExpired') === '1',
        includeRetracted: reqUrl.searchParams.get('includeRetracted') === '1',
        includeUntrusted: reqUrl.searchParams.get('includeUntrusted') === '1',
        keywords: reqUrl.searchParams.get('keywords') || '',
        limit: Number(reqUrl.searchParams.get('limit') || 50),
      }, actor));
      return true;
    }
    if (scopedMemoryAudit) {
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const id = decodeURIComponent(scopedMemoryAudit[1]);
      const reqUrl = new URL(req.url || pathname, 'http://localhost');
      writeJson(res, 200, await listResponsibilityMemoryAudit(id, actor, { limit: Number(reqUrl.searchParams.get('limit') || 50) }));
      return true;
    }
    if(memoryConflicts) {const id=decodeURIComponent(memoryConflicts[1]),action=memoryConflicts[2];if(!action&&req.method==='GET') {writeJson(res,200,await listResponsibilityMemoryConflicts(id,actor));return true;}if(!action||req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}if(action==='commit'&&process.env.RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED!=='1') {writeJson(res,503,{code:'MEMORY_REVISION_DISABLED',error:'Memory revision is disabled'});return true;}const raw=await readBody(req,65536);let body;try {body=JSON.parse(raw||'{}');}catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}writeJson(res,200,await (action==='preview'?previewResponsibilityMemoryConflict(id,body,actor):commitResponsibilityMemoryConflict(id,body,actor)));return true;}
    if(triggerBinding) {const id=decodeURIComponent(triggerBinding[1]);if(req.method==='GET'&&!triggerBinding[2]) {writeJson(res,200,await listResponsibilityTriggers(id,actor));return true;}if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');}catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}const result=triggerBinding[2]?await changeResponsibilityTrigger(id,decodeURIComponent(triggerBinding[2]),triggerBinding[3],body,actor):await createResponsibilityTrigger(id,body,actor);writeJson(res,200,result);return true;}
    const bearer=req?._bearerAuthSession;
    const registrationSupported=authSession?.principalKind==='trusted_device'&&bearer?.principalKind==='trusted_device'&&authSession.role==='owner'&&bearer.role==='owner'&&!authSession.workspaceAccess&&!!authSession.deviceId&&authSession.deviceId===bearer.deviceId&&!!authSession.accountId&&authSession.accountId===bearer.accountId&&!!authSession.bindingAuthorityRevision&&authSession.bindingAuthorityRevision===bearer.bindingAuthorityRevision;
    if(notificationBinding) {if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}if(notificationBinding[2]==='revoke') {writeJson(res,200,await revokeResponsibilityNotificationSubscription({...body,subscriptionId:notificationBinding[1]},actor));return true;}if(!registrationSupported) {writeJson(res,403,{code:'RESPONSIBILITY_DEVICE_BINDING_REQUIRED',error:'A verified paired owner device is required'});return true;}writeJson(res,200,await registerResponsibilityNotificationSubscription(body,actor,authSession));return true;}
    if(plans) {const id=decodeURIComponent(plans[1]);if(!plans[2]&&req.method==='GET') {writeJson(res,200,await listResponsibilityPlans(id,actor));return true;}if(plans[2]&&req.method==='POST'&&mutationSourceAllowed(req)) {const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');}catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}writeJson(res,200,await approveResponsibilityPlan(id,decodeURIComponent(plans[2]),body,actor));return true;}writeJson(res,405,{error:'Method or request source is not allowed'});return true;}
    if(match?.[1]==='capabilities'&&!match[2]) {if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;}const url=new URL(req.url||pathname,'http://localhost');writeJson(res,200,await getResponsibilityCapabilities({organizationId:url.searchParams.get('organizationId')||'',projectId:url.searchParams.get('projectId')||''},actor));return true;}
    if(memoryRevision) { if(req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;} if(!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;} if(memoryRevision[3]!=='preview'&&process.env.RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED!=='1') {writeJson(res,503,{code:'MEMORY_REVISION_DISABLED',error:'Memory revision is disabled'});return true;} const raw=await readBody(req,16384); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;} const id=decodeURIComponent(memoryRevision[1]),factId=decodeURIComponent(memoryRevision[2]); const result=memoryRevision[3]==='preview'?await previewResponsibilityMemory(id,factId,body,actor):await reviseResponsibilityMemory(id,factId,memoryRevision[3],body,actor); writeJson(res,200,result);return true; }
    if(sessionContext) {const sessionId=decodeURIComponent(sessionContext[1]); if(typeof requireSessionAccess!=='function') {writeJson(res,503,{error:'Session authorization is unavailable'});return true;} if(!await requireSessionAccess(res,authSession,sessionId)) return true; if(req.method==='GET') {writeJson(res,200,await getResponsibilitySessionContext(sessionId,actor));return true;} if(req.method!=='PUT') {writeJson(res,405,{error:'Method not allowed'});return true;} if(!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;} const raw=await readBody(req,8192); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;} writeJson(res,200,await setResponsibilitySessionContext(sessionId,body,actor));return true; }
    if(review) { if(req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;} if(!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;}
      const runId=decodeURIComponent(review[1]),targetId=decodeURIComponent(review[2]); const run=await getRun(runId); if(!run?.sessionId) {writeJson(res,404,{error:'Run not found'});return true;}
      if(typeof requireSessionAccess!=='function') {writeJson(res,503,{error:'Session authorization is unavailable'});return true;} if(!await requireSessionAccess(res,authSession,run.sessionId)) return true;
      const session=await getSession(run.sessionId); if(!session||!sanitizeEmailCompletionTargets(session.completionTargets||[]).some(target=>target.id===targetId)) {writeJson(res,404,{error:'Email target not found'});return true;}
      const raw=await readBody(req,8192); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
      writeJson(res,200,await recordEmailDeliveryReview({runId,targetId,observation:body?.observation,evidence:body?.evidence},actor)); return true;
    }
    if(match?.[1]==='intent'&&!match[2]) { if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;} const raw=await readBody(req,8192); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;} writeJson(res,200,await proposeResponsibilityIntent({text:body?.text,responsibilityId:body?.responsibilityId},actor));return true; }
    const id=match[1]?decodeURIComponent(match[1]):'', action=match[2]||'', url=new URL(req.url||pathname,'http://localhost'); let result;
    if(action==='code-baseline') {if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}const current=await getResponsibility(id,actor);writeJson(res,200,{schemaVersion:1,baseline:await captureResponsibilityCodeBaseline(current.responsibility.organizationId,current.responsibility.projectId)});return true;}
    if(id&&action==='observations') {
      if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;}
      const current=await getResponsibility(id,actor);
      const watermarks=await listExternalResourceWatermarks(id);
      const rows=await read(db=>({
        changeObservations:db.prepare('SELECT * FROM responsibility_change_observations WHERE responsibility_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id).map(r=>({wakeId:r.wake_id,responsibilityRevision:r.responsibility_revision,policyRevision:r.policy_revision,catalogDigest:r.catalog_digest,decisionId:r.decision_id||null,projectFactId:r.project_fact_id,observationKind:r.observation_kind,outcome:r.outcome,baselineWakeId:r.baseline_wake_id||null,fingerprintDigest:r.fingerprint_digest,gitDigest:r.git_digest||null,workspaceDigest:r.workspace_digest||null,externalDigest:r.external_digest||null,details:JSON.parse(r.details_json||'{}'),createdAt:r.created_at})),
        gitObservations:db.prepare('SELECT * FROM responsibility_git_observations WHERE responsibility_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id).map(r=>({wakeId:r.wake_id,decisionId:r.decision_id,projectFactId:r.project_fact_id,observationDigest:r.observation_digest,observation:JSON.parse(r.observation_json||'{}'),createdAt:r.created_at})),
      }));
      writeJson(res,200,{schemaVersion:1,responsibilityId:current.responsibility.id,externalWatermarks:watermarks,...rows});
      return true;
    }
    if(id&&action==='external-watermarks') {
      if(req.method==='GET') {await getResponsibility(id,actor);writeJson(res,200,{schemaVersion:1,responsibilityId:id,watermarks:await listExternalResourceWatermarks(id)});return true;}
      if(req.method!=='POST'||!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Owner JSON request required'});return true;}
      await getResponsibility(id,actor);
      const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');}catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
      const watermark=await recordExternalResourceWatermark({responsibilityId:id,source:body?.source,resourceKey:body?.resourceKey,watermarkValue:body?.watermarkValue,observedAt:body?.observedAt,metadata:body?.metadata||{}});
      writeJson(res,200,{schemaVersion:1,watermark});return true;
    }
    if(id&&action==='producer-events') {
      if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;}
      const current=await getResponsibility(id,actor);
      const afterSequence=Number(url.searchParams.get('afterSequence')||0);
      const limit=Number(url.searchParams.get('limit')||100);
      const eventType=url.searchParams.get('eventType')||'';
      const org=await read(db=>db.prepare('SELECT root_session_id FROM organizations WHERE id=?').get(current.responsibility.organizationId));
      const byOrg=await listProducerTriggerEvents({organizationId:current.responsibility.organizationId,eventType,afterSequence,limit});
      const bySess=org?.root_session_id?await listProducerTriggerEvents({sessionId:org.root_session_id,eventType,afterSequence,limit}):{events:[],nextSequence:afterSequence,retention:byOrg.retention,cursorGapDetected:false};
      const merged=new Map();for(const ev of [...byOrg.events,...bySess.events]) merged.set(ev.sequence,ev);
      const events=[...merged.values()].sort((a,b)=>a.sequence-b.sequence).slice(0,Math.max(1,Math.min(limit||100,500)));
      writeJson(res,200,{schemaVersion:1,responsibilityId:id,events,nextSequence:events.length?events.at(-1).sequence:afterSequence,retention:byOrg.retention,cursorGapDetected:byOrg.cursorGapDetected||bySess.cursorGapDetected});
      return true;
    }
    if(id&&action==='goal-revisions') {
      if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;}
      const current=await getResponsibility(id,actor);
      const links=await listResponsibilityWorkLinks(id,actor);
      const goalIds=[...new Set((links.links||[]).map(l=>l.goalId).filter(Boolean))];
      const goals=[];for(const gid of goalIds) {try {goals.push(await getFactoryGoalRevisionArtifacts({organizationId:current.responsibility.organizationId,goalId:gid},actor));}catch {}}
      writeJson(res,200,{schemaVersion:1,responsibilityId:id,goals});return true;
    }
    if(req.method==='GET'&&!id) result=await listResponsibilities({organizationId:url.searchParams.get('organizationId')||'',projectId:url.searchParams.get('projectId')||'',limit:Number(url.searchParams.get('limit')||100)},actor);
    else if(req.method==='GET'&&id&&!action) {const base=await getResponsibility(id,actor);const stage2=await loadResponsibilityStage2Summary(base.responsibility,actor);result={...base,changeObservation:stage2.changeObservation,producerEvents:stage2.producerEvents,goalRevisionSummary:stage2.goalRevisionSummary};}
    else if(req.method==='GET'&&id&&action==='activity') result=await listResponsibilityActivity(id,{after:Number(url.searchParams.get('after')||0),limit:Number(url.searchParams.get('limit')||100)},actor);
    else if(req.method==='GET'&&id&&action==='context') result=await assembleResponsibilityContext(id,actor);
    else if(req.method==='GET'&&id&&action==='memory') {
      const assembled = await assembleResponsibilityContext(id, actor);
      result = {
        schemaVersion: 1,
        revisionEnabled: process.env.RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED === '1',
        memory: assembled.memory,
        layers: assembled.layers,
        retrievedMemory: assembled.retrievedMemory,
        retrieval: assembled.retrieval,
      };
    }
    else if(id&&action==='notifications') {if(req.method==='GET') {const settings=await getResponsibilityNotificationSettings(id,actor),runtimeEnabled=process.env.RAGENT_RESPONSIBILITY_RUNTIME_ENABLED==='1',accountCloudPushAvailable=Boolean(settings.deliveryEnabled&&runtimeEnabled&&settings.accountCloudPush?.configured);result={...settings,runtimeEnabled,deliveryAvailable:settings.deliveryEnabled&&runtimeEnabled,accountCloudPushAvailable,registrationSupported,registrationReason:registrationSupported?'':'A verified paired owner device is required'};}else if(req.method==='PUT'&&mutationSourceAllowed(req)) {const raw=await readBody(req,16384);let body;try {body=JSON.parse(raw||'{}');}catch {throw Object.assign(new Error('Invalid JSON body'),{statusCode:400});}result=await setResponsibilityNotificationSettings(id,body,actor);}else {writeJson(res,405,{error:'Method or request source is not allowed'});return true;}}
    else if((req.method==='POST'&&!id)||(req.method==='PATCH'&&id&&!action)||(req.method==='POST'&&id&&['pause','resume','complete','cancel','archive','wake','github-event'].includes(action))) { if(!mutationSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;} const raw=await readBody(req,64*1024); let body; try {body=JSON.parse(raw||'{}');} catch {throw Object.assign(new Error('Invalid JSON body'),{statusCode:400});} if(!body||typeof body!=='object'||Array.isArray(body)) throw Object.assign(new Error('Body must be an object'),{statusCode:400}); if(!id) result=await createResponsibility(body,actor); else if(!action) result=await updateResponsibility(id,body,actor); else if(action==='wake') result=await wakeResponsibility(id,body,actor); else if(action==='github-event') result=await observeGithubFailure(id,body,actor); else result=await setResponsibilityLifecycle(id,action,body,actor);
    } else {writeJson(res,405,{error:'Method not allowed'});return true;} writeJson(res,200,result);
  } catch(e) {writeJson(res,e?.code==='BODY_TOO_LARGE'?413:(e?.statusCode||400),{error:e?.message||'Responsibility request failed',...(e?.code?{code:e.code}:{}),...(Array.isArray(e?.blockers)?{blockers:e.blockers}:{})});} return true;
}
