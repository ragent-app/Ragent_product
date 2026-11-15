// Isolated actual JS entry wiring with OS execution substituted. Actual cold
// Windows timings are separate hosted evidence, not simulated here.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const files=['windows-owner-discovery.mjs','windows-owner-activation-trust.mjs','windows-owner-service-trust.mjs'].map(p=>new URL('../../lib/'+p,import.meta.url).href);
const platform=process.platform;if(platform!=='win32')Object.defineProperty(process,'platform',{value:'win32'});
const calls=[];let mode='missing';
function execFile(){}
execFile[Symbol.for('nodejs.util.promisify.custom')]=async(exe,args,options)=>{
 calls.push({exe,args,options});assert.equal(exe,'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');assert.equal(options.timeout,60000);assert.equal(options.maxBuffer,65536);assert.deepEqual(options.env,{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'});assert.equal(args.includes('-ExecutionPolicy'),false);
 if(mode==='timeout')throw Object.assign(Error('secret stderr must not be returned'),{killed:true});
 if(mode==='abort'){options.signal?.throwIfAborted();throw Error('unexpected');}
 return {stdout:JSON.stringify({ok:false,code:'OBD_RELEASE_NOT_INSTALLED'}),stderr:''};
};
globalThis.__ownerInspectionAdapter={execFile};
registerHooks({resolve(specifier,context,next){if(files.includes(context.parentURL)&&specifier==='node:child_process')return {url:'qa:inspection-child',shortCircuit:true};return next(specifier,context);},load(url,context,next){return url==='qa:inspection-child'?{format:'module',source:'export const execFile=globalThis.__ownerInspectionAdapter.execFile;',shortCircuit:true}:next(url,context);}});
const {inspectInstalledOwnerBootstrap}=await import(files[0]),{inspectInstalledOwnerActivation}=await import(files[1]),{inspectInstalledOwnerActivationService}=await import(files[2]);
const context={instanceRoot:'C:/ProgramData/Ragent/instances/owner',instanceId:'inst_'+'a'.repeat(32),host:'127.0.0.1',port:7690};
const entries=[['discovery',()=>inspectInstalledOwnerBootstrap(),'OBD_INSPECTION_TIMEOUT'],['activation',()=>inspectInstalledOwnerActivation(),'OBD_INSPECTION_TIMEOUT'],['service',()=>inspectInstalledOwnerActivationService(context),'OSV_INSPECTION_TIMEOUT']];
for(const [name,call,timeout]of entries){mode='missing';await assert.rejects(call(),{code:'OBD_RELEASE_NOT_INSTALLED'});mode='timeout';await assert.rejects(call(),{code:timeout,message:timeout});}
mode='abort';const abort=new AbortController();abort.abort();await assert.rejects(inspectInstalledOwnerActivationService(context,{signal:abort.signal}),{code:'OSV_ABORTED'});
console.log(JSON.stringify({pass:true,cases:7,actualJsEntries:true,osInspectionSubstituted:true,nativeAuthorityIssued:false,platformSimulated:platform!=='win32'}));
