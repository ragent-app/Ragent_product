// Actual native adapter, with explicitly substituted process/filesystem/OS IO.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
if(process.platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
const adapter=new URL('../../lib/windows-owner-bootstrap.mjs',import.meta.url).href,helper='C:/Program Files/Ragent/payload/Ragent.OwnerBootstrap.exe',bytes=Buffer.from('QA ONLY'),hash=createHash('sha256').update(bytes).digest('hex');
const policy={domain:'owner.activation.v1',instanceId:'inst_'+'a'.repeat(32),controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:'S-1-5-21-1-2-3-1001',ownerSessionId:1};
const frame={version:1,operation:'owner.activation.request',instanceId:policy.instanceId,requestId:'a'.repeat(32),expiresAtUnixMs:Date.now()+20000,challenge:'a'.repeat(43),launchNonce:'b'.repeat(64)};
const facts={pid:999,createdTicks:'134368500000000000',sid:policy.ownerSid,sessionId:1,integrityRid:8192,elevated:false,enabledAdministrators:false,queryOnlyAuthorityVerified:true};
let mode='success',activated=0,committed=0,complete=0,rolledBack=0,spawned=0,inspected=0;
globalThis.__activationAdapterQa={
  async inspect(){inspected++;return {policy,executablePath:helper,executableSha256:hash};},
  async lstat(path){assert.equal(path,helper);return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1};},
  async readFile(path){assert.equal(path,helper);return bytes;},
  spawn(path,args,options){spawned++;assert.equal(path,helper);assert.ok(['activation-client','activation-server'].includes(args[0]));assert.equal(args.length,1);assert.deepEqual(options.env,{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'});
    const child=new EventEmitter();child.pid=888;child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};let closed=false,first=true;
    const end=code=>{if(!closed){closed=true;child.emit('close',code);}};child.kill=()=>end(1);child.stdin.end=()=>{};
    const emit=value=>child.stdout.emit('data',JSON.stringify(value)+'\n');
    child.stdin.write=line=>{const v=JSON.parse(line);queueMicrotask(()=>{
      if(first){first=false;assert.deepEqual(v,policy);emit({kind:'identity',facts:{}});
        if(args[0]==='activation-client'){emit({kind:'result',facts:{}});end(0);}else{emit({kind:'ready'});emit({kind:'request',facts,frame});}
      }else{
        assert.deepEqual(Object.keys(v).sort(),Object.keys(frame).sort());assert.equal(v.sessionToken,undefined);
        if(v.operation==='owner.activation.ready'){assert.equal(committed,0);if(mode==='lost-receipt')end(1);else emit({kind:'receipt'});}
        else{assert.equal(v.operation,'owner.activation.committed');assert.equal(committed,1);end(mode==='lost-final'?1:0);}
      }
    });return true;};return child;
  },
};
const sources={'qa:act-os':`export const inspectInstalledOwnerActivation=globalThis.__activationAdapterQa.inspect;`,
  'qa:act-fs':`export const readFile=globalThis.__activationAdapterQa.readFile;export const lstat=globalThis.__activationAdapterQa.lstat;`,
  'qa:act-child':`export const spawn=globalThis.__activationAdapterQa.spawn;`};
registerHooks({resolve(specifier,context,next){const key=context.parentURL===adapter?({'node:fs/promises':'qa:act-fs','node:child_process':'qa:act-child','./windows-owner-activation-trust.mjs':'qa:act-os'})[specifier]:null;return key?{url:key,shortCircuit:true}:next(specifier,context);},load(url,context,next){return sources[url]?{format:'module',source:sources[url],shortCircuit:true}:next(url,context);}});
const {requestInstalledOwnerActivation,serveOwnerActivationOnce}=await import(adapter);
await requestInstalledOwnerActivation({policy:{},executablePath:'evil',baseUrl:'http://remote'});assert.equal(inspected,1);
const abort=new AbortController();abort.abort();await assert.rejects(requestInstalledOwnerActivation({signal:abort.signal}),{code:'OBC_ABORTED'});assert.equal(spawned,1);
for(mode of ['success','lost-receipt','lost-final']){
  activated=committed=complete=rolledBack=0;
  const endpoint=await serveOwnerActivationOnce({policy,executablePath:helper,executableSha256:hash,activate:async request=>{assert.deepEqual(request.frame,frame);activated++;return {commit:async()=>{committed++;},complete:async()=>{complete++;},rollback:async()=>{rolledBack++;}};}});
  if(mode==='success'){await endpoint.completion;assert.equal(committed,1);assert.equal(complete,1);assert.equal(rolledBack,0);}
  else{await assert.rejects(endpoint.completion);assert.equal(rolledBack,1);assert.equal(complete,0);assert.equal(committed,mode==='lost-final'?1:0);}
  assert.equal(activated,1);await endpoint.close();
}
console.log(JSON.stringify({pass:true,scenarios:5,scope:'actual JS adapter; synthetic OS/filesystem/native helper IO',actualNativePipe:false}));
