// Durable, node-scoped admission intent. Run files and organization state live
// in different stores, so an interrupted publication is retained as unknown.
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { CHAT_COLLABORATIONS_DB } from '../lib/config.mjs';
import { withDatabase } from './collaboration-store.mjs';

const fail = message => { throw Object.assign(new Error(message),{code:'ORG_RUN_ADMISSION_CONFLICT',statusCode:409}); };
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS organization_run_admissions (
  run_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,node_id TEXT NOT NULL,binding_generation INTEGER NOT NULL,
  session_id TEXT NOT NULL,source TEXT NOT NULL,publisher_host TEXT NOT NULL,publisher_pid INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_org_run_admission_node ON organization_run_admissions(organization_id,node_id,state);`); }
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const parse=value=>{try{return JSON.parse(value || '{}');}catch{return null;}};

export async function reserveOrganizationRun({runId,sessionId,requestId,session}={}) {
  const managed=session?.sessionPlane==='organization' && session?.managedScope!=='consultation' && Boolean(session?.organizationId || session?.organizationNodeId);
  if (!await stat(CHAT_COLLABORATIONS_DB).then(()=>true,error=>{if(error?.code==='ENOENT') return false; throw error;})) { if(managed) fail('Organization storage is unavailable'); return null; }
  return withDatabase(db=>{schema(db);db.exec('BEGIN IMMEDIATE');try {
    const matches=[];
    if (table(db,'organization_nodes')) for(const n of db.prepare('SELECT * FROM organization_nodes WHERE current_session_id=? AND retired_revision IS NULL').all(sessionId)) matches.push({node:n,source:'binding'});
    if (table(db,'collaboration_dispatch_commands')) {
      const rows=db.prepare(`SELECT d.id,d.state,c.policy_json FROM collaboration_dispatch_commands d JOIN collaborations c ON c.id=d.collaboration_id
        JOIN collaboration_attempts a ON a.id=d.attempt_id WHERE d.session_id=? AND d.request_id=? AND a.state='running' AND d.state IN ('pending','claimed','completed')`).all(sessionId,requestId || '');
      for(const row of rows) { const p=parse(row.policy_json); if(!p) fail('Managed outbox policy is unavailable'); if(!p.organizationId && !p.organizationNodeId) continue;
        if(!p.organizationNodeId && p.organizationId && !managed && matches.length===0 && p.organizationBindingGeneration===undefined && !p.factoryExecution) continue;
        if(!p.organizationId || !p.organizationNodeId || !Number.isInteger(p.organizationBindingGeneration)) fail('Managed outbox binding is incomplete');
        const n=db.prepare('SELECT * FROM organization_nodes WHERE id=? AND organization_id=?').get(p.organizationNodeId,p.organizationId);
        if(!n || n.retired_revision!==null || n.binding_generation!==p.organizationBindingGeneration) fail('Managed outbox binding changed');
        matches.push({node:n,source:'outbox'});
      }
    }
    const unique=new Map(matches.map(x=>[`${x.node.organization_id}:${x.node.id}`,x]));
    if(unique.size>1) fail('Session has ambiguous organization binding');
    const found=[...unique.values()][0];
    if(managed && (!session.organizationId || !session.organizationNodeId || !found || found.node.organization_id!==session.organizationId || found.node.id!==session.organizationNodeId)) fail('Managed Session binding is unavailable');
    if(!found) {db.exec('COMMIT');return null;}
    const n=found.node;
    if(found.source==='outbox' && managed && sessionId!==n.current_session_id && session.parentSessionId!==n.current_session_id && session.delegatedFromSessionId!==n.current_session_id) fail('Managed child is not bound to the current node Session');
    if(table(db,'organization_node_rebind_operations') && db.prepare("SELECT 1 FROM organization_node_rebind_operations WHERE organization_id=? AND node_id=? AND state='pending'").get(n.organization_id,n.id)) fail('Node replacement is pending');
    const old=db.prepare('SELECT * FROM organization_run_admissions WHERE run_id=?').get(runId);
    if(old) fail('Run admission already exists; reconcile the prior publication');
    const ts=new Date().toISOString(); db.prepare("INSERT INTO organization_run_admissions VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)").run(runId,n.organization_id,n.id,n.binding_generation,sessionId,found.source,hostname(),process.pid,ts,ts);
    db.exec('COMMIT');return {runId,organizationId:n.organization_id,nodeId:n.id,bindingGeneration:n.binding_generation};
  } catch(error) {try{db.exec('ROLLBACK');}catch{}throw error;} },{mutate:true});
}
export async function reconcileOrganizationRunAdmissions({organizationId,nodeId,commandId}={}) {
  const rows=await withDatabase(db=>{schema(db);return db.prepare("SELECT * FROM organization_run_admissions WHERE organization_id=? AND node_id=? AND state NOT IN ('resolved','unpublished') ORDER BY created_at,run_id").all(organizationId,nodeId);});
  const {getRunAcceptanceEvidence,runDir}=await import('./runs.mjs');
  for(const row of rows) {
    const run=await getRunAcceptanceEvidence(row.run_id);
    let unpublished=false;
    if(!run && row.publisher_host===hostname() && Number.isInteger(row.publisher_pid) && row.publisher_pid>0) {
      let dead=false; try {process.kill(row.publisher_pid,0);} catch(error) {dead=error?.code==='ESRCH';}
      if(dead) unpublished=await stat(runDir(row.run_id)).then(()=>false,error=>error?.code==='ENOENT');
    }
    if(!unpublished && (!run || run.id!==row.run_id || run.sessionId!==row.session_id || !run.finalizedAt || !['completed','failed','cancelled'].includes(run.state))) fail(`Run ${row.run_id} requires reconciliation before node replacement`);
    await withDatabase(db=>{schema(db);db.exec('BEGIN IMMEDIATE');try {
      const pending=db.prepare("SELECT * FROM organization_node_rebind_operations WHERE command_id=? AND organization_id=? AND node_id=? AND state='pending'").get(commandId,organizationId,nodeId);
      const current=db.prepare('SELECT * FROM organization_run_admissions WHERE run_id=?').get(row.run_id);
      if(!pending || !current || current.organization_id!==organizationId || current.node_id!==nodeId || current.binding_generation!==pending.expected_generation || current.session_id!==row.session_id) fail('Admission or replacement identity changed');
      if(!unpublished && current.source==='outbox') {
        const attempts=db.prepare(`SELECT a.state,a.failure_kind,a.run_id FROM collaboration_dispatch_commands d JOIN collaboration_attempts a ON a.id=d.attempt_id
          WHERE d.session_id=? AND d.request_id=? AND d.run_id=?`).all(row.session_id,run.requestId,row.run_id);
        if(attempts.length!==1 || attempts[0].run_id!==row.run_id || !['succeeded','failed','cancelled'].includes(attempts[0].state) || attempts[0].failure_kind==='unknown_outcome') fail('Managed Attempt is not terminal or requires reconciliation');
      }
      db.prepare("UPDATE organization_run_admissions SET state='resolved',updated_at=? WHERE run_id=? AND state IN ('reserved','published','unknown')").run(new Date().toISOString(),row.run_id);
      db.exec('COMMIT');
    } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}},{mutate:true});
  }
}
export async function markOrganizationRunAdmission(runId,state) {
  if(!['published','unpublished','unknown'].includes(state)) fail('Invalid admission state');
  return withDatabase(db=>{schema(db);db.prepare("UPDATE organization_run_admissions SET state=?,updated_at=? WHERE run_id=? AND state='reserved'").run(state,new Date().toISOString(),runId);},{mutate:true});
}
