// Bounded local observations: only 403 responses emitted by the Factory handler.
// No request body, credential, principal or raw URL is retained.
import { factoryRead, factoryTransaction, now } from './work-graph-store.mjs';
import { authorize } from './work-graph.mjs';
const LIMIT=500;
function schema(db) { db.exec(`CREATE TABLE IF NOT EXISTS factory_api_denial_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, observed_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS factory_api_denial_org_id ON factory_api_denial_observations(organization_id,id);`); }
export async function recordFactoryApiDenial(organizationId) {
 if(typeof organizationId!=='string' || !organizationId || organizationId.length>160) return;
 return factoryTransaction(db=>{
  if(!db.prepare('SELECT 1 FROM organizations WHERE id=?').get(organizationId)) return;
  schema(db);db.prepare('INSERT INTO factory_api_denial_observations(organization_id,observed_at) VALUES(?,?)').run(organizationId,now());
  db.prepare('DELETE FROM factory_api_denial_observations WHERE organization_id=? AND id NOT IN (SELECT id FROM factory_api_denial_observations WHERE organization_id=? ORDER BY id DESC LIMIT ?)').run(organizationId,organizationId,LIMIT);
 });
}
export function factoryApiDenialSummary(db,organizationId) {
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_api_denial_observations'").get();
 if(!exists) return {state:'unknown',reason:'no_observation_store',coverage:'factory_handler_403_only'};
 try { const row=db.prepare('SELECT COUNT(*) AS count,MIN(observed_at) AS oldest,MAX(observed_at) AS latest FROM factory_api_denial_observations WHERE organization_id=?').get(organizationId);
  return {state:'observed',count:row.count,oldest:row.oldest || null,latest:row.latest || null,retentionLimit:LIMIT,coverage:'factory_handler_403_only',completeHistory:false,recording:'best_effort'};
 } catch { return {state:'unknown',reason:'observation_query_unavailable',coverage:'factory_handler_403_only'}; }
}
export async function listFactoryApiDenials(organizationId,actor) {
 if(actor?.kind!=='user' || actor.role!=='owner' || !actor.principalId) throw Object.assign(new Error('Owner required'),{statusCode:403});
 return factoryRead(db=>{authorize(db,organizationId,actor,'factory.read');const summary=factoryApiDenialSummary(db,organizationId);
  if(summary.state!=='observed') return {summary,items:[]};
  const items=db.prepare('SELECT id,observed_at FROM factory_api_denial_observations WHERE organization_id=? ORDER BY id DESC LIMIT 100').all(organizationId).map(r=>({id:r.id,observedAt:r.observed_at}));
  return {summary,items,truncated:summary.count>items.length};});
}
