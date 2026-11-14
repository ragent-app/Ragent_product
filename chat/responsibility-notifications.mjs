import { createHash } from 'node:crypto';
import { getTrustedDeviceStatus } from './trusted-devices.mjs';
import { authorizeDeviceBinding } from '../lib/binding-authority-runtime.mjs';
import { getOwnerAccountBinding } from '../lib/owner-account-auth.mjs';
import { hasResponsibilityWebSubscription, responsibilitySubscriptionCredentialHash, sendResponsibilityWebPush } from './push.mjs';

const schema = `
CREATE TABLE IF NOT EXISTS responsibility_notification_settings (responsibility_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_notification_bindings (endpoint_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, account_id TEXT NOT NULL, authority_revision TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsibility_notification_outbox (event_id TEXT NOT NULL, responsibility_id TEXT NOT NULL, owner_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL, settings_version INTEGER NOT NULL, binding_version INTEGER NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(event_id,owner_id,endpoint_hash));`;
function ensureSchema(db) { db.exec(schema); if (!db.prepare('PRAGMA table_info(responsibility_notification_bindings)').all().some(c=>c.name==='credential_hash')) db.exec('ALTER TABLE responsibility_notification_bindings ADD COLUMN credential_hash TEXT'); }
const important = new Set(['plan_proposed','planning_needs_input','planning_invalid_output','plan_admission_blocked','planning_evidence_blocked','decision_waiting','budget_blocked','execution_attempt_failed','workflow_completed']);
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, code:'RESPONSIBILITY_NOTIFICATION_CONFLICT' });
const stamp = () => new Date().toISOString();
const owner = actor => { if (actor?.kind !== 'user' || actor?.role !== 'owner' || !actor.principalId) throw fail('Owner required',403); return actor.principalId; };

// Called inside the responsibility activity transaction, never sends network I/O.
export function enqueueResponsibilityNotification(db,{responsibilityId,sequence,type}) {
  ensureSchema(db);
  if (!important.has(type)) return;
  const r=db.prepare('SELECT r.owner_principal_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(responsibilityId);
  const settings=r&&db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=? AND owner_id=? AND enabled=1').get(responsibilityId,r.owner_principal_id);
  if (!settings) return;
  const bindings=db.prepare('SELECT * FROM responsibility_notification_bindings WHERE owner_id=? AND enabled=1').all(r.owner_principal_id);
  const insert=db.prepare('INSERT OR IGNORE INTO responsibility_notification_outbox VALUES(?,?,?,?,?,?,?,?,?)');
  for(const binding of bindings) insert.run(`responsibility:${responsibilityId}:${sequence}`,responsibilityId,r.owner_principal_id,binding.endpoint_hash,settings.version,binding.version,type,'pending',stamp());
}

async function verifiedDevice(session) {
  if (session?.principalKind !== 'trusted_device' || !session.deviceId || !session.accountId || !session.bindingAuthorityRevision || session.workspaceAccess) throw fail('Authenticated owner device required',403);
  const device=await getTrustedDeviceStatus(session.deviceId);
  if (!device || device.status!=='bound' || device.revokedAt || device.accountId!==session.accountId || device.bindingAuthorityRevision!==session.bindingAuthorityRevision) throw fail('Device binding unavailable',403);
  const account=await getOwnerAccountBinding(); if(!account?.accountId || account.accountId!==device.accountId) throw fail('Owner account binding changed',403);
  await authorizeDeviceBinding(device,{credential:true,tokenRevision:session.bindingAuthorityRevision});
  return device;
}

export async function registerResponsibilityNotificationSubscription(input,actor,session) {
  const principal=owner(actor), device=await verifiedDevice(session);
  const subscription=input?.subscription, endpoint=subscription?.endpoint;
  if (typeof endpoint!=='string' || endpoint.length>4096 || !endpoint.startsWith('https://')) throw fail('Valid existing subscription required',400);
  const endpointHash=createHash('sha256').update(endpoint).digest('hex');
  if (!await hasResponsibilityWebSubscription(subscription)) throw fail('Subscription is not registered',404);
  const credentialHash=responsibilitySubscriptionCredentialHash(subscription); if(!credentialHash) throw fail('Subscription credentials unavailable',400);
  const {transaction}=await import('./responsibility-store.mjs');
  return transaction(db=>{ensureSchema(db); const prior=db.prepare('SELECT * FROM responsibility_notification_bindings WHERE endpoint_hash=?').get(endpointHash);
    if(prior && (prior.owner_id!==principal || prior.device_id!==device.id)) throw fail('Subscription is already bound');
    const version=(prior?.version||0)+1;db.prepare('INSERT INTO responsibility_notification_bindings(endpoint_hash,owner_id,device_id,account_id,authority_revision,enabled,version,credential_hash) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET account_id=excluded.account_id,authority_revision=excluded.authority_revision,enabled=1,version=excluded.version,credential_hash=excluded.credential_hash').run(endpointHash,principal,device.id,device.accountId,device.bindingAuthorityRevision,version,credentialHash);
    return {schemaVersion:1,subscriptionId:endpointHash,version};});
}

export async function setResponsibilityNotificationSettings(id,input,actor) {
  const principal=owner(actor); if(typeof input?.enabled!=='boolean'||!Number.isSafeInteger(input.expectedVersion)||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()||input.confirmed!==true) throw fail('Confirmation, version and idempotency key required',400);
  const {transaction,receipt}=await import('./responsibility-store.mjs');
  return transaction(db=>{ensureSchema(db);return receipt(db,principal,'notification_settings',id,input.idempotencyKey,input,()=>{const r=db.prepare('SELECT r.owner_principal_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(id);if(!r||r.owner_principal_id!==principal) throw fail('Responsibility unavailable',404);const old=db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=?').get(id);if((old?.version||0)!==input.expectedVersion) throw fail('Notification settings changed'); const version=input.expectedVersion+1;db.prepare('INSERT INTO responsibility_notification_settings VALUES(?,?,?,?) ON CONFLICT(responsibility_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version').run(id,principal,input.enabled?1:0,version);return {schemaVersion:1,enabled:input.enabled,version};});});
}
export async function getResponsibilityNotificationSettings(id,actor) {
  const principal=owner(actor),{read}=await import('./responsibility-store.mjs');return read(db=>{ensureSchema(db);const r=db.prepare('SELECT r.owner_principal_id FROM responsibilities r JOIN organizations o ON o.id=r.organization_id AND o.project_id=r.project_id WHERE r.id=?').get(id);if(!r||r.owner_principal_id!==principal) throw fail('Responsibility unavailable',404);const s=db.prepare('SELECT * FROM responsibility_notification_settings WHERE responsibility_id=?').get(id);const bindings=db.prepare('SELECT endpoint_hash AS subscriptionId,device_id AS deviceId,version FROM responsibility_notification_bindings WHERE owner_id=? AND enabled=1').all(principal);const receipts=db.prepare('SELECT event_id AS eventId,type,state,updated_at AS updatedAt FROM responsibility_notification_outbox WHERE responsibility_id=? AND owner_id=? ORDER BY updated_at DESC LIMIT 20').all(id,principal);return {schemaVersion:1,enabled:s?.enabled===1,version:s?.version||0,deliveryEnabled:process.env.AGENTOC_RESPONSIBILITY_PUSH_ENABLED==='1',bindings,receipts};});
}
export async function revokeResponsibilityNotificationSubscription(input,actor) {
  const principal=owner(actor);if(!/^[a-f0-9]{64}$/.test(String(input?.subscriptionId||''))||!Number.isSafeInteger(input.expectedVersion)||input.confirmed!==true||typeof input.idempotencyKey!=='string'||!input.idempotencyKey.trim()) throw fail('Confirmation, version and idempotency key required',400);
  const {transaction,receipt}=await import('./responsibility-store.mjs');return transaction(db=>{ensureSchema(db);return receipt(db,principal,'notification_revoke',input.subscriptionId,input.idempotencyKey,input,()=>{const b=db.prepare('SELECT * FROM responsibility_notification_bindings WHERE endpoint_hash=? AND owner_id=?').get(input.subscriptionId,principal);if(!b||b.version!==input.expectedVersion) throw fail('Subscription binding changed');const version=b.version+1;db.prepare('UPDATE responsibility_notification_bindings SET enabled=0,version=? WHERE endpoint_hash=? AND owner_id=?').run(version,input.subscriptionId,principal);return {schemaVersion:1,subscriptionId:input.subscriptionId,enabled:false,version};});});
}

export async function processResponsibilityNotifications() {
  if (process.env.AGENTOC_RESPONSIBILITY_PUSH_ENABLED!=='1') return;
  const {transaction}=await import('./responsibility-store.mjs');
  const row=await transaction(db=>{ensureSchema(db);db.prepare("UPDATE responsibility_notification_outbox SET state='unknown',updated_at=? WHERE state='sending' AND updated_at<?").run(stamp(),new Date(Date.now()-300000).toISOString());
    db.prepare(`UPDATE responsibility_notification_outbox SET state='suppressed',updated_at=? WHERE state='pending' AND NOT EXISTS (
      SELECT 1 FROM responsibilities r JOIN organizations g ON g.id=r.organization_id AND g.project_id=r.project_id
      JOIN responsibility_notification_settings s ON s.responsibility_id=r.id AND s.owner_id=r.owner_principal_id
      JOIN responsibility_notification_bindings b ON b.owner_id=r.owner_principal_id AND b.endpoint_hash=responsibility_notification_outbox.endpoint_hash
      WHERE r.id=responsibility_notification_outbox.responsibility_id AND r.owner_principal_id=responsibility_notification_outbox.owner_id
      AND r.lifecycle NOT IN ('cancelled','archived') AND s.enabled=1 AND s.version=responsibility_notification_outbox.settings_version
      AND b.enabled=1 AND b.version=responsibility_notification_outbox.binding_version)`).run(stamp());
    const next=db.prepare("SELECT o.*,b.device_id,b.account_id,b.authority_revision,b.credential_hash,g.root_session_id FROM responsibility_notification_outbox o JOIN responsibility_notification_bindings b ON b.endpoint_hash=o.endpoint_hash AND b.owner_id=o.owner_id JOIN responsibility_notification_settings s ON s.responsibility_id=o.responsibility_id AND s.owner_id=o.owner_id JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id JOIN organizations g ON g.id=r.organization_id AND g.project_id=r.project_id WHERE o.state='pending' AND r.lifecycle NOT IN ('cancelled','archived') AND b.enabled=1 AND b.version=o.binding_version AND s.enabled=1 AND s.version=o.settings_version LIMIT 1").get();if(!next)return null;const claim=db.prepare("UPDATE responsibility_notification_outbox SET state='sending',updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='pending'").run(stamp(),next.event_id,next.owner_id,next.endpoint_hash);return claim.changes?next:null;});
  if(!row)return;
  let state='unknown';
  try {
    const device=await getTrustedDeviceStatus(row.device_id);
    const account=await getOwnerAccountBinding();
    if(!row.credential_hash || !account?.accountId || account.accountId!==row.account_id || !device || device.status!=='bound' || device.revokedAt || device.accountId!==row.account_id || device.bindingAuthorityRevision!==row.authority_revision) state='authorization_revoked';
    else { await authorizeDeviceBinding(device,{credential:true,tokenRevision:row.authority_revision});
      const allowed=await transaction(db=>!!db.prepare("SELECT 1 FROM responsibility_notification_outbox o JOIN responsibility_notification_bindings b ON b.endpoint_hash=o.endpoint_hash AND b.owner_id=o.owner_id JOIN responsibility_notification_settings s ON s.responsibility_id=o.responsibility_id AND s.owner_id=o.owner_id JOIN responsibilities r ON r.id=o.responsibility_id AND r.owner_principal_id=o.owner_id WHERE o.event_id=? AND o.endpoint_hash=? AND o.state='sending' AND r.lifecycle NOT IN ('cancelled','archived') AND b.enabled=1 AND b.version=o.binding_version AND s.enabled=1 AND s.version=o.settings_version").get(row.event_id,row.endpoint_hash));
      if(!allowed || process.env.AGENTOC_RESPONSIBILITY_PUSH_ENABLED!=='1') state='authorization_revoked';
      else {const query=new URLSearchParams({tab:'sessions',session:row.root_session_id,responsibility:row.responsibility_id});state=(await sendResponsibilityWebPush(row.endpoint_hash,row.credential_hash,{title:'Ragent',body:'A responsibility needs your attention.',kind:'responsibility',eventId:row.event_id,tag:row.event_id,sessionId:row.root_session_id,responsibilityId:row.responsibility_id,url:`/?${query}`})).state;}
    }
  } catch { state='unknown'; }
  await transaction(db=>db.prepare("UPDATE responsibility_notification_outbox SET state=?,updated_at=? WHERE event_id=? AND owner_id=? AND endpoint_hash=? AND state='sending'").run(state,stamp(),row.event_id,row.owner_id,row.endpoint_hash));
}
