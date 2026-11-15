// Transactional cookie-session authority. The caller owns/protects this namespace;
// path checks do not establish Windows ACLs or isolate equal-UID processes.
import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,readFileSync,writeFileSync,fsyncSync,fstatSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHmac,randomUUID} from 'node:crypto';
const typed=code=>Object.assign(new Error(code),{code});
const keyValid=key=>typeof key==='string'&&/^s[a-f0-9]{64}$/.test(key);
function regular(file){
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw typed('AUTH_SESSION_PATH_UNSAFE');return stat;
}
function boundedJson(file,limit){
  const before=regular(file);if(before.size>limit)throw typed('AUTH_SESSION_DATA_INVALID');
  const fd=openSync(file,'r');try{const actual=fstatSync(fd);if(actual.dev!==before.dev||actual.ino!==before.ino||actual.nlink!==1)throw typed('AUTH_SESSION_PATH_UNSAFE');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
function parents(file){for(let path=dirname(file);;path=dirname(path)){
  const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path).toLowerCase()!==path.toLowerCase())throw typed('AUTH_SESSION_PATH_UNSAFE');if(path===dirname(path))break;
}}
function validSession(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.expiry)&&value.expiry>0&&typeof value.role==='string'&&value.role.length>0;}

export function openAuthSessionStore({legacyFile,databaseFile,secret,normalizeSession=value=>value,clock=Date.now}={}){
  if(typeof legacyFile!=='string'||typeof databaseFile!=='string'||typeof secret!=='string'||!secret)throw typed('AUTH_SESSION_CONFIGURATION_REQUIRED');
  const legacy=resolve(legacyFile),file=resolve(databaseFile),marker=file+'.cutover',keyId=createHmac('sha256',secret).update('ragent-auth-store-key-v1').digest('hex');
  let db,healthy=true,closed=false;
  function transaction(action){
    if(closed||!healthy)throw typed('AUTH_SESSION_STORE_UNAVAILABLE');
    try{db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}}
    catch(error){if(error?.code==='ERR_SQLITE_ERROR'&&[5,6].includes(error.errcode))throw typed('AUTH_SESSION_STORE_BUSY');if(error?.code==='AUTH_SESSION_CAPACITY')throw error;healthy=false;throw typed('AUTH_SESSION_STORE_UNAVAILABLE');}
  }
  try{
    parents(file);if(dirname(file)!==dirname(legacy))throw typed('AUTH_SESSION_CONFIGURATION_REQUIRED');
    for(const path of [file,marker,file+'-wal',file+'-shm',file+'-journal'])if(existsSync(path))regular(path);
    let cutover,initial=false,imported=[];
    if(!existsSync(marker)){
      if(existsSync(file))throw typed('AUTH_SESSION_CUTOVER_INVALID');
      if(existsSync(legacy)){
        const data=boundedJson(legacy,8*1024*1024);
        if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length>10000)throw typed('AUTH_SESSION_DATA_INVALID');
        for(const [key,value]of Object.entries(data)){
          if(!keyValid(key)&&!/^[A-Za-z0-9._~-]{1,256}$/.test(key))throw typed('AUTH_SESSION_DATA_INVALID');
          const session=normalizeSession(value);if(!validSession(session))throw typed('AUTH_SESSION_DATA_INVALID');
          if(session.expiry>clock())imported.push([keyValid(key)?key:'s'+createHmac('sha256',secret).update(key).digest('hex'),session]);
        }
      }
      cutover={version:1,id:randomUUID(),keyId};
      // A failed/killed initial cutover is deliberately not retried as a fresh
      // import. Marker-before-DB prevents missing/replaced DB reviving legacy.
      const fd=openSync(marker,'wx',0o600);try{writeFileSync(fd,JSON.stringify(cutover)+'\n');fsyncSync(fd);}finally{closeSync(fd);}initial=true;
      const databaseFd=openSync(file,'wx',0o600);try{fsyncSync(databaseFd);}finally{closeSync(databaseFd);}
    }else{
      cutover=boundedJson(marker,1024);
      if(cutover?.version!==1||typeof cutover.id!=='string'||cutover.keyId!==keyId||!existsSync(file))throw typed('AUTH_SESSION_CUTOVER_INVALID');
    }
    db=new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
    if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'||db.prepare('PRAGMA synchronous').get().synchronous!==2)throw typed('AUTH_SESSION_STORE_UNAVAILABLE');
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw typed('AUTH_SESSION_DATA_INVALID');
    if(initial){
      transaction(()=>{
        db.exec('CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, cutover TEXT NOT NULL, key_id TEXT NOT NULL); CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expiry INTEGER NOT NULL, data TEXT NOT NULL) STRICT;');
        db.prepare('INSERT INTO metadata VALUES(1,1,?,?)').run(cutover.id,keyId);
        const insert=db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?)');for(const [key,session]of imported)insert.run(key,session.expiry,JSON.stringify(session));
      });
    }
    const metadata=db.prepare('SELECT * FROM metadata WHERE id=1').get();
    if(metadata?.version!==1||metadata.cutover!==cutover.id||metadata.key_id!==keyId)throw typed('AUTH_SESSION_CUTOVER_INVALID');
  }catch(error){try{db?.close();}catch{}throw typed(/^AUTH_SESSION_[A-Z_]+$/.test(error?.code||'')?error.code:'AUTH_SESSION_STORE_UNAVAILABLE');}
  function read(action){if(closed||!healthy)throw typed('AUTH_SESSION_STORE_UNAVAILABLE');try{return action();}catch{healthy=false;throw typed('AUTH_SESSION_STORE_UNAVAILABLE');}}
  function decode(row){if(!row)return null;const value=JSON.parse(row.data);if(!validSession(value)||value.expiry!==row.expiry)throw typed('AUTH_SESSION_DATA_INVALID');return value;}
  const store={
    get healthy(){return healthy&&!closed;},
    get(key){if(!keyValid(key))return null;return read(()=>decode(db.prepare('SELECT data,expiry FROM sessions WHERE token_hash=?').get(key)));},
    snapshot(){return read(()=>new Map(db.prepare('SELECT token_hash,data,expiry FROM sessions WHERE expiry>? ORDER BY token_hash').all(clock()).map(row=>[row.token_hash,decode(row)])));},
    insert(key,session){
      if(!keyValid(key)||!validSession(session))throw typed('AUTH_SESSION_DATA_INVALID');const json=JSON.stringify(session);if(Buffer.byteLength(json)>16384)throw typed('AUTH_SESSION_DATA_INVALID');
      return transaction(()=>{
        db.prepare('DELETE FROM sessions WHERE expiry<=?').run(clock());
        if(db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total>=10000){
          // Only loopback browser sessions are disposable in this recovery:
          // never evict Google, paired-device, or other authentication state.
          if(session.authMethod==='local_web'&&session.role==='owner'){
            db.prepare("DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE json_extract(data,'$.authMethod')='local_web' AND json_extract(data,'$.role')='owner' ORDER BY expiry,token_hash LIMIT 1)").run();
          }
          if(db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total>=10000)throw typed('AUTH_SESSION_CAPACITY');
        }
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(key,session.expiry,json);return true;
      });
    },
    revoke(key){if(!keyValid(key))return false;return transaction(()=>db.prepare('DELETE FROM sessions WHERE token_hash=?').run(key).changes>0);},
    refresh(key,{force=false,windowMs,expiryMs}={}){
      if(!keyValid(key)||!Number.isSafeInteger(windowMs)||!Number.isSafeInteger(expiryMs))throw typed('AUTH_SESSION_DATA_INVALID');
      return transaction(()=>{const now=clock(),value=decode(db.prepare('SELECT data,expiry FROM sessions WHERE token_hash=?').get(key));
        if(!value||value.expiry<=now||(!force&&value.expiry-now>windowMs))return false;
        value.expiry=now+expiryMs;db.prepare('UPDATE sessions SET expiry=?,data=? WHERE token_hash=?').run(value.expiry,JSON.stringify(value),key);return true;
      });
    },
    flush(){return read(()=>true);}, // Every returned mutation already COMMITed.
    close(){if(closed)return;db.close();closed=true;},
  };
  return Object.freeze(store);
}

// Read-only administration count; never open/create authority or fall back to
// stale JSON after any cutover marker/database is present. No secret is needed.
export function readAuthSessionStoreUsage(databaseFile){
  const file=resolve(databaseFile),marker=file+'.cutover';
  if(!existsSync(file)&&!existsSync(marker))return {migrated:false,count:null};
  let db;try{
    parents(file);regular(file);const cutover=boundedJson(marker,1024);
    db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=1000;');
    const metadata=db.prepare('SELECT * FROM metadata WHERE id=1').get();
    if(metadata?.version!==1||metadata.cutover!==cutover.id||metadata.key_id!==cutover.keyId)throw typed('AUTH_SESSION_CUTOVER_INVALID');
    return {migrated:true,count:db.prepare('SELECT COUNT(*) AS total FROM sessions WHERE expiry>?').get(Date.now()).total};
  }catch{return {migrated:true,count:null};}finally{db?.close();}
}
