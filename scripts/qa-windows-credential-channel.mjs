// One bounded isolated service batch. Ordinary Owner attempts only denial.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,rename,lstat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {credentialScenarios} from '../tests/fixtures/windows-service-credential-channel-probe.mjs';
if(!process.argv.includes('--live-credential-channel'))throw new Error('Explicit live credential flag required');
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..'),evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8'));assert.equal(dirname(resolve(prepared.bundle)).toLowerCase(),evidence.toLowerCase());assert.match(basename(prepared.bundle),/^bundle-[a-f0-9]{32}$/);
const bytes=await readFile(join(prepared.bundle,'manifest.json'));assert.equal(hash(bytes),prepared.manifestSha256);const spec=JSON.parse(bytes);assert.equal(spec.crossServiceCredentialChannel,true);if(spec.crossServiceCredentialProvider)assert.ok(process.argv.includes('--live-provider'),'Explicit real Provider flag required');
const root=join(process.env.ProgramData,'RagentIdentityQA','case-'+spec.caseId),report={pass:false,caseId:spec.caseId,cases:[],productionChanged:false,providerUsed:false,phoneTouched:false};
async function production(){const {stdout}=await promisify(execFile)('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command',`[pscustomobject]@{services=@(Get-CimInstance Win32_Service -Filter "Name='Ragent-ControlPlane' OR Name='Ragent-RunnerSupervisor'"|Sort-Object Name|Select-Object Name,State,ProcessId,StartName)}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:10000});return JSON.parse(stdout.trim());}
const before=await production();await writeFile(join(prepared.bundle,'production-before.json'),JSON.stringify(before));
let status;const child=spawn(process.execPath,[join(source,'scripts/qa-windows-service-identities.mjs'),'--live'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
child.stdout.on('data',b=>{output=(output+b).slice(-32768);});child.stderr.on('data',b=>{output=(output+b).slice(-32768);});
const finished=new Promise(done=>{child.once('error',()=>{status=-1;done(-1);});child.once('close',code=>{status=code;done(code);});});
async function get(path,ms){const until=Date.now()+ms;while(Date.now()<until){try{const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<131072);return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}if(status!==undefined)throw new Error('Service batch ended before ready');await new Promise(done=>setTimeout(done,50));}throw new Error('Credential ready deadline');}
try{
  for(const round of [1,2])for(const scenario of credentialScenarios){report.phase=`ready-r${round}-${scenario}`;const prefix=`r${round}-credential-${scenario}-`,ready=await get(join(root,'handoff/executor',prefix+'ready.json'),round===1&&scenario==='success'?180000:spec.crossServiceCredentialProvider?115000:40000);
    report.phase=`owner-denial-r${round}-${scenario}`;const denied=await new Promise(done=>{const socket=net.connect('\\\\.\\pipe\\'+ready.policy.pipeName),timer=setTimeout(()=>{socket.destroy();done(false);},2000);
      socket.once('connect',()=>{clearTimeout(timer);socket.destroy();done(false);});socket.once('error',error=>{clearTimeout(timer);done(['EACCES','EPERM'].includes(error.code));});});assert.equal(denied,true);
    const ack=join(root,'control/inbox',prefix+'owner-denied.json');await writeFile(ack+'.tmp',JSON.stringify({denied}),{flag:'wx'});await rename(ack+'.tmp',ack);
    report.cases.push({round,scenario,ownerDenied:true,server:ready.ready.facts});
  }
  report.phase='service-summary';assert.equal(await finished,0);const summary=JSON.parse(await readFile(join(prepared.bundle,'summary.json'),'utf8'));assert.equal(summary.pass,true);assert.equal(summary.credentialHandoffRemoved,true);report.providerUsed=spec.crossServiceCredentialProvider===true;report.pass=true;
}catch(error){report.error=error.code||error.name;await finished;}
finally{const after=await production();await writeFile(join(prepared.bundle,'production-after.json'),JSON.stringify(after));report.productionObservationUnchanged=JSON.stringify(after)===JSON.stringify(before);report.pass&&=report.productionObservationUnchanged;
  report.exitCode=status;await writeFile(join(prepared.bundle,'credential-client.json'),JSON.stringify(report,null,2));if(!report.pass)await writeFile(join(prepared.bundle,'credential-launch.log'),output);}
console.log(JSON.stringify({pass:report.pass,caseId:spec.caseId,cases:report.cases.length}));if(!report.pass)process.exitCode=1;
