import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { factoryRead, factoryTransaction, factoryError, decode, encode, now } from './work-graph-store.mjs';
import { authorize, selectItem } from './work-graph.mjs';
import { verifyFactoryCandidate, preflightFactoryWorkspace } from './factory-candidates.mjs';
import { checkFactoryBaseline, checkedFactoryTarget, factoryTargetBranch, factoryTargetHead } from './factory-integration.mjs';
import { createStagingWorkspace, discardStaging } from './managed-writer.mjs';

const fail=message=>{throw factoryError('FACTORY_INTEGRATION_BLOCKED',message);};
const sha=value=>createHash('sha256').update(value).digest('hex');
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_integration_queue (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, target_root TEXT NOT NULL, target_branch TEXT NOT NULL,
 base_head TEXT NOT NULL, inputs_json TEXT NOT NULL, input_digest TEXT NOT NULL, state TEXT NOT NULL,
 workspace TEXT, combination_digest TEXT, manifest_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS factory_combination_validations (
 queue_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, validation_work_item_id TEXT NOT NULL UNIQUE,
 combination_digest TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS factory_integration_queue_receipts (
 organization_id TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL, queue_id TEXT NOT NULL, PRIMARY KEY(organization_id,actor_id,idempotency_key));`); }
function inputs(db,orgId,list) {
  return list.map(input=>{
    const item=selectItem(db,orgId,input.workItemId);
    if(item.state!=='completed'||item.control_state!=='none'||item.candidate_digest!==input.candidateDigest) fail('Candidate is not accepted or changed');
    const binding=db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND status='candidate'").get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    const details=decode(db.prepare('SELECT details_json FROM factory_candidates WHERE work_item_id=? AND digest=? AND contract_revision=? AND execution_epoch=?').get(item.id,item.candidate_digest,item.contract_revision,item.execution_epoch)?.details_json,{});
    if(input.contractRevision!==undefined && (input.contractRevision!==item.contract_revision || input.executionEpoch!==item.execution_epoch
      || input.bindingGeneration!==item.binding_generation || input.candidateId!==details.candidateId)) fail('Pinned candidate execution identity changed');
    const b=binding&&{status:binding.status,dispatchKey:binding.dispatch_key,contractRevision:binding.contract_revision,executionEpoch:binding.execution_epoch,bindingGeneration:binding.binding_generation,runId:binding.run_id,attemptId:binding.attempt_id,collaborationId:binding.collaboration_id};
    if(!b||!verifyFactoryCandidate({db,binding:b,item:{id:item.id},payload:{candidateId:details.candidateId,digest:item.candidate_digest}})) fail('Candidate evidence changed');
    const base=decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${binding.dispatch_key}`)?.files_json,null);
    const changes=decode(db.prepare('SELECT files_json FROM factory_candidate_payloads WHERE candidate_id=?').get(details.candidateId)?.files_json,null);
    if(!base?.source||!base?.workspace||!Array.isArray(base.files)||!Array.isArray(changes)) fail('Candidate baseline unavailable');
    const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision)?.contract_json,{});
    if(contract.integrationApprovalRequired===true) fail('This candidate requires a separate integration approval');
    if(typeof contract.targetBranch!=='string'||!contract.targetBranch.trim()||contract.targetBranch.trim()!==base.source.branch) fail('Candidate target branch does not match its authorized contract');
    return {item,base,changes,candidateId:details.candidateId};
  });
}
export function verifyFactoryIntegrationQueue(db,{organizationId,queueId,combinationDigest,allowedStates=['materialized']}) {
  schema(db); const row=db.prepare('SELECT * FROM factory_integration_queue WHERE id=? AND organization_id=?').get(queueId,organizationId);
  if(!row||!allowedStates.includes(row.state)||row.combination_digest!==combinationDigest) fail('Combination identity is stale or unavailable');
  const frozen=decode(row.inputs_json,[]); if(sha(JSON.stringify(frozen))!==row.input_digest) fail('Combination input identity changed');
  const all=inputs(db,organizationId,frozen), base=all[0]?.base;
  if(!base||all.some(x=>!compareBase(base,x.base))||base.source.head!==row.base_head||base.source.branch!==row.target_branch||base.workspace.canonicalCwd!==row.target_root) fail('Combination base changed');
  const manifest=decode(row.manifest_json,null);
  if(!Array.isArray(manifest)||sha(JSON.stringify({baseHead:row.base_head,inputDigest:row.input_digest,manifest}))!==row.combination_digest) fail('Combination manifest changed');
  return {row,base,all,manifest};
}
export function loadFactoryCombination(db,organizationId,queueId,{allowedStates=['materialized']}={}) {
  schema(db); const row=db.prepare('SELECT * FROM factory_integration_queue WHERE id=? AND organization_id=?').get(queueId,organizationId);
  if(!row) fail('Queue entry not found');
  if(db.prepare("SELECT 1 FROM factory_integration_queue WHERE target_root=? AND state IN ('queued','materialized','applying','applied_unverified','workspace_applied_verified','committing','commit_verified') AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1").get(row.target_root,row.created_at,row.created_at,row.id)) fail('Earlier integration is pending');
  return verifyFactoryIntegrationQueue(db,{organizationId,queueId,combinationDigest:row.combination_digest,allowedStates});
}
export async function attachFactoryCombinationValidation(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  return factoryTransaction(db=>{schema(db);authorize(db,input.organizationId,actor,'factory.IntegrateWork');
    const data=loadFactoryCombination(db,input.organizationId,input.queueId), item=selectItem(db,input.organizationId,input.validationWorkItemId);
    const old=db.prepare('SELECT * FROM factory_combination_validations WHERE queue_id=?').get(data.row.id);
    if(old) {if(old.validation_work_item_id!==item.id||old.combination_digest!==data.row.combination_digest) fail('Combination validation identity conflicts');return {queueId:data.row.id,validationWorkItemId:item.id,combinationDigest:old.combination_digest,replayed:true};}
    if(item.row_version!==input.expectedVersion||item.project_id!==data.all[0].item.project_id||!['proposed','ready'].includes(item.state)||item.control_state!=='none') fail('Validation Work Item changed');
    const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision)?.contract_json,{});
    if(contract.accessMode!=='read') fail('Combination validation requires a read-scoped Work Item');
    db.prepare('INSERT INTO factory_combination_validations VALUES(?,?,?,?,?)').run(data.row.id,input.organizationId,item.id,data.row.combination_digest,now());
    return {queueId:data.row.id,validationWorkItemId:item.id,combinationDigest:data.row.combination_digest}; });
}
export async function findFactoryCombinationValidation(organizationId,workItemId,actor) {
  return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');return db.prepare('SELECT * FROM factory_combination_validations WHERE organization_id=? AND validation_work_item_id=?').get(organizationId,workItemId)||null;});
}
export async function prepareFactoryCombinationValidation({organizationId,workItemId,binding,actor}) {
  const data=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.execution');const map=db.prepare('SELECT * FROM factory_combination_validations WHERE organization_id=? AND validation_work_item_id=?').get(organizationId,workItemId);if(!map) fail('Combination validation mapping missing');
    const item=selectItem(db,organizationId,workItemId);if(item.state!=='claimed'||item.execution_epoch!==binding.executionEpoch||item.contract_revision!==binding.contractRevision||item.binding_generation!==binding.bindingGeneration) fail('Validation binding changed');
    const combo=verifyFactoryIntegrationQueue(db,{organizationId,queueId:map.queue_id,combinationDigest:map.combination_digest});const contract=decode(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision)?.contract_json,{});
    const outputPaths=Array.isArray(contract.outputPaths)?contract.outputPaths:[];
    if(outputPaths.some(p=>typeof p!=='string'||!p||p.startsWith('/')||p.includes('\\')||/^[A-Za-z]:/.test(p)||p.split('/').some(part=>!part||part==='.'||part==='..'))||outputPaths.some(o=>combo.manifest.some(f=>f.path===o||f.path.startsWith(`${o}/`)||o.startsWith(`${f.path}/`)))) fail('Invalid or overlapping validation output paths');
    const prior=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_validation_workspaces'").get() && db.prepare('SELECT * FROM factory_validation_workspaces WHERE id=?').get(`validation:${binding.id}`);
    return {...combo,map,outputPaths,prior};});
  const {checkWorkspace}=await import('./factory-checks.mjs');
  if(await factoryTargetHead(data.row.target_root)!==data.row.base_head||await factoryTargetBranch(data.row.target_root)!==data.row.target_branch) fail('Combination target changed; validation is stale');
  await checkWorkspace({cwd:data.row.workspace,input_manifest_json:data.row.manifest_json,output_paths_json:'[]'});
  if(data.prior) {if(data.prior.state!=='prepared'||data.prior.run_id||data.prior.session_id||data.prior.candidate_digest!==data.row.combination_digest||data.prior.provenance!=='combination_materialized'||data.prior.input_manifest_json!==data.row.manifest_json||data.prior.output_paths_json!==encode(data.outputPaths)) fail('Prior validation workspace differs');
    await checkWorkspace(data.prior);return {id:data.prior.id,cwd:data.prior.cwd,candidateDigest:data.prior.candidate_digest};}
  await preflightFactoryWorkspace({canonicalCwd:data.row.workspace,writablePaths:data.base.workspace.writablePaths});
  const stage=await createStagingWorkspace({canonicalCwd:data.row.workspace,writablePaths:data.base.workspace.writablePaths,includeRootReferenceFiles:false});
  try {await checkWorkspace({cwd:stage.stagingDir,input_manifest_json:data.row.manifest_json,output_paths_json:'[]'});
    await factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.execution');verifyFactoryIntegrationQueue(db,{organizationId,queueId:data.map.queue_id,combinationDigest:data.map.combination_digest});
      const item=selectItem(db,organizationId,workItemId);if(item.state!=='claimed'||item.execution_epoch!==binding.executionEpoch||item.contract_revision!==binding.contractRevision||item.binding_generation!==binding.bindingGeneration) fail('Validation binding changed');
      db.exec(`CREATE TABLE IF NOT EXISTS factory_validation_workspaces (id TEXT PRIMARY KEY, validation_work_item_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, candidate_digest TEXT NOT NULL, state TEXT NOT NULL, provenance TEXT NOT NULL, input_manifest_json TEXT NOT NULL, output_paths_json TEXT NOT NULL)`);
      db.prepare('INSERT INTO factory_validation_workspaces VALUES(?,?,?,?,?,?,?,?,?,?)').run(`validation:${binding.id}`,workItemId,'','',stage.stagingDir,data.row.combination_digest,'prepared','combination_materialized',data.row.manifest_json,encode(data.outputPaths));});
    return {id:`validation:${binding.id}`,cwd:stage.stagingDir,candidateDigest:data.row.combination_digest};
  } catch(error) {await discardStaging(stage.stagingDir).catch(()=>{});throw error;}
}
function compareBase(base,other) {
  return base.source.head===other.source.head && base.source.branch===other.source.branch
    && base.workspace.canonicalCwd===other.workspace.canonicalCwd
    && JSON.stringify(base.workspace.writablePaths)===JSON.stringify(other.workspace.writablePaths)
    && JSON.stringify(base.files)===JSON.stringify(other.files);
}
// Owner submits identities only; every payload and acceptance fact is loaded by the server.
export async function enqueueFactoryIntegration(input,actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  const org=input?.organizationId,list=input?.candidates,key=input?.idempotencyKey;
  if(!org||typeof key!=='string'||!key.trim()||key.length>255||!Array.isArray(list)||list.length<1||list.length>20||list.some(x=>!x?.workItemId||!/^[a-f0-9]{64}$/.test(x.candidateDigest||''))||new Set(list.map(x=>x.workItemId)).size!==list.length) fail('Ordered distinct candidate identities and idempotency key required');
  const requested=list.map(({workItemId,candidateDigest})=>({workItemId,candidateDigest}));
  return factoryTransaction(db=>{schema(db);authorize(db,org,actor,'factory.IntegrateWork'); const requestDigest=sha(JSON.stringify(requested));
    const receipt=db.prepare('SELECT * FROM factory_integration_queue_receipts WHERE organization_id=? AND actor_id=? AND idempotency_key=?').get(org,actor.principalId,key);
    if(receipt) {if(receipt.request_digest!==requestDigest) fail('Idempotency key belongs to another candidate set'); const prior=db.prepare('SELECT * FROM factory_integration_queue WHERE id=?').get(receipt.queue_id); if(!prior) fail('Queue receipt has no operation'); return {id:prior.id,state:prior.state,inputDigest:prior.input_digest,baseHead:prior.base_head,candidates:decode(prior.inputs_json,[]),replayed:true};}
    const all=inputs(db,org,requested),base=all[0].base;
    const frozen=all.map(x=>({workItemId:x.item.id,candidateDigest:x.item.candidate_digest,contractRevision:x.item.contract_revision,executionEpoch:x.item.execution_epoch,bindingGeneration:x.item.binding_generation,candidateId:x.candidateId})), identity=sha(JSON.stringify(frozen));
    if(all.some(x=>!compareBase(base,x.base))) fail('Candidates do not share the same baseline');
    const paths=new Set(); let bytes=0; for(const source of all) for(const change of source.changes) { if(paths.has(change.path)) fail('Candidate paths conflict; resolve the conflict explicitly'); paths.add(change.path); if(change.bytes) bytes+=Buffer.byteLength(change.bytes,'base64'); }
    if(paths.size>1000||bytes>32*1024*1024) fail('Combination exceeds the file or byte limit; split the integration');
    const id=`integration_queue_${randomUUID()}`,ts=now(); db.prepare('INSERT INTO factory_integration_queue VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,org,base.workspace.canonicalCwd,base.source.branch,base.source.head,encode(frozen),identity,'queued',null,null,null,ts,ts);
    db.prepare('INSERT INTO factory_integration_queue_receipts VALUES(?,?,?,?,?)').run(org,actor.principalId,key,requestDigest,id); return {id,state:'queued',inputDigest:identity,baseHead:base.source.head,candidates:frozen}; });
}
export async function materializeFactoryIntegration({organizationId,id},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  const data=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.IntegrateWork');const row=db.prepare('SELECT * FROM factory_integration_queue WHERE id=? AND organization_id=?').get(id,organizationId);if(!row||row.state!=='queued') fail('Queue entry is not materializable');
    const earlier=db.prepare("SELECT 1 FROM factory_integration_queue WHERE target_root=? AND state IN ('queued','materialized','applying','applied_unverified','workspace_applied_verified','committing','commit_verified') AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1").get(row.target_root,row.created_at,row.created_at,row.id);if(earlier) fail('Earlier integration is pending');
    const frozen=decode(row.inputs_json,[]);if(sha(JSON.stringify(frozen))!==row.input_digest) fail('Queue input identity changed');const all=inputs(db,organizationId,frozen),base=all[0].base;if(all.some(x=>!compareBase(base,x.base))) fail('Candidate baseline changed');return {row,all,base};});
  const root=await realpath(data.base.workspace.canonicalCwd);
  if(await factoryTargetHead(root)!==data.row.base_head||await factoryTargetBranch(root)!==data.row.target_branch) { await factoryTransaction(db=>db.prepare("UPDATE factory_integration_queue SET state='stale',updated_at=? WHERE id=? AND state='queued'").run(now(),id)); fail('Target changed; combination evidence is stale'); }
  await preflightFactoryWorkspace({canonicalCwd:root,writablePaths:data.base.workspace.writablePaths}); await checkFactoryBaseline(root,data.base);
  const stage=await createStagingWorkspace({canonicalCwd:root,writablePaths:data.base.workspace.writablePaths,includeRootReferenceFiles:false});
  try { await checkFactoryBaseline(stage.stagingDir,data.base);const files=new Map(data.base.files.map(file=>[file.path,file]));const paths=new Set();
    for(const source of data.all) for(const change of source.changes) {if(paths.has(change.path)) fail('Candidate paths conflict');paths.add(change.path);const target=await checkedFactoryTarget(stage.stagingDir,change.path);if(change.type==='delete'){await rm(target);files.delete(change.path);}else{await mkdir(dirname(target),{recursive:true});await writeFile(target,Buffer.from(change.bytes,'base64'));files.set(change.path,change);}}
    const final=[...files.values()].sort((a,b)=>a.path.localeCompare(b.path));await checkFactoryBaseline(stage.stagingDir,{...data.base,files:final});
    if(await factoryTargetHead(root)!==data.row.base_head||await factoryTargetBranch(root)!==data.row.target_branch) fail('Target changed during materialization');
    await checkFactoryBaseline(root,data.base);
    const manifest=final.map(({path,digest})=>({path,digest}));const combinationDigest=sha(JSON.stringify({baseHead:data.row.base_head,inputDigest:data.row.input_digest,manifest}));
    await factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.IntegrateWork');const row=db.prepare('SELECT * FROM factory_integration_queue WHERE id=?').get(id);if(!row||row.state!=='queued'||row.input_digest!==data.row.input_digest) fail('Queue entry changed');inputs(db,organizationId,decode(row.inputs_json,[]));db.prepare("UPDATE factory_integration_queue SET state='materialized',workspace=?,combination_digest=?,manifest_json=?,updated_at=? WHERE id=? AND state='queued'").run(stage.stagingDir,combinationDigest,encode(manifest),now(),id);});
    return {id,state:'materialized',combinationDigest,workspace:stage.stagingDir,validation:'required'};
  } catch(error) {await discardStaging(stage.stagingDir).catch(()=>{});throw error;}
}

// Refresh only from the actual target repository; no caller-provided HEAD is
// evidence. Stale entries retain their identity and require a new combination.
export async function refreshFactoryIntegrationQueue({organizationId,id},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  const record=await factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.IntegrateWork');
    const row=db.prepare('SELECT * FROM factory_integration_queue WHERE organization_id=? AND id=?').get(organizationId,id); if(!row) fail('Queue entry not found');return row;});
  const root=await realpath(record.target_root),head=await factoryTargetHead(root),branch=await factoryTargetBranch(root);
  return factoryTransaction(db=>{schema(db);authorize(db,organizationId,actor,'factory.IntegrateWork');
    db.prepare("UPDATE factory_integration_queue SET state='stale',updated_at=? WHERE organization_id=? AND target_root=? AND state IN ('queued','materialized') AND (base_head<>? OR target_branch<>?)").run(now(),organizationId,record.target_root,head,branch);
    const row=db.prepare('SELECT * FROM factory_integration_queue WHERE organization_id=? AND id=?').get(organizationId,id);
    return {id:row.id,state:row.state,baseHead:row.base_head,currentHead:head,currentBranch:branch,combinationDigest:row.combination_digest,validation:'required'};});
}

export async function getFactoryIntegrationQueue({organizationId,id},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');
    const row=db.prepare('SELECT * FROM factory_integration_queue WHERE organization_id=? AND id=?').get(organizationId,id);if(!row) fail('Queue entry not found');
    const hasCommits=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_combination_commits'").get();
    const operation=hasCommits?db.prepare('SELECT * FROM factory_combination_commits WHERE organization_id=? AND queue_id=?').get(organizationId,id):null;
    const hasReceipts=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_combination_receipts'").get();
    const receipt=hasReceipts&&operation?db.prepare('SELECT * FROM factory_combination_receipts WHERE operation_id=? AND organization_id=? AND queue_id=?').get(operation.id,organizationId,id):null;
    const members=receipt?decode(receipt.inputs_json,[]).map(input=>({workItemId:input.workItemId,candidateDigest:input.candidateDigest,
      integrated:!!db.prepare("SELECT 1 FROM factory_delivery_milestones WHERE organization_id=? AND work_item_id=? AND operation_id=? AND milestone='integrated' AND candidate_digest=?").get(organizationId,input.workItemId,`${operation.id}:${input.workItemId}`,input.candidateDigest)})):[];
    const recovery=operation?.state==='applying'||operation?.state==='applied_unverified'
      ? 'Inspect target branch, HEAD, index and affected files against the recorded baseline and combination; do not repeat the write until the outcome is established.'
      : operation?.state==='committing' ? 'Compare recorded commit and tree with target HEAD and reconcile any retained Git index lock before retrying this operation.'
      : row.state==='stale' ? 'Target changed; create and validate a new combination.' : null;
    return {id:row.id,state:row.state,targetRoot:row.target_root,targetBranch:row.target_branch,baseHead:row.base_head,
      candidates:decode(row.inputs_json,[]),inputDigest:row.input_digest,combinationDigest:row.combination_digest,
      workspace:row.workspace,manifest:decode(row.manifest_json,[]),operation:operation?{id:operation.id,state:operation.state,commitId:operation.commit_id,treeId:operation.tree_id,resultDigest:operation.result_digest}:null,
      receipt:receipt?{state:'commit_recorded',commitId:receipt.commit_id,treeId:receipt.tree_id,resultDigest:receipt.result_digest,combinationDigest:receipt.combination_digest,members}:null,recovery}; });
}

export async function listFactoryIntegrationQueue(organizationId,{cursor='',limit=50}={},actor) {
  if(actor?.kind!=='user'||actor.role!=='owner') fail('Owner required');
  let after=['',''];
  if(cursor) {try {after=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(after)||after.length!==2||after.some(x=>typeof x!=='string')) throw new Error();} catch {fail('Invalid queue cursor');}}
  const count=Number.isInteger(limit)?Math.max(1,Math.min(limit,100)):50;
  return factoryRead(db=>{schema(db);authorize(db,organizationId,actor,'factory.read');
    const rows=db.prepare(`SELECT id,state,target_branch,base_head,input_digest,combination_digest,created_at,updated_at
      FROM factory_integration_queue WHERE organization_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?`).all(organizationId,after[0],after[0],after[1],count+1);
    const more=rows.length>count, page=rows.slice(0,count),last=page.at(-1);
    return {items:page.map(row=>({id:row.id,state:row.state,targetBranch:row.target_branch,baseHead:row.base_head,inputDigest:row.input_digest,combinationDigest:row.combination_digest,createdAt:row.created_at,updatedAt:row.updated_at})),nextCursor:more?Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url'):null};});
}
