// Fixed credential-free canary task; never load product config or a Provider.
import { readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import https from 'node:https';
const root=process.env.RAGENT_IDENTITY_QA_ROOT,role=process.env.RAGENT_IDENTITY_QA_ROLE;
if(!root||!['control','executor','selftest'].includes(role))throw new Error('Invalid fixed canary context');
const spec=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const checks={noControlEnvironment:!Object.keys(process.env).some(k=>/AUTH_SESSION|OAUTH|API_KEY|TOKEN|SECRET|RAGENT_CONFIG|PROVIDER/.test(k))};
let ipc,provider,ownerBootstrap,credentialChannel;
const state=join(root,'state',role);
async function deniedRead(path){try{await readFile(path);return false;}catch(e){return ['EACCES','EPERM'].includes(e.code);}}
async function deniedWrite(path){try{const file=await open(path,'r+');await file.close();return false;}catch(e){return ['EACCES','EPERM'].includes(e.code);}}
async function pipe(){return new Promise(resolve=>{
  const client=net.connect('\\\\.\\pipe\\ragent-identity-owner-'+spec.caseId);
  const timer=setTimeout(()=>{client.destroy();resolve('timeout');},2500);
  client.once('connect',()=>{clearTimeout(timer);client.end();resolve('connected');});
  client.once('error',e=>{clearTimeout(timer);client.destroy();resolve(e.code);});
});}
try{
  const csv=await readFile(join(root,'workspace','input.csv'),'utf8');
  const sums={};for(const row of csv.trim().split(/\r?\n/).slice(1)){const [name,value]=row.split(',');sums[name]=(sums[name]||0)+Number(value);}
  await writeFile(join(root,'workspace',role+'-output.json'),JSON.stringify(sums));
  checks.csvTask=sums.alpha===42&&sums.beta===11;
  await writeFile(join(root,'extra-workspace',role+'-authorized.txt'),'Authorized QA directory only');checks.extraAuthorizedWrite=true;
  if(role!=='selftest'){
    checks.binaryWriteDenied=await deniedWrite(join(root,'runtime','IdentityCanary.exe'));
    checks.nodeWriteDenied=await deniedWrite(join(root,'runtime','node.exe'));
    if(role==='control'){
      checks.controlRead=(await readFile(join(root,'control','secret.txt'),'utf8')).startsWith('SYNTHETIC-IDENTITY-QA-');
      checks.ownerPipePositive=await pipe()==='connected';
    }else{
      checks.controlReadDenied=await deniedRead(join(root,'control','secret.txt'));
      checks.controlWriteDenied=await deniedWrite(join(root,'control','secret.txt'));
      checks.controlStateDenied=await deniedRead(join(root,'state','control','private-state.txt'));
      const connection=await pipe();checks.ownerPipeDenied=['EACCES','EPERM'].includes(connection);
      checks.noBinaryWriteAuthority=checks.binaryWriteDenied&&checks.nodeWriteDenied;
      checks.publicTlsHead=await new Promise(resolve=>{
        const request=https.request('https://example.com/',{method:'HEAD',timeout:8000},response=>{
          response.resume();resolve(response.statusCode>=200&&response.statusCode<400);
        });
        request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(false));request.end();
      });
    }
  }
  if(role!=='selftest' && spec.crossServiceCredentialChannel){
    credentialChannel=await (await import('./tests/fixtures/windows-service-credential-channel-probe.mjs')).serviceCredentialChannel(root,role,spec);
    checks.credentialChannel=credentialChannel.pass;
    if(spec.crossServiceCredentialProvider){checks.crossServiceRunIpc=credentialChannel.pass;checks.crossServiceProvider=credentialChannel.pass&&credentialChannel.providerUsed;}
  }else if(role!=='selftest' && spec.crossServiceOwnerBootstrap){
    ownerBootstrap=spec.ownerActivation
      ?await (await import('./tests/fixtures/windows-service-owner-activation-probe.mjs')).serviceOwnerActivation(root,role,spec)
      :spec.ownerDiscoverySet
      ?await (await import('./tests/fixtures/windows-service-owner-set-probe.mjs')).serviceOwnerSet(root,role,spec)
      :spec.ownerPurposeV2
      ?await (await import('./tests/fixtures/windows-service-owner-purpose-probe.mjs')).serviceOwnerPurpose(root,role,spec)
      :await (await import('./tests/fixtures/windows-service-owner-bootstrap-probe.mjs')).serviceOwnerBootstrap(root,role,spec);
    checks.ownerBootstrap=ownerBootstrap.pass;
  }else if(role!=='selftest' && spec.crossServiceProvider){
    provider=await (await import('./tests/fixtures/windows-service-provider-probe.mjs')).serviceProviderProbe(root,role,spec);
    checks.crossServiceRunIpc=provider.transportVerified;checks.crossServiceProvider=provider.pass;
  }else if(role!=='selftest' && spec.crossServiceIpc){
    ipc=await (await import('./tests/fixtures/windows-service-run-ipc-probe.mjs')).serviceRunIpc(root,role,spec);
    checks.crossServiceRunIpc=ipc.pass;
  }
  const pass=Object.values(checks).every(Boolean);
  await writeFile(join(state,'node-report.json'),JSON.stringify({pass,role,pid:process.pid,checks,...(ipc?{ipc}:{}),...(provider?{provider}:{}),...(ownerBootstrap?{ownerBootstrap}:{}),...(credentialChannel?{credentialChannel}:{})}));
  process.exitCode=pass?0:1;
}catch(error){await writeFile(join(state,'node-report.json'),JSON.stringify({pass:false,role,checks,error:{code:error.code||'',message:error.message}}));process.exitCode=1;}
