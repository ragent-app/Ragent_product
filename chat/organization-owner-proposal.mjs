// Owner-authored initial organization only; never creates or impersonates a Run.
import {createHash} from 'node:crypto';
import {withDatabase} from './collaboration-store.mjs';
import {getSession} from './session-manager.mjs';
import {buildOrganizationAgentCatalog} from './organization-leader-ingress.mjs';
import {catalogProfiles} from './agent-capability-catalog.mjs';
import {createOrganization,compileOrganizationProposal,reviseOrganizationProposal,freezeRevision} from './organization-runtime.mjs';
import {getOrganizationByRootSession,getRevision,initializeOrganizationStore,listOrganizationNodes} from './organization-store.mjs';
import {normalizeAppId} from './apps.mjs';
import {provisionRootLeadershipRevision} from './organization-provisioning.mjs';
import {createManagedSessionForNode} from './organization-managed-session-factory.mjs';

const text=x=>typeof x==='string'?x.trim():'';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(message,statusCode=409)=>{throw Object.assign(new Error(message),{code:'OWNER_ORGANIZATION_PROPOSAL',statusCode});};
function owner(actor) {if(actor?.kind!=='user'||actor.role!=='owner'||!text(actor.principalId)) fail('Owner required',403);}
function schema(db) {db.exec(`CREATE TABLE IF NOT EXISTS owner_initial_organization_operations (
 command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, root_session_id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL, input_digest TEXT NOT NULL, preview_digest TEXT NOT NULL, state TEXT NOT NULL,
 step TEXT NOT NULL, organization_id TEXT, revision INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(actor_id,idempotency_key));`);}
function view(row) {return {commandId:row.command_id,state:row.state==='running'?'unknown':row.state,step:row.step,organizationId:row.organization_id || null,revision:row.revision || null,errorCode:row.error_code || null,source:'owner',updatedAt:row.updated_at};}
async function inspect(input,actor) {
 owner(actor);
 const rootSessionId=text(input?.rootSessionId),projectId=text(input?.projectId),proposal=input?.proposal;
 if(!rootSessionId||!projectId||!proposal||typeof proposal!=='object'||Array.isArray(proposal)) fail('Root Session, project and proposal are required',400);
 const session=await getSession(rootSessionId);
 if(!session||session.sessionClass!=='ROOT_LEADERSHIP'||session.sessionPlane!=='user'||session.userAddressable===false||session.projectId!==projectId||!text(session.folder)) fail('Root Session or project is unavailable');
 if(session.activeRunId || ['queued','starting','running','awaiting_approval','cancelling'].includes(session.activity?.run?.state)) fail('Root Session has an active Run');
 const budget=proposal.budget, nodes=proposal.nodes;
 if(!budget||!Number.isSafeInteger(budget.maxTotalRuns)||budget.maxTotalRuns<1||!Number.isSafeInteger(budget.maxTokens)||budget.maxTokens<1
  ||!Number.isFinite(budget.maxCost)||budget.maxCost<=0||budget.maxConcurrent!==1||budget.maxNodes!==1) fail('Positive bounded runs, tokens and cost, and concurrency/maxNodes of one are required',400);
 if(!Array.isArray(nodes)||nodes.length!==1||nodes[0]?.role!=='reviewer'||nodes[0]?.parentKey || (proposal.manages?.length || 0)!==0) fail('Only one root reviewer is supported',400);
 const runtime=nodes[0].runtime;
 if(!runtime || !text(runtime.tool) || !text(runtime.model) || !text(runtime.effort) || !text(runtime.providerProfile || runtime.provider)) fail('Explicit tool, provider, model and effort are required',400);
 const capabilities=nodes[0].capabilities;
 if(!Array.isArray(capabilities)||new Set(capabilities).size!==capabilities.length||!capabilities.includes('read')||!capabilities.includes('run')||capabilities.some(x=>!['read','run','review'].includes(x))||Object.hasOwn(nodes[0],'grant')) fail('Reviewer capabilities must be a read/run/review subset including read and run',400);
 const catalog=await buildOrganizationAgentCatalog();
 const profiles=catalogProfiles(catalog);
 const planned=await compileOrganizationProposal(proposal,{profiles});
 const node=planned.compiled?.nodes?.[0];
 const profile=profiles.find(x=>x.agentId===node?.resolver?.selectedAgentId);
 if(!profile||!Array.isArray(profile.capabilities)||capabilities.some(x=>!profile.capabilities.includes(x))) fail('Agent profile does not authorize requested capabilities');
 if(node?.runtime?.tool!==runtime.tool || node?.runtime?.model!==runtime.model || node?.runtime?.effort!==runtime.effort || text(node?.runtime?.provider || node?.runtime?.providerProfile)!==text(runtime.provider || runtime.providerProfile)) fail('Compiled runtime differs from explicit selection');
 const root={id:session.id,projectId:session.projectId,folder:session.folder,sessionClass:session.sessionClass,sessionPlane:session.sessionPlane,userAddressable:session.userAddressable!==false};
 const previewDigest=hash({root,catalogRevision:catalog.revision,planDigest:planned.digest,budget:planned.proposal.budget});
 return {rootSessionId,projectId,planned,catalogRevision:catalog.revision,previewDigest};
}
export async function previewOwnerOrganization(input,actor) {
 const plan=await inspect(input,actor);
 if(await getOrganizationByRootSession(plan.rootSessionId)) fail('Root Session already has an organization');
 return {source:'owner',previewDigest:plan.previewDigest,catalogRevision:plan.catalogRevision,planDigest:plan.planned.digest,proposal:plan.planned.proposal,compiled:plan.planned.compiled};
}
export async function getOwnerOrganizationOperation(commandId,actor) {
 owner(actor);
 return withDatabase(db=>{schema(db);const row=db.prepare('SELECT * FROM owner_initial_organization_operations WHERE command_id=? AND actor_id=?').get(text(commandId),actor.principalId);if(!row) fail('Operation not found',404);return view(row);});
}
export async function commitOwnerOrganization(input,actor) {
 owner(actor);
 const commandId=text(input?.commandId),key=text(input?.idempotencyKey),previewDigest=text(input?.previewDigest);
 const rootSessionId=text(input?.rootSessionId),projectId=text(input?.projectId);
 if(!commandId||commandId.length>120||!key||key.length>160||!rootSessionId||!projectId||!/^[a-f0-9]{64}$/.test(previewDigest)) fail('Command identity or preview is invalid',400);
 const inputDigest=hash({rootSessionId,projectId,proposal:input.proposal,previewDigest});
 const prior=await withDatabase(db=>{schema(db);return db.prepare('SELECT * FROM owner_initial_organization_operations WHERE command_id=? OR (actor_id=? AND idempotency_key=?) OR root_session_id=?').get(commandId,actor.principalId,key,rootSessionId);});
 if(prior && (prior.command_id!==commandId||prior.actor_id!==actor.principalId||prior.idempotency_key!==key||prior.input_digest!==inputDigest)) fail('Command, key or root Session belongs to another proposal');
 if(prior && prior.state!=='retryable') return view(prior);
 const plan=await inspect(input,actor);
 if(previewDigest!==plan.previewDigest) fail('Preview no longer matches current root or Agent profile');
 await initializeOrganizationStore();
 const chosen=await withDatabase(db=>{schema(db);db.exec('BEGIN IMMEDIATE');try {
  const existing=db.prepare('SELECT * FROM owner_initial_organization_operations WHERE command_id=? OR (actor_id=? AND idempotency_key=?) OR root_session_id=?').get(commandId,actor.principalId,key,plan.rootSessionId);
  if(existing){if(existing.command_id!==commandId||existing.actor_id!==actor.principalId||existing.idempotency_key!==key||existing.input_digest!==inputDigest) fail('Command, key or root Session belongs to another proposal');
   if(!['retryable'].includes(existing.state)){db.exec('COMMIT');return {row:existing,run:false};}
   const changed=db.prepare("UPDATE owner_initial_organization_operations SET state='running',error_code=NULL,updated_at=? WHERE command_id=? AND state='retryable'").run(new Date().toISOString(),commandId);
   if(!changed.changes) fail('Operation changed');db.exec('COMMIT');return {row:existing,run:true};}
  if(db.prepare('SELECT 1 FROM organizations WHERE root_session_id=?').get(plan.rootSessionId)) fail('Root Session already has an organization');
  const ts=new Date().toISOString();db.prepare('INSERT INTO owner_initial_organization_operations (command_id,actor_id,idempotency_key,root_session_id,project_id,input_digest,preview_digest,state,step,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(commandId,actor.principalId,key,plan.rootSessionId,plan.projectId,inputDigest,previewDigest,'running','create_intent',ts,ts);
  db.exec('COMMIT');return {run:true};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}},{mutate:true});
 if(!chosen.run) return view(chosen.row);
 const mark=async(step,extra={})=>withDatabase(db=>{const result=db.prepare("UPDATE owner_initial_organization_operations SET step=?,organization_id=COALESCE(?,organization_id),revision=COALESCE(?,revision),updated_at=? WHERE command_id=? AND state='running'").run(step,extra.organizationId || null,extra.revision || null,new Date().toISOString(),commandId);if(!result.changes)fail('Operation state changed');},{mutate:true});
 try {
  let org=await getOrganizationByRootSession(plan.rootSessionId);
  const orgKey=`owner-initial:${commandId}`;
  if(org && org.idempotencyKey!==orgKey) fail('Root Session already has an organization');
  org ||= await createOrganization({rootSessionId:plan.rootSessionId,projectId:plan.projectId,policy:{source:'owner',proposalOnly:true},budget:plan.planned.proposal.budget,idempotencyKey:orgKey});
  if(org.projectId!==plan.projectId || org.rootSessionId!==plan.rootSessionId || org.idempotencyKey!==orgKey) fail('Organization identity changed');
  if((await inspect(input,actor)).previewDigest!==previewDigest) fail('Root Session or Agent profile changed');
  await mark('revision_intent',{organizationId:org.id});
  let revision;
  if(org.currentRevision) {revision=await getRevision(org.id,org.currentRevision);if(org.currentRevision!==1||revision?.digest!==plan.planned.digest) fail('Existing revision differs from owner proposal');}
  else revision=await reviseOrganizationProposal({organizationId:org.id,proposal:input.proposal,compiledPlan:plan.planned,idempotencyKey:`owner-revision:${commandId}`,expectedCurrentRevision:0});
  if((await inspect(input,actor)).previewDigest!==previewDigest) fail('Root Session or Agent profile changed');
  await mark('freeze_intent',{revision:revision.revision});
  await freezeRevision(org.id,revision.revision);
  if((await inspect(input,actor)).previewDigest!==previewDigest) fail('Root Session or Agent profile changed');
  await mark('provision_intent');
  const result=await provisionRootLeadershipRevision({organizationId:org.id,revision:revision.revision,createManagedSession:createManagedSessionForNode,idempotencyKey:`owner-provision:${commandId}`});
  if(result.state!=='provisioned') fail('Managed Session provisioning was not completed');
  const nodes=await listOrganizationNodes(org.id);
  if(nodes.length!==1 || nodes[0].nodeRole!=='reviewer' || !nodes[0].currentSessionId) fail('Provisioned reviewer identity is unavailable');
  const managed=await getSession(nodes[0].currentSessionId), fixed=plan.planned.compiled.nodes[0];
  if(!managed || managed.sessionPlane!=='organization' || managed.organizationId!==org.id || managed.organizationNodeId!==nodes[0].id
    || managed.organizationRevision!==revision.revision || managed.templateId!==normalizeAppId(fixed.resolver.selectedAgentId)
    || managed.tool!==fixed.runtime.tool || managed.model!==fixed.runtime.model || managed.effort!==fixed.runtime.effort
    || text(managed.providerProfile)!==text(fixed.runtime.provider || fixed.runtime.providerProfile)) fail('Provisioned Session differs from the frozen reviewer runtime');
  await withDatabase(db=>db.prepare("UPDATE owner_initial_organization_operations SET state='completed',step='completed',updated_at=? WHERE command_id=? AND state='running'").run(new Date().toISOString(),commandId),{mutate:true});
 }catch(error){await withDatabase(db=>db.prepare("UPDATE owner_initial_organization_operations SET state=CASE WHEN step='provision_intent' THEN 'unknown' ELSE 'retryable' END,error_code=?,updated_at=? WHERE command_id=? AND state='running'").run(text(error?.code)||'OWNER_PROVISION_FAILED',new Date().toISOString(),commandId),{mutate:true});throw error;}
 return getOwnerOrganizationOperation(commandId,actor);
}
