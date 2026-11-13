// One explicitly authorized asset, not a directory synchronizer or Factory acceptance path.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { factoryRead, factoryTransaction, factoryError, now } from './work-graph-store.mjs';
import { getSession } from './session-manager.mjs';
import { getFileAsset, localizeFileAsset, createFileAssetUploadIntent, ingestFileAssetUpload, finalizeFileAssetUpload, findFileAssetUploadReceipt } from './file-assets.mjs';
import { loadOrCreateInstanceIdentity, signWithInstanceIdentity } from '../lib/instance-identity.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { proxyToTarget } from './router-target-runtime-routes.mjs';

const LIMIT=4*1024*1024, text=v=>typeof v==='string'?v.trim():'', hash=v=>createHash('sha256').update(v).digest('hex');
function id(v) {const s=text(v);if(!/^[A-Za-z0-9_-]{1,160}$/.test(s)) throw factoryError('FILE_TRANSFER_INVALID','Invalid identity',400);return s;}
function schema(db) {db.exec(`CREATE TABLE IF NOT EXISTS remote_file_grants (
 id TEXT PRIMARY KEY,role TEXT NOT NULL,owner_id TEXT NOT NULL,peer_id TEXT NOT NULL,peer_key TEXT NOT NULL,
 session_id TEXT NOT NULL,asset_id TEXT NOT NULL,peer_grant_id TEXT NOT NULL,peer_version INTEGER NOT NULL,
 sha256 TEXT NOT NULL,size_bytes INTEGER NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,
 version INTEGER NOT NULL,enabled INTEGER NOT NULL,expires_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS remote_file_transfers (
 grant_id TEXT NOT NULL,transfer_id TEXT NOT NULL,payload_digest TEXT NOT NULL,status TEXT NOT NULL,
 target_asset_id TEXT,updated_at TEXT NOT NULL,scope_json TEXT NOT NULL DEFAULT '',PRIMARY KEY(grant_id,transfer_id));
 CREATE TABLE IF NOT EXISTS remote_file_source_transfers (
 grant_id TEXT NOT NULL,transfer_id TEXT NOT NULL,payload_digest TEXT NOT NULL,status TEXT NOT NULL,
 receipt_json TEXT,updated_at TEXT NOT NULL,scope_json TEXT NOT NULL DEFAULT '',PRIMARY KEY(grant_id,transfer_id));`);
  for(const table of ['remote_file_transfers','remote_file_source_transfers']) if(!db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name==='scope_json')) db.exec(`ALTER TABLE ${table} ADD COLUMN scope_json TEXT NOT NULL DEFAULT ''`);
}
function active(row) {return row && row.enabled && Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at)>Date.now();}
function validKey(key,peer) {try{return createPublicKey(key).asymmetricKeyType==='ed25519'&&`inst_${createInstancePublicKeyFingerprint(key).slice(0,32)}`===peer;}catch{return false;}}
function grant(row) {return {id:row.id,role:row.role,ownerId:row.owner_id,peerId:row.peer_id,peerKey:row.peer_key,sessionId:row.session_id,assetId:row.asset_id,peerGrantId:row.peer_grant_id,peerVersion:row.peer_version,sha256:row.sha256,sizeBytes:row.size_bytes,filename:row.filename,mime:row.mime,version:row.version,enabled:!!row.enabled,expiresAt:row.expires_at};}
export async function configureRemoteFileGrant(input,actor) {
  if(actor?.kind!=='user'||actor?.role!=='owner'||!text(actor.principalId)) throw factoryError('FILE_TRANSFER_FORBIDDEN','Owner required',403);
  const grantId=id(input?.id),role=text(input?.role),peer=id(input?.peerId),key=text(input?.peerKey),sessionId=id(input?.sessionId),peerGrantId=id(input?.peerGrantId),assetId=role==='source'?id(input?.assetId):'';
  if(!['source','target'].includes(role)||!validKey(key,peer)||!Number.isSafeInteger(input?.expectedVersion)||input.expectedVersion<0||!Number.isSafeInteger(input.peerVersion)||input.peerVersion<1
      ||!Number.isSafeInteger(input.sizeBytes)||input.sizeBytes<1||input.sizeBytes>LIMIT||!/^[a-f0-9]{64}$/.test(text(input.sha256))||!text(input.filename)||text(input.filename).length>255
      ||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()) throw factoryError('FILE_TRANSFER_INVALID','Grant scope invalid',400);
  const session=await getSession(sessionId); if(!session?.id || session.archived) throw factoryError('FILE_TRANSFER_INVALID','Session unavailable',409);
  if(role==='source') {const asset=await getFileAsset(assetId);if(!asset||asset.sessionId!==sessionId||asset.status!=='ready'||asset.sizeBytes!==input.sizeBytes||asset.sha256!==input.sha256) throw factoryError('FILE_TRANSFER_INVALID','Source asset does not match grant',409);}
  return factoryTransaction(db=>{schema(db);const old=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);if((old?.version||0)!==input.expectedVersion||(old&&(old.owner_id!==actor.principalId||old.role!==role))) throw factoryError('FILE_TRANSFER_CONFLICT','Grant changed',409);
    db.prepare(`INSERT INTO remote_file_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,peer_id=excluded.peer_id,peer_key=excluded.peer_key,session_id=excluded.session_id,asset_id=excluded.asset_id,peer_grant_id=excluded.peer_grant_id,peer_version=excluded.peer_version,sha256=excluded.sha256,size_bytes=excluded.size_bytes,filename=excluded.filename,mime=excluded.mime,version=excluded.version,enabled=excluded.enabled,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(grantId,role,actor.principalId,peer,key,sessionId,assetId,peerGrantId,input.peerVersion,input.sha256,input.sizeBytes,text(input.filename),text(input.mime)||'application/octet-stream',input.expectedVersion+1,input.enabled===false?0:1,new Date(input.expiresAt).toISOString(),now());return grant(db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId));});
}
export async function revokeRemoteFileGrant(grantId,expectedVersion,actor) {
  grantId=id(grantId);if(actor?.kind!=='user'||actor?.role!=='owner'||!text(actor.principalId)||!Number.isSafeInteger(expectedVersion)) throw factoryError('FILE_TRANSFER_FORBIDDEN','Owner and version required',403);
  return factoryTransaction(db=>{schema(db);const row=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);if(!row||row.owner_id!==actor.principalId||row.version!==expectedVersion) throw factoryError('FILE_TRANSFER_CONFLICT','Grant changed',409);
    db.prepare('UPDATE remote_file_grants SET enabled=0,version=version+1,updated_at=? WHERE id=?').run(now(),grantId);return grant(db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId));});
}
function principalOk(principal,grantId,operation) {if(!principal?.targetRuntime||principal.targetRuntimeOperation!==operation||principal.targetRuntimeResourceId!==grantId) throw factoryError('FILE_TRANSFER_FORBIDDEN','Target grant required',403);}
async function currentTarget(grantId,principal,operation) {principalOk(principal,grantId,operation);return factoryRead(db=>{schema(db);const row=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);if(!row||row.role!=='target'||row.peer_id!==principal.sourceInstanceId) throw factoryError('FILE_TRANSFER_FORBIDDEN','Transfer source mismatch',403);return grant(row);});}
export async function receiveRemoteFile(input,principal) {
  const grantId=id(input?.grantId),transferId=id(input?.transferId), g=await currentTarget(grantId,principal,'file.transfer.write');
  const canonical={grantId,transferId,sourceGrantId:id(input.sourceGrantId),sourceVersion:input.sourceVersion,targetVersion:input.targetVersion,sha256:text(input.sha256),sizeBytes:input.sizeBytes,bytes:text(input.bytes)};
  const bytes=Buffer.from(canonical.bytes,'base64');
  if(!g.enabled||Date.parse(g.expiresAt)<=Date.now()||canonical.targetVersion!==g.version||canonical.sourceGrantId!==g.peerGrantId||canonical.sourceVersion!==g.peerVersion||canonical.sha256!==g.sha256||canonical.sizeBytes!==g.sizeBytes||bytes.length!==g.sizeBytes||hash(bytes)!==g.sha256) throw factoryError('FILE_TRANSFER_FORBIDDEN','Transfer scope changed',403);
  let ok=false;try {ok=verify(null,Buffer.from(`agentoc-file-transfer-v1:${hash(JSON.stringify(canonical))}`),createPublicKey(g.peerKey),Buffer.from(text(input.signature),'base64url'));}catch{} if(!ok) throw factoryError('FILE_TRANSFER_FORBIDDEN','Transfer signature invalid',403);
  const payloadDigest=hash(JSON.stringify(canonical));
  const claimed=await factoryTransaction(db=>{schema(db);const row=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId), old=db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId,transferId);
    if(!active(row)||row.version!==g.version) throw factoryError('FILE_TRANSFER_FORBIDDEN','Target authorization changed',403);
    if(old) {if(old.payload_digest!==payloadDigest) throw factoryError('FILE_TRANSFER_CONFLICT','Transfer identity reused',409);return false;}
    db.prepare('INSERT INTO remote_file_transfers (grant_id,transfer_id,payload_digest,status,target_asset_id,updated_at,scope_json) VALUES(?,?,?,?,?,?,?)').run(grantId,transferId,payloadDigest,'unknown',null,now(),JSON.stringify(g));return true;});
  if(!claimed) return queryRemoteFile(grantId,transferId,principal,{operation:'file.transfer.write'});
  const authorize=async()=>{const current=await currentTarget(grantId,principal,'file.transfer.write');if(!current.enabled||current.version!==g.version||Date.parse(current.expiresAt)<=Date.now()) throw factoryError('FILE_TRANSFER_FORBIDDEN','Target authorization changed',403);const session=await getSession(g.sessionId);if(!session?.id||session.archived) throw factoryError('FILE_TRANSFER_FORBIDDEN','Target session unavailable',403);};
  try {await authorize();const intent=await createFileAssetUploadIntent({sessionId:g.sessionId,originalName:g.filename,mimeType:g.mime,sizeBytes:g.sizeBytes,sha256:g.sha256,requestId:transferId,principalScope:`remote-file:${grantId}`,forceLocal:true,authorize});
    const assetId=intent.asset.id;if(!intent.duplicate) await ingestFileAssetUpload(assetId,Readable.from(bytes),{authorize});const result=await finalizeFileAssetUpload(assetId,{sizeBytes:g.sizeBytes,authorize});
    const confirmed=await factoryTransaction(db=>{schema(db);const current=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);if(!active(current)||current.version!==g.version) return false;db.prepare('UPDATE remote_file_transfers SET status=?,target_asset_id=?,updated_at=? WHERE grant_id=? AND transfer_id=?').run('received',assetId,now(),grantId,transferId);return true;});
    if(!confirmed) return {grantId,transferId,status:'unknown'};
    return {grantId,transferId,status:'received',targetAssetId:result.id,sha256:g.sha256,sizeBytes:g.sizeBytes};
  }catch{return {grantId,transferId,status:'unknown'};}
}
export async function queryRemoteFile(grantId,transferId,principal,{operation='file.transfer.read'}={}) {
  grantId=id(grantId);transferId=id(transferId);principalOk(principal,grantId,operation);
  const saved=await factoryRead(db=>{schema(db);return db.prepare('SELECT * FROM remote_file_transfers WHERE grant_id=? AND transfer_id=?').get(grantId,transferId);});if(!saved) throw factoryError('FILE_TRANSFER_NOT_FOUND','Transfer unavailable',404);
  let g;try {g=JSON.parse(saved.scope_json);} catch {return {grantId,transferId,status:'unknown'};}
  if(!g||g.id!==grantId||g.role!=='target'||g.peerId!==principal.sourceInstanceId||!g.sessionId||!/^[a-f0-9]{64}$/.test(g.sha256)||!Number.isSafeInteger(g.sizeBytes)) return {grantId,transferId,status:'unknown'};
  const found=await findFileAssetUploadReceipt({sessionId:g.sessionId,requestId:transferId,principalScope:`remote-file:${grantId}`}).catch(()=>null);
  const asset=found?.asset;return asset?.status==='ready'&&asset.sha256===g.sha256&&asset.sizeBytes===g.sizeBytes?{grantId,transferId,status:'received',targetAssetId:asset.id,sha256:g.sha256,sizeBytes:g.sizeBytes}:{grantId,transferId,status:'unknown'};
}
export async function signRemoteFileReceipt(receipt) {const identity=await loadOrCreateInstanceIdentity(),body={targetInstanceId:identity.instanceId,receipt};return {...body,signature:signWithInstanceIdentity(identity,`agentoc-file-receipt-v1:${hash(JSON.stringify(body))}`)};}
export async function sendRemoteFile(grantId,transferId,actor,{targetRevision=0}={}) {
  grantId=id(grantId);transferId=id(transferId);const row=await factoryRead(db=>{schema(db);return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);});
  if(!active(row)||row.role!=='source'||actor?.kind!=='user'||actor.role!=='owner'||row.owner_id!==actor.principalId) throw factoryError('FILE_TRANSFER_FORBIDDEN','Source authorization unavailable',403);
  const g=grant(row),session=await getSession(g.sessionId),asset=await getFileAsset(g.assetId);if(!session?.id||session.archived||!asset||asset.sessionId!==g.sessionId||asset.status!=='ready'||asset.sha256!==g.sha256||asset.sizeBytes!==g.sizeBytes) throw factoryError('FILE_TRANSFER_CONFLICT','Source session or asset changed',409);
  const bytes=await readFile(await localizeFileAsset(asset));if(bytes.length!==g.sizeBytes||hash(bytes)!==g.sha256) throw factoryError('FILE_TRANSFER_CONFLICT','Source bytes changed',409);
  const identity=await loadOrCreateInstanceIdentity(),canonical={grantId:g.peerGrantId,transferId,sourceGrantId:g.id,sourceVersion:g.version,targetVersion:g.peerVersion,sha256:g.sha256,sizeBytes:g.sizeBytes,bytes:bytes.toString('base64')};
  const payloadDigest=hash(JSON.stringify(canonical));
  const claimed=await factoryTransaction(db=>{schema(db);const still=db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId),old=db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId,transferId);
    if(old) {if(old.payload_digest!==payloadDigest) throw factoryError('FILE_TRANSFER_CONFLICT','Transfer identity reused',409);return false;}
    if(!active(still)||still.version!==g.version) throw factoryError('FILE_TRANSFER_FORBIDDEN','Source authorization changed',403);
    db.prepare('INSERT INTO remote_file_source_transfers (grant_id,transfer_id,payload_digest,status,receipt_json,updated_at,scope_json) VALUES(?,?,?,?,?,?,?)').run(grantId,transferId,payloadDigest,'unknown',null,now(),JSON.stringify(g));return true;});
  if(!claimed) return {grantId,transferId,status:'unknown',reason:'query_required'};
  const signature=signWithInstanceIdentity(identity,`agentoc-file-transfer-v1:${hash(JSON.stringify(canonical))}`),path=`/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`,requestId=`file_${randomUUID()}`;
  try {const summaryId=`summary_${randomUUID()}`,summary=await proxyToTarget({targetId:g.peerId,requestId:summaryId,idempotencyKey:summaryId,method:'GET',path:'/api/runtime/summary',operation:'runtime.summary',resourceId:g.peerId,expectedRevision:0});if(!summary.response.ok) throw new Error();const revision=Number(JSON.parse(summary.body.toString('utf8'))?.revision);if(!Number.isSafeInteger(revision)||revision<0) throw new Error();
    const latest=await factoryRead(db=>{schema(db);return db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId);}),currentSession=await getSession(g.sessionId),currentAsset=await getFileAsset(g.assetId);
    if(!active(latest)||latest.version!==g.version||!currentSession?.id||currentSession.archived||!currentAsset||currentAsset.status!=='ready'||currentAsset.sessionId!==g.sessionId||currentAsset.sha256!==g.sha256||currentAsset.sizeBytes!==g.sizeBytes) throw new Error('Source authorization, session or asset changed');
    const {response,body}=await proxyToTarget({targetId:g.peerId,requestId,idempotencyKey:transferId,method:'POST',path,operation:'file.transfer.write',resourceId:g.peerGrantId,expectedRevision:revision,body:JSON.stringify({...canonical,signature}),headers:{'content-type':'application/json'}});if(!response.ok) throw new Error();const envelope=JSON.parse(body.toString('utf8')),receipt=envelope?.receipt;
    const valid=envelope?.targetInstanceId===g.peerId&&verify(null,Buffer.from(`agentoc-file-receipt-v1:${hash(JSON.stringify({targetInstanceId:envelope.targetInstanceId,receipt}))}`),createPublicKey(g.peerKey),Buffer.from(text(envelope.signature),'base64url'));
    if(!valid||receipt?.grantId!==g.peerGrantId||receipt?.transferId!==transferId||receipt?.sha256!==g.sha256||receipt?.sizeBytes!==g.sizeBytes) throw new Error();
    await factoryTransaction(db=>{schema(db);db.prepare('UPDATE remote_file_source_transfers SET status=?,receipt_json=?,updated_at=? WHERE grant_id=? AND transfer_id=?').run(receipt.status,JSON.stringify(receipt),now(),grantId,transferId);});return receipt;
  }catch{return {grantId,transferId,status:'unknown'};}
}
export async function queryRemoteFileFromSource(grantId,transferId,actor) {
  grantId=id(grantId);transferId=id(transferId);const data=await factoryRead(db=>{schema(db);return {row:db.prepare('SELECT * FROM remote_file_grants WHERE id=?').get(grantId),saved:db.prepare('SELECT * FROM remote_file_source_transfers WHERE grant_id=? AND transfer_id=?').get(grantId,transferId)};});
  if(!data.row||!data.saved||data.row.role!=='source'||actor?.kind!=='user'||actor.role!=='owner'||data.row.owner_id!==actor.principalId) throw factoryError('FILE_TRANSFER_FORBIDDEN','Source owner required',403);
  let g;try {g=JSON.parse(data.saved.scope_json);} catch {return {grantId,transferId,status:'unknown'};}
  if(!g||g.id!==grantId||g.role!=='source'||g.ownerId!==actor.principalId||!validKey(g.peerKey,g.peerId)) return {grantId,transferId,status:'unknown'};
  const path=`/api/remote-files/grants/${g.peerGrantId}/transfers/${transferId}`,requestId=`file_read_${randomUUID()}`;
  try {const {response,body}=await proxyToTarget({targetId:g.peerId,requestId,idempotencyKey:requestId,method:'GET',path,operation:'file.transfer.read',resourceId:g.peerGrantId,expectedRevision:0});
    if(!response.ok) throw new Error();const envelope=JSON.parse(body.toString('utf8')),receipt=envelope?.receipt;
    const valid=envelope?.targetInstanceId===g.peerId&&verify(null,Buffer.from(`agentoc-file-receipt-v1:${hash(JSON.stringify({targetInstanceId:envelope.targetInstanceId,receipt}))}`),createPublicKey(g.peerKey),Buffer.from(text(envelope.signature),'base64url'));
    if(!valid||receipt?.grantId!==g.peerGrantId||receipt?.transferId!==transferId||(receipt.status==='received'&&(receipt.sha256!==g.sha256||receipt.sizeBytes!==g.sizeBytes))) throw new Error();
    await factoryTransaction(db=>{schema(db);db.prepare('UPDATE remote_file_source_transfers SET status=?,receipt_json=?,updated_at=? WHERE grant_id=? AND transfer_id=?').run(receipt.status,JSON.stringify(receipt),now(),grantId,transferId);});return receipt;
  }catch{return {grantId,transferId,status:'unknown'};}
}
