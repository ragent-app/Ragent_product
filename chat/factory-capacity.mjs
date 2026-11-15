import { factoryError, now } from './work-graph-store.mjs';

function cap(name) {
  const raw=process.env[name]; if (raw===undefined || raw==='') return null;
  const value=Number(raw); if (!Number.isInteger(value)||value<1||value>10000) throw factoryError('FACTORY_CONFIGURATION_INVALID',`${name} must be an integer from 1 to 10000`);
  return value;
}

// Called under the claim transaction. Metadata is a server-observed Session
// identity, retained separately from mutable binding details.
export function claimFactoryCapacity(db,{item,node,bindingId,sessionId,tool,organization}) {
  db.exec(`CREATE TABLE IF NOT EXISTS factory_binding_runtime_identity (
    binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS factory_binding_runtime_identity_no_update BEFORE UPDATE ON factory_binding_runtime_identity BEGIN SELECT RAISE(ABORT,'immutable runtime identity'); END;
    CREATE TRIGGER IF NOT EXISTS factory_binding_runtime_identity_no_delete BEFORE DELETE ON factory_binding_runtime_identity BEGIN SELECT RAISE(ABORT,'immutable runtime identity'); END;`);
  if (!sessionId || node.current_session_id!==sessionId || typeof tool!=='string' || !tool.trim()) throw factoryError('FACTORY_CONFLICT','Managed session runtime identity changed');
  const instance=cap('RAGENT_FACTORY_INSTANCE_CAPACITY'), project=cap('RAGENT_FACTORY_PROJECT_CAPACITY');
  // The new intent has already been inserted by the enclosing transaction.
  const active=`b.status IN ('intent','running','unknown') AND b.id <> '${bindingId.replaceAll("'", "''")}'`;
  if(instance!==null && db.prepare(`SELECT COUNT(*) AS n FROM factory_execution_bindings b WHERE ${active}`).get().n>=instance) throw factoryError('FACTORY_CONFLICT','Instance capacity exhausted');
  if(project!==null && db.prepare(`SELECT COUNT(*) AS n FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE ${active} AND w.project_id=?`).get(item.project_id).n>=project) throw factoryError('FACTORY_CONFLICT','Project capacity exhausted');
  let harness={}; try { harness=JSON.parse(process.env.RAGENT_FACTORY_HARNESS_CAPACITIES||'{}'); } catch { throw factoryError('FACTORY_CONFIGURATION_INVALID','Invalid harness capacity configuration'); }
  if(!harness || typeof harness!=='object' || Array.isArray(harness) || Object.values(harness).some(x=>!Number.isInteger(x)||x<1||x>10000)) throw factoryError('FACTORY_CONFIGURATION_INVALID','Invalid harness capacity configuration');
  if(Object.keys(harness).length) {
    if(!Object.hasOwn(harness,tool)) throw factoryError('FACTORY_CAPABILITY_UNAVAILABLE','No configured capacity for this Harness');
    if(db.prepare(`SELECT 1 FROM factory_execution_bindings b LEFT JOIN factory_binding_runtime_identity r ON r.binding_id=b.id WHERE ${active} AND r.binding_id IS NULL LIMIT 1`).get()) throw factoryError('FACTORY_CONFLICT','Active binding has unknown Harness identity');
    if(db.prepare(`SELECT COUNT(*) AS n FROM factory_execution_bindings b JOIN factory_binding_runtime_identity r ON r.binding_id=b.id WHERE ${active} AND r.tool=?`).get(tool).n>=harness[tool]) throw factoryError('FACTORY_CONFLICT','Harness capacity exhausted');
  }
  const policy=JSON.parse(organization.policy_json||'{}'), reserved=policy.factoryReviewReserved;
  if(reserved!==undefined) {
    if(!Number.isInteger(reserved)||reserved<0||reserved>=policy.factoryMaxConcurrent) throw factoryError('FACTORY_CONFIGURATION_INVALID','Invalid review reservation');
    if(item.kind!=='review' && db.prepare(`SELECT COUNT(*) AS n FROM factory_execution_bindings b JOIN factory_work_items w ON w.id=b.work_item_id WHERE ${active} AND w.organization_id=?`).get(organization.id).n>=policy.factoryMaxConcurrent-reserved) throw factoryError('FACTORY_CONFLICT','Review capacity is reserved');
  }
  db.prepare('INSERT INTO factory_binding_runtime_identity VALUES(?,?,?,?)').run(bindingId,sessionId,tool,now());
}
