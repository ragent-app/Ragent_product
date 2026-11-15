// Real Chromium + loopback HTTP + original auth with isolated synthetic secrets.
// No installed/native service, OS identity, Provider, phone or TURN proof.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {DatabaseSync} from 'node:sqlite';
import {createLocalUiBootstrap,createLocalUiBootstrapClaimStore} from '../lib/local-ui-bootstrap.mjs';
import {createOwnerBootstrapIssuer} from '../lib/windows-owner-bootstrap-protocol.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-ui-browser-')),config=join(root,'config'),claims=join(root,'claims');
await mkdir(config);await mkdir(claims);
const evidence=resolve('artifacts/showcase/T2-current-20261017/owner-purpose');await mkdir(evidence,{recursive:true});
const report={pass:false,level:'real Chromium, actual loopback HTTP, original auth with isolated synthetic key',checks:[],productionChanged:false,nativeIpc:false,signedInstallation:false,phoneOrTurn:false};
let browser,server,component,auth;
try{
  const secret=randomBytes(32).toString('hex');
  await writeFile(join(config,'auth.json'),JSON.stringify({username:'isolated-bootstrap-qa',passwordHash:'SYNTHETIC-NO-PASSWORD-LOGIN'}));
  Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_INSTANCE_ROOT:root,RAGENT_CONFIG_DIR:config,
    RAGENT_RUN_SPOOL_DIR:join(root,'data/chat-runs'),RAGENT_PROVIDER_HOMES_DIR:join(root,'provider-homes'),
    RAGENT_MEMORY_DIR:join(root,'memory'),RAGENT_WORK_ROOT_DIR:join(root,'workspace'),RAGENT_AUTH_SESSION_SECRET:secret,
    RAGENT_LOCAL_WEB_AUTH:'0',SECURE_COOKIES:'0'});
  const paths=await import('../lib/config.mjs');assert.equal(resolve(paths.CONFIG_DIR),resolve(config));
  // Assert isolation before importing auth (which reads auth/session files).
  auth=await import('../lib/auth.mjs');
  const logs=[];
  server=createServer(async(req,res)=>{
    logs.push({url:req.url,referer:req.headers.referer||''});
    if(await component.handle(req,res))return;
    if(req.url==='/'||req.url==='/api/owner-proof'){
      const session=auth.getAuthSession(req),allowed=auth.isAuthenticated(req)&&session?.role==='owner';
      res.writeHead(allowed?200:401,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(allowed?'<title>Owner ready</title><p id="owner">Owner ready</p>':'Login required');return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port,instanceId=randomUUID();
  component=createLocalUiBootstrap({instanceId,origin,claimStore:createLocalUiBootstrapClaimStore({directory:claims}),issueOwnerSession:auth.issueSession,
    revokeOwnerSession:async token=>{auth.revokeSession(token);await auth.saveAuthSessions();},setCookie:auth.setCookie});
  const issue=()=>component.issue({launchNonce:randomBytes(32).toString('hex'),expiresAtUnixMs:Date.now()+30000});
  async function privateBrowserIssue(){
    const policy={protocolVersion:2,purpose:'browser',pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId,requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+20000,controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:'S-1-5-21-1-2-3-1001',ownerSessionId:1};
    const event={kind:'request',facts:{sid:policy.ownerSid,sessionId:1,pid:1234,createdTicks:'134368500000000000',integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true},frame:{version:2,operation:'owner.browser',instanceId,requestId:policy.requestId,expiresAtUnixMs:policy.expiresAtUnixMs,challenge:randomBytes(32).toString('base64url'),launchNonce:randomBytes(32).toString('hex')}};
    const issuer=createOwnerBootstrapIssuer({policy,issueBrowserTicket:async(_,binding)=>component.issueTicket(binding)}),result=await issuer.accept(event);
    return {ticket:result.bootstrapTicket,url:origin+'/local-bootstrap#'+new URLSearchParams({ticket:result.bootstrapTicket,nonce:result.launchNonce,instance:instanceId})};
  }
  browser=await chromium.launch({headless:true,channel:'chrome'});
  report.browserVersion=browser.version();
  const context=await browser.newContext(),page=await context.newPage();
  assert.equal((await page.goto(origin+'/')).status(),401);report.checks.push('anonymous HTML cannot acquire Owner in isolated HTTP fixture');
  const value=await privateBrowserIssue(),parts=Object.fromEntries(new URLSearchParams(new URL(value.url).hash.slice(1)));
  assert.equal(auth.sessions.size,0);assert.equal((await fetch(origin+'/api/owner-proof',{headers:{Cookie:'session_token='+value.ticket}})).status,401);report.checks.push('synthetic v2 browser transcript mints no session; ticket used as cookie denied');
  const response=page.waitForResponse(r=>r.url()===origin+'/api/auth/local-bootstrap');await page.goto(value.url);
  assert.equal((await response).status(),204);await page.waitForURL(origin+'/');assert.equal(await page.locator('#owner').textContent(),'Owner ready');
  component.confirmTicket(value.ticket);assert.equal(await component.revokeTicket(value.ticket),false);
  assert.equal(new URL(page.url()).hash,'');report.checks.push('fragment POST exchange and Owner HTTP use');
  const cookies=await context.cookies(origin),cookie=cookies.find(x=>x.name==='session_token');assert.ok(cookie?.httpOnly);assert.equal(cookie.sameSite,'Lax');
  const token=cookie.value;assert.equal(await page.evaluate(()=>document.cookie.includes('session_token')),false);report.checks.push('actual HttpOnly normal-auth cookie');
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.ok(logs.every(x=>!x.url.includes(parts.ticket)&&!x.url.includes(parts.nonce)&&!x.referer.includes(parts.ticket)&&!x.referer.includes(parts.nonce)));
  const key='s'+createHmac('sha256',secret).update(token).digest('hex');assert.equal(auth.sessions.get(key)?.authMethod,'local_bootstrap');
  for(const suffix of ['','-wal']){try{assert.ok(!(await readFile(join(config,'auth-sessions.sqlite'+suffix))).includes(Buffer.from(token)));}catch(error){if(error.code!=='ENOENT')throw error;}}
  report.checks.push('no fragment in HTTP URL/Referer, no web storage, committed session disk token hashed');
  await page.goBack();assert.ok(!page.url().includes(parts.ticket));await page.goto(origin+'/');report.checks.push('browser back history does not restore fragment');
  const replay=await page.evaluate(async payload=>{const response=await fetch('/api/auth/local-bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return response.status;},parts);
  assert.equal(replay,410);assert.equal(auth.sessions.size,1);report.checks.push('browser replay refused without second session');
  const otherContext=await browser.newContext(),other=await otherContext.newPage(),crossValue=issue(),crossParts=Object.fromEntries(new URLSearchParams(new URL(crossValue.url).hash.slice(1)));
  // Different localhost port is a real cross-origin browser request. It sends a
  // simple text/plain request (no preflight requirement); target must refuse.
  const attacker=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Foreign origin</title>');});await new Promise(done=>attacker.listen(0,'127.0.0.1',done));
  try{
    await other.goto('http://127.0.0.1:'+attacker.address().port);
    const rejected=other.waitForResponse(r=>r.url()===origin+'/api/auth/local-bootstrap');
    await other.evaluate(async({url,payload})=>{try{await fetch(url,{method:'POST',mode:'no-cors',credentials:'include',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload)});}catch{}},{url:origin+'/api/auth/local-bootstrap',payload:crossParts});
    assert.equal((await rejected).status(),403);assert.equal((await otherContext.cookies(origin)).filter(x=>x.name==='session_token').length,0);assert.equal(auth.sessions.size,1);
    report.checks.push('real browser different-port simple POST refused, no cookie/session');
  }finally{attacker.closeAllConnections();await new Promise(done=>attacker.close(done));}
  await other.goto(origin+'/local-bootstrap#ticket=invalid');await other.waitForFunction(()=>document.getElementById('status')?.textContent.includes('过期'));
  assert.equal(new URL(other.url()).hash,'');assert.equal((await otherContext.cookies(origin)).length,0);report.checks.push('invalid fragment scrubbed with normal login guidance');
  await other.goto(crossValue.url);await other.waitForURL(origin+'/');assert.equal(auth.sessions.size,2);report.checks.push('rejected foreign source did not consume valid private launch');
  for(const context of [await browser.contexts()[0],otherContext])for(const value of await context.cookies(origin))if(value.name==='session_token')auth.revokeSession(value.value);
  await auth.saveAuthSessions();assert.equal(auth.sessions.size,0);
  const proof=await page.goto(origin+'/api/owner-proof');assert.equal(proof.status(),401);report.checks.push('original auth revocation actually rejects cookie');
  const raced=await privateBrowserIssue();await other.goto(raced.url);await other.waitForURL(origin+'/');assert.equal(auth.sessions.size,1);
  assert.equal(await component.revokeTicket(raced.ticket),true);assert.equal(auth.sessions.size,0);assert.equal((await other.goto(origin+'/api/owner-proof')).status(),401);
  report.checks.push('synthetic native delivery failure after real browser exchange revokes committed cookie');
  const refused=issue(),refusedPayload=Object.fromEntries(new URLSearchParams(new URL(refused.url).hash.slice(1))),sql=new DatabaseSync(join(config,'auth-sessions.sqlite'));
  try{
    sql.exec("CREATE TRIGGER refuse_browser_issue BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'SYNTHETIC-STORE-REFUSAL'); END");
    await otherContext.clearCookies();const failure=other.waitForResponse(r=>r.url()===origin+'/api/auth/local-bootstrap');await other.goto(refused.url);const failedResponse=await failure;
    assert.equal(failedResponse.status(),503);assert.equal(failedResponse.headers()['set-cookie'],undefined);
    await other.waitForFunction(()=>document.getElementById('status')?.textContent.includes('过期'));assert.equal((await otherContext.cookies(origin)).length,0);
    assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,0);
    const replay=await other.evaluate(async payload=>(await fetch('/api/auth/local-bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,refusedPayload);assert.equal(replay,410);
    report.checks.push('actual SQLite statement refusal: browser503/no cookie/no session, consumed ticket410');
  }finally{sql.close();}
  report.pass=true;
}catch(error){report.error={name:error.name,code:error.code||'',message:typeof error.message==='string'?error.message.replace(/[a-f0-9]{64}/g,'[redacted]').slice(0,1500):''};process.exitCode=1;}
finally{
  component?.close();await browser?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}auth?.closeAuthSessionStore();
  // This exact freshly-created fixture root alone is removed.
  assert.ok(relative(await realpath(tmpdir()),root).startsWith('ragent-ui-browser-'));await rm(root,{recursive:true,force:true});
  report.cleanup=true;await writeFile(join(evidence,'browser.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
