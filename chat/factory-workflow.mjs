import { digest, factoryError } from './work-graph-store.mjs';

// A formula is data, not code or a source of authority. Callers must submit the
// resulting proposal through the same Factory Control authorization boundary.
const FORMULAS = Object.freeze({
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
});
function invalid(message) { throw factoryError('FACTORY_INVALID',message,400); }
function string(v,name) { if (typeof v!=='string'||!v.trim()||v.length>1024) invalid(`${name} is required`); return v.trim(); }
function safePath(v) { string(v,'path'); if (/^(?:[A-Za-z]:|[\\/])/.test(v)||v.split(/[\\/]/).some(s=>s==='..'||s==='.'||!s)) invalid('Paths must be normalized project-relative paths'); return v; }
function safeBranch(v) { string(v,'targetBranch'); if (v.startsWith('-')||v.includes('..')||/[\s~^:?*\[\\]/.test(v)||v.endsWith('/')||v.includes('@{')) invalid('Invalid target branch'); return v; }
export function getFactoryFormula(id,version=1) { const f=FORMULAS[`${id}@${version}`]; if (!f) throw factoryError('FACTORY_NOT_FOUND','Formula version not found',404); return {...structuredClone(f),digest:digest(f)}; }
export function compileFactoryWorkflow({templateId,templateVersion=1,organizationId,projectId,objective,targetBranch,allowedPaths,candidateScope,maxAttempts,maxCost}={}) {
  const formula=getFactoryFormula(templateId,templateVersion); string(organizationId,'organizationId'); string(projectId,'projectId'); string(objective,'objective'); safeBranch(targetBranch); if (!Array.isArray(allowedPaths)||!allowedPaths.length) invalid('allowedPaths are required'); allowedPaths.forEach(safePath); safePath(candidateScope); if (!allowedPaths.some(path=>candidateScope===path || candidateScope.startsWith(path+'/'))) invalid('candidateScope must be within an allowed path'); if (!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10) invalid('maxAttempts must be between 1 and 10'); if (!Number.isFinite(maxCost)||maxCost<=0) invalid('A positive cost budget is required');
  const reservationCost=maxCost/(formula.rules.length*maxAttempts); if (!Number.isFinite(reservationCost)||reservationCost<=0) invalid('Cost budget is too small to reserve');
  const input={organizationId,projectId,objective,targetBranch,allowedPaths:[...allowedPaths],candidateScope,maxAttempts,maxCost};
  return {schemaVersion:1,templateId:formula.id,templateVersion:formula.version,templateDigest:formula.digest,inputDigest:digest(input),goal:{organizationId,projectId,objective},resources:{roles:formula.roles,capabilities:formula.capabilities,maxAttempts,maxCost},workItems:formula.rules.map(rule=>({key:rule.key,kind:rule.kind,requiredRole:rule.role,contract:{objective,requiredRole:rule.role,acceptanceCriteria:rule.criteria.map(id=>({id,...(id==='integration-recorded'?{}:{method:'manual'})})),allowedPaths:[...allowedPaths],accessMode:rule.kind==='review'?'read':'write',targetBranch,candidateScope,retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:reservationCost}},dependencies:rule.dependsOn?[{predecessorKey:rule.dependsOn.key,milestone:rule.dependsOn.milestone}]:[]}))};
}

// The proposal is regenerated on the server and all graph facts are committed
// together. It never assigns an executor, approves contracts, or launches work.
export async function instantiateFactoryWorkflow(input,actor) {
  const {factoryTransaction,newId,now,encode,itemRow,goalRow,event}=await import('./work-graph-store.mjs');
  const {authorize,required}=await import('./work-graph.mjs');
  const proposal=compileFactoryWorkflow(input); const commandId=required(input.commandId,'commandId'), key=required(input.idempotencyKey,'idempotencyKey'), actorId=required(actor?.principalId,'authenticated principal');
  const payloadDigest=digest({templateId:proposal.templateId,templateVersion:proposal.templateVersion,inputDigest:proposal.inputDigest});
  return factoryTransaction(db=>{ const org=authorize(db,proposal.goal.organizationId,actor,'factory.CreateWorkItem'); if (org.project_id!==proposal.goal.projectId) throw factoryError('FACTORY_CONFLICT','Project does not match organization'); const existing=db.prepare('SELECT * FROM factory_command_receipts WHERE actor_id=? AND command_type=? AND target_id=? AND idempotency_key=?').get(actorId,'InstantiateWorkflow',proposal.goal.organizationId,key); if (existing) { if (existing.payload_digest!==payloadDigest) throw factoryError('FACTORY_CONFLICT','Idempotency key reused with different inputs'); return {...JSON.parse(existing.result_json),replayed:true}; } if (db.prepare('SELECT 1 FROM factory_command_receipts WHERE command_id=?').get(commandId)) throw factoryError('FACTORY_CONFLICT','Command ID already used');
    const ts=now(), goalId=newId('goal'), instanceId=newId('workflow'); db.prepare('INSERT INTO factory_goals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(goalId,proposal.goal.organizationId,proposal.goal.projectId,null,encode({objective:proposal.goal.objective,acceptanceBaseline:[]}),1,1,'active',ts,ts); const mapping={};
    for (const spec of proposal.workItems) { const id=newId('work'); mapping[spec.key]=id; db.prepare('INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,goalId,proposal.goal.organizationId,proposal.goal.projectId,spec.kind,'active','proposed','none',0,null,1,1,0,0,null,encode({workflowInstanceId:instanceId,templateKey:spec.key}),null,0,ts,ts); db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(id,1,encode({...spec.contract,organizationRevision:org.current_revision}),digest({...spec.contract,organizationRevision:org.current_revision}),ts); }
    for (const spec of proposal.workItems) for (const edge of spec.dependencies) db.prepare('INSERT INTO factory_dependencies VALUES(?,?,?,?,?)').run(mapping[edge.predecessorKey],mapping[spec.key],edge.milestone,null,ts);
    db.prepare('INSERT INTO factory_workflow_instances VALUES(?,?,?,?,?,?,?,?,?)').run(instanceId,proposal.goal.organizationId,goalId,proposal.templateId,proposal.templateVersion,proposal.templateDigest,proposal.inputDigest,encode(mapping),ts); event(db,proposal.goal.organizationId,goalId,'WorkflowInstantiated',{instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping}); const result={schemaVersion:1,operation:{commandId,state:'completed'},instance:{id:instanceId,templateId:proposal.templateId,templateVersion:proposal.templateVersion,templateDigest:proposal.templateDigest,inputDigest:proposal.inputDigest,mapping},goal:goalRow(db.prepare('SELECT * FROM factory_goals WHERE id=?').get(goalId)),items:Object.values(mapping).map(id=>itemRow(db,db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(id)))}; db.prepare('INSERT INTO factory_command_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,proposal.goal.organizationId,actorId,'InstantiateWorkflow',proposal.goal.organizationId,key,payloadDigest,encode(result),ts); return result; });
}
