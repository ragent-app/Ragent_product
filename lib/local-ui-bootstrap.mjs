// Private control-parent component. No HTTP mint endpoint and no automatic Owner
// authentication. Installation/OS peer trust must precede calls to issue().
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {open,lstat,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';

const typed=code=>Object.assign(new Error(code),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const pageScript=`(()=>{
let busy=false;
async function bootstrap(){
  const fragment=location.hash;
  history.replaceState(null,'','/local-bootstrap');
  if(busy)return;
  busy=true;
  const fail=()=>{document.getElementById('status').textContent='登录链接无效或已过期。请从应用重新打开，或使用账号登录。';};
  try{
    const params=new URLSearchParams(fragment.slice(1)),keys=[...params.keys()];
    if(keys.length!==3||new Set(keys).size!==3||!['ticket','nonce','instance'].every(key=>params.has(key)))return fail();
    const payload={ticket:params.get('ticket'),nonce:params.get('nonce'),instance:params.get('instance')};
    if(!/^[a-f0-9]{64}$/.test(payload.ticket)||!/^[a-f0-9]{64}$/.test(payload.nonce)||!/^[a-f0-9-]{36}$/.test(payload.instance))return fail();
    const response=await fetch('/api/auth/local-bootstrap',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(response.status!==204)return fail();
    location.replace('/');
  }catch{fail();}finally{busy=false;}
}
addEventListener('hashchange',bootstrap);
void bootstrap();
})();`;
const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ragent 登录</title><p id="status" role="status">正在登录…</p><a href="/login">账号登录</a><script>${pageScript}</script></html>`;
const securityHeaders={
  'Cache-Control':'no-store, max-age=0','Pragma':'no-cache','Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
  'Content-Security-Policy':`default-src 'none'; script-src 'sha256-${createHash('sha256').update(pageScript).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

// The existing directory AND all its ancestors must already have protected write
// ACLs. These path/link checks do not establish OS ownership/ACL trust. Claims
// are never reclaimed here; installer-controlled offline cleanup is separate.
export function createLocalUiBootstrapClaimStore({directory}={}){
  if(typeof directory!=='string'||!directory)throw typed('LUB_STORE_REQUIRED');
  const fixed=resolve(directory);
  return Object.freeze({async claim(record){
    if(!exact(record,['version','generation','instance','ticketHash','nonceHash','expiresAtUnixMs'])||record.version!==1
      ||!uuid(record.generation)||!uuid(record.instance)||!hex(record.ticketHash)||!hex(record.nonceHash)||!Number.isSafeInteger(record.expiresAtUnixMs))throw typed('LUB_CLAIM_INVALID');
    for(let path=fixed;;path=dirname(path)){
      const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||(await realpath(path)).toLowerCase()!==path.toLowerCase())throw typed('LUB_STORE_UNSAFE');
      if(path===dirname(path))break;
    }
    const file=await open(join(fixed,record.generation+'-'+record.ticketHash+'.json'),'wx',0o600);
    try{await file.writeFile(JSON.stringify(record)+'\n');await file.sync();}finally{await file.close();}
  }});
}

function validateOrigin(origin){
  // Canonical literals only, including exact port. Never derive authority from
  // request headers, URL normalization, environment/PATH or forwarded markers.
  if(typeof origin!=='string'||!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(origin))throw typed('LUB_ORIGIN_INVALID');
  const port=Number(origin.slice(origin.lastIndexOf(':')+1));if(port>65535||port===80)throw typed('LUB_ORIGIN_INVALID');
  return origin.slice(7);
}
function singleHeader(req,name){
  const values=[];for(let i=0;i<(req.rawHeaders?.length||0);i+=2)if(req.rawHeaders[i].toLowerCase()===name)values.push(req.rawHeaders[i+1]);
  if(values.length>1)throw typed('LUB_SOURCE_DENIED');
  return req.headers?.[name];
}
function checkSource(req,origin,host,post){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)||singleHeader(req,'host')!==host)throw typed('LUB_SOURCE_DENIED');
  for(const name of Object.keys(req.headers||{}))if(name==='forwarded'||name==='via'||name==='x-real-ip'||name==='x-ragent-tunnel'||name.startsWith('x-forwarded-'))throw typed('LUB_SOURCE_DENIED');
  const requestOrigin=singleHeader(req,'origin');if((post||requestOrigin!==undefined)&&requestOrigin!==origin)throw typed('LUB_SOURCE_DENIED');
  const site=singleHeader(req,'sec-fetch-site');if(site!==undefined&&!(site==='same-origin'||(!post&&site==='none')))throw typed('LUB_SOURCE_DENIED');
}
function body(req){return new Promise((done,reject)=>{
  const chunks=[];let size=0;
  const finish=(error)=>{clearTimeout(timer);req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',failed);req.removeListener('aborted',aborted);if(error){req.pause();reject(error);}else{try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(typed('LUB_BODY_INVALID'));}}};
  const data=chunk=>{size+=chunk.length;if(size>1024)finish(typed('LUB_BODY_INVALID'));else chunks.push(chunk);};
  const end=()=>finish(),failed=()=>finish(typed('LUB_BODY_INVALID')),aborted=()=>finish(typed('LUB_BODY_INVALID'));
  const timer=setTimeout(()=>finish(typed('LUB_BODY_INVALID')),2000);
  req.on('data',data);req.once('end',end);req.once('error',failed);req.once('aborted',aborted);
});}

export function createLocalUiBootstrap({instanceId,origin,claimStore,issueOwnerSession,revokeOwnerSession,setCookie,clock=Date.now}={}){
  const host=validateOrigin(origin),generation=randomUUID(),pending=new Map(),nativeIssues=new Map();let issued=0,active=0,closed=false;
  if(!uuid(instanceId)||typeof claimStore?.claim!=='function'||typeof issueOwnerSession!=='function'||typeof revokeOwnerSession!=='function'||typeof setCookie!=='function')throw typed('LUB_CONFIGURATION_REQUIRED');
  const prune=()=>{for(const [key,value]of pending)if(clock()>=value.expiresAtUnixMs)pending.delete(key);};
  function mint({launchNonce,expiresAtUnixMs}={}){
    prune();if(closed)throw typed('LUB_CLOSED');
    const now=clock();if(!hex(launchNonce)||!Number.isSafeInteger(expiresAtUnixMs)||expiresAtUnixMs<=now||expiresAtUnixMs>now+60000)throw typed('LUB_BINDING_INVALID');
    if(pending.size>=32||issued>=128)throw typed('LUB_CAPACITY');
    const ticket=randomBytes(32).toString('hex'),ticketHash=hash(ticket);
    pending.set(ticketHash,{nonceHash:hash(launchNonce),expiresAtUnixMs,revoked:false,confirmed:true,token:'',delivered:false});issued++;return ticket;
  }
  return Object.freeze({
    // Private authenticated OS caller supplies a fresh launcher nonce and an
    // authority deadline. This method itself does not authenticate OS facts.
    issue({launchNonce,expiresAtUnixMs}={}){
      const ticket=mint({launchNonce,expiresAtUnixMs});
      return Object.freeze({url:origin+'/local-bootstrap#'+new URLSearchParams({ticket,nonce:launchNonce,instance:instanceId}),expiresAtUnixMs});
    },
    issueTicket({instanceId:instance,launchNonce,expiresAtUnixMs}={}){
      if(instance!==instanceId)throw typed('LUB_BINDING_INVALID');
      const ticket=mint({launchNonce,expiresAtUnixMs}),key=hash(ticket),entry=pending.get(key);entry.confirmed=false;nativeIssues.set(key,entry);return ticket;
    },
    // Native delivery failure may race a browser POST. Retain only bounded
    // unconfirmed records so explicit revocation also reaches a raced cookie.
    async revokeTicket(ticket){const key=hex(ticket)?hash(ticket):'',entry=nativeIssues.get(key);if(!entry)return false;
      entry.revoked=true;pending.delete(key);if(entry.token){await revokeOwnerSession(entry.token);entry.token='';}nativeIssues.delete(key);return true;
    },
    confirmTicket(ticket){const key=hex(ticket)?hash(ticket):'',entry=nativeIssues.get(key);if(!entry||entry.revoked)throw typed('LUB_TICKET_INVALID');
      entry.confirmed=true;if(entry.delivered){entry.token='';nativeIssues.delete(key);}return true;
    },
    close(){closed=true;pending.clear();},
    async handle(req,res){
      const path=(req.url||'').split('?')[0];if(!['/local-bootstrap','/api/auth/local-bootstrap'].includes(path))return false;
      const reply=(status,code)=>{res.writeHead(status,{...securityHeaders,'Connection':'close','Content-Type':'application/json'});res.end(code?JSON.stringify({code}):undefined);};
      let token='',admitted=false,entry=null,consumedKey='';
      try{
        const post=path==='/api/auth/local-bootstrap';checkSource(req,origin,host,post);
        if(req.url!==path||req.method!==(post?'POST':'GET')){reply(400,'LUB_REQUEST_INVALID');return true;}
        if(!post){res.writeHead(200,{...securityHeaders,'Content-Type':'text/html; charset=utf-8'});res.end(page);return true;}
        if(singleHeader(req,'content-type')!=='application/json'||req.headers['content-encoding']!==undefined||Number(singleHeader(req,'content-length'))>1024)throw typed('LUB_BODY_INVALID');
        const payload=await body(req);if(!exact(payload,['ticket','nonce','instance'])||!hex(payload.ticket)||!hex(payload.nonce)||payload.instance!==instanceId)throw typed('LUB_TICKET_INVALID');
        prune();const ticketHash=hash(payload.ticket);entry=pending.get(ticketHash);
        if(closed||!entry||entry.revoked||entry.nonceHash!==hash(payload.nonce))throw typed('LUB_TICKET_INVALID');
        if(active>=4)throw typed('LUB_CAPACITY');active++;admitted=true;
        pending.delete(ticketHash); // Consume before any await; failure never restores.
        consumedKey=ticketHash;
        await claimStore.claim({version:1,generation,instance:instanceId,ticketHash,nonceHash:entry.nonceHash,expiresAtUnixMs:entry.expiresAtUnixMs});
        if(closed||entry.revoked||clock()>=entry.expiresAtUnixMs||req.aborted||res.destroyed)throw typed('LUB_TICKET_INVALID');
        token=await issueOwnerSession({role:'owner',authMethod:'local_bootstrap'});
        entry.token=token;
        if(!hex(token))throw typed('LUB_ISSUANCE_FAILED');
        if(closed||entry.revoked||clock()>=entry.expiresAtUnixMs||req.aborted||res.destroyed)throw typed('LUB_TICKET_INVALID');
        const cookie=setCookie(token);if(typeof cookie!=='string'||/[\r\n]/.test(cookie)||!cookie.startsWith('session_token='+token+';')||!cookie.includes('; HttpOnly')||!cookie.includes('; SameSite=')||!cookie.includes('; Path=/'))throw typed('LUB_ISSUANCE_FAILED');
        // An actual connection loss before response finish revokes the minted
        // session; a finished response still cannot prove browser receipt.
        await new Promise((done,reject)=>{
          const finish=()=>{res.removeListener('close',lost);done();};
          const lost=()=>{res.removeListener('finish',finish);reject(typed('LUB_DELIVERY_UNCONFIRMED'));};
          res.once('finish',finish);res.once('close',lost);res.setHeader('Set-Cookie',cookie);reply(204);
        });entry.delivered=true;if(entry.confirmed){entry.token='';nativeIssues.delete(ticketHash);}token='';
      }catch(error){
        // Never expose issuer/store messages, paths, tickets or cookies.
        if(token){try{await revokeOwnerSession(token);}catch{if(!res.headersSent)reply(503,'LUB_UNAVAILABLE');else res.destroy();return true;}}
        if(admitted&&entry){entry.revoked=true;entry.token='';nativeIssues.delete(consumedKey);}
        if(!res.headersSent&&!res.destroyed){const code=error?.code,status=code==='LUB_SOURCE_DENIED'?403:code==='LUB_BODY_INVALID'?400:code==='LUB_TICKET_INVALID'?410:503;reply(status,status===503?'LUB_UNAVAILABLE':code);}
      }finally{if(admitted)active--;}
      return true;
    },
  });
}
