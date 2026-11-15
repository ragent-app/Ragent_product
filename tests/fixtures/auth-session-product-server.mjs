// Run only through launch-test-instance: current product routes, no extra listener.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=resolve(process.env.RAGENT_INSTANCE_ROOT||''),config=resolve(process.env.RAGENT_CONFIG_DIR||'');
assert.ok(process.env.RAGENT_TEST_INSTANCE_ID&&relative(root,config)==='config');
assert.ok(![7690,7699].includes(Number(process.env.CHAT_PORT)));assert.equal(new URL(process.env.RAGENT_ACCOUNTS_URL).hostname,'127.0.0.1');
process.env.RAGENT_LOCAL_WEB_AUTH='0';
const legacy=randomBytes(32).toString('hex');await writeFile(join(config,'auth-sessions.json'),JSON.stringify({[legacy]:{role:'owner',expiry:Date.now()+60000}}));
let sql;
try{
  await import('../../chat-server.mjs');const auth=await import('../../lib/auth.mjs'),origin='http://127.0.0.1:'+process.env.CHAT_PORT;
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/healthz')).status===200){ready=true;break;}}catch{}await new Promise(done=>setTimeout(done,50));}assert.equal(ready,true);
  const call=(path,options={})=>fetch(origin+path,{redirect:'manual',...options});
  assert.equal((await call('/api/auth/me')).status,401);
  const info=await call('/api/auth/me',{headers:{Cookie:'session_token='+legacy}});assert.equal(info.status,200);assert.match(info.headers.get('set-cookie'),/HttpOnly/);assert.equal((await info.json()).role,'owner');
  const key='s'+createHmac('sha256',process.env.RAGENT_AUTH_SESSION_SECRET).update(legacy).digest('hex');sql=new DatabaseSync(join(config,'auth-sessions.sqlite'),{readOnly:true});
  assert.ok(sql.prepare('SELECT expiry FROM sessions WHERE token_hash=?').get(key).expiry>Date.now()+3600000);sql.close();sql=null;
  const logout=await call('/logout',{headers:{Cookie:'session_token='+legacy}});assert.equal(logout.status,302);assert.equal(auth.sessions.get(key),null);assert.equal((await call('/api/auth/me',{headers:{Cookie:'session_token='+legacy}})).status,401);
  await writeFile(join(config,'auth.json'),JSON.stringify({username:'qa-owner',passwordHash:await auth.hashPasswordAsync('SYNTHETIC-PASSWORD-123')}));
  const login=()=>call('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'qa-owner',password:'SYNTHETIC-PASSWORD-123'})});
  const success=await login();assert.equal(success.status,302);const cookie=success.headers.get('set-cookie');assert.ok(cookie?.startsWith('session_token='));assert.equal((await call('/api/auth/me',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
  sql=new DatabaseSync(join(config,'auth-sessions.sqlite'));sql.exec("CREATE TRIGGER refuse_issue BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'SYNTHETIC-WRITE-REFUSAL'); END");
  const failed=await login();assert.equal(failed.status,500);assert.equal(failed.headers.get('set-cookie'),null);assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,1);
  assert.equal((await call('/api/cli/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  sql.close();sql=null;console.log('AUTH_SESSION_HTTP_PASS');process.emit('SIGTERM');
}catch(error){sql?.close();console.error('AUTH_SESSION_HTTP_FAIL',error.code||error.name,String(error.message||'').replace(/[a-f0-9]{64}/g,'[redacted]'));process.exit(1);}
