// Explicit owner revision of a quiescent single-node reviewer organization.
// Role and Session creation identities remain historical; current authority is
// a separate immutable role-grant version and the node/ledger projection.
import { createHash, randomUUID } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';
import { getOrganization, getRevision, getNode, getRoleInstance } from './organization-store.mjs';
import { buildOrganizationAgentCatalog } from './organization-leader-ingress.mjs';
import { compileOrganizationProposal } from './organization-planner.mjs';
import { beginNodeRebind, cancelNodeRebind, assertNodeWorkQuiescent, getLatestLegacyNodeRebind } from './organization-session-lifecycle.mjs';
import { getSession } from './session-manager.mjs';
import { getRunAcceptanceEvidence, listDurableSessionRunIndexEntries } from './runs.mjs';
import { reconcileOrganizationRunAdmissions } from './organization-run-admission.mjs';

const fail=(message,statusCode=409)=>Object.assign(new Error(message),{code:'ORG_GRANT_REVISION_CONFLICT',statusCode});
const text=value=>typeof value==='string'?value.trim():'';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function getOrganizationNodeGrantRevision(organizationId,nodeId,actor) {
  if(actor?.kind!=='user'||actor?.role!=='owner'||!text(actor.principalId))throw fail('Owner access required',403);
  return withDatabase(db=>{
    const org=db.prepare('SELECT id,state,version,current_revision FROM organizations WHERE id=?').get(text(organizationId));
    const node=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(text(nodeId),text(organizationId));
    if(!org||!node)throw fail('Organization or node not found',404);
    let grant;try{grant=JSON.parse(node.grant_json);}catch{throw fail('Node grant is unreadable');}
    const initialized=['factory_work_items','factory_execution_bindings'].every(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const active=initialized?db.prepare("SELECT COUNT(*) AS n FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id WHERE w.organization_id=? AND w.assignee_node_id=? AND b.status IN ('intent','running','unknown')").get(org.id,node.id).n:null;
    return {organizationId:org.id,nodeId:node.id,organizationVersion:org.version,organizationRevision:org.current_revision,bindingGeneration:node.binding_generation,
      state:org.state,capabilities:Array.isArray(grant?.allowedCapabilities)?grant.allowedCapabilities:[],activeOrUnknownBindings:active,quiescence:'not_verified',schemaVersion:1};
  });
}

export async function reviseOrganizationNodeGrant(input,actor) {
  if(actor?.kind!=='user'||actor?.role!=='owner'||!text(actor.principalId)) throw fail('Owner access required',403);
  const organizationId=text(input?.organizationId),nodeId=text(input?.nodeId),commandId=text(input?.commandId);
  const expectedOrganizationVersion=input?.expectedOrganizationVersion, expectedRevision=input?.expectedRevision, expectedBindingGeneration=input?.expectedBindingGeneration;
  const requested=input?.capabilities;
  if(!organizationId||!nodeId||!commandId||commandId.length>120||![expectedOrganizationVersion,expectedRevision,expectedBindingGeneration].every(Number.isSafeInteger)
      || !Array.isArray(requested)||requested.length<1||new Set(requested).size!==requested.length||requested.some(x=>!['read','run','review'].includes(x))||!requested.includes('read')) throw fail('Invalid reviewer grant revision request',400);
  const capabilities=[...requested].sort(),payloadDigest=hash({organizationId,nodeId,commandId,expectedOrganizationVersion,expectedRevision,expectedBindingGeneration,capabilities});
  const replay=await withDatabase(db=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_grant_revision_receipts'").get()) return null;
    const prior=db.prepare('SELECT * FROM organization_grant_revision_receipts WHERE command_id=?').get(commandId);
    if(!prior)return null;
    if(prior.organization_id!==organizationId||prior.actor_id!==actor.principalId||prior.payload_digest!==payloadDigest)throw fail('Command id belongs to another request');
    return {...JSON.parse(prior.result_json),replayed:true};
  });
  if(replay)return replay;
  const [org,base,node]=await Promise.all([getOrganization(organizationId),getRevision(organizationId,expectedRevision),getNode(nodeId)]);
  if(!org||!base||!node||node.organizationId!==organizationId) throw fail('Organization, node or revision not found',404);
  const observed=await getOrganizationNodeGrantRevision(organizationId,nodeId,actor);
  if(observed.activeOrUnknownBindings===null) throw fail('Factory execution state is not initialized');
  if(observed.activeOrUnknownBindings>0) throw fail('Node has an active or unknown Factory execution');
  const role=await getRoleInstance(node.roleInstanceId);
  if(!role||role.organizationId!==organizationId||role.stableKey!==node.stableKey||role.role!=='reviewer'||!role.agentId||node.nodeRole!=='reviewer'||node.parentNodeId) throw fail('Only a root reviewer with a consistent role is supported');
  if(base.state!=='frozen'||!Array.isArray(base.proposal?.nodes)) throw fail('Frozen base proposal is unavailable');
  const proposal=JSON.parse(JSON.stringify(base.proposal)), nodes=proposal.nodes.filter(x=>x.stableKey===node.stableKey);
  if(proposal.nodes.length!==1||nodes.length!==1||nodes[0].agentId!==role.agentId) throw fail('Only a single-node reviewer revision is supported');
  nodes[0].capabilities=capabilities;
  proposal.idempotencyKey=`grant-revision:${commandId}`;
  proposal.proposalId=`${proposal.proposalId}:grant:${commandId}`;
  const catalog=await buildOrganizationAgentCatalog(), profile=catalog.agents?.find(x=>x.agentId===role.agentId && x.selectable!==false);
  if(!profile||!Array.isArray(profile.capabilities)||capabilities.some(x=>!profile.capabilities.includes(x))) throw fail('Requested capability exceeds the current Agent profile');
  const compiled=await compileOrganizationProposal(proposal,{profiles:catalog.agents,budget:org.budget});
  const compiledNode=compiled.compiled?.nodes?.find(x=>x.stableKey===node.stableKey);
  if(!compiledNode||compiledNode.resolver?.selectedAgentId!==role.agentId||!compiledNode.grant||!Array.isArray(compiledNode.grant.allowedCapabilities)||compiledNode.grant.canWrite===true
      || JSON.stringify([...compiledNode.grant.allowedCapabilities].sort())!==JSON.stringify(capabilities)) throw fail('Compiled reviewer grant differs from the request');
  const latestCatalog=await buildOrganizationAgentCatalog();
  if(latestCatalog.revision!==catalog.revision) throw fail('Agent catalog changed during authorization');
  const prefix=`legacy_${hash([organizationId,nodeId,`grant:${commandId}`])}_`;
  const previous=await getLatestLegacyNodeRebind(organizationId,nodeId,prefix);
  const fenceCommandId=previous?.state==='pending'?previous.commandId:`${prefix}${(previous?.attempt||0)+1}`;
  const fenceResult=await beginNodeRebind({organizationId,nodeId,commandId:fenceCommandId,actorId:actor.principalId,expectedGeneration:expectedBindingGeneration});
  if(fenceResult.state!=='pending')throw fail('Node authorization fence is not pending');
  let committed=false;
  try {
    await assertNodeWorkQuiescent(organizationId,nodeId,node.currentSessionId);
    const session=await getSession(node.currentSessionId);
    if(!session || session.sessionPlane!=='organization' || session.organizationId!==organizationId || session.organizationNodeId!==nodeId
        || session.roleInstanceId!==role.id || Number(session.organizationRevision)!==Number(node.createdRevision)
        || session.activeRunId || ['queued','starting','running','awaiting_approval','cancelling'].includes(session.activity?.run?.state)) throw fail('Node session is active or its identity changed');
    const entries=await listDurableSessionRunIndexEntries(node.currentSessionId);
    for(const entry of entries) {
      const run=await getRunAcceptanceEvidence(entry.id);
      if(!run||run.sessionId!==node.currentSessionId||!run.finalizedAt||!['completed','failed','cancelled'].includes(run.state)) throw fail('Node Run history is not conclusively terminal');
    }
    await reconcileOrganizationRunAdmissions({organizationId,nodeId,commandId:fenceCommandId});
    if((await buildOrganizationAgentCatalog()).revision!==catalog.revision) throw fail('Agent catalog changed during authorization');
    const result=await withDatabase(db=>{
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS organization_role_grant_versions (organization_id TEXT NOT NULL,node_id TEXT NOT NULL,role_instance_id TEXT NOT NULL,revision INTEGER NOT NULL,grant_json TEXT NOT NULL,profile_digest TEXT NOT NULL,command_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(role_instance_id,revision),UNIQUE(command_id));
        CREATE TABLE IF NOT EXISTS organization_grant_revision_receipts (command_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,actor_id TEXT NOT NULL,payload_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS organization_role_grant_versions_no_update BEFORE UPDATE ON organization_role_grant_versions BEGIN SELECT RAISE(ABORT,'immutable role grant'); END;
        CREATE TRIGGER IF NOT EXISTS organization_role_grant_versions_no_delete BEFORE DELETE ON organization_role_grant_versions BEGIN SELECT RAISE(ABORT,'immutable role grant'); END;`);
      const prior=db.prepare('SELECT * FROM organization_grant_revision_receipts WHERE command_id=?').get(commandId);
      if(prior){if(prior.organization_id!==organizationId||prior.actor_id!==actor.principalId||prior.payload_digest!==payloadDigest)throw fail('Command id belongs to another request');db.exec('COMMIT');return {...JSON.parse(prior.result_json),replayed:true};}
      const current=db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId), n=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(nodeId,organizationId), r=db.prepare('SELECT * FROM role_instances WHERE id=? AND organization_id=?').get(role.id,organizationId);
      if(!current||!n||!r||current.state!=='active'||current.version!==expectedOrganizationVersion||current.current_revision!==expectedRevision||n.binding_generation!==expectedBindingGeneration||n.role_instance_id!==role.id||n.retired_revision!==null||n.current_session_id!==node.currentSessionId) throw fail('Organization or node version changed');
      if(db.prepare('SELECT COUNT(*) AS n FROM organization_nodes WHERE organization_id=? AND retired_revision IS NULL').get(organizationId).n!==1) throw fail('Only a single active node is supported');
      if(!['factory_work_items','factory_execution_bindings'].every(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) throw fail('Factory execution state is not initialized');
      if(db.prepare("SELECT 1 FROM factory_work_items w JOIN factory_execution_bindings b ON b.work_item_id=w.id WHERE w.organization_id=? AND w.assignee_node_id=? AND b.status IN ('intent','running','unknown') LIMIT 1").get(organizationId,nodeId)) throw fail('Node has an active or unknown Factory execution');
      if(db.prepare("SELECT 1 FROM collaboration_attempts WHERE session_id=? AND (state NOT IN ('succeeded','failed','cancelled') OR (state='failed' AND failure_kind='unknown_outcome')) LIMIT 1").get(n.current_session_id)) throw fail('Node has an active or unknown Collaboration attempt');
      if(db.prepare(`SELECT 1 FROM collaboration_attempts a JOIN collaboration_tasks t ON t.id=a.task_id JOIN collaborations c ON c.id=t.collaboration_id
        WHERE json_valid(c.policy_json) AND json_extract(c.policy_json,'$.organizationId')=? AND json_extract(c.policy_json,'$.organizationNodeId')=?
        AND (a.state NOT IN ('succeeded','failed','cancelled') OR (a.state='failed' AND a.failure_kind='unknown_outcome')) LIMIT 1`).get(organizationId,nodeId)) throw fail('Node has an active or unknown managed attempt');
      const fence=db.prepare("SELECT * FROM organization_node_rebind_operations WHERE command_id=? AND organization_id=? AND node_id=? AND state='pending'").get(fenceCommandId,organizationId,nodeId);
      if(!fence || fence.actor_id!==actor.principalId || fence.expected_generation!==expectedBindingGeneration || fence.old_session_id!==n.current_session_id) throw fail('Node authorization fence changed');
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_run_admissions'").get() && db.prepare("SELECT 1 FROM organization_run_admissions WHERE organization_id=? AND node_id=? AND state NOT IN ('resolved','unpublished') LIMIT 1").get(organizationId,nodeId)) throw fail('Node has an unresolved Run admission');
      const dbBase=db.prepare('SELECT digest,state FROM organization_revisions WHERE organization_id=? AND revision=?').get(organizationId,expectedRevision);
      if(dbBase?.state!=='frozen'||dbBase.digest!==base.digest||r.agent_id!==role.agentId||n.grant_json!==JSON.stringify(node.grant)) throw fail('Frozen authority changed');
      const next=expectedRevision+1,ts=new Date().toISOString(),grantJson=JSON.stringify(compiledNode.grant);
      if(db.prepare('SELECT 1 FROM organization_revisions WHERE organization_id=? AND revision=?').get(organizationId,next))throw fail('Next revision already exists');
      db.prepare('INSERT INTO organization_revisions (organization_id,revision,proposal_json,compiled_json,digest,state,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?)').run(organizationId,next,JSON.stringify(compiled.proposal),JSON.stringify(compiled.compiled),compiled.digest,'frozen',`grant-revision:${commandId}`,ts);
      db.prepare('INSERT INTO organization_role_grant_versions VALUES (?,?,?,?,?,?,?,?)').run(organizationId,nodeId,role.id,next,grantJson,catalog.revision,commandId,ts);
      const updateNode=db.prepare('UPDATE organization_nodes SET grant_json=?,binding_generation=binding_generation+1,version=version+1 WHERE id=? AND organization_id=? AND binding_generation=?').run(grantJson,nodeId,organizationId,expectedBindingGeneration);
      const updateOrg=db.prepare('UPDATE organizations SET current_revision=?,version=version+1,updated_at=? WHERE id=? AND version=? AND current_revision=?').run(next,ts,organizationId,expectedOrganizationVersion,expectedRevision);
      if(Number(updateNode.changes)!==1||Number(updateOrg.changes)!==1)throw fail('Organization or node changed');
      for(const capability of ['read','write','manage','review','aggregate','input','run']) db.prepare('INSERT INTO organization_grants (id,organization_id,node_id,revision,capability,allow,scope_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`grant_${randomUUID()}`,organizationId,nodeId,next,capability,capabilities.includes(capability)?1:0,JSON.stringify(current.project_id?{projectId:current.project_id}:{}),ts);
      const result={organizationId,nodeId,organizationRevision:next,organizationVersion:expectedOrganizationVersion+1,bindingGeneration:expectedBindingGeneration+1,capabilities,operation:{commandId,state:'completed'},schemaVersion:1};
      db.prepare('INSERT INTO organization_grant_revision_receipts VALUES (?,?,?,?,?,?)').run(commandId,organizationId,actor.principalId,payloadDigest,JSON.stringify(result),ts);
      db.prepare("UPDATE organization_node_rebind_operations SET state='completed',result_json=?,updated_at=? WHERE command_id=? AND state='pending'").run(JSON.stringify({sessionId:n.current_session_id,bindingGeneration:expectedBindingGeneration+1,kind:'grant_revision'}),ts,fenceCommandId);
      db.exec('COMMIT');return result;
    } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
    },{mutate:true});
    committed=true;
    return result;
  } finally {
    if(!committed) await cancelNodeRebind({organizationId,nodeId,commandId:fenceCommandId}).catch(()=>{});
  }
}
