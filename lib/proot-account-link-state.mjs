import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

// The instance is the sole serializer for this one local association. Accounts
// remains the authority for the separately signed account binding revision.
const path = join(CONFIG_DIR, 'proot-account-link.sqlite');
let db;
const signOutObservers = new Set();
export function subscribeProotAccountSignOut(observer) {
  signOutObservers.add(observer);
  return () => signOutObservers.delete(observer);
}
function openStore() {
  if (db) return db;
  if (!existsSync(path)) {
    try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const name of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(name)) continue;
    const info = lstatSync(name);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077)) throw new Error('Unsafe account link store');
  }
  db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS link_state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
      state TEXT NOT NULL, link_id TEXT, device_id TEXT, account_id TEXT, device_key TEXT, key_algorithm TEXT);
    INSERT OR IGNORE INTO link_state(id,generation,state) VALUES(1,0,'unlinked');
    CREATE TABLE IF NOT EXISTS unbind_state (id INTEGER PRIMARY KEY CHECK(id=1), pending INTEGER NOT NULL CHECK(pending IN (0,1)));
    INSERT OR IGNORE INTO unbind_state(id,pending) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS link_events (event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL, link_id TEXT NOT NULL, device_id TEXT NOT NULL, account_id TEXT NOT NULL);`);
  return db;
}
function projection(row) {
  return { state: row.state, generation: row.generation, linkId: row.link_id || null,
    deviceId: row.device_id || null, accountId: row.account_id || null };
}
export function readProotAccountLink() { return projection(openStore().prepare('SELECT * FROM link_state WHERE id=1').get()); }
export function readProotAccountLinkKey() { const row = openStore().prepare('SELECT device_key,key_algorithm FROM link_state WHERE id=1').get(); return { publicKey:row.device_key || '', algorithm:row.key_algorithm || '' }; }
export function prootRemoteAccountActive(accountId = '') {
  if (process.env.AGENTOC_RUNTIME_MODE !== 'proot') return true;
  try { const state = readProotAccountLink(); return state.state === 'active' && (!accountId || state.accountId === accountId); } catch { return false; }
}
export function reserveProotAccountInvitation(event) {
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    const state = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    if (state.state !== 'login_pending' || state.generation !== event.expectedGeneration || state.linkId !== event.linkId
        || state.deviceId !== event.deviceId || state.accountId !== event.accountId)
      throw Object.assign(new Error('Account link generation conflict'), { code:'account_link_generation_conflict', statusCode:409 });
    if (store.prepare('SELECT 1 FROM link_events WHERE event_id=?').get(event.eventId))
      throw Object.assign(new Error('Invitation event already used'), { code:'account_link_event_conflict', statusCode:409 });
    store.prepare('INSERT INTO link_events VALUES(?,?,?,?,?,?,?)').run(event.eventId, 'invitation', state.generation,
      state.state, state.linkId, state.deviceId, state.accountId);
    store.exec('COMMIT'); return state;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}
export function beginProotNativeLogin(requestId, expectedGeneration = null) {
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    if (store.prepare('SELECT pending FROM unbind_state WHERE id=1').get().pending)
      throw Object.assign(new Error('Account unlink is pending'), { code:'account_link_unbind_pending', statusCode:409 });
    const key = `native:${requestId}`;
    const prior = store.prepare('SELECT generation FROM link_events WHERE event_id=?').get(key);
    if (prior) { store.exec('COMMIT'); return prior.generation; }
    const state = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    if (expectedGeneration !== null && state.generation !== expectedGeneration)
      throw Object.assign(new Error('Account link generation conflict'), { code:'account_link_generation_conflict', statusCode:409 });
    store.prepare('INSERT INTO link_events VALUES(?,?,?,?,?,?,?)').run(key,'native-login',state.generation,state.state,
      state.linkId || '',state.deviceId || '',state.accountId || '');
    store.exec('COMMIT'); return state.generation;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}
export function prootLoginGenerationFor(requestId) {
  const row = openStore().prepare('SELECT generation FROM link_events WHERE event_id=? AND payload_hash=?').get(`native:${requestId}`, 'native-login');
  return row && Number.isSafeInteger(row.generation) ? row.generation : null;
}
export function assertProotOwnerAccount(accountId) {
  const state = readProotAccountLink();
  if (state.accountId && state.accountId !== accountId)
    throw Object.assign(new Error('Account link requires explicit conflict resolution'), { code:'account_link_conflict', statusCode:409 });
}
export function completeProotNativeLogin(generation, accountId, deviceId) {
  if (!Number.isSafeInteger(generation)) return readProotAccountLink();
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    const state = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    const unbindPending = store.prepare('SELECT pending FROM unbind_state WHERE id=1').get().pending;
    if (!unbindPending && state.state === 'signed_out' && state.generation === generation && state.accountId === accountId && (!deviceId || state.deviceId === deviceId)) {
      if (!Number.isSafeInteger(generation + 1)) throw new Error('Account link generation exhausted');
      store.prepare("UPDATE link_state SET state='login_pending',generation=? WHERE id=1").run(generation + 1);
    }
    const result = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    store.exec('COMMIT'); return result;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}
export function commitProotAccountEvent(event) {
  const store = openStore();
  const semantic = JSON.stringify([event.instanceId,event.linkId,event.deviceId,event.accountId,event.action,event.expectedGeneration]);
  const hash = createHash('sha256').update(semantic).digest('hex');
  store.exec('BEGIN IMMEDIATE');
  try {
    if (store.prepare('SELECT pending FROM unbind_state WHERE id=1').get().pending && event.action === 'link')
      throw Object.assign(new Error('Account unlink is pending'), { code:'account_link_unbind_pending', statusCode:409 });
    const receipt = store.prepare('SELECT * FROM link_events WHERE event_id=?').get(event.eventId);
    if (receipt) {
      if (receipt.payload_hash !== hash) throw Object.assign(new Error('Event identity conflict'), { code:'account_link_event_conflict', statusCode:409 });
      const current = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
      store.exec('COMMIT'); return { ...current, eventId:event.eventId, replay:true };
    }
    const current = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    if (event.expectedGeneration !== current.generation) throw Object.assign(new Error('Account link generation conflict'), { code:'account_link_generation_conflict', statusCode:409 });
    if (event.action === 'link') {
      if (current.state === 'active' || current.state === 'signed_out' || (current.state === 'login_pending'
          && (current.linkId !== event.linkId || current.deviceId !== event.deviceId || current.accountId !== event.accountId)))
        throw Object.assign(new Error('Account link requires explicit conflict resolution'), { code:'account_link_conflict', statusCode:409 });
    } else if (!['active','login_pending'].includes(current.state) || current.linkId !== event.linkId || current.deviceId !== event.deviceId || current.accountId !== event.accountId) {
      throw Object.assign(new Error('Account link is not active'), { code:'account_link_conflict', statusCode:409 });
    }
    const generation = current.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Account link generation exhausted');
    const state = event.action === 'link' ? 'active' : event.action === 'resume' ? 'login_pending' : 'signed_out';
    store.prepare('UPDATE link_state SET generation=?,state=?,link_id=?,device_id=?,account_id=?,device_key=?,key_algorithm=? WHERE id=1')
      .run(generation,state,event.linkId,event.deviceId,event.accountId,event.devicePublicKey,event.keyAlgorithm);
    store.prepare('INSERT INTO link_events VALUES(?,?,?,?,?,?,?)')
      .run(event.eventId,hash,generation,state,event.linkId,event.deviceId,event.accountId);
    store.exec('COMMIT');
    return { state,generation,linkId:event.linkId,deviceId:event.deviceId,accountId:event.accountId,eventId:event.eventId,replay:false };
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}

/** Close local authority before sending an unbind request whose result may be unknown. */
export function beginProotAccountUnbind() {
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    const current = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    store.prepare('UPDATE unbind_state SET pending=1 WHERE id=1').run();
    if (current.state === 'active' || current.state === 'login_pending') {
      if (!Number.isSafeInteger(current.generation + 1)) throw new Error('Account link generation exhausted');
      store.prepare("UPDATE link_state SET state='signed_out',generation=? WHERE id=1").run(current.generation + 1);
    }
    const result = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    store.exec('COMMIT');
    for (const observer of signOutObservers) { try { observer(result); } catch {} }
    return result;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}

/** Explicit instance-side sign-out. Keep the cloud owner binding and device grants. */
export function signOutProotAccountLink() {
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    const current = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    if (current.state === 'active' || current.state === 'login_pending') {
      if (!Number.isSafeInteger(current.generation + 1)) throw new Error('Account link generation exhausted');
      store.prepare("UPDATE link_state SET state='signed_out',generation=? WHERE id=1").run(current.generation + 1);
    }
    const result = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    store.exec('COMMIT');
    if (current.state === 'active' || current.state === 'login_pending') for (const observer of signOutObservers) { try { observer(result); } catch {} }
    return result;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}
/** Drop the association only after Accounts confirms that the owner binding ended. */
export function clearProotAccountLink() {
  const store = openStore(); store.exec('BEGIN IMMEDIATE');
  try {
    const current = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    if (current.state !== 'unlinked') {
      if (!Number.isSafeInteger(current.generation + 1)) throw new Error('Account link generation exhausted');
      store.prepare("UPDATE link_state SET state='unlinked',generation=?,link_id=NULL,device_id=NULL,account_id=NULL,device_key=NULL,key_algorithm=NULL WHERE id=1").run(current.generation + 1);
    }
    store.prepare('UPDATE unbind_state SET pending=0 WHERE id=1').run();
    const result = projection(store.prepare('SELECT * FROM link_state WHERE id=1').get());
    store.exec('COMMIT');
    if (current.state !== 'unlinked') for (const observer of signOutObservers) { try { observer(result); } catch {} }
    return result;
  } catch (error) { try { store.exec('ROLLBACK'); } catch {} throw error; }
}
