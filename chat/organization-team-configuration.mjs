// Versioned position preferences and typed, non-management relationships.
// These facts do not confer grants or rewrite existing work contracts.
import { randomUUID, createHash } from 'node:crypto';
import { withDatabase } from './collaboration-store.mjs';

const fail = (message,statusCode=409) => Object.assign(new Error(message),{code:'TEAM_CONFIG_CONFLICT',statusCode});
const text = value => typeof value === 'string' ? value.trim() : '';
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS organization_position_profiles (
  organization_id TEXT NOT NULL,node_id TEXT NOT NULL,version INTEGER NOT NULL,organization_revision INTEGER NOT NULL,
  profile_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(organization_id,node_id,version));
  CREATE TABLE IF NOT EXISTS organization_team_configuration_receipts (
  command_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,actor_id TEXT NOT NULL,payload_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS organization_team_relations (
  organization_id TEXT NOT NULL,version INTEGER NOT NULL,id TEXT NOT NULL,base_organization_revision INTEGER NOT NULL,
  edge_type TEXT NOT NULL,from_node_id TEXT NOT NULL,to_node_id TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id,version),UNIQUE(organization_id,edge_type,from_node_id,to_node_id));
  CREATE TRIGGER IF NOT EXISTS organization_team_relations_no_update BEFORE UPDATE ON organization_team_relations BEGIN SELECT RAISE(ABORT,'immutable relation'); END;
  CREATE TRIGGER IF NOT EXISTS organization_team_relations_no_delete BEFORE DELETE ON organization_team_relations BEGIN SELECT RAISE(ABORT,'immutable relation'); END;`); }
function owner(actor) { if (actor?.kind!=='user' || actor?.role!=='owner' || !text(actor.principalId)) throw fail('Owner access required',403); }
function transact(input,actor,fn) {
  owner(actor); const orgId=text(input?.organizationId), commandId=text(input?.commandId);
  if (!orgId || !commandId || commandId.length>255 || !Number.isInteger(input?.expectedOrganizationRevision)) throw fail('Organization, command and expected revision are required',400);
  const digest=createHash('sha256').update(JSON.stringify({input,actorId:actor.principalId})).digest('hex');
  return withDatabase(db=>{ schema(db); db.exec('BEGIN IMMEDIATE'); try {
    const prior=db.prepare('SELECT * FROM organization_team_configuration_receipts WHERE command_id=?').get(commandId);
    if (prior) { if(prior.payload_digest!==digest) throw fail('Command ID belongs to a different request'); db.exec('COMMIT'); return {...JSON.parse(prior.result_json),replayed:true}; }
    const org=db.prepare('SELECT * FROM organizations WHERE id=?').get(orgId);
    if (!org) throw fail('Organization not found',404);
    if (['archived','lifecycle_pending'].includes(org.state) || org.current_revision!==input.expectedOrganizationRevision) throw fail('Organization revision or lifecycle changed');
    const result={...fn(db,org),operation:{commandId,state:'completed'},schemaVersion:1};
    db.prepare('INSERT INTO organization_team_configuration_receipts VALUES(?,?,?,?,?,?)').run(commandId,orgId,actor.principalId,digest,JSON.stringify(result),new Date().toISOString());
    db.exec('COMMIT'); return result;
  } catch(error) { try {db.exec('ROLLBACK');} catch {} throw error; } },{mutate:true});
}
function node(db,orgId,nodeId) { const row=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=? AND retired_revision IS NULL').get(nodeId,orgId); if(!row) throw fail('Active node not found',404); return row; }
function boundedList(value) { if(!Array.isArray(value) || value.length>16 || value.some(v=>!text(v)||v.length>200)) throw fail('List must contain at most 16 bounded strings',400); return value.map(text); }

export async function setPositionProfile(input,actor) {
  const p=input?.profile; if(!p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).some(k=>!['responsibility','capabilityRequirements','runtimePreference','alternativeRuntimes','capacity'].includes(k))) throw fail('Invalid position profile',400);
  const profile={ responsibility:text(p.responsibility),capabilityRequirements:boundedList(p.capabilityRequirements || []),runtimePreference:text(p.runtimePreference),alternativeRuntimes:boundedList(p.alternativeRuntimes || []),capacity:p.capacity };
  if(profile.responsibility.length>2000 || profile.runtimePreference.length>200 || !Number.isInteger(profile.capacity) || profile.capacity<1 || profile.capacity>100) throw fail('Invalid position profile bounds',400);
  return transact(input,actor,(db,org)=>{ node(db,org.id,input.nodeId); const current=db.prepare('SELECT MAX(version) AS version FROM organization_position_profiles WHERE organization_id=? AND node_id=?').get(org.id,input.nodeId).version || 0; if(current!==input.expectedProfileVersion) throw fail('Position profile version changed'); const version=current+1; db.prepare('INSERT INTO organization_position_profiles VALUES(?,?,?,?,?,?,?)').run(org.id,input.nodeId,version,org.current_revision,JSON.stringify(profile),actor.principalId,new Date().toISOString()); return {nodeId:input.nodeId,version,organizationRevision:org.current_revision,profile,actualRuntimeChanged:false,enforcement:{capabilityRequirements:'admission_and_reconciliation',capacity:'existing_node_limit_one',runtimePreference:'advisory'}}; });
}
export async function addTeamRelation(input,actor) {
  if(!['REVIEWS','CONSULTS'].includes(input?.edgeType) || !text(input.fromNodeId) || !text(input.toNodeId) || input.fromNodeId===input.toNodeId) throw fail('Distinct nodes and REVIEWS or CONSULTS are required',400);
  if(input.requiredReview === true && input.edgeType!=='REVIEWS') throw fail('Only review relations may propose required review',400);
  return transact(input,actor,(db,org)=>{
    node(db,org.id,input.fromNodeId); node(db,org.id,input.toNodeId);
    if(db.prepare('SELECT 1 FROM organization_team_relations WHERE organization_id=? AND edge_type=? AND from_node_id=? AND to_node_id=?').get(org.id,input.edgeType,input.fromNodeId,input.toNodeId)) throw fail('Relation already exists');
    const edgeId=`edge_${randomUUID()}`;
    const version=(db.prepare('SELECT MAX(version) AS version FROM organization_team_relations WHERE organization_id=?').get(org.id).version || 0)+1;
    db.prepare('INSERT INTO organization_team_relations VALUES(?,?,?,?,?,?,?,?)').run(org.id,version,edgeId,org.current_revision,input.edgeType,input.fromNodeId,input.toNodeId,new Date().toISOString());
    const hasItems=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_work_items'").get();
    const items=hasItems ? db.prepare("SELECT id,state,contract_revision,candidate_digest FROM factory_work_items WHERE organization_id=? AND ownership='active' AND state NOT IN ('completed','cancelled') ORDER BY id LIMIT 501").all(org.id) : [];
    const affected=items.slice(0,500).map(r=>({workItemId:r.id,state:r.state,contractRevision:r.contract_revision,candidateDigest:r.candidate_digest}));
    return {edge:{id:edgeId,type:input.edgeType,fromNodeId:input.fromNodeId,toNodeId:input.toNodeId,organizationRevision:org.current_revision,relationVersion:version},
      requiredReview:input.requiredReview===true ? {state:'proposed',requiresContractAmendment:affected,truncated:items.length>500} : null,
      impact:{affectedWorkItems:affected,truncated:items.length>500,grantsChanged:false,contractsChanged:false}};
  });
}
export async function getTeamConfiguration(organizationId,actor) {
  owner(actor); return withDatabase(db=>{schema(db); const org=db.prepare('SELECT current_revision FROM organizations WHERE id=?').get(organizationId); if(!org) throw fail('Organization not found',404); const profiles=db.prepare(`SELECT p.* FROM organization_position_profiles p WHERE p.organization_id=? AND p.version=(SELECT MAX(q.version) FROM organization_position_profiles q WHERE q.organization_id=p.organization_id AND q.node_id=p.node_id) ORDER BY p.node_id`).all(organizationId).map(r=>({nodeId:r.node_id,version:r.version,organizationRevision:r.organization_revision,profile:JSON.parse(r.profile_json)})); const relations=db.prepare('SELECT * FROM organization_team_relations WHERE organization_id=? ORDER BY version').all(organizationId).map(r=>({id:r.id,type:r.edge_type,fromNodeId:r.from_node_id,toNodeId:r.to_node_id,organizationRevision:r.base_organization_revision,relationVersion:r.version})); const relationVersion=relations.at(-1)?.relationVersion || 0; return {organizationId,organizationRevision:org.current_revision,relationVersion,profiles,relations,schemaVersion:1}; });
}
