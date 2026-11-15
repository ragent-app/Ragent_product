// Real .NET compilation/resource queries against a small, actually frozen and
// staged fixture repo. No MSI/SCM/Provider/network/installed product operation.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp,link,unlink,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,sep,basename} from 'node:path';
import {stageRuntimePayload} from '../scripts/stage-runtime-payload.mjs';
const exec=promisify(execFile),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const repo=resolve('.'),builder=join(repo,'packaging/windows/build-service-host.ps1');
const root=await mkdtemp(join(tmpdir(),'ragent-host-build-')),evidence=join(repo,'artifacts/service-host-build',randomUUID());
await mkdir(evidence,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),checks=[];
const files=['packaging/windows/Ragent.ServiceHost.cs','lib/instance-runtime.mjs','lib/instance-ownership.mjs','packaging/runtime-payload.json'];
const source=join(root,'source'),staged=join(root,'staged');
const git=async(...args)=>(await exec('git',args,{cwd:source,windowsHide:true,encoding:'utf8'})).stdout;
const run=async(file,args)=>(await exec(file,args,{windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:131072})).stdout;
let pass=false,report;
async function build(stage,output,args=[],shell=ps){return run(shell,['-NoProfile','-NonInteractive','-File',builder,'-OutputPath',output,...stage?['-RuntimePayloadRoot',stage]:[],...args,'-Verbose']);}
async function manifest(stage){return JSON.parse(await readFile(join(stage,'runtime-payload-manifest.json')));}
async function putManifest(stage,m){await writeFile(join(stage,'runtime-payload-manifest.json'),JSON.stringify(m));}
async function changed(stage,path,bytes){await writeFile(join(stage,path),bytes);const m=await manifest(stage),row=m.files.find(f=>f.path===path);row.sha256=hash(Buffer.from(bytes));row.bytes=Buffer.byteLength(bytes);await putManifest(stage,m);}
async function negative(name,alter,code,{compile=false,shell=ps}={}){
 const stage=join(root,name),output=join(root,'out',name+'.exe');await cp(staged,stage,{recursive:true});
 const extra=await alter(stage,output)||[];let error;
 try{await build(stage,output,extra,shell);assert.fail('Bad build accepted: '+name);}catch(e){error=e;}
 assert.ok(error.code!==undefined,name);assert.match((error.stderr||error.stdout||error.message).replace(/\r?\n/g,''),new RegExp(code),name);
 if(!compile)await assert.rejects(readFile(output),{code:'ENOENT'},name+' created an output before admission');
 checks.push({name,refused:true,code});
}
try{
 await mkdir(source);await git('init');await git('config','core.autocrlf','false');
 for(const file of files){await mkdir(dirname(join(source,file)),{recursive:true});await writeFile(join(source,file),await readFile(join(repo,file)));}
 for(const [file,text]of Object.entries({'package.json':'{"name":"synthetic-host-build"}','package-lock.json':'{}','chat-server.mjs':'export {};','cli.js':'','static/chat/ui.js':'export {};','templates/chat.html':'<html></html>'})){await mkdir(dirname(join(source,file)),{recursive:true});await writeFile(join(source,file),text);}
 await git('add','.');await git('-c','user.name=Host Build Fixture','-c','user.email=fixture@example.invalid','commit','-m','frozen actual host and runtime sources');
 const stageManifest=await stageRuntimePayload({source,destination:staged,profile:'desktop'});
 const output=join(root,'out','Host.exe');await build(staged,output);
 const info=JSON.parse(await run(output,['--build-info']));
 assert.deepEqual(Object.keys(info),['schemaVersion','purpose','sourceCommit','ownershipProtocolVersion','sourceManifestSha256','allowlistSha256','serviceHostSourceSha256','instanceRuntimeSha256','instanceOwnershipSha256']);
 assert.equal(info.schemaVersion,1);assert.equal(info.purpose,'windows-service-host-build');assert.equal(info.sourceCommit,stageManifest.sourceRevision);assert.equal(info.ownershipProtocolVersion,1);
 assert.equal(info.sourceManifestSha256,hash(await readFile(join(staged,'runtime-payload-manifest.json'))));assert.equal(info.allowlistSha256,hash(await readFile(join(staged,'packaging/runtime-payload.json'))));
 for(const [field,path]of [['serviceHostSourceSha256',files[0]],['instanceRuntimeSha256',files[1]],['instanceOwnershipSha256',files[2]]])assert.equal(info[field],hash(await readFile(join(staged,path))));
 checks.push({name:'real-compiler-embeds-matching-frozen-source-closure',pass:true});
 const ps7Output=join(root,'out','Host-PowerShell7.exe');await build(staged,ps7Output,[],'pwsh.exe');
 assert.deepEqual(JSON.parse(await run(ps7Output,['--build-info'])),info);
 checks.push({name:'powershell-7-json-integers-compile-the-same-frozen-source',pass:true});
 for(const args of [['--build-info','--force'],['--build-info','C:\\other']]){await assert.rejects(run(output,args),e=>e.code===2&&JSON.parse(e.stdout).code==='SHT_BUILD_INFO_ARGUMENTS');}
 checks.push({name:'read-only-query-rejects-extra-arguments',pass:true});
 const oldOutput=join(root,'out','untouched.exe');await writeFile(oldOutput,'do not touch');await assert.rejects(build(null,oldOutput),e=>e.code===1&&/SHB_RUNTIME_PAYLOAD_REQUIRED/.test(e.stderr));assert.equal(await readFile(oldOutput,'utf8'),'do not touch');checks.push({name:'default-build-refuses-missing-runtime-before-output',pass:true});
 const dev=join(root,'out','Development.exe');await build(null,dev,['-DevelopmentOnly']);await assert.rejects(run(dev,['--build-info']),e=>e.code===1&&JSON.parse(e.stdout).code==='SHT_BUILD_INFO_UNAVAILABLE');checks.push({name:'explicit-development-build-has-no-product-provenance',pass:true});
 await negative('different-source-path',async()=>['-SourcePath',join(source,files[0])],'SHB_SOURCE_PATH_MISMATCH');
 await negative('development-product-mode-conflict',async()=>['-DevelopmentOnly'],'SHB_BUILD_MODE_CONFLICT');
 await negative('wrong-stamp',async stage=>writeFile(join(stage,'.ragent-source-commit'),'0'.repeat(40)+'\n'),'SHB_RUNTIME_METADATA_INVALID');
 await negative('wrong-profile',async stage=>{const m=await manifest(stage);m.profile='accounts';await putManifest(stage,m);},'SHB_RUNTIME_METADATA_INVALID');
 await negative('wrong-schema',async stage=>{const m=await manifest(stage);m.schemaVersion='1';await putManifest(stage,m);},'SHB_RUNTIME_METADATA_INVALID');
 await negative('powershell-7-string-schema',async stage=>{const m=await manifest(stage);m.schemaVersion='1';await putManifest(stage,m);},'SHB_RUNTIME_METADATA_INVALID',{shell:'pwsh.exe'});
 await negative('changed-allowlist',async stage=>{await writeFile(join(stage,'packaging/runtime-payload.json'),'{}');},'SHB_RUNTIME_METADATA_INVALID');
 await negative('missing-js-entry',async stage=>{const m=await manifest(stage);m.files=m.files.filter(f=>f.path!==files[1]);await putManifest(stage,m);},'SHB_RUNTIME_ENTRY_REQUIRED');
 await negative('duplicate-case-entry',async stage=>{const m=await manifest(stage);m.files.push({...m.files.find(f=>f.path===files[0]),path:files[0].toLowerCase()});await putManifest(stage,m);},'SHB_RUNTIME_ENTRY_REQUIRED');
 for(const [name,path]of [['changed-csharp',files[0]],['changed-js',files[1]],['changed-ownership',files[2]]])await negative(name,async stage=>{await writeFile(join(stage,path),(await readFile(join(stage,path),'utf8'))+'\n// changed\n');},'SHB_RUNTIME_ENTRY_MISMATCH');
 await negative('wrong-byte-count',async stage=>{const m=await manifest(stage);m.files.find(f=>f.path===files[0]).bytes++;await putManifest(stage,m);},'SHB_RUNTIME_ENTRY_MISMATCH');
 await negative('old-js-protocol',async stage=>{await changed(stage,files[1],(await readFile(join(stage,files[1]),'utf8')).replace('WINDOWS_SERVICE_OWNERSHIP_PROTOCOL_VERSION = 1','WINDOWS_SERVICE_OWNERSHIP_PROTOCOL_VERSION = 2'));},'SHB_OWNERSHIP_PROTOCOL_UNSUPPORTED');
 await negative('native-protocol-disagrees',async stage=>{await changed(stage,files[0],(await readFile(join(stage,files[0]),'utf8')).replace('internal const int ProtocolVersion = 1','internal const int ProtocolVersion = 2'));},'SHB_BUILD_INFO_MISMATCH',{compile:true});
 await negative('hardlinked-js',async stage=>{await link(join(stage,files[1]),join(root,'outside-link'));},'SHB_INPUT_IDENTITY_REFUSED');
 const alias=join(root,'junction');await symlink(staged,alias,'junction');try{await assert.rejects(build(alias,join(root,'out','junction.exe')),e=>e.code===1&&/SHB_INPUT_IDENTITY_REFUSED/.test(e.stderr));checks.push({name:'junction-root-refused',refused:true});}finally{await unlink(alias);}
 assert.equal((await readdir(join(root,'out'))).some(n=>n.startsWith('service-host-build-')),false,'temporary resource files leaked');
 await writeFile(join(evidence,'build-info.json'),JSON.stringify(info,null,2)+'\n');
 report={pass:true,sourceCommit:(await exec('git',['rev-parse','HEAD'],{cwd:repo,windowsHide:true,encoding:'utf8'})).stdout.trim(),fixtureSourceCommit:stageManifest.sourceRevision,actualCompiler:true,fullRuntimePayload:false,actualScm:false,msiBuilt:false,installedProductChanged:false,authorityIssued:false,sourceFiles:await Promise.all(['packaging/windows/Ragent.ServiceHost.cs','packaging/windows/build-service-host.ps1','packaging/windows/build-msi.ps1','lib/instance-runtime.mjs','lib/instance-ownership.mjs','tests/test-windows-service-host-build.mjs'].map(async path=>({path,sha256:hash(await readFile(join(repo,path)))}))),hostSha256:hash(await readFile(output)),checks};pass=true;
}catch(error){report={pass:false,error:error.stack,checks,actualScm:false,installedProductChanged:false};throw error;}
finally{
 const resolvedRoot=resolve(root),resolvedTemp=resolve(tmpdir());
 if(!resolvedRoot.toLowerCase().startsWith((resolvedTemp+sep).toLowerCase())||!basename(resolvedRoot).startsWith('ragent-host-build-'))throw new Error('Fixture cleanup target escaped its marked temp root');
 await rm(resolvedRoot,{recursive:true,force:true});
 if(report){report.cleanupConfirmed=true;await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify({pass,checks:checks.length,report:join(evidence,'report.json')}));
}
