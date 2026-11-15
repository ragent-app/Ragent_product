// Test-only loader substitutes OS inspection and native IO. Exercises the actual
// installed entry/adapter wiring, not real installed trust or an actual pipe.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
const actualPlatform=process.platform;
// This fixture runs on all CI hosts; only this isolated process exercises the
// Windows JS branch. All OS inspection and helper IO below are substituted.
if(actualPlatform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
const adapter=new URL('../../lib/windows-owner-bootstrap.mjs',import.meta.url).href;
const helper='C:/Program Files/Ragent/payload/Ragent.OwnerBootstrap.exe',bytes=Buffer.from('SYNTHETIC HELPER'),hash=createHash('sha256').update(bytes).digest('hex');
const calls=[],policies=[];
const peer={pid:1234,createdTicks:'134368500000000000',sid:'S-1-5-80-1-2-3-4-5',sessionId:0,integrityRid:8192,elevated:false,enabledAdministrators:false};
globalThis.__ownerInstalledQa={
  async inspect(options){calls.push(options);assert.deepEqual(Object.keys(options),['purpose']);assert.ok(['cli','browser'].includes(options.purpose));return {
    baseUrl:'http://127.0.0.1:7690',instanceId:'00000000-0000-4000-8000-000000000000',executablePath:helper,executableSha256:hash,
    policy:{protocolVersion:2,purpose:options.purpose,pipeName:'ragent-owner-bootstrap-'+'a'.repeat(32),instanceId:'00000000-0000-4000-8000-000000000000',
      requestId:'b'.repeat(32),expiresAtUnixMs:Date.now()+20000,controlSid:peer.sid,ownerSid:'S-1-5-21-1-2-3-1001',ownerSessionId:1,peer}};},
  async lstat(path){assert.equal(path,helper);return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1};},
  async readFile(path){assert.equal(path,helper);return bytes;},
  spawn(path,args,options){assert.equal(path,helper);assert.deepEqual(args,['client']);assert.deepEqual(options.env,{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'});
    const child=new EventEmitter();child.pid=4321;child.stdin=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};let closed=false;
    const end=()=>{if(!closed){closed=true;child.emit('close',0);}};child.kill=end;child.stdin.end=()=>{};
    child.stdin.write=line=>{const policy=JSON.parse(line);policies.push(policy);queueMicrotask(()=>{
      child.stdout.emit('data',JSON.stringify({kind:'identity',facts:{}})+'\n');
      child.stdout.emit('data',JSON.stringify({kind:'result',facts:peer,outcome:{launchNonce:policy.launchNonce,[policy.purpose==='cli'?'sessionToken':'bootstrapTicket']:'c'.repeat(64)}})+'\n');end();});return true;};return child;},
};
const sources={
  'qa:os':`export const inspectInstalledOwnerBootstrap=globalThis.__ownerInstalledQa.inspect;`,
  'qa:fs':`export const readFile=globalThis.__ownerInstalledQa.readFile;export const lstat=globalThis.__ownerInstalledQa.lstat;`,
  'qa:child':`export const spawn=globalThis.__ownerInstalledQa.spawn;`,
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===adapter){const key=specifier==='node:fs/promises'?'qa:fs':specifier==='node:child_process'?'qa:child':specifier==='./windows-owner-discovery.mjs'?'qa:os':null;if(key)return {url:key,shortCircuit:true};}return next(specifier,context);},
  load(url,context,next){return sources[url]?{format:'module',source:sources[url],shortCircuit:true}:next(url,context);}});
const {requestInstalledOwnerBootstrap,requestInstalledOwnerBrowserBootstrap}=await import(adapter);
const fake={purpose:'browser',policy:{purpose:'browser'},executablePath:'C:/override',launchNonce:'untrusted-CLI-input'};
for(let i=0;i<2;i++){const result=await requestInstalledOwnerBootstrap(fake);assert.match(result.sessionToken,/^[a-f0-9]{64}$/);assert.equal(result.bootstrapTicket,undefined);assert.equal(result.baseUrl,'http://127.0.0.1:7690');assert.equal(result.instanceId,'00000000-0000-4000-8000-000000000000');assert.ok(Object.isFrozen(result));}
assert.equal(calls[0].purpose,'cli');assert.equal(calls[1].purpose,'cli');for(const p of policies)assert.match(p.launchNonce,/^[a-f0-9]{64}$/);assert.notEqual(policies[0].launchNonce,policies[1].launchNonce);
const nonce='d'.repeat(64),result=await requestInstalledOwnerBrowserBootstrap({...fake,purpose:'cli',launchNonce:nonce});
assert.equal(calls[2].purpose,'browser');assert.equal(policies[2].launchNonce,nonce);const url=new URL(result.url);assert.equal(url.origin,'http://127.0.0.1:7690');assert.equal(url.pathname,'/local-bootstrap');assert.equal(url.search,'');
assert.equal(new URLSearchParams(url.hash.slice(1)).get('nonce'),nonce);assert.equal(result.sessionToken,undefined);
console.log(JSON.stringify({pass:true,level:'actual installed JS entry with test-only OS/helper IO substitution',platformSimulated:actualPlatform!=='win32',cliCalls:2,browserCalls:1,cliNonceFresh:true,callerPathPurposeIgnored:true,actualInstalledTrust:false,actualNativePipe:false}));
