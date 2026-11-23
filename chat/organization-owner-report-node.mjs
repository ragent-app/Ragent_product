// Owner-only preparation for one project-report node. No Run is dispatched here.
import { createHash } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { getOrganization, getRevision, listOrganizationNodes } from './organization-store.mjs';
import { isAppendOnlyRevisionCompatible } from './organization-revision-compatibility.mjs';
import { compileOrganizationProposal } from './organization-planner.mjs';
import { buildOrganizationAgentCatalog } from './organization-leader-ingress.mjs';
import { catalogProfiles } from './agent-capability-catalog.mjs';
import { buildOrganizationRuntimeCatalog, runtimePolicyForProfile } from './organization-runtime-selection.mjs';
import { selectRuntimeConstraints } from './organization-runtime-decision.mjs';
import { readSessionRuntimeConstraints } from './session-collaboration-settings.mjs';
import { getSession } from './session-manager.mjs';
import { provisionFrozenRevision } from './organization-provisioning.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { resolveRuntimeReadOnlyCapability } from './runtime-adapter.mjs';
import { canonicalJson } from './execution-scope.mjs';
import { ensureOwnerReportScope } from './factory-owner-report-scope.mjs';
import { validateProjectReportPolicy } from './responsibility-providers.mjs';

const activeSetups=new Set();
const text=x=>typeof x==='string'?x.trim():'';
function requireAllowedOrganization(organizationId) {
 const allowed=[...new Set(String(process.env.RAGENT_FACTORY_ORGANIZATIONS || '').split(',').map(text).filter(Boolean))];
 if(allowed.length!==1 || allowed[0]!==organizationId) fail('Organization is outside the configured single-report scope','OWNER_REPORT_SETUP_FORBIDDEN',403);
}
const hash=x=>createHash('sha256').update(canonicalJson(x)).digest('hex');
const fail=(message,code='OWNER_REPORT_SETUP_CONFLICT',statusCode=409)=>{throw Object.assign(new Error(message),{code,statusCode});};
function owner(actor) { if(actor?.kind!=='user'||actor.role!=='owner'||!text(actor.principalId)) fail('Verified instance owner required','OWNER_REPORT_SETUP_FORBIDDEN',403); }
function schema(db) { ensureOwnerReportScope(db); db.exec(`CREATE TABLE IF NOT EXISTS owner_report_setup_operations (
 command_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 input_digest TEXT NOT NULL, preview_digest TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER, node_id TEXT,
 error_code TEXT, input_json TEXT NOT NULL, constraints_revision INTEGER NOT NULL, stable_key TEXT NOT NULL,
 worker_pid INTEGER NOT NULL, budget_change_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(actor_id,idempotency_key));
 CREATE TABLE IF NOT EXISTS owner_report_scope_actions (command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 organization_id TEXT NOT NULL, action TEXT NOT NULL, payload_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(actor_id,idempotency_key))`); }
function view(row) { return {commandId:row.command_id,state:row.state==='running'?'unknown':row.state,organizationId:row.organization_id,revision:row.revision || null,nodeId:row.node_id || null,errorCode:row.error_code || null,updatedAt:row.updated_at}; }
function bounds(value) { if(!value || value.maxTotalRuns!==1 || value.maxConcurrent!==1 || !Number.isSafeInteger(value.maxTokens) || value.maxTokens<1 || !Number.isFinite(value.maxCost) || value.maxCost<=0 || Object.keys(value).sort().join(',')!=='maxConcurrent,maxCost,maxTokens,maxTotalRuns') fail('Explicit authorized report bounds are required','OWNER_REPORT_SETUP_INVALID',400); return value; }
function runtimeValue(value) {
 if(!value || value.tool!=='codex' || !text(value.provider) || !text(value.model) || !text(value.effort) || Object.keys(value).some(k=>!['tool','provider','model','effort'].includes(k))) fail('Explicit Codex runtime is required','OWNER_REPORT_SETUP_INVALID',400);
 return {tool:'codex',provider:text(value.provider),model:text(value.model),effort:text(value.effort)};
}
function isReportAgent(profile) {
 const policy=runtimePolicyForProfile(profile);
 return ['read','run'].every(c=>profile.capabilities?.includes(c)) && (!policy.allowedTools.length || policy.allowedTools.includes('codex'));
}
function factsInDb(db,organizationId) {
  const exists=n=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  const scope=exists('factory_owner_report_scope') && db.prepare("SELECT 1 FROM factory_owner_report_scope WHERE organization_id=? AND state<>'closed'").get(organizationId);
  const active=exists('factory_execution_bindings') ? db.prepare("SELECT COUNT(*) AS n FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? AND b.status IN ('intent','running','unknown')").get(organizationId).n : 0;
  const lease=exists('factory_scheduler_leases') && db.prepare('SELECT 1 FROM factory_scheduler_leases WHERE organization_id=? AND expires_at>?').get(organizationId,new Date().toISOString());
  const rows=exists('organization_budget_counters') ? db.prepare('SELECT totals_json,reserved_json,reservations_json FROM organization_budget_counters WHERE organization_id=?').all(organizationId) : [];
  if(!exists('organization_budget_counters') && exists('factory_execution_bindings') && db.prepare('SELECT 1 FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? LIMIT 1').get(organizationId)) fail('Historical budget evidence is unavailable');
  const total={runs:0,tokens:0,cost:0};
  for(const row of rows) {
   let used,reserved,entries; try {used=JSON.parse(row.totals_json);reserved=JSON.parse(row.reserved_json);entries=JSON.parse(row.reservations_json);} catch { fail('Budget ledger is unreadable'); }
   if(Object.values(entries).some(x=>x?.state==='reserved' || (x?.state!=='released' && x?.state!=='settled' && x?.unknownDimensions?.length))) fail('Unresolved budget reservations require reconciliation');
   for(const key of Object.keys(total)) { const a=used?.[key],b=reserved?.[key]; if(!Number.isFinite(a)||a<0||!Number.isFinite(b)||b<0) fail('Budget totals are unavailable'); total[key]+=a+b; }
  }
  return {scope:!!scope,active,lease:!!lease,total};
}
async function facts(organizationId) { return withDatabase(db=>factsInDb(db,organizationId)); }
async function inspect(organizationId,input,actor) {
 owner(actor); requireAllowedOrganization(organizationId); const projectId=text(input?.projectId), agentId=text(input?.agentId), runtime=runtimeValue(input?.runtime), budget=bounds(input?.budget);
 if(!projectId || !agentId || !Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision<1) fail('Project, agent and revision required','OWNER_REPORT_SETUP_INVALID',400);
 if(process.env.RAGENT_FACTORY_SCHEDULER_ENABLED==='1') fail('Disable Factory scheduling before preparing the node');
 const org=await getOrganization(organizationId), revision=org && await getRevision(organizationId,input.expectedRevision), root=org && await getSession(org.rootSessionId);
 if(!org || org.projectId!==projectId || org.currentRevision!==input.expectedRevision || org.state!=='active' || revision?.state!=='frozen' || !revision.proposal || !revision.compiled || !root || root.projectId!==projectId || !text(root.folder)) fail('Organization, project, revision or root Session changed');
 if(root.activeRunId || ['queued','starting','running','awaiting_approval','cancelling'].includes(root.activity?.run?.state)) fail('Root Session has an active Run');
 const fact=await facts(organizationId); if(fact.scope||fact.active||fact.lease) fail('Report setup, active execution or scheduler lease already exists');
 const support=resolveRuntimeReadOnlyCapability({toolId:'codex'}); if(!support.supportsReadOnlyFilesystem) fail('Read-only Codex capability is unavailable');
 const catalog=await buildOrganizationAgentCatalog(),profiles=catalogProfiles(catalog),profile=profiles.find(x=>x.agentId===agentId);
 if(!profile || !isReportAgent(profile)) fail('Agent does not expose compatible read/run Codex capabilities');
 const constraints=await readSessionRuntimeConstraints(org.rootSessionId), runtimeCatalog=await buildOrganizationRuntimeCatalog();
 const stableKey=`owner_report_${hash({organizationId,revision:input.expectedRevision,agentId,runtime}).slice(0,20)}`;
 if((revision.proposal.nodes || []).some(x=>x.stableKey===stableKey)) fail('Report node already exists');
 const phaseId=revision.proposal.phases?.[0]?.phaseId; if(!phaseId) fail('Frozen phase is unavailable');
 const node={stableKey,role:'specialist',agentId,phaseId,displayName:'Project report',capabilities:['read','run'],scope:{projectId,accessMode:'read_only'},runtime};
 const proposal={...revision.proposal,nodes:[...revision.proposal.nodes,node]};
 const old=Object.fromEntries((revision.compiled.nodes || []).map(n=>[n.stableKey,n]));
 const planned=await compileOrganizationProposal(proposal,{profiles,frozenNodeByKey:old,runtimeDecisionByNode:{[stableKey]:{constraints:selectRuntimeConstraints(constraints.constraints,['organization',`node:${stableKey}`]),catalog:runtimeCatalog}}});
 const selected=planned.compiled.nodes.find(n=>n.stableKey===stableKey);
 if(!selected || selected.role!=='specialist' || selected.grant?.canWrite!==false || selected.grant?.accessMode!=='read_only' || selected.grant?.allowedCapabilities?.includes('write') || !['read','run'].every(c=>selected.grant?.allowedCapabilities?.includes(c)) || selected.runtime?.tool!=='codex' || selected.runtime?.model!==runtime.model || selected.runtime?.effort!==runtime.effort || text(selected.runtime?.provider || selected.runtime?.providerProfile)!==runtime.provider) fail('Compiled node differs from the requested read-only runtime');
 const updatedBudget={...org.budget}; for(const [key,dimension,amount] of [['maxTotalRuns','runs',budget.maxTotalRuns],['maxTokens','tokens',budget.maxTokens],['maxCost','cost',budget.maxCost]]) {
  if(updatedBudget[key]===undefined) updatedBudget[key]=fact.total[dimension]+amount;
  if(!Number.isFinite(updatedBudget[key]) || updatedBudget[key]<=fact.total[dimension] || updatedBudget[key]<0 || (dimension!=='cost' && !Number.isSafeInteger(updatedBudget[key]))) fail('Existing organization budget is unavailable or exhausted');
 }
 if(updatedBudget.maxConcurrent===undefined) updatedBudget.maxConcurrent=1;
 if(!Number.isSafeInteger(updatedBudget.maxConcurrent)||updatedBudget.maxConcurrent<1) fail('Organization concurrency budget is unavailable');
 const updatedPolicy={...org.policy}; if(updatedPolicy.factoryMaxConcurrent===undefined) updatedPolicy.factoryMaxConcurrent=1;
 if(!Number.isSafeInteger(updatedPolicy.factoryMaxConcurrent)||updatedPolicy.factoryMaxConcurrent<1) fail('Factory concurrency policy is unavailable');
 const previewDigest=hash({organizationId,projectId,revision:input.expectedRevision,organizationVersion:org.version,revisionDigest:revision.digest,agentId,runtime,budget,stableKey,planDigest:planned.digest,catalogRevision:catalog.revision,constraintsRevision:constraints.revision,ledger:fact.total,updatedBudget,updatedPolicy});
 return {org,revision,root,planned,stableKey,agentId,runtime,budget,previewDigest,catalogRevision:catalog.revision,constraintsRevision:constraints.revision,ledger:fact.total,updatedBudget,updatedPolicy,support};
}
export async function ownerReportCatalog(organizationId,actor) {
 owner(actor); requireAllowedOrganization(organizationId); const org=await getOrganization(organizationId); if(!org) fail('Organization unavailable','OWNER_REPORT_SETUP_NOT_FOUND',404);
 const catalog=await buildOrganizationAgentCatalog(),support=resolveRuntimeReadOnlyCapability({toolId:'codex'});
 return {organizationId,projectId:org.projectId,revision:org.currentRevision,agents:catalogProfiles(catalog).filter(isReportAgent).map(p=>({agentId:p.agentId,name:p.agentName || p.agentId,capabilities:p.capabilities.filter(c=>['read','run','review'].includes(c)),runtimePolicy:runtimePolicyForProfile(p)})),readOnlySupport:{available:support.supportsReadOnlyFilesystem===true,enforcement:support.enforcement,note:support.note},budget:org.budget};
}
export async function previewOwnerReportNode(organizationId,input,actor) {
 const p=await inspect(organizationId,input,actor);
 return {organizationId,projectId:p.org.projectId,revision:p.org.currentRevision,previewDigest:p.previewDigest,agentId:p.agentId,runtime:p.runtime,budget:p.budget,readOnlySupport:{available:true,enforcement:p.support.enforcement,note:p.support.note},existingBudget:p.org.budget,proposedBudget:p.updatedBudget,ledger:p.ledger,notice:'No Run is started; provider read-only enforcement is verified at admission.'};
}
export async function getOwnerReportNodeOperation(organizationId,commandId,actor) {
 owner(actor); requireAllowedOrganization(organizationId); return withDatabase(db=>{ if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_report_setup_operations'").get()) fail('Operation unavailable','OWNER_REPORT_SETUP_NOT_FOUND',404); const row=db.prepare('SELECT * FROM owner_report_setup_operations WHERE command_id=? AND organization_id=? AND actor_id=?').get(text(commandId),organizationId,actor.principalId); if(!row) fail('Operation unavailable','OWNER_REPORT_SETUP_NOT_FOUND',404); const scope=db.prepare('SELECT state,responsibility_id,work_item_id,max_tokens,max_cost FROM factory_owner_report_scope WHERE organization_id=? AND command_id=?').get(organizationId,row.command_id); return {...view(row),scope:scope?{state:scope.state,responsibilityId:scope.responsibility_id || null,workItemId:scope.work_item_id || null,maxTokens:scope.max_tokens,maxCost:scope.max_cost,maxRuns:1,maxConcurrent:1}:null}; });
}
export async function commitOwnerReportNode(organizationId,input,actor) {
 owner(actor); requireAllowedOrganization(organizationId); const commandId=text(input?.commandId),key=text(input?.idempotencyKey),previewDigest=text(input?.previewDigest);
 if(input?.confirmed!==true || !/^[A-Za-z0-9_.:-]{1,120}$/.test(commandId) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(key) || !/^[a-f0-9]{64}$/.test(previewDigest)) fail('Confirmation and command identity are required','OWNER_REPORT_SETUP_INVALID',400);
 if(activeSetups.has(commandId)) fail('Setup is already in progress');
 activeSetups.add(commandId);
 try {
 const payload={projectId:input.projectId,expectedRevision:input.expectedRevision,agentId:input.agentId,runtime:input.runtime,budget:input.budget}, inputDigest=hash(payload);
 const prior=await withDatabase(db=>{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_report_setup_operations'").get()) return null;return db.prepare('SELECT * FROM owner_report_setup_operations WHERE command_id=? OR (actor_id=? AND idempotency_key=?)').get(commandId,actor.principalId,key);});
 if(prior) {
  if(prior.command_id!==commandId||prior.organization_id!==organizationId||prior.actor_id!==actor.principalId||prior.idempotency_key!==key||prior.input_digest!==inputDigest||prior.preview_digest!==previewDigest) fail('Command identity conflicts');
  if(['completed','cancelled'].includes(prior.state)) return getOwnerReportNodeOperation(organizationId,commandId,actor);
  if(prior.state==='running' && prior.worker_pid!==process.pid) {
   try { process.kill(prior.worker_pid,0); return getOwnerReportNodeOperation(organizationId,commandId,actor); }
   catch(error) { if(error?.code!=='ESRCH') return getOwnerReportNodeOperation(organizationId,commandId,actor); }
  }
  const org=await getOrganization(organizationId), frozen=org && await getRevision(organizationId,prior.revision);
  const scope=await withDatabase(db=>db.prepare('SELECT * FROM factory_owner_report_scope WHERE organization_id=? AND command_id=?').get(organizationId,commandId));
  const fixed=frozen?.compiled?.nodes?.find(n=>n.stableKey===prior.stable_key), runtime=runtimeValue(payload.runtime);
  if(!org || org.currentRevision!==prior.revision || org.projectId!==payload.projectId || frozen?.state!=='frozen' || !scope || scope.state!=='pending' || scope.owner_id!==actor.principalId
    || fixed?.role!=='specialist' || fixed.grant?.canWrite!==false || fixed.grant?.allowedCapabilities?.includes('write') || fixed.runtime?.tool!=='codex' || fixed.runtime?.model!==runtime.model || fixed.runtime?.effort!==runtime.effort || text(fixed.runtime?.provider || fixed.runtime?.providerProfile)!==runtime.provider) fail('Stored setup cannot be safely resumed');
  const claimed=await withDatabase(db=>db.prepare("UPDATE owner_report_setup_operations SET state='running',worker_pid=?,error_code=NULL,updated_at=? WHERE command_id=? AND state=? AND worker_pid=?").run(process.pid,new Date().toISOString(),commandId,prior.state,prior.worker_pid).changes,{mutate:true});
  if(claimed!==1) return getOwnerReportNodeOperation(organizationId,commandId,actor);
  return await finishOwnerReportNode({org,stableKey:prior.stable_key,runtime,constraintsRevision:prior.constraints_revision},organizationId,prior.revision,commandId,actor);
 }
 const p=await inspect(organizationId,payload,actor); if(p.previewDigest!==previewDigest) fail('Preview changed; review again');
 const revision=p.org.currentRevision+1, idempotency=`owner-report-append:${commandId}`, ts=new Date().toISOString();
 await withDatabase(db=>{ db.exec('BEGIN IMMEDIATE');try {
  schema(db); const fresh=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
  if(!fresh || fresh.current_revision!==p.org.currentRevision || fresh.version!==p.org.version || fresh.project_id!==p.org.projectId || fresh.state!=='active' || process.env.RAGENT_FACTORY_SCHEDULER_ENABLED==='1') fail('Organization or scheduler changed');
  if(db.prepare("SELECT 1 FROM factory_owner_report_scope WHERE organization_id=? AND state<>'closed'").get(organizationId)) fail('A report scope already exists');
  const freshFacts=factsInDb(db,organizationId);
  if(freshFacts.active || freshFacts.lease || hash(freshFacts.total)!==hash(p.ledger)) fail('Budget or execution facts changed');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_execution_bindings'").get() && db.prepare("SELECT 1 FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? AND b.status IN ('intent','running','unknown')").get(organizationId)) fail('Execution became active');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_scheduler_leases'").get() && db.prepare('SELECT 1 FROM factory_scheduler_leases WHERE organization_id=? AND expires_at>?').get(organizationId,ts)) fail('Scheduler lease became active');
  db.prepare("INSERT INTO organization_revisions (organization_id,revision,proposal_json,compiled_json,digest,state,idempotency_key,created_at) VALUES (?,?,?,?,?,'frozen',?,?)").run(organizationId,revision,JSON.stringify(p.planned.proposal),JSON.stringify(p.planned.compiled),p.planned.digest,idempotency,ts);
  db.prepare('INSERT INTO owner_report_setup_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(commandId,organizationId,actor.principalId,key,inputDigest,previewDigest,'running',revision,null,null,JSON.stringify(payload),p.constraintsRevision,p.stableKey,process.pid,JSON.stringify({budgetBefore:p.org.budget,budgetAfter:p.updatedBudget,policyBefore:p.org.policy,policyAfter:p.updatedPolicy}),ts,ts);
  if(!isAppendOnlyRevisionCompatible(db,organizationId,p.org.currentRevision,revision)) fail('Existing frozen facts would change');
  db.prepare("INSERT INTO factory_owner_report_scope (organization_id,command_id,owner_id,project_id,node_id,state,work_item_id,dispatch_key,max_tokens,max_cost,created_at,responsibility_id) VALUES (?,?,?,?,NULL,'pending',NULL,NULL,?,?,?,NULL)").run(organizationId,commandId,actor.principalId,p.org.projectId,p.budget.maxTokens,p.budget.maxCost,ts);
  const updated=db.prepare('UPDATE organizations SET current_revision=?,version=version+1,budget_json=?,policy_json=?,updated_at=? WHERE id=? AND current_revision=? AND version=?').run(revision,JSON.stringify(p.updatedBudget),JSON.stringify(p.updatedPolicy),ts,organizationId,p.org.currentRevision,p.org.version);
  if(updated.changes!==1) fail('Organization changed'); db.exec('COMMIT');
 } catch(e) {try {db.exec('ROLLBACK');}catch{} throw e;} },{mutate:true});
 return await finishOwnerReportNode(p,organizationId,revision,commandId,actor);
 } finally { activeSetups.delete(commandId); }
}
async function finishOwnerReportNode(p,organizationId,revision,commandId,actor) {
 try {
  const beforeNode=async()=>{
   const org=await getOrganization(organizationId);
   const constraints=await readSessionRuntimeConstraints(p.org.rootSessionId);
   const root=await getSession(p.org.rootSessionId);
   requireAllowedOrganization(organizationId);
   if(!org || org.currentRevision!==revision || org.projectId!==p.org.projectId
     || constraints.revision!==p.constraintsRevision || !root || root.projectId!==p.org.projectId
     || root.activeRunId || String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim()!==actor.principalId
     || process.env.RAGENT_FACTORY_SCHEDULER_ENABLED==='1') fail('Setup authority changed');
  };
  const result=await provisionFrozenRevision({organizationId,revision,createManagedSession:createManagedSessionForNode,beforeNode});
  const nodes=await listOrganizationNodes(organizationId),node=nodes.find(n=>n.stableKey===p.stableKey);
  if(result.state!=='provisioned' || !node || node.nodeRole!=='specialist' || node.createdRevision!==revision
    || !node.currentSessionId || node.grant?.canWrite!==false || node.grant?.accessMode!=='read_only'
    || node.grant?.allowedCapabilities?.includes('write')
    || !['read','run'].every(c=>node.grant?.allowedCapabilities?.includes(c))
    || result.sessions?.some(s=>s.runId)) fail('Node provisioning is incomplete');
  const session=await getSession(node.currentSessionId);
  if(!session || session.organizationId!==organizationId || session.organizationNodeId!==node.id
    || session.organizationRevision!==revision || session.tool!=='codex' || session.model!==p.runtime.model
    || session.effort!==p.runtime.effort || text(session.providerProfile)!==p.runtime.provider) fail('Managed Session identity is unavailable');
  await withDatabase(db=>{
   db.exec('BEGIN IMMEDIATE');
   try {
    const changed=db.prepare("UPDATE factory_owner_report_scope SET node_id=?,state='awaiting_responsibility' WHERE organization_id=? AND command_id=? AND state='pending'").run(node.id,organizationId,commandId);
    if(changed.changes!==1) fail('Scope changed');
    const updated=db.prepare("UPDATE owner_report_setup_operations SET state='completed',node_id=?,updated_at=? WHERE command_id=? AND state='running' AND worker_pid=?").run(node.id,new Date().toISOString(),commandId,process.pid);
    if(updated.changes!==1) fail('Setup ownership changed');
    db.exec('COMMIT');
   } catch(e) {try{db.exec('ROLLBACK');}catch{}throw e;}
  },{mutate:true});
 } catch(e) {
  await withDatabase(db=>db.prepare("UPDATE owner_report_setup_operations SET state='unknown',error_code=?,updated_at=? WHERE command_id=? AND state='running' AND worker_pid=?").run(text(e.code)||'OWNER_REPORT_PROVISION_UNKNOWN',new Date().toISOString(),commandId,process.pid),{mutate:true});
  throw e;
 }
 return getOwnerReportNodeOperation(organizationId,commandId,actor);
}

// Bind and close are explicit, idempotent owner actions. Closing never turns on scheduling.
export async function changeOwnerReportScope(organizationId,action,input,actor) {
 owner(actor); requireAllowedOrganization(organizationId); const commandId=text(input?.commandId),key=text(input?.idempotencyKey),responsibilityId=text(input?.responsibilityId);
 if(!['bind','close'].includes(action) || input?.confirmed!==true || !/^[A-Za-z0-9_.:-]{1,120}$/.test(commandId) || !/^[A-Za-z0-9_.:-]{1,160}$/.test(key)
   || (action==='bind' && (!responsibilityId || !Number.isSafeInteger(input?.expectedVersion)))) fail('Invalid scope action','OWNER_REPORT_SETUP_INVALID',400);
 const payloadDigest=hash({organizationId,action,responsibilityId,expectedVersion:input?.expectedVersion ?? null});
 return withDatabase(db=>{db.exec('BEGIN IMMEDIATE');try {
  schema(db); const prior=db.prepare('SELECT * FROM owner_report_scope_actions WHERE command_id=? OR (actor_id=? AND idempotency_key=?)').get(commandId,actor.principalId,key);
  if(prior) {if(prior.command_id!==commandId||prior.actor_id!==actor.principalId||prior.idempotency_key!==key||prior.organization_id!==organizationId||prior.action!==action||prior.payload_digest!==payloadDigest) fail('Scope action identity conflicts');db.exec('COMMIT');return {...JSON.parse(prior.result_json),replayed:true};}
  const scope=db.prepare("SELECT * FROM factory_owner_report_scope WHERE organization_id=? AND state<>'closed'").get(organizationId),org=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId);
  if(!scope || !org || scope.owner_id!==actor.principalId || org.project_id!==scope.project_id || String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim()!==actor.principalId || process.env.RAGENT_FACTORY_SCHEDULER_ENABLED==='1') fail('Scope or scheduler authority changed');
  const now=new Date().toISOString();
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_scheduler_leases'").get() && db.prepare('SELECT 1 FROM factory_scheduler_leases WHERE organization_id=? AND expires_at>?').get(organizationId,now)) fail('A scheduler lease is active');
  if(action==='bind') {
   if(scope.state!=='awaiting_responsibility' || scope.work_item_id || !scope.node_id) fail('Scope cannot be bound');
   const r=db.prepare('SELECT * FROM responsibilities WHERE id=? AND organization_id=? AND project_id=? AND owner_principal_id=?').get(responsibilityId,organizationId,scope.project_id,actor.principalId);
   if(!r || r.row_version!==input.expectedVersion || !['draft','active'].includes(r.lifecycle)) fail('Responsibility changed');
   const p=db.prepare('SELECT policy_json,valid_until FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,r.policy_revision);
   let policy; try {policy=JSON.parse(p?.policy_json || '{}');validateProjectReportPolicy(policy,scope.project_id);} catch {fail('Report policy unavailable');}
   if(policy.providerId!=='project-report' || policy.nodeBindings?.report?.nodeId!==scope.node_id || policy.maxAttempts!==1 || policy.maxCost!==scope.max_cost || policy.dailyBudget?.maxRuns!==1 || policy.dailyBudget?.maxTokens!==scope.max_tokens || policy.dailyBudget?.maxCost!==scope.max_cost || !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until)<=Date.now()) fail('Report policy does not match the authorized scope');
   const node=db.prepare('SELECT node_role,binding_generation,grant_json,current_session_id FROM organization_nodes WHERE id=? AND organization_id=? AND retired_revision IS NULL').get(scope.node_id,organizationId);
   let grant;try{grant=JSON.parse(node?.grant_json || '{}');}catch{fail('Node grant unavailable');}
   if(!node?.current_session_id || node.node_role!=='specialist' || node.binding_generation!==policy.nodeBindings.report.bindingGeneration || grant.canWrite!==false || grant.accessMode!=='read_only' || grant.allowedCapabilities?.includes('write') || !['read','run'].every(c=>grant.allowedCapabilities?.includes(c))) fail('Read-only node binding changed');
   db.prepare("UPDATE factory_owner_report_scope SET state='ready',responsibility_id=? WHERE organization_id=? AND state='awaiting_responsibility'").run(r.id,organizationId);
  } else {
   const setup=db.prepare('SELECT state,budget_change_json FROM owner_report_setup_operations WHERE command_id=? AND organization_id=?').get(scope.command_id,organizationId);
   if(scope.state==='pending') {
    if(setup?.state!=='unknown') fail('Setup is still in progress');
   } else if(!['awaiting_responsibility','ready'].includes(scope.state)) fail('Scope cannot be closed');
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_execution_bindings'").get() && db.prepare("SELECT 1 FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE w.organization_id=? AND b.status IN ('intent','running','unknown')").get(organizationId)) fail('Execution remains active or unknown');
   factsInDb(db,organizationId); // Unsettled or unknown usage must be reconciled first.
   let change,budget,policy; try {change=JSON.parse(setup.budget_change_json);budget=JSON.parse(org.budget_json);policy=JSON.parse(org.policy_json);} catch {fail('Original budget evidence is unavailable');}
   for(const [current,before,after,keys] of [[budget,change.budgetBefore,change.budgetAfter,['maxTotalRuns','maxTokens','maxCost','maxConcurrent']],[policy,change.policyBefore,change.policyAfter,['factoryMaxConcurrent']]]) {
    for(const key of keys) if(!Object.hasOwn(before,key)) {if(current[key]!==after[key]) fail('Organization budget changed; review before closing');delete current[key];}
   }
   db.prepare('UPDATE organizations SET budget_json=?,policy_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(budget),JSON.stringify(policy),now,organizationId);
   db.prepare("UPDATE factory_owner_report_scope SET state='closed' WHERE command_id=? AND state IN ('pending','awaiting_responsibility','ready')").run(scope.command_id);
   db.prepare("UPDATE owner_report_setup_operations SET state='cancelled',updated_at=? WHERE command_id=? AND state='unknown'").run(now,scope.command_id);
  }
  const result={organizationId,state:action==='bind'?'ready':'closed',responsibilityId:action==='bind'?responsibilityId:(scope.responsibility_id || null),schedulerEnabled:false};
  db.prepare('INSERT INTO owner_report_scope_actions VALUES (?,?,?,?,?,?,?,?)').run(commandId,actor.principalId,key,organizationId,action,payloadDigest,JSON.stringify(result),now);
  db.exec('COMMIT');return result;
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}},{mutate:true});
}
