import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { factoryTransaction, factoryRead, factoryError, now, newId, encode, digest, event, itemRow } from './work-graph-store.mjs';
import { getSession } from './session-manager.mjs';
import { getRunAcceptanceEvidence } from './runs.mjs';
import { verifyRemoteFactoryAdmission, verifyRemoteFactoryCancellation } from './remote-factory-operations.mjs';
import { authorize, update } from './work-graph.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';
import { verifyFactoryCandidate } from './factory-candidates.mjs';

const fail=message=>{throw factoryError('REMOTE_ADMISSION_UNAVAILABLE',message,409);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git=promisify(execFile);
function gitEnvironment() {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_')));
  return {...env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};
}
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_remote_children (
 binding_id TEXT NOT NULL, operation_id TEXT NOT NULL, goal_id TEXT NOT NULL, work_item_id TEXT NOT NULL UNIQUE,
 operation_digest TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(binding_id,operation_id));
 CREATE TRIGGER IF NOT EXISTS factory_remote_children_no_update BEFORE UPDATE ON factory_remote_children BEGIN SELECT RAISE(ABORT,'immutable remote child'); END;
 CREATE TRIGGER IF NOT EXISTS factory_remote_children_no_delete BEFORE DELETE ON factory_remote_children BEGIN SELECT RAISE(ABORT,'immutable remote child'); END;
 CREATE TABLE IF NOT EXISTS factory_remote_cancel_receipts (cancel_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,operation_id TEXT NOT NULL,payload_digest TEXT NOT NULL,created_at TEXT NOT NULL);`); }
function facts(db,bindingId,operationId) {
  const b=db.prepare('SELECT * FROM remote_factory_bindings WHERE id=?').get(bindingId);
  const op=db.prepare('SELECT * FROM remote_factory_operations WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
  if(!b || !op || !b.enabled || b.version!==op.binding_version || b.source_instance_id!==op.source_instance_id
      || !b.expires_at || !Number.isFinite(Date.parse(b.expires_at)) || Date.parse(b.expires_at)<=Date.now()) fail('Remote authorization expired or changed');
  const scope=JSON.parse(b.scope_json), payload=JSON.parse(op.payload_json);
  const contractDigest=hash(payload.contract);
  if(!Array.isArray(scope)||!scope.includes(contractDigest)||!payload.sourceReservationId || !Number.isFinite(payload.reservedCost)
      || payload.reservedCost<=0 || payload.reservedCost>b.budget_limit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(payload.expectedBaseHead||'')
      || typeof payload.expectedBaseBranch!=='string' || !payload.expectedBaseBranch || !/^[a-f0-9]{64}$/.test(payload.expectedBaselineDigest||'')) fail('Remote contract, baseline or budget is outside binding');
  const canonical={bindingId,operationId,requestId:op.request_id,sourceFactoryBindingId:op.source_factory_binding_id,bindingVersion:op.binding_version,
    contractRevision:op.contract_revision,executionEpoch:op.execution_epoch,contractDigest,payload};
  if(hash(canonical)!==op.payload_digest) fail('Remote operation identity changed');
  verifyRemoteFactoryAdmission(db,{binding:{id:b.id,version:b.version,sourceInstanceId:b.source_instance_id,targetInstanceId:b.target_instance_id,
    organizationId:b.organization_id,projectId:b.project_id,nodeId:b.node_id,sessionId:b.session_id,nodeGeneration:b.node_generation},operation:canonical});
  return {binding:b,operation:op,payload,contractDigest};
}
function checkedContract(facts,org,node) {
  const c=facts.payload.contract, paths=c?.allowedPaths;
  if(!c || typeof c.objective!=='string' || !c.objective.trim() || c.objective.length>4096 || c.accessMode!=='write'
      || !Array.isArray(paths) || !paths.length || paths.some(p=>typeof p!=='string'||!p||p.includes('\\')||/^(?:[A-Za-z]:|[\\/])/.test(p)||p.split('/').some(s=>!s||s==='.'||s==='..'))
      || !Array.isArray(c.acceptanceCriteria) || !c.acceptanceCriteria.length) fail('Only scoped writer contracts are supported');
  if (typeof c.candidateScope!=='string' || !paths.some(path=>c.candidateScope===path||c.candidateScope.startsWith(`${path}/`))
      || typeof c.targetBranch!=='string' || !c.targetBranch || c.targetBranch.startsWith('-') || c.targetBranch.includes('..')
      || /[\s~^:?*\[\\]/.test(c.targetBranch) || c.targetBranch.endsWith('/') || c.targetBranch.includes('@{')) fail('Remote candidate scope or branch is invalid');
  const grant=JSON.parse(node.grant_json || '{}'), within=(path,root)=>path===root||path.startsWith(`${root}/`);
  if(grant.canWrite!==true || !Array.isArray(grant.writablePaths) || paths.some(path=>!grant.writablePaths.some(root=>within(path,root)))) fail('Target node write scope changed');
  for(const capability of ['run','write']) {
    const row=org.db.prepare('SELECT allow,scope_json FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(org.id,node.id,capability,org.current_revision);
    if(!row?.allow) fail('Target node grant is unavailable');
    const scope=JSON.parse(row.scope_json || '{}');
    if((scope.projectId&&scope.projectId!==org.project_id)||Object.keys(scope).some(k=>!['projectId','writablePaths'].includes(k))
      ||(capability==='write'&&Array.isArray(scope.writablePaths)&&paths.some(path=>!scope.writablePaths.some(root=>within(path,root))))) fail('Target grant scope changed');
  }
  return {objective:c.objective,acceptanceCriteria:[{id:'remote-execution-result',method:'manual'}],accessMode:'write',allowedPaths:paths,
    ...(typeof c.targetBranch==='string'?{targetBranch:c.targetBranch}:{}),...(typeof c.candidateScope==='string'?{candidateScope:c.candidateScope}:{}),
    retry:{maxAttempts:1},budget:{maxCost:facts.payload.reservedCost},budgetReservation:{cost:facts.payload.reservedCost},organizationRevision:org.current_revision};
}
// Invoked only by the authenticated target operation receiver. It creates a
// local execution child, never a source acceptance decision or a second runner.
export async function admitRemoteFactoryAttempt({binding,operation}={}) {
  if(process.env.AGENTOC_FACTORY_CONTROL_ENABLED!=='true'||process.env.AGENTOC_FACTORY_SCHEDULER_ENABLED!=='1') fail('Target Factory admission is disabled');
  if(!binding?.id||!operation?.operationId) fail('Remote operation identity required');
  const organizations=String(process.env.AGENTOC_FACTORY_ORGANIZATIONS || '').split(',').map(value=>value.trim()).filter(Boolean);
  if(!String(process.env.AGENTOC_FACTORY_SCHEDULER_OWNER_ID || '').trim() || !organizations.includes(binding.organizationId)) fail('Target organization is not enabled for Factory');
  const session=await getSession(binding.sessionId);
  if(!session || session.sessionPlane!=='organization' || session.organizationId!==binding.organizationId
      || session.organizationNodeId!==binding.nodeId || !session.templateId || !session.tool || !session.model || !session.effort) fail('Target managed session is unavailable');
  return factoryTransaction(db=>{
    schema(db); const f=facts(db,binding.id,operation.operationId), b=f.binding;
    if(b.version!==binding.version || b.organization_id!==binding.organizationId || b.project_id!==binding.projectId
        || b.node_id!==binding.nodeId || b.session_id!==binding.sessionId || b.node_generation!==binding.nodeGeneration
        || hash(operation)!==f.operation.payload_digest) fail('Remote admission facts changed');
    const existing=db.prepare('SELECT * FROM factory_remote_children WHERE binding_id=? AND operation_id=?').get(b.id,f.operation.operation_id);
    if(existing) { if(existing.operation_digest!==f.operation.payload_digest) fail('Remote child identity conflicts'); return {status:'unknown',reason:'target_work_pending',workItemId:existing.work_item_id}; }
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(b.organization_id), node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(b.node_id,b.organization_id);
    if(!org || org.project_id!==b.project_id || ['archived','lifecycle_pending'].includes(org.state) || !node || node.retired_revision!==null || !['active','ready','provisioned'].includes(node.lifecycle_state)
        || node.current_session_id!==b.session_id || node.binding_generation!==b.node_generation || session.organizationRevision!==org.current_revision) fail('Target organization or managed node changed');
    const contract=checkedContract(f,{...org,db},node), ts=now(), goalId=newId('goal'), workId=newId('work');
    const parentRemoteOperation={bindingId:b.id,bindingVersion:b.version,operationId:f.operation.operation_id,requestId:f.operation.request_id,
      sourceFactoryBindingId:f.operation.source_factory_binding_id,contractRevision:f.operation.contract_revision,executionEpoch:f.operation.execution_epoch,
      contractDigest:f.contractDigest,nodeGeneration:b.node_generation};
    db.prepare('INSERT INTO factory_goals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(goalId,b.organization_id,b.project_id,null,encode({objective:contract.objective,acceptanceBaseline:[],parentRemoteOperation}),1,1,'active',ts,ts);
    db.prepare('INSERT INTO factory_work_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(workId,goalId,b.organization_id,b.project_id,'execution','active','ready','none',0,b.node_id,1,1,0,0,null,encode({parentRemoteOperation}),null,0,ts,ts);
    db.prepare('INSERT INTO factory_work_contracts VALUES(?,?,?,?,?)').run(workId,1,encode(contract),digest(contract),ts);
    db.prepare('INSERT INTO factory_remote_children VALUES(?,?,?,?,?,?)').run(b.id,f.operation.operation_id,goalId,workId,f.operation.payload_digest,ts);
    event(db,b.organization_id,workId,'RemoteExecutionChildCreated',{parentRemoteOperation,sourceReservationId:f.payload.sourceReservationId});
    return {status:'unknown',reason:'target_work_pending',workItemId:workId};
  });
}
export function verifyRemoteFactoryChild(db,item,{bindingGeneration=item.binding_generation,requireDispatch=true}={}) {
  const source=JSON.parse(item.source_json || '{}'), parent=source.parentRemoteOperation;
  if(!parent) return null;
  if(requireDispatch && process.env.AGENTOC_REMOTE_FACTORY_ENABLED!=='1') fail('Remote Factory dispatch is disabled');
  const f=facts(db,parent.bindingId,parent.operationId), b=f.binding;
  const link=db.prepare('SELECT * FROM factory_remote_children WHERE binding_id=? AND operation_id=? AND work_item_id=?').get(parent.bindingId,parent.operationId,item.id);
  if(!link || link.operation_digest!==f.operation.payload_digest || parent.bindingVersion!==b.version || parent.nodeGeneration!==bindingGeneration
      || b.node_generation!==bindingGeneration || b.organization_id!==item.organization_id || b.project_id!==item.project_id
      || b.node_id!==item.assignee_node_id || parent.requestId!==f.operation.request_id || parent.sourceFactoryBindingId!==f.operation.source_factory_binding_id
      || parent.contractRevision!==f.operation.contract_revision || parent.executionEpoch!==f.operation.execution_epoch || parent.contractDigest!==f.contractDigest) fail('Remote child fence changed');
  return {bindingId:b.id,operationId:f.operation.operation_id,sessionId:b.session_id,organizationId:b.organization_id,
    expectedBaseHead:f.payload.expectedBaseHead,expectedBaseBranch:f.payload.expectedBaseBranch,expectedBaselineDigest:f.payload.expectedBaselineDigest,
    allowedPaths:f.payload.contract.allowedPaths,taskSummary:f.payload.taskSummary || null,taskSummaryDigest:f.payload.taskSummaryDigest || null};
}
export async function assertRemoteTargetWorkspace(remote) {
  const {getOrganization}=await import('./organization-store.mjs');
  const org=await getOrganization(remote.organizationId), root=org?.rootSessionId && await getSession(org.rootSessionId);
  if(!root?.folder || !Array.isArray(remote.allowedPaths) || !remote.allowedPaths.length) fail('Target project root is unavailable');
  const projectRoot=await realpath(root.folder), options={cwd:projectRoot,windowsHide:true,timeout:15000,maxBuffer:1024*1024,env:gitEnvironment()};
  const [head,branch,status,top]=await Promise.all([
    git('git',['rev-parse','--verify','HEAD'],options),git('git',['symbolic-ref','--quiet','--short','HEAD'],options),
    git('git',['status','--porcelain=v1','--ignored','--untracked-files=all','--',...remote.allowedPaths],options),
    git('git',['rev-parse','--show-toplevel'],options),
  ]);
  const topRoot=await realpath(top.stdout.trim());
  if(process.platform==='win32'?topRoot.toLowerCase()!==projectRoot.toLowerCase():topRoot!==projectRoot) fail('Target project root is not its Git root');
  if(head.stdout.trim()!==remote.expectedBaseHead||branch.stdout.trim()!==remote.expectedBaseBranch||status.stdout.trim()) fail('Target workspace baseline changed or has untracked/ignored inputs');
}
export async function inspectSourceRemoteBaseline(rootPath,allowedPaths) {
  if(!rootPath || !Array.isArray(allowedPaths) || !allowedPaths.length) fail('Source baseline scope is unavailable');
  const root=await realpath(rootPath), options={cwd:root,windowsHide:true,timeout:15000,maxBuffer:4*1024*1024,env:gitEnvironment()};
  const [headResult,branchResult,status,tracked,top]=await Promise.all([
    git('git',['rev-parse','--verify','HEAD'],options),git('git',['symbolic-ref','--quiet','--short','HEAD'],options),
    git('git',['status','--porcelain=v1','--ignored','--untracked-files=all','--',...allowedPaths],options),
    git('git',['ls-files','-z','--',...allowedPaths],options),
    git('git',['rev-parse','--show-toplevel'],options),
  ]);
  const topRoot=await realpath(top.stdout.trim());
  if(process.platform==='win32'?topRoot.toLowerCase()!==root.toLowerCase():topRoot!==root) fail('Source project root is not its Git root');
  if(status.stdout.trim()) fail('Source workspace has modified, untracked or ignored inputs');
  const paths=[...new Set(tracked.stdout.split('\0').filter(Boolean))].sort((a,b)=>a.localeCompare(b)), files=[]; let total=0;
  if(paths.length>1000) fail('Source baseline exceeds the file limit');
  for(const path of paths) {
    if(path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')) fail('Source baseline path is invalid');
    const absolute=join(root,...path.split('/')), before=await lstat(absolute);
    if(!before.isFile()||before.isSymbolicLink()) fail('Source baseline contains unsupported files');
    const resolved=await realpath(absolute), rel=relative(root,resolved);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`)) fail('Source baseline escapes project');
    total+=before.size; if(total>32*1024*1024) fail('Source baseline exceeds the byte limit');
    const handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW||0)); let bytes;
    try {const opened=await handle.stat(); if(!opened.isFile()||opened.ino!==before.ino||opened.size!==before.size) fail('Source baseline changed before reading'); bytes=await handle.readFile();}
    finally {await handle.close();}
    const after=await lstat(absolute);
    if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs) fail('Source baseline changed while reading');
    files.push({path,digest:createHash('sha256').update(bytes).digest('hex'),executable:Boolean(before.mode&0o111)});
  }
  const head=headResult.stdout.trim(),branch=branchResult.stdout.trim(),baselineDigest=digest({head,branch,files});
  return {clean:true,baseHead:head,baseBranch:branch,baselineDigest};
}
export function verifyRemoteCapturedBaseline(db,remote,dispatchKey) {
  const row=db.prepare("SELECT * FROM factory_candidate_payloads WHERE candidate_id=?").get(`baseline:${dispatchKey}`);
  if(!row) fail('Remote staging baseline is unavailable');
  const baseline=JSON.parse(row.files_json || '{}');
  const manifest={head:baseline.source?.head,branch:baseline.source?.branch,files:baseline.files};
  if(manifest.head!==remote.expectedBaseHead||manifest.branch!==remote.expectedBaseBranch||digest(manifest)!==remote.expectedBaselineDigest) fail('Remote staging baseline differs from delegated inputs');
}
export async function getRemoteFactoryChild(bindingId,operationId) {
  const child=await factoryRead(db=>{schema(db); const row=db.prepare('SELECT c.*,w.state,w.control_state,w.execution_epoch FROM factory_remote_children c JOIN factory_work_items w ON w.id=c.work_item_id WHERE c.binding_id=? AND c.operation_id=?').get(bindingId,operationId);
    if(!row) return null; const binding=db.prepare('SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND execution_epoch=? ORDER BY created_at DESC LIMIT 1').get(row.work_item_id,row.execution_epoch);
    let usage=null;
    if(binding?.run_id && binding.attempt_id) {
      const item=db.prepare('SELECT organization_id FROM factory_work_items WHERE id=?').get(row.work_item_id);
      const contract=JSON.parse(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(row.work_item_id,binding.contract_revision)?.contract_json||'{}');
      const key=`factory:${binding.id}`, counter=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(item.organization_id,contract.organizationRevision);
      const entry=JSON.parse(counter?.reservations_json||'{}')[key];
      const attempt=db.prepare('SELECT state,run_id FROM collaboration_attempts WHERE id=? AND task_id=?').get(binding.attempt_id,binding.task_id);
      if(entry?.state==='settled' && attempt?.run_id===binding.run_id && ['succeeded','failed','cancelled'].includes(attempt.state)
          && Number.isSafeInteger(entry.usage?.tokens) && entry.usage.tokens>=0 && Number.isFinite(entry.usage?.cost) && entry.usage.cost>=0) {
        usage={reservationId:key,revision:contract.organizationRevision,attemptId:binding.attempt_id,runId:binding.run_id,tokens:entry.usage.tokens,cost:entry.usage.cost};
      }
    }
    const attempt=binding?.attempt_id && db.prepare('SELECT state,run_id,session_id,failure_kind FROM collaboration_attempts WHERE id=? AND task_id=?').get(binding.attempt_id,binding.task_id);
    return {workItemId:row.work_item_id,state:row.state,controlState:row.control_state,attemptId:binding?.attempt_id||null,runId:binding?.run_id||null,usage,
      execution:binding?{bindingId:binding.id,bindingStatus:binding.status,contractRevision:binding.contract_revision,executionEpoch:binding.execution_epoch,
        bindingGeneration:binding.binding_generation,attemptState:attempt?.state||null,attemptRunId:attempt?.run_id||null,sessionId:attempt?.session_id||null,failureKind:attempt?.failure_kind||null}:null}; });
  if(!child?.runId || !child.execution || child.execution.attemptRunId!==child.runId) return child;
  const run=await getRunAcceptanceEvidence(child.runId);
  return {...child,execution:{...child.execution,runState:run?.id===child.runId && run.sessionId===child.execution.sessionId?run.state:null}};
}
export async function cancelRemoteFactoryChild(input,principal) {
  return factoryTransaction(db=>{schema(db);verifyRemoteFactoryCancellation(db,input,principal);
    const link=db.prepare('SELECT * FROM factory_remote_children WHERE binding_id=? AND operation_id=?').get(input.bindingId,input.operationId);
    if(!link) return {state:'unknown',reason:'target_work_unavailable'};
    const item=db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(link.work_item_id);
    if(!item) fail('Target child is unavailable');
    const payloadDigest=digest({bindingId:input.bindingId,operationId:input.operationId,cancelId:input.cancelId,contractRevision:input.contractRevision,executionEpoch:input.executionEpoch});
    const old=db.prepare('SELECT * FROM factory_remote_cancel_receipts WHERE cancel_id=?').get(input.cancelId);
    if(old && (old.binding_id!==input.bindingId||old.operation_id!==input.operationId||old.payload_digest!==payloadDigest)) fail('Remote cancellation identity conflicts');
    if(!old) {
      const active=db.prepare("SELECT 1 FROM factory_execution_bindings WHERE work_item_id=? AND status IN ('intent','running','unknown')").get(item.id);
      if(!['completed','cancelled','failed','review'].includes(item.state) && item.control_state!=='cancel_requested') {
        const next=update(db,item,active?{control_state:'cancel_requested'}:{state:'cancelled',control_state:'none'});
        event(db,item.organization_id,item.id,'RemoteCancellationRequested',{bindingId:input.bindingId,operationId:input.operationId,cancelId:input.cancelId,rowVersion:next.row_version});
      }
      db.prepare('INSERT INTO factory_remote_cancel_receipts VALUES(?,?,?,?,?)').run(input.cancelId,input.bindingId,input.operationId,payloadDigest,now());
    }
    const current=db.prepare('SELECT state,control_state FROM factory_work_items WHERE id=?').get(item.id);
    return {workItemId:item.id,state:current.state,controlState:current.control_state,replayed:!!old};
  });
}

// Internal target-side envelope builder. The authenticated transport must sign
// the entire returned object; a candidate is not a source acceptance verdict.
export async function getRemoteFactoryCandidate(bindingId,operationId) {
  return factoryRead(db=>{
    schema(db); const f=facts(db,bindingId,operationId);
    const link=db.prepare('SELECT * FROM factory_remote_children WHERE binding_id=? AND operation_id=?').get(bindingId,operationId);
    const item=link && db.prepare('SELECT * FROM factory_work_items WHERE id=?').get(link.work_item_id);
    if(!item || item.state!=='review' || item.control_state!=='none' || !item.candidate_digest) fail('Target candidate is unavailable');
    const fence=verifyRemoteFactoryChild(db,item,{requireDispatch:false});
    if(!fence) fail('Remote child is not authorized');
    const raw=db.prepare("SELECT * FROM factory_execution_bindings WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND status='candidate'").get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation);
    const saved=raw && db.prepare('SELECT * FROM factory_candidates WHERE work_item_id=? AND contract_revision=? AND execution_epoch=? AND binding_generation=? AND digest=?').get(item.id,item.contract_revision,item.execution_epoch,item.binding_generation,item.candidate_digest);
    const details=JSON.parse(saved?.details_json || '{}');
    const binding=raw && {id:raw.id,status:raw.status,contractRevision:raw.contract_revision,executionEpoch:raw.execution_epoch,bindingGeneration:raw.binding_generation,
      dispatchKey:raw.dispatch_key,collaborationId:raw.collaboration_id,taskId:raw.task_id,attemptId:raw.attempt_id,runId:raw.run_id};
    if(!binding || !verifyFactoryCandidate({db,item:itemRow(db,item),binding,payload:{candidateId:details.candidateId,digest:item.candidate_digest}})) fail('Target candidate evidence is not verified');
    const candidate=db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(details.candidateId);
    const baseline=db.prepare('SELECT * FROM factory_candidate_payloads WHERE candidate_id=?').get(`baseline:${raw.dispatch_key}`);
    if(!candidate || !baseline || candidate.baseline_digest!==baseline.digest) fail('Target baseline is unavailable');
    const base=JSON.parse(baseline.files_json), changes=JSON.parse(candidate.files_json);
    const safe=path=>typeof path==='string' && path.length<=1024 && !/^(?:[A-Za-z]:|[\\/])/.test(path)
      && !path.includes('\\') && path.split('/').every(part=>part && part!=='.' && part!=='..'
        && !/^(?:\.git|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|credentials?|secrets?|node_modules|\.cache|id_rsa|id_ed25519)$/i.test(part)
        && !/\.(?:pem|key|p12|pfx)$/i.test(part));
    if(!Array.isArray(base.files)||!Array.isArray(changes)||base.files.some(file=>!safe(file.path))||changes.some(file=>!safe(file.path))) fail('Candidate contains a restricted path');
    const baselineManifest={head:base.source?.head,branch:base.source?.branch,files:base.files};
    if(baselineManifest.head!==f.payload.expectedBaseHead || baselineManifest.branch!==f.payload.expectedBaseBranch
        || digest(baselineManifest)!==f.payload.expectedBaselineDigest) fail('Candidate baseline differs from source delegation');
    const envelope={version:1,sourceInstanceId:f.binding.source_instance_id,targetInstanceId:f.binding.target_instance_id,
      sourceBindingId:f.payload.sourceBindingId,sourceBindingVersion:f.payload.sourceBindingVersion,
      targetBindingId:bindingId,targetBindingVersion:f.binding.version,operationId,requestId:f.operation.request_id,
      sourceFactoryBindingId:f.operation.source_factory_binding_id,sourceContractRevision:f.operation.contract_revision,sourceExecutionEpoch:f.operation.execution_epoch,
      targetWorkItemId:item.id,targetExecutionBindingId:raw.id,targetContractRevision:raw.contract_revision,targetExecutionEpoch:raw.execution_epoch,
      targetBindingGeneration:raw.binding_generation,attemptId:raw.attempt_id,runId:raw.run_id,
      baselineDigest:baseline.digest,baselineManifestDigest:digest(baselineManifest),candidateDigest:candidate.digest,contentDigest:digest(changes),baseline:baselineManifest,changes};
    if(Buffer.byteLength(JSON.stringify(envelope),'utf8')>4*1024*1024) fail('Candidate envelope exceeds transfer limit');
    return envelope;
  });
}

// The source gateway invokes this synchronously in its existing transaction
// before signing a remote delegation. It never creates a Run or sends data.
export function verifySourceRemoteDelegation(db,input,actor) {
  if(actor?.kind!=='service'||actor.role!=='factory_scheduler') fail('Factory scheduler service required');
  const org=authorize(db,input.organizationId,actor,'factory.dispatch');
  const item=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(input.workItemId,input.organizationId);
  const binding=item && db.prepare('SELECT * FROM factory_execution_bindings WHERE id=? AND work_item_id=?').get(input.sourceFactoryBindingId,item.id);
  const lease=db.prepare('SELECT * FROM factory_scheduler_leases WHERE organization_id=?').get(input.organizationId);
  if(!item||!binding||!lease||lease.owner_token!==input.leaseOwnerToken||lease.generation!==input.leaseGeneration||lease.expires_at<=now()
      || item.row_version!==input.expectedVersion||item.state!=='claimed'||item.control_state!=='none'||item.ownership!=='active'
      || binding.status!=='intent'||binding.contract_revision!==input.contractRevision||binding.execution_epoch!==input.executionEpoch
      || binding.binding_generation!==input.bindingGeneration||item.contract_revision!==binding.contract_revision
      || item.execution_epoch!==binding.execution_epoch||item.binding_generation!==binding.binding_generation) fail('Source Factory binding or lease changed');
  const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assignee_node_id,input.organizationId);
  if(!node||node.retired_revision!==null||node.binding_generation!==binding.binding_generation||['archived','lifecycle_pending'].includes(org.state)) fail('Source organization binding changed');
  const contract=JSON.parse(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision)?.contract_json || '{}');
  if(contract.organizationRevision!==org.current_revision||hash(contract)!==input.contractDigest||digest(contract)!==digest(input.payload?.contract)) fail('Source contract changed');
  const key=`factory:${binding.id}`, counter=db.prepare('SELECT reservations_json FROM organization_budget_counters WHERE organization_id=? AND revision=?').get(input.organizationId,contract.organizationRevision);
  const entry=JSON.parse(counter?.reservations_json || '{}')[key];
  if(!entry || entry.state!=='reserved'||input.payload?.sourceReservationId!==key||!Number.isFinite(input.payload?.reservedCost)
      || input.payload.reservedCost<=0||input.payload.reservedCost>entry.delta?.cost) fail('Source budget reservation is unavailable');
  const grant=JSON.parse(node.grant_json || '{}'), paths=contract.accessMode==='read'?[]:(contract.allowedPaths || []);
  const within=(path,root)=>path===root||path.startsWith(`${root}/`);
  if(paths.length && (grant.canWrite!==true||!Array.isArray(grant.writablePaths)||paths.some(path=>!grant.writablePaths.some(root=>within(path,root))))) fail('Source write grant changed');
  for(const capability of paths.length?['run','write']:['run']) {
    const row=db.prepare('SELECT allow,scope_json FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(org.id,node.id,capability,org.current_revision);
    if(!row?.allow) fail('Source grant is unavailable');
    const scope=JSON.parse(row.scope_json || '{}');
    if((scope.projectId&&scope.projectId!==item.project_id)||Object.keys(scope).some(key=>!['projectId','writablePaths'].includes(key))
      ||(capability==='write'&&Array.isArray(scope.writablePaths)&&paths.some(path=>!scope.writablePaths.some(root=>within(path,root))))) fail('Source grant scope changed');
  }
  verifyFactoryResponsibilityFence(db,item);
  return {organizationId:item.organization_id,projectId:item.project_id,workItemId:item.id,bindingId:binding.id,dispatchKey:binding.dispatch_key,
    contractRevision:binding.contract_revision,executionEpoch:binding.execution_epoch,bindingGeneration:binding.binding_generation,reservationId:key};
}
