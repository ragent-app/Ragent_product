// Owner-scoped one-report fence. It never grants a node permission.
import { factoryError } from './work-graph-store.mjs';

export function ensureOwnerReportScope(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_owner_report_scope (
    organization_id TEXT NOT NULL, command_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL, node_id TEXT, state TEXT NOT NULL, work_item_id TEXT,
    dispatch_key TEXT, max_tokens INTEGER NOT NULL, max_cost REAL NOT NULL, created_at TEXT NOT NULL,
    responsibility_id TEXT
  ); CREATE UNIQUE INDEX IF NOT EXISTS factory_one_open_owner_report_scope ON factory_owner_report_scope(organization_id) WHERE state <> 'closed'`);
}

// Called within the same transaction as claim; pending fences all admissions.
export function assertOwnerReportClaim(db, org, item, dispatchKey) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_owner_report_scope'").get()) return;
  const scope=db.prepare("SELECT * FROM factory_owner_report_scope WHERE organization_id=? AND state<>'closed'").get(org.id);
  if (!scope) return;
  const fail=()=>{ throw factoryError('FACTORY_OWNER_REPORT_SCOPE','Only the explicitly authorized single read-only report can be claimed',409); };
  if(scope.state!=='ready' || !scope.node_id || item.assignee_node_id!==scope.node_id || item.project_id!==scope.project_id) fail();
  if(scope.work_item_id && (scope.work_item_id!==item.id || scope.dispatch_key!==dispatchKey)) fail();
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='responsibility_work_links'").get()) fail();
  const link=db.prepare(`SELECT r.id,r.owner_principal_id,r.lifecycle,p.policy_json,p.valid_until
    FROM responsibility_work_links l JOIN responsibilities r ON r.id=l.responsibility_id
    JOIN responsibility_policy_revisions p ON p.responsibility_id=r.id AND p.revision=r.policy_revision
    WHERE l.goal_id=? AND r.organization_id=? AND r.project_id=? AND r.id=?`).get(item.goal_id,org.id,scope.project_id,scope.responsibility_id);
  let policy,contract;
  try { policy=JSON.parse(link?.policy_json || '{}'); contract=JSON.parse(db.prepare('SELECT contract_json FROM factory_work_contracts WHERE work_item_id=? AND revision=?').get(item.id,item.contract_revision)?.contract_json || '{}'); }
  catch { fail(); }
  if(!link || link.id!==scope.responsibility_id || link.owner_principal_id!==scope.owner_id || link.lifecycle!=='active' || !Number.isFinite(Date.parse(link.valid_until)) || Date.parse(link.valid_until)<=Date.now()
    || policy.providerId!=='project-report' || policy.nodeBindings?.report?.nodeId!==scope.node_id
    || contract.accessMode!=='read' || contract.resource?.projectId!==scope.project_id || contract.resource?.readScope!=='entire_project'
    || !Array.isArray(contract.allowedPaths) || contract.allowedPaths.length || item.kind!=='execution') fail();
  if(!scope.work_item_id) {
    const result=db.prepare("UPDATE factory_owner_report_scope SET work_item_id=?,dispatch_key=? WHERE organization_id=? AND state='ready' AND work_item_id IS NULL")
      .run(item.id,dispatchKey,org.id);
    if(result.changes!==1) fail();
  }
}
