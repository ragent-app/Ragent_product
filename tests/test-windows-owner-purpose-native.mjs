import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
if(process.platform!=='win32')throw new Error('Actual Windows runtime required');
const root=resolve('.'),evidence=resolve(process.argv[2]||join(root,'artifacts/showcase/T2-current-20261017/owner-purpose')),bundle=join(evidence,'native-'+randomUUID());await mkdir(bundle,{recursive:true});
const exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex'),source=join(root,'native/windows-owner-bootstrap.cs'),fixture=join(root,'tests/fixtures/windows-owner-purpose-codec.cs');
const report={pass:false,level:'actual Windows helper admission; real native codec with synthetic policy/frame inputs',checks:[],servicesCreated:false,productionChanged:false,realOsPeerPositive:false,livePipePositive:false,sourceSha256:hash(await readFile(source)),fixtureSha256:hash(await readFile(fixture))};
async function run(exe,args,input){const child=spawn(exe,args,{windowsHide:true,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',bytes=>{output+=bytes;if(output.length>16384)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});const timer=setTimeout(()=>child.kill(),5000);try{
  const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(input?JSON.stringify(input)+'\n':'');});return {code,event:JSON.parse(output.trim())};
}finally{clearTimeout(timer);}}
try{
  const compiler='C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',product=join(bundle,'OwnerBootstrap.exe'),codec=join(bundle,'OwnerPurposeCodec.exe');
  for(const [out,extra]of [[product,[]],[codec,['/main:OwnerPurposeCodecMain',fixture]]])await exec(compiler,['/nologo','/utf8output','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+out,source,...extra],{windowsHide:true,timeout:30000,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  report.productSha256=hash(await readFile(product));report.codecSha256=hash(await readFile(codec));
  const own=await run(product,['facts']);assert.equal(own.code,0);const facts=own.event.facts;report.ordinaryIdentity=facts;assert.equal(facts.integrityRid,8192);assert.equal(facts.elevated,false);assert.equal(facts.enabledAdministrators,false);
  const policy={protocolVersion:2,purpose:'browser',pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),instanceId:randomUUID(),requestId:randomBytes(16).toString('hex'),expiresAtUnixMs:Date.now()+25000,controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:facts.sid,ownerSessionId:facts.sessionId};
  const nonce=randomBytes(32).toString('hex'),challenge=randomBytes(32).toString('base64url'),frame={version:2,operation:'owner.browser',instanceId:policy.instanceId,requestId:policy.requestId,expiresAtUnixMs:policy.expiresAtUnixMs,challenge,launchNonce:nonce};
  async function codecCheck(name,patch,expected){const result=await run(codec,[],{policy,frame,phase:'request',challenge,expectedNonce:nonce,...patch});assert.equal(result.code,expected?1:0,name);assert.equal(result.event.kind,expected?'error':'accepted',name);if(expected)assert.equal(result.event.code,expected,name);report.checks.push({name,scope:'native codec/synthetic inputs',pass:true,...expected?{code:expected}:{}});}
  await codecCheck('browser request',{});
  await codecCheck('browser challenge',{phase:'challenge',frame:{...frame,operation:'owner.browser.challenge',launchNonce:undefined}});
  await codecCheck('browser result',{phase:'result',frame:{...frame,operation:'owner.browser.result',bootstrapTicket:'a'.repeat(64)}});
  await codecCheck('browser receipt',{phase:'receipt',frame:{...frame,operation:'owner.browser.receipt'}});
  await codecCheck('receipt nonce mismatch',{phase:'receipt',expectedNonce:'f'.repeat(64),frame:{...frame,operation:'owner.browser.receipt'}},'OBC_LAUNCH_NONCE_MISMATCH');
  await codecCheck('receipt purpose mismatch',{phase:'receipt',frame:{...frame,operation:'owner.cli.receipt'}},'OBC_OPERATION_DENIED');
  await codecCheck('receipt cannot contain ticket',{phase:'receipt',frame:{...frame,operation:'owner.browser.receipt',bootstrapTicket:'a'.repeat(64)}},'OBC_FRAME_INVALID');
  const cli={...policy,purpose:'cli'};
  const productInstance='inst_'+'a'.repeat(32),productPolicy={...cli,instanceId:productInstance};
  await codecCheck('product inst identity policy',{phase:'policy',policy:productPolicy,server:true,self:{sid:policy.controlSid,sessionId:0}});
  await codecCheck('product inst identity request',{policy:productPolicy,frame:{...frame,operation:'owner.cli',instanceId:productInstance}});
  await codecCheck('product inst identity cannot contain newline',{phase:'policy',policy:{...productPolicy,instanceId:productInstance+'\n'},server:true,self:{sid:policy.controlSid,sessionId:0}},'OBC_POLICY_INVALID');
  await codecCheck('product inst identity cannot alias another instance',{policy:productPolicy,frame:{...frame,operation:'owner.cli',instanceId:'inst_'+'b'.repeat(32)}},'OBC_BINDING_MISMATCH');
  await codecCheck('CLI request',{policy:cli,frame:{...frame,operation:'owner.cli'}});
  await codecCheck('CLI result',{policy:cli,phase:'result',frame:{...frame,operation:'owner.cli.result',sessionToken:'b'.repeat(64)}});
  const legacy={...policy};delete legacy.protocolVersion;delete legacy.purpose;const oldFrame={...frame,version:1,operation:'owner.bootstrap'};delete oldFrame.launchNonce;
  await codecCheck('legacy CLI request',{policy:legacy,frame:oldFrame});
  for(const [name,patch,expected]of [
    ['cross purpose',{frame:{...frame,operation:'owner.cli'}},'OBC_OPERATION_DENIED'],
    ['downgrade',{frame:{...frame,version:1}},'OBC_OPERATION_DENIED'],
    ['string version',{frame:{...frame,version:'2'}},'OBC_OPERATION_DENIED'],
    ['missing nonce',{frame:{...frame,launchNonce:undefined}},'OBC_FRAME_INVALID'],
    ['bad nonce',{frame:{...frame,launchNonce:'bad'}},'OBC_LAUNCH_NONCE_INVALID'],
    ['nonce result mismatch',{phase:'result',expectedNonce:'f'.repeat(64),frame:{...frame,operation:'owner.browser.result',bootstrapTicket:'a'.repeat(64)}},'OBC_LAUNCH_NONCE_MISMATCH'],
    ['cookie in browser result',{phase:'result',frame:{...frame,operation:'owner.browser.result',sessionToken:'a'.repeat(64)}},'OBC_FRAME_INVALID'],
    ['ticket in CLI result',{policy:cli,phase:'result',frame:{...frame,operation:'owner.cli.result',bootstrapTicket:'a'.repeat(64)}},'OBC_FRAME_INVALID'],
    ['deadline extension',{frame:{...frame,expiresAtUnixMs:frame.expiresAtUnixMs+1000}},'OBC_BINDING_MISMATCH'],
    ['challenge mismatch',{frame:{...frame,challenge:'x'.repeat(43)}},'OBC_CHALLENGE_DENIED'],
  ])await codecCheck(name,patch,expected);
  for(const [name,mode,input,expected]of [
    ['ordinary user not control','server',policy,'OBC_LOCAL_IDENTITY_DENIED'],
    ['unknown purpose','client',{...policy,purpose:'run',peer:{},launchNonce:nonce},'OBC_PURPOSE_DENIED'],
    ['no client nonce','client',{...policy,peer:{}},'OBC_LAUNCH_NONCE_INVALID'],
    ['client string protocol','client',{...policy,protocolVersion:'2',peer:{},launchNonce:nonce},'OBC_POLICY_INVALID'],
    ['client nonce in discovery/server policy','server',{...policy,launchNonce:nonce},'OBC_POLICY_INVALID'],
  ]){const result=await run(product,[mode],input);assert.equal(result.code,1,name);assert.equal(result.event.code,expected,name);report.checks.push({name,scope:'actual ordinary Windows process admission',pass:true,code:expected});}
  assert.equal(hash(await readFile(source)),report.sourceSha256);assert.equal(hash(await readFile(fixture)),report.fixtureSha256);report.pass=true;
}catch(error){report.error={code:error.code||error.name,message:String(error.message||'').replace(/[a-f0-9]{64}/g,'[redacted]').slice(0,1000)};process.exitCode=1;}
finally{await writeFile(join(bundle,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(evidence,'native-latest.json'),JSON.stringify({bundle,pass:report.pass},null,2)+'\n');}
console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,bundle,realOsPeerPositive:false,livePipePositive:false}));
