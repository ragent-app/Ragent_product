// Explicit owner authorization for a bounded read-only report. It creates no
// responsibility, capability, Run, acceptance, or project snapshot.
import {factoryTransaction,factoryError,itemRow,digest,now} from './work-graph-store.mjs';
import {authorize,selectItem} from './work-graph.mjs';
import {factoryGrantDenial} from './factory-grant-authority.mjs';
import {verifyFactoryResponsibilityFence} from './factory-responsibility-admission.mjs';

const text=x=>typeof x==='string'?x.trim():'';
const fail=(message,statusCode=409)=>{throw factoryError('FACTORY_OWNER_REPORT',message,statusCode);};
function schema(db) {db.exec(`CREATE TABLE IF NOT EXISTS factory_owner_report_authorizations (
 command_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,work_item_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,input_digest TEXT NOT NULL,contract_revision INTEGER NOT NULL,contract_digest TEXT NOT NULL,
 organization_revision INTEGER NOT NULL,execution_epoch INTEGER NOT NULL,node_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,managed_session_id TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(organization_id,actor_id,idempotency_key),UNIQUE(work_item_id,contract_revision,execution_epoch));
 CREATE TRIGGER IF NOT EXISTS factory_owner_report_no_update BEFORE UPDATE ON factory_owner_report_authorizations BEGIN SELECT RAISE(ABORT,'immutable owner report authorization'); END;
 CREATE TRIGGER IF NOT EXISTS factory_owner_report_no_delete BEFORE DELETE ON factory_owner_report_authorizations BEGIN SELECT RAISE(ABORT,'immutable owner report authorization'); END;`);}
export async function authorizeOwnerFactoryReport(input,actor) {
 if(actor?.kind!=='user'||actor.role!=='owner'||!text(actor.principalId)) fail('Owner required',403);
 const organizationId=text(input?.organizationId),workItemId=text(input?.workItemId),commandId=text(input?.commandId),key=text(input?.idempotencyKey),version=input?.expectedVersion;
 if(!organizationId||!workItemId||!commandId||commandId.length>120||!key||key.length>160||!Number.isSafeInteger(version)) fail('Invalid authorization identity',400);
 const inputDigest=digest({organizationId,workItemId,expectedVersion:version});
 return factoryTransaction(db=>{schema(db);const org=authorize(db,organizationId,actor,'factory.CreateWorkItem');
  const prior=db.prepare('SELECT * FROM factory_owner_report_authorizations WHERE command_id=? OR (organization_id=? AND actor_id=? AND idempotency_key=?)').get(commandId,organizationId,actor.principalId,key);
  if(prior){if(prior.command_id!==commandId||prior.organization_id!==organizationId||prior.work_item_id!==workItemId||prior.actor_id!==actor.principalId||prior.idempotency_key!==key||prior.input_digest!==inputDigest)fail('Authorization command or key conflicts');return {operation:{commandId,state:'completed'},contractRevision:prior.contract_revision,executionEpoch:prior.execution_epoch,scope:'owner_read_only_report',sourceSnapshot:'unverified',replayed:true};}
  const raw=selectItem(db,organizationId,workItemId), item=itemRow(db,raw), node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assigneeNodeId,organizationId);
  if(raw.row_version!==version||raw.state!=='proposed'||raw.ownership!=='active'||raw.control_state!=='none'||db.prepare('SELECT 1 FROM factory_execution_bindings WHERE work_item_id=?').get(workItemId)) fail('A matching proposed work item without execution is required');
  if(!node||node.retired_revision!==null||node.node_role!=='reviewer'||!node.current_session_id) fail('An active reviewer binding is required');
  const contract=item.contract, resource=contract?.resource;
  if(contract?.accessMode!=='read'||!Array.isArray(contract.allowedPaths)||contract.allowedPaths.length||resource?.projectId!==item.projectId||resource.readScope!=='entire_project'||resource.networkPolicy!=='inherit_existing_permissions'||!contract.acceptanceCriteria?.length||contract.acceptanceCriteria.some(x=>x.method!=='manual')||contract.organizationRevision!==org.current_revision) fail('A current read-only project report with manual criteria is required');
  let grant; try { grant=JSON.parse(node.grant_json || '{}'); } catch { fail('Reviewer grant is unreadable'); }
  const writeGrant=db.prepare("SELECT allow FROM organization_grants WHERE organization_id=? AND node_id=? AND capability='write' AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1").get(organizationId,node.id,org.current_revision);
  if(grant.canWrite===true || writeGrant?.allow || factoryGrantDenial(db,org,node,item)) fail('Read-only reviewer grant is unavailable');
  if(!Number.isSafeInteger(item.executionEpoch) || item.executionEpoch>=Number.MAX_SAFE_INTEGER) fail('Execution epoch is unavailable');
  const nextEpoch=item.executionEpoch+1;
  if(verifyFactoryResponsibilityFence(db,raw)) fail('Responsibility-owned work uses its own authority');
  db.prepare('INSERT INTO factory_owner_report_authorizations (command_id,organization_id,work_item_id,actor_id,idempotency_key,input_digest,contract_revision,contract_digest,organization_revision,execution_epoch,node_id,binding_generation,managed_session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(commandId,organizationId,workItemId,actor.principalId,key,inputDigest,item.contractRevision,item.contractDigest,org.current_revision,nextEpoch,node.id,node.binding_generation,node.current_session_id,now());
  return {operation:{commandId,state:'completed'},contractRevision:item.contractRevision,executionEpoch:nextEpoch,scope:'owner_read_only_report',sourceSnapshot:'unverified'};
 });
}
export function verifyOwnerReportScope(db,item,binding) {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_owner_report_authorizations'").get())return false;
 const row=db.prepare('SELECT * FROM factory_owner_report_authorizations WHERE organization_id=? AND work_item_id=? AND contract_revision=? AND execution_epoch=?').get(item.organizationId,item.id,item.contractRevision,item.executionEpoch);
 const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(item.organizationId),node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assigneeNodeId,item.organizationId);
 if(!row||!org||!node||org.current_revision!==row.organization_revision||item.contractDigest!==row.contract_digest||item.contract?.organizationRevision!==org.current_revision
  ||item.assigneeNodeId!==row.node_id||node.id!==row.node_id||node.node_role!=='reviewer'||node.retired_revision!==null||node.current_session_id!==row.managed_session_id
  ||JSON.parse(node.grant_json || '{}').canWrite===true
  ||db.prepare("SELECT allow FROM organization_grants WHERE organization_id=? AND node_id=? AND capability='write' AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1").get(item.organizationId,node.id,org.current_revision)?.allow
  ||node.binding_generation!==row.binding_generation||binding.bindingGeneration!==row.binding_generation||binding.executionEpoch!==row.execution_epoch
  ||binding.contractRevision!==row.contract_revision||factoryGrantDenial(db,org,node,item))return false;
 return true;
}

export function verifyOwnerFactoryReport(db,item,binding) {
 if(!verifyOwnerReportScope(db,item,binding)) return false;
 const node=db.prepare('SELECT current_session_id FROM organization_nodes WHERE id=? AND organization_id=?').get(item.assigneeNodeId,item.organizationId);
 return !!node && db.prepare('SELECT session_id FROM collaboration_attempts WHERE id=? AND task_id=?').get(binding.attemptId,binding.taskId)?.session_id===node.current_session_id;
}
