// Explicit isolated SCM canary preparation/launch; no production changes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile, mkdir, rm, realpath, lstat, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createRequire} from 'node:module';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { powershellUtf8, canaryLaunchGuard } from './qa-windows-service-launch-guards.mjs';
const exec=promisify(execFile),source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const windows=process.env.SystemRoot||'C:/Windows',powershell=join(windows,'System32/WindowsPowerShell/v1.0/powershell.exe');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const ipcFiles=['RunPipeCandidate.exe','chat/restricted-run-ipc.mjs','tests/helpers/windows-run-pipe-fixture.mjs','tests/fixtures/windows-service-run-ipc-probe.mjs'];
const providerFiles=['RestrictedProviderCandidate.exe','claude.exe','tests/fixtures/windows-service-provider-worker.mjs','tests/fixtures/windows-service-provider-probe.mjs'];
let ownerRows=[];
let ownerFiles=['OwnerBootstrap.exe','OwnerBootstrapRaw.exe','owner-files.json'];
const runtimeFiles=(ipc,provider=false)=>[...new Set(['IdentityCanary.exe','node.exe','probe.mjs',...(ipc?ipcFiles:[]),...(provider?providerFiles:[]),...(ownerRows.length?[...ownerFiles,...ownerRows.map(x=>x.path)]:[])])];
async function noReparse(path){for(let p=resolve(path);;p=dirname(p)){
  if((await lstat(p)).isSymbolicLink()||(await realpath(p)).toLowerCase()!==p.toLowerCase())throw new Error('Reparse path rejected');
  if(dirname(p)===p)return;
}}
if(process.platform!=='win32')throw new Error('Windows only');
const identity=await assertOrdinaryWindowsExecutionIdentity();
await mkdir(evidence,{recursive:true});
if(!process.argv.includes('--live')){
  const ownerActivation=process.argv.includes('--owner-activation'),ownerDiscoverySet=process.argv.includes('--owner-discovery-set'),ownerPurposeV2=ownerDiscoverySet||process.argv.includes('--owner-purpose-v2');
  const id=randomBytes(16).toString('hex'),bundle=join(evidence,'bundle-'+id),crossServiceCredentialProvider=process.argv.includes('--credential-provider'),crossServiceProvider=crossServiceCredentialProvider||process.argv.includes('--provider'),crossServiceIpc=crossServiceProvider||process.argv.includes('--run-ipc'),crossServiceOwnerBootstrap=ownerActivation||ownerPurposeV2||process.argv.includes('--owner-bootstrap'),crossServiceCredentialChannel=crossServiceCredentialProvider||process.argv.includes('--credential-channel');
  if(crossServiceCredentialChannel&&(crossServiceOwnerBootstrap||crossServiceIpc&&!crossServiceCredentialProvider))throw new Error('Credential channel is a separate case');
  if(ownerActivation)ownerFiles.push('OwnerActivationRaw.exe');
  if(crossServiceCredentialChannel)ownerFiles=['RunCredentialChannel.exe','owner-files.json'];
  if(crossServiceOwnerBootstrap&&crossServiceIpc)throw new Error('Owner and Run-only transport cases stay separate');
  await mkdir(bundle);await noReparse(bundle);
  const native='native/windows-service-identity-candidate.cs',probe='tests/fixtures/windows-service-identity-probe.mjs',bootstrap='scripts/qa-windows-service-identities.ps1';
  const sourceFiles=await Promise.all([native,probe,bootstrap,'scripts/qa-windows-service-identities.mjs','scripts/qa-windows-service-launch-guards.mjs',...(crossServiceIpc?['native/windows-run-pipe-candidate.cs',...ipcFiles.slice(1)]:[]),...(crossServiceProvider?['native/windows-restricted-provider-candidate.cs',...providerFiles.slice(2),'scripts/qa-windows-service-provider-run.mjs','chat/restricted-run-host.mjs','chat/run-api-store.mjs','chat/message-commit-store.mjs']:[]),...(crossServiceOwnerBootstrap?['native/windows-owner-bootstrap.cs','tests/fixtures/windows-owner-bootstrap-raw.cs','scripts/qa-windows-owner-bootstrap.mjs']:[])].map(async path=>({path,sha256:hash(await readFile(join(source,path)))})));
  if(crossServiceOwnerBootstrap)for(const path of ['tests/test-windows-owner-publication.mjs','scripts/qa-windows-service-identity-evidence.mjs'])sourceFiles.push({path,sha256:hash(await readFile(join(source,path)))});
  if(ownerPurposeV2)for(const path of ['scripts/qa-windows-owner-purpose.mjs','scripts/qa-windows-owner-purpose-evidence.mjs'])sourceFiles.push({path,sha256:hash(await readFile(join(source,path)))});
  if(ownerActivation)for(const path of ['scripts/qa-windows-owner-activation.mjs','scripts/qa-windows-owner-activation-evidence.mjs','tests/fixtures/windows-owner-activation-raw.cs','packaging/windows/read-owner-service-trust.ps1'])sourceFiles.push({path,sha256:hash(await readFile(join(source,path)))});
  if(ownerDiscoverySet)for(const path of ['scripts/qa-windows-owner-discovery-set.mjs','scripts/qa-windows-owner-set-evidence.mjs'])sourceFiles.push({path,sha256:hash(await readFile(join(source,path)))});
  if(crossServiceCredentialProvider)sourceFiles.push(...await Promise.all(['tests/fixtures/windows-service-provider-provision.mjs','chat/restricted-provider-worker-input.mjs','tests/test-credential-provider-worker-input.mjs'].map(async path=>({path,sha256:hash(await readFile(join(source,path)))}))));
  if(crossServiceCredentialChannel)for(const path of ['native/windows-run-credential-channel.cs','scripts/qa-windows-credential-channel.mjs','tests/test-credential-dispatch.mjs','tests/test-credential-channel-native-admission.mjs','package-lock.json'])sourceFiles.push({path,sha256:hash(await readFile(join(source,path)))});
  let build;
  try{build=await exec(join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),[
    '/nologo','/utf8output','/target:exe','/platform:x64','/r:System.ServiceProcess.dll','/r:System.Web.Extensions.dll',
    `/out:${join(bundle,'IdentityCanary.exe')}`,join(source,native)],{windowsHide:true,timeout:30000,maxBuffer:32768});
  }catch(error){await writeFile(join(bundle,'build.log'),String(error.stdout||'')+String(error.stderr||''));throw error;}
  await writeFile(join(bundle,'build.log'),build.stdout+build.stderr);
  if(crossServiceIpc){
    const pipeBuild=await exec(join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/r:System.Web.Extensions.dll',`/out:${join(bundle,'RunPipeCandidate.exe')}`,join(source,'native/windows-run-pipe-candidate.cs')],{windowsHide:true,timeout:30000,maxBuffer:32768});
    await writeFile(join(bundle,'pipe-build.log'),pipeBuild.stdout+pipeBuild.stderr);
    for(const file of ipcFiles.slice(1)){await mkdir(dirname(join(bundle,file)),{recursive:true});await copyFile(join(source,file),join(bundle,file));}
  }
  if(crossServiceProvider){
    const providerBuild=await exec(join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/r:System.Web.Extensions.dll',`/out:${join(bundle,'RestrictedProviderCandidate.exe')}`,join(source,'native/windows-restricted-provider-candidate.cs')],{windowsHide:true,timeout:30000,maxBuffer:32768});
    await writeFile(join(bundle,'provider-build.log'),providerBuild.stdout+providerBuild.stderr);
    await copyFile('C:/ProgramData/AgentoC/harnesses/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe',join(bundle,'claude.exe'));
    for(const file of providerFiles.slice(2)){await mkdir(dirname(join(bundle,file)),{recursive:true});await copyFile(join(source,file),join(bundle,file));}
  }
  if(crossServiceOwnerBootstrap||crossServiceCredentialChannel){
    for(const [name,extra] of crossServiceCredentialChannel?[['RunCredentialChannel.exe',[]]]:[['OwnerBootstrap.exe',[]],['OwnerBootstrapRaw.exe',['/main:OwnerBootstrapRawMain',join(source,'tests/fixtures/windows-owner-bootstrap-raw.cs')]]]){
      await exec(join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/r:System.Web.Extensions.dll',`/out:${join(bundle,name)}`,join(source,crossServiceCredentialChannel?'native/windows-run-credential-channel.cs':'native/windows-owner-bootstrap.cs'),...extra],{windowsHide:true,timeout:30000,maxBuffer:32768});
    }
    if(ownerActivation){
      const inspector=await readFile(join(source,'packaging/windows/read-owner-service-trust.ps1'),'utf8'),wts=inspector.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
      if(!wts)throw new Error('Actual WTS source missing');const wtsPath=join(bundle,'owner-wts.cs');await writeFile(wtsPath,wts[1]);
      await exec(join(windows,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/utf8output','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/main:OwnerActivationRawMain','/out:'+join(bundle,'OwnerActivationRaw.exe'),join(source,'native/windows-owner-bootstrap.cs'),join(source,'tests/fixtures/windows-owner-activation-raw.cs'),wtsPath],{windowsHide:true,timeout:30000,maxBuffer:32768});
    }
    const seen=new Set();async function collect(path){if(seen.has(path))return;seen.add(path);const content=await readFile(join(source,path),'utf8');
      for(const found of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g))if(found[2].startsWith('.')){
        const target=resolve(dirname(join(source,path)),found[2]);const relative=target.slice(source.length+1).replaceAll('\\','/');
        if(!target.startsWith(source+'\\')&&!target.startsWith(source+'/'))throw new Error('Auth source escaped repository');
        if(/\.m?js$/.test(relative))await collect(relative);
      }}
    for(const path of crossServiceCredentialChannel?['tests/fixtures/windows-service-credential-channel-probe.mjs']:['lib/auth.mjs',ownerActivation?'tests/fixtures/windows-service-owner-activation-probe.mjs':ownerDiscoverySet?'tests/fixtures/windows-service-owner-set-probe.mjs':ownerPurposeV2?'tests/fixtures/windows-service-owner-purpose-probe.mjs':'tests/fixtures/windows-service-owner-bootstrap-probe.mjs'])await collect(path);seen.add('package.json');
    if(crossServiceCredentialProvider)seen.add('tests/fixtures/windows-service-provider-provision.mjs');
    if(crossServiceCredentialChannel)for(const path of ['runtime/manager-boundary.md','runtime/codex-developer-instructions.txt','system/startup-context.md','turn/context-hook.md'])seen.add('chat/prompt-assets/'+path);
    if(crossServiceCredentialChannel){
      const packages=new Set();
      async function dependency(name,from=join(source,'package.json')){
        let path=dirname(createRequire(from).resolve(name));
        for(;;){try{if(JSON.parse(await readFile(join(path,'package.json'),'utf8')).name===name)break;}catch{}const parent=dirname(path);if(parent===path)throw new Error('Dependency root missing');path=parent;}
        if(!path.startsWith(join(source,'node_modules')+'\\'))throw new Error('Dependency outside frozen repository');
        if(packages.has(path))return;packages.add(path);await noReparse(path);
        async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isSymbolicLink())throw new Error('Dependency symlink refused');
          if(item.isDirectory()){if(!['node_modules','test','tests','examples','example','docs','doc','.github'].includes(item.name))await walk(file);}
          else if(/\.(?:js|mjs|cjs|json)$/.test(item.name))seen.add(file.slice(source.length+1).replaceAll('\\','/'));}}
        await walk(path);const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));
        for(const child of Object.keys(pkg.dependencies||{}))await dependency(child,join(path,'package.json'));
      }
      await dependency('web-push');await dependency('ws');
    }
    ownerRows=await Promise.all([...seen].sort().map(async path=>({path,sha256:hash(await readFile(join(source,path)))})));
    for(const row of ownerRows){await mkdir(dirname(join(bundle,row.path)),{recursive:true});await copyFile(join(source,row.path),join(bundle,row.path));}
    await writeFile(join(bundle,'owner-files.json'),JSON.stringify({version:1,files:ownerRows}));
  }
  let nodeSource='C:/Program Files/AgentoC/payload/node.exe';
  if(process.argv.includes('--frozen-internal-node')){
    nodeSource=join(evidence,'bundle-c62e7d1319543507823ed7728b247518/node.exe');
    if(hash(await readFile(nodeSource))!=='2ffe3acc0458fdde999f50d11809bbe7c9b7ef204dcf17094e325d26ace101d8')throw new Error('Frozen internal Node mismatch');
  }
  await copyFile(nodeSource,join(bundle,'node.exe'));
  await copyFile(join(source,probe),join(bundle,'probe.mjs'));await copyFile(join(source,bootstrap),join(bundle,'bootstrap.ps1'));
  const manifest={schemaVersion:1,caseId:id,crossServiceIpc,crossServiceProvider,crossServiceOwnerBootstrap,crossServiceCredentialChannel,ownerPurposeV2,ownerDiscoverySet,ownerActivation,requestorSid:identity.sid,crossServiceCredentialProvider,sourceBaseCommit:(await exec('git',['rev-parse','HEAD'],{cwd:source})).stdout.trim(),sourceFiles};
  if(crossServiceOwnerBootstrap){manifest.ownerInstanceId=ownerActivation?'inst_'+id:randomUUID();manifest.ownerSessionId=Number((await exec(powershell,['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).SessionId`],{windowsHide:true,timeout:10000})).stdout.trim());}
  for(const file of [...runtimeFiles(crossServiceIpc,crossServiceProvider).filter(file=>!ownerRows.some(row=>row.path===file)||providerFiles.includes(file)||ipcFiles.includes(file)),'bootstrap.ps1'])manifest[file]=hash(await readFile(join(bundle,file)));
  if(crossServiceCredentialProvider){
    const {createNativeProviderRegistry}=await import('../lib/provider-runtime/registry.mjs');
    const registry=createNativeProviderRegistry({configDir:'C:/ProgramData/AgentoC/instances/owner/config'});
    const selected=(await registry.listProviderProfiles()).find(row=>row.agentType==='claude'&&row.enabled!==false&&row.status==='ready'&&row.protocol==='anthropic-messages');
    if(!selected)throw new Error('Selected Claude static Provider unavailable');
    const auth=await registry.getAuthProfile(selected.authProfileId);
    if(auth?.authType!=='api-key'||auth.storageType!=='secret-store')throw new Error('Static Provider auth required');
    const url=new URL(selected.baseUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Invalid Provider endpoint');
    const {lookup}=await import('node:dns/promises');const addresses=await lookup(url.hostname,{all:true});
    if(!addresses.length||addresses.some(({address})=>/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|::ffff:|f[cd]|fe80:)/i.test(address)))throw new Error('Private Provider endpoint refused');
    manifest.providerSource={profileId:selected.id,profileRevision:selected.revision,authRevision:auth.revision,baseUrl:selected.baseUrl,model:selected.modelPolicy.defaultModel};
  }
  await writeFile(join(bundle,'manifest.json'),JSON.stringify(manifest,null,2));
  const selfParent=join(process.env.LOCALAPPDATA,'AgentoC/identity-qa');await mkdir(selfParent,{recursive:true});await noReparse(selfParent);
  const self=join(selfParent,'case-'+id);await mkdir(self);
  try{
    for(const path of ['runtime','workspace','extra-workspace','state','state/selftest'])await mkdir(join(self,path));
    for(const file of runtimeFiles(crossServiceIpc,crossServiceProvider)){await mkdir(dirname(join(self,'runtime',file)),{recursive:true});await copyFile(join(bundle,file),join(self,'runtime',file));}
    await copyFile(join(bundle,'manifest.json'),join(self,'manifest.json'));
    await writeFile(join(self,'.agentoc-identity-qa'),'case-'+id);
    await writeFile(join(self,'workspace/input.csv'),'name,amount\nalpha,17\nbeta,11\nalpha,25\n');
    let stdout;
    try{({stdout}=await exec(join(self,'runtime/IdentityCanary.exe'),['--self-test',self],{windowsHide:true,timeout:35000,maxBuffer:65536}));}
    catch(error){await writeFile(join(bundle,'self-test-failure.json'),JSON.stringify({code:error.code,stdout:error.stdout,stderr:error.stderr}));throw error;}
    const report=JSON.parse(stdout.trim());if(!report.pass)throw new Error('Native self-test refused');
    await writeFile(join(bundle,'self-test.json'),JSON.stringify(report,null,2));
    if(crossServiceCredentialChannel){
      const authorityRoot=join(self,'authority-check');await mkdir(authorityRoot);
      const helperUrl=new URL('file:///'+join(self,'runtime/tests/fixtures/local-control-authority.mjs').replaceAll('\\','/')).href;
      const code=`const {localControlAuthority}=await import(${JSON.stringify(helperUrl)});const f=await localControlAuthority(${JSON.stringify(authorityRoot)});const v=await f.seed({id:'qa',modelPolicy:{defaultModel:'qa'}},'synthetic');console.log(JSON.stringify({pass:!!v.runId,originalPrincipal:v.principal.principalKind}));`;
      try{const result=await exec(join(self,'runtime/node.exe'),['--input-type=module','-e',code],{windowsHide:true,timeout:15000,maxBuffer:32768});
        await writeFile(join(bundle,'authority-self-test.log'),result.stdout+result.stderr);
      }catch(error){await writeFile(join(bundle,'authority-self-test-failure.log'),String(error.stdout||'')+String(error.stderr||''));throw new Error('Frozen original authority self-test failed');}
    }
  }finally{
    const actual=await realpath(self);if(dirname(actual).toLowerCase()!==selfParent.toLowerCase()||basename(actual)!=='case-'+id)throw new Error('Cleanup root mismatch');
    await rm(actual,{recursive:true,force:true});
  }
  for(const item of sourceFiles)if(hash(await readFile(join(source,item.path)))!==item.sha256)throw new Error('Source changed during preparation');
  for(const item of ownerRows)if(hash(await readFile(join(source,item.path)))!==item.sha256)throw new Error('Owner source changed during preparation');
  await writeFile(join(evidence,'prepared.json'),JSON.stringify({bundle,manifestSha256:hash(await readFile(join(bundle,'manifest.json'))),preparedAt:new Date().toISOString(),selfTestPass:true,productionChanged:false},null,2));
  console.log(JSON.stringify({prepared:true,bundle,selfTestPass:true,requiresUac:true}));
}else{
  const prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8')),bundle=resolve(prepared.bundle);
  if(dirname(bundle).toLowerCase()!==evidence.toLowerCase()||!/^bundle-[a-f0-9]{32}$/.test(basename(bundle)))throw new Error('Prepared bundle escaped evidence root');
  await noReparse(bundle);
  const bytes=await readFile(join(bundle,'manifest.json'));if(hash(bytes)!==prepared.manifestSha256)throw new Error('Prepared manifest changed');
  const manifest=JSON.parse(bytes);
  if(manifest.ownerActivation)ownerFiles.push('OwnerActivationRaw.exe');
  if(manifest.crossServiceCredentialChannel)ownerFiles=['RunCredentialChannel.exe','owner-files.json'];
  if(manifest.crossServiceOwnerBootstrap||manifest.crossServiceCredentialChannel){const raw=await readFile(join(bundle,'owner-files.json'));if(hash(raw)!==manifest['owner-files.json'])throw new Error('Owner index changed');ownerRows=JSON.parse(raw).files;}
  for(const item of manifest.sourceFiles)if(hash(await readFile(join(source,item.path)))!==item.sha256)throw new Error('Prepared source changed; prepare a fresh canary');
  for(const item of ownerRows)if(hash(await readFile(join(source,item.path)))!==item.sha256||hash(await readFile(join(bundle,item.path)))!==item.sha256)throw new Error('Owner source changed');
  for(const file of [...runtimeFiles(manifest.crossServiceIpc,manifest.crossServiceProvider).filter(file=>!ownerRows.some(row=>row.path===file)),'bootstrap.ps1'])if(hash(await readFile(join(bundle,file)))!==manifest[file])throw new Error('Prepared file changed');
  // Pin and read the entire bootstrap once in the elevated process. Copying
  // payloads into its protected root is also followed by manifest verification.
  const startBeforeMs=Date.now()+120000;
  const command=`$ErrorActionPreference='Stop';${canaryLaunchGuard(startBeforeMs)}$qaBytes=[IO.File]::ReadAllBytes(${quote(join(bundle,'bootstrap.ps1'))});$qaSha=[Security.Cryptography.SHA256]::Create();try{$qaActual=([BitConverter]::ToString($qaSha.ComputeHash($qaBytes))).Replace('-','').ToLowerInvariant()}finally{$qaSha.Dispose()};if($qaActual -cne ${quote(manifest['bootstrap.ps1'])}){throw 'Pinned bootstrap changed'};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($qaBytes))) -BundleRoot ${quote(bundle)} -ManifestSha256 ${quote(prepared.manifestSha256)}`;
  const encoded=Buffer.from(command,'utf16le').toString('base64');
  const launcher=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';${powershellUtf8}$qaStage='request-elevation';try{$qaProcess=Start-Process -FilePath ${quote(powershell)} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',${quote(encoded)}) -Verb RunAs -WindowStyle Hidden -PassThru;$qaStage='wait-for-bootstrap';$qaProcess.WaitForExit();$qaStage='read-exit-code';$qaExitCode=$qaProcess.ExitCode;if($null -eq $qaExitCode){throw 'Elevated process exit code unavailable'};exit $qaExitCode}catch{$qaNative=$_.Exception;while($qaNative.InnerException){$qaNative=$qaNative.InnerException};[pscustomobject]@{phase='uac-launch';stage=$qaStage;type=$qaNative.GetType().Name;nativeErrorCode=$qaNative.NativeErrorCode;message=$qaNative.Message}|ConvertTo-Json -Compress;exit 1}`;
  await writeFile(join(bundle,'launch-intent.json'),JSON.stringify({caseId:manifest.caseId,manifestSha256:prepared.manifestSha256,bootstrapSha256:manifest['bootstrap.ps1'],
    serviceNames:['Control','Executor'].map(role=>'AgentoC-IdentityQA-'+role+'-'+manifest.caseId),protectedRoot:join(process.env.ProgramData,'AgentoCIdentityQA','case-'+manifest.caseId),startBefore:new Date(startBeforeMs).toISOString(),productionChanged:false},null,2));
  let launchFailure;
  try{
    await exec(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(launcher,'utf16le').toString('base64')],{windowsHide:true,timeout:manifest.crossServiceProvider?420000:240000,maxBuffer:32768});
  }catch(error){launchFailure=error;await writeFile(join(bundle,'launch-failure.json'),JSON.stringify({code:error.code,killed:error.killed,stdout:error.stdout,stderr:error.stderr}));
  }finally{
    const exported=join(process.env.ProgramData,'AgentoCIdentityQA','case-'+manifest.caseId,'export');
    try{
      for(const file of await readdir(exported))if(/^(summary|desktop-preparer-report|(?:control|executor)-(?:service|node)-report)\.json$/.test(file))await copyFile(join(exported,file),join(bundle,file));
      const summary=JSON.parse(await readFile(join(bundle,'summary.json'),'utf8'));
      console.log(JSON.stringify({caseId:manifest.caseId,pass:summary.pass,cleanup:summary.cleanup,evidence:join(bundle,'summary.json')}));
      if(!summary.pass)launchFailure??=new Error('Isolated identity canary failed; inspect summary');
    }catch(error){launchFailure??=error;await writeFile(join(bundle,'export-failure.json'),JSON.stringify({code:error.code||'',message:error.message,productionChanged:false}));}
  }
  if(launchFailure)throw Object.assign(new Error('Isolated identity canary did not pass; inspect retained evidence'),
    {code:'IDENTITY_CANARY_FAILED',evidence:bundle});
}
