import { digest, factoryError, factoryTransaction, newId, now, encode, itemRow, goalRow, event } from './work-graph-store.mjs';
import { authorize, required } from './work-graph.mjs';

// A formula is data, not code or a source of authority. Callers must submit the
// resulting proposal through the same Factory Control authorization boundary.
const FORMULAS = Object.freeze({
  'agentoc-project-report@1': Object.freeze({
    id:'agentoc-project-report', version:1,
    source:'docs/ragent-2.0-autonomy/phase-d-context-organization.zh.md',
    roles:['specialist'], capabilities:['read'],
    rules:[{key:'report',kind:'execution',role:'specialist',accessMode:'read',criteria:['report-reviewed']}],
  }),
  'agentoc-responsibility-planner@1': Object.freeze({
    id:'agentoc-responsibility-planner', version:1,
    source:'docs/ragent-2.0-autonomy/phase-d-context-organization.zh.md',
    roles:['specialist'], capabilities:['read'],
    rules:[{key:'planning',kind:'execution',role:'specialist',accessMode:'read',criteria:['plan-reviewed']}],
  }),
  'agentoc-reviewed-change@1': Object.freeze({
    id:'agentoc-reviewed-change', version:1,
    source:'docs/factory-runtime/phase-4-delivery.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen']},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
  'agentoc-reviewed-change@2': Object.freeze({
    id:'agentoc-reviewed-change', version:2,
    source:'docs/factory-runtime/phase-4-delivery.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen'],independentReview:true},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
  'agentoc-reviewed-change@3': Object.freeze({
    id:'agentoc-reviewed-change', version:3,
    source:'docs/ragent-2.0-autonomy/phase-a-execution-closure.zh.md',
    roles:['writer','reviewer'], capabilities:['read','write','review'],
    rules:[
      {key:'implementation',kind:'execution',role:'writer',criteria:['candidate-frozen','registered-check'],independentReview:true},
      {key:'review',kind:'review',role:'reviewer',criteria:['review-recorded'],dependsOn:{key:'implementation',milestone:'candidate_ready'}},
      {key:'integration',kind:'integration',role:'writer',criteria:['integration-recorded'],dependsOn:{key:'review',milestone:'accepted'}},
    ],
  }),
});
function invalid(message) { throw factoryError('FACTORY_INVALID',message,400); }
function string(v,name) { if (typeof v!=='string'||!v.trim()||v.length>1024) invalid(`${name} is required`); return v.trim(); }
function safePath(v) { string(v,'path'); if (/^(?:[A-Za-z]:|[\\/])/.test(v)||v.split(/[\\/]/).some(s=>s==='..'||s==='.'||!s)) invalid('Paths must be normalized project-relative paths'); return v; }
function safeBranch(v) { string(v,'targetBranch'); if (v.startsWith('-')||v.includes('..')||/[\s~^:?*\[\\]/.test(v)||v.endsWith('/')||v.includes('@{')) invalid('Invalid target branch'); return v; }
export function getFactoryFormula(id,version=1) { const f=FORMULAS[`${id}@${version}`]; if (!f) throw factoryError('FACTORY_NOT_FOUND','Formula version not found',404); return {...structuredClone(f),digest:digest(f)}; }
export function compileFactoryWorkflow({templateId,templateVersion=1,organizationId,projectId,objective,targetBranch,allowedPaths,candidateScope,maxAttempts,maxCost,checkActionId,resource}={}) {
  const formula=getFactoryFormula(templateId,templateVersion); string(organizationId,'organizationId'); string(projectId,'projectId'); string(objective,'objective');
  const report=['agentoc-project-report','agentoc-responsibility-planner'].includes(templateId) && templateVersion===1;
  if(report) { if(!resource || resource.projectId!==projectId || resource.readScope!=='entire_project' || !['deny','inherit_existing_permissions'].includes(resource.networkPolicy) || Object.keys(resource).sort().join(',')!=='networkPolicy,projectId,readScope') invalid('Explicit whole-project read and network authority is required'); }
  else { safeBranch(targetBranch); if (!Array.isArray(allowedPaths)||!allowedPaths.length) invalid('allowedPaths are required'); allowedPaths.forEach(safePath); safePath(candidateScope); if (!allowedPaths.some(path=>candidateScope===path || candidateScope.startsWith(path+'/'))) invalid('candidateScope must be within an allowed path'); }
  if (!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10) invalid('maxAttempts must be between 1 and 10'); if (!Number.isFinite(maxCost)||maxCost<=0) invalid('A positive cost budget is required');
  const reservationCost=maxCost/(formula.rules.length*maxAttempts); if (!Number.isFinite(reservationCost)||reservationCost<=0) invalid('Cost budget is too small to reserve');
  if (templateId==='agentoc-reviewed-change' && templateVersion===3) string(checkActionId,'checkActionId');
  if(report) { const input={organizationId,projectId,objective,resource,maxAttempts,maxCost}; return {schemaVersion:1,templateId:formula.id,templateVersion:formula.version,templateDigest:formula.digest,inputDigest:digest(input),goal:{organizationId,projectId,objective},resources:{roles:formula.roles,capabilities:formula.capabilities,maxAttempts,maxCost},workItems:formula.rules.map(rule=>({key:rule.key,kind:rule.kind,requiredRole:rule.role,contract:{objective,requiredRole:rule.role,acceptanceCriteria:rule.criteria.map(id=>({id,method:'manual'})),accessMode:'read',allowedPaths:[],resource,retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:reservationCost}},dependencies:[]}))}; }
  const input={organizationId,projectId,objective,targetBranch,allowedPaths:[...allowedPaths],candidateScope,maxAttempts,maxCost,...(templateVersion===3?{checkActionId}:{})};
  return {schemaVersion:1,templateId:formula.id,templateVersion:formula.version,templateDigest:formula.digest,inputDigest:digest(input),goal:{organizationId,projectId,objective},resources:{roles:formula.roles,capabilities:formula.capabilities,maxAttempts,maxCost},workItems:formula.rules.map(rule=>({key:rule.key,kind:rule.kind,requiredRole:rule.role,contract:{objective,requiredRole:rule.role,...(rule.independentReview?{independentReview:true}:{}),acceptanceCriteria:rule.criteria.map(id=>({id,...(id==='registered-check'?{method:'check',actionId:checkActionId}:id==='integration-recorded'?{}:{method:'manual'})})),allowedPaths:[...allowedPaths],accessMode:rule.kind==='review'?'read':'write',targetBranch,candidateScope,retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:reservationCost}},dependencies:rule.dependsOn?[{predecessorKey:rule.dependsOn.key,milestone:rule.dependsOn.milestone}]:[]}))};
}

// Model output can select only frozen owner catalog entries and ordering; it
// cannot supply command text, resources, limits or a new execution authority.
export function compileFactoryPlanSteps({plan,policy,organizationId,projectId,objective}) {
  if(plan?.schemaVersion!==1 || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length>16 || !Array.isArray(policy?.planCatalog)) invalid('Invalid bounded plan');
  if(!Number.isFinite(policy.planExecutionMaxCost) || policy.planExecutionMaxCost<=0 || !Number.isSafeInteger(policy.planExecutionMaxAttempts) || policy.planExecutionMaxAttempts<1) invalid('Plan execution limits are required');
  const byId=new Map(), entries=[];
  for(const step of plan.steps) {
    if(!step || Object.keys(step).sort().join(',')!=='dependsOn,entryDigest,entryId,id,nodeBindings,templateDigest,templateId,templateVersion' || typeof step.id!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(step.id) || byId.has(step.id) || typeof step.entryId!=='string' || !step.entryId || typeof step.entryDigest!=='string' || !step.entryDigest || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size!==step.dependsOn.length) invalid('Invalid plan step');
    const matches=policy.planCatalog.filter(e=>e.entryId===step.entryId);
    if(matches.length!==1) invalid('Step is not in the authorized catalog');
    const {entryDigest,...entryContents}=matches[0];
    if(entryDigest!==step.entryDigest || digest(entryContents)!==entryDigest || matches[0].templateId!==step.templateId || matches[0].templateVersion!==step.templateVersion || matches[0].templateDigest!==step.templateDigest || digest(matches[0].nodeBindings)!==digest(step.nodeBindings)) invalid('Catalog entry identity changed');
    const catalog=matches[0], proposal=compileFactoryWorkflow({...catalog,organizationId,projectId,objective});
    if(proposal.templateDigest!==step.templateDigest) invalid('Plan template changed');
    const entry={step,catalog,proposal}; byId.set(step.id,entry); entries.push(entry);
  }
  const order=[], active=new Set(), done=new Set();
  function visit(id) { if(active.has(id)) invalid('Plan contains a cycle'); if(done.has(id)) return; const entry=byId.get(id); if(!entry) invalid('Plan dependency does not exist'); active.add(id); for(const dependency of entry.step.dependsOn) { if(typeof dependency!=='string') invalid('Invalid dependency'); visit(dependency); } active.delete(id); done.add(id); order.push(entry); }
  for(const {step} of entries) visit(step.id);
  if(entries.reduce((sum,e)=>sum+e.catalog.maxCost,0)>policy.planExecutionMaxCost || entries.reduce((sum,e)=>sum+e.catalog.maxAttempts,0)>policy.planExecutionMaxAttempts) invalid('Plan exceeds execution limits');
  return order;
}

// The proposal is regenerated on the server and all graph facts are committed
// together. It never assigns an executor, approves contracts, or launches work.
export async function instantiateFactoryWorkflow(input,actor) {
  const proposal=compileFactoryWorkflow(input); const commandId=required(input.commandId,'commandId'), key=required(input.idempotencyKey,'idempotencyKey'), actorId=required(actor?.principalId,'authenticated principal');
  const payloadDigest=digest({templateId:proposal.templateId,templateVersion:proposal.templateVersion,inputDigest:proposal.inputDigest});
  return factoryTransaction(db=>{ const org=authorize(db,proposal.goal.organizationId,actor,'factory.CreateWorkItem'); if (org.project_id!==proposal.goal.projectId) throw factoryError('FACTORY_CONFLICT','Project does not match organization'); const existing=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actorId,'InstantiateWorkflow',proposal.goal.organizationId,key); if (existing) { if (existing.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Idempotency key reused with different inputs'); return {...JSON.parse(existing.result_json),replayed:true}; } if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const result=instantiateFactoryWorkflowInTransaction(db,proposal,org,commandId);
    db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,proposal.goal.organizationId,actorId,'InstantiateWorkflow',proposal.goal.organizationId,key,payloadDigest,encode(result),now()); return result; });
}

// Both owner instantiation and restricted admission share the template writer.
// The caller owns the transaction and must authorize all supplied assignments.
export function instantiateFactoryWorkflowInTransaction(db,proposal,org,commandId,{assignments=null}={}) {
  const ts=now(), goalId=newId('goal'), instanceId=newId('workflow');
  db.prepare('INSERT INTO factory_goals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(goalId,proposal.goal.organizationId,proposal.goal.projectId,null,encode({objective:proposal.goal.objective,acceptanceBaseline:[]}),1,1,'active',ts,ts);
  const mapping={};
  for (const spec of proposal.workItems) {
    const id=newId('work'); mapping[spec.key]=id;
    const state=assignments ? (spec.dependencies.length ? 'blocked' : 'ready') : 'proposed';
    const blocked=state==='blocked'?encode({code:'dependencies',predecessors:[]}):null;
    db.prepare('INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,goalId,proposal.goal.organizationId,proposal.goal.projectId,spec.kind,'active',state,'none',0,assignments?.[spec.key]?.nodeId||null,1,1,0,0,blocked,encode({workflowInstanceId:instanceId,templateKey:spec.key}),null,0,ts,ts);
    const contract={...spec.contract,organizationRevision:org.current_revision};
    db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(id,1,encode(contract),digest(contract),ts);
  }
  for (const spec of proposal.workItems) {
    for (const edge of spec.dependencies) db.prepare('INSERT INTO factory_dependencies VALUES(?,?,?,?,?)').run(mapping[edge.predecessorKey],mapping[spec.key],edge.milestone,null,ts);
    if (assignments && spec.dependencies.length) db.prepare('UPDATE factory_work_items SET blocked_json=? WHERE id=?').run(encode({code:'dependencies',predecessors:spec.dependencies.map(edge=>mapping[edge.predecessorKey])}),mapping[spec.key]);
  }
  db.prepare('INSERT INTO factory_workflow_instances VALUES(?,?,?,?,?,?,?,?,?)').run(instanceId,proposal.goal.organizationId,goalId,proposal.templateId,proposal.templateVersion,proposal.templateDigest,proposal.inputDigest,encode(mapping),ts);
  event(db,proposal.goal.organizationId,goalId,'WorkflowInstantiated',{instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping});
  return {schemaVersion:1,operation:{commandId,state:'completed'},instance:{id:instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping},goal:goalRow(db.prepare('SELECT * FROM factory_goals WHERE id=?').get(goalId)),items:Object.values(mapping).map(id=>itemRow(db,db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(id)))};
}
