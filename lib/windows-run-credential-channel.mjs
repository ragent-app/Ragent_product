// Private installation/control inputs only. No PATH lookup or public peer claims.
import {spawn} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const installedCredentialChannel=`${(process.env.RAGENT_INSTALL_ROOT||'C:/Program Files/Ragent').replaceAll('\\','/').replace(/\/+$/,'')}/payload/Ragent.RunCredentialChannel.exe`;
export async function credentialEndpoint({mode,policy,executablePath=installedCredentialChannel,executableSha256,signal}){
  if(process.platform!=='win32'||!['server','client'].includes(mode))fail('RCC_PLATFORM_INVALID');
  const binding=policy?.binding;
  if(!/^ragent-run-credential-[a-f0-9]{32}$/.test(policy?.pipeName||'')||!binding||!Number.isSafeInteger(binding.expiresAtUnixMs)
    ||binding.expiresAtUnixMs<=Date.now()||binding.expiresAtUnixMs>Date.now()+120000)fail('RCC_POLICY_INVALID');
  const stat=await lstat(executablePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||! /^[a-f0-9]{64}$/.test(executableSha256||'')
    ||createHash('sha256').update(await readFile(executablePath)).digest('hex')!==executableSha256)fail('RCC_HELPER_INVALID');
  if(signal?.aborted)fail('RCC_ABORTED');
  const child=spawn(executablePath,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  const queue=[],waiters=[];let buffer='',closed=false;const deliver=value=>waiters.length?waiters.shift()(value):queue.push(value);
  const exit=new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);});child.stdin.on('error',()=>{});child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',bytes=>{buffer+=bytes.toString('utf8');if(Buffer.byteLength(buffer)>1048576){child.kill();deliver({kind:'error',code:'RCC_OUTPUT_INVALID'});return;}
    for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{deliver(JSON.parse(line));}catch{deliver({kind:'error',code:'RCC_OUTPUT_INVALID'});}}});
  const abort=()=>{child.kill();deliver({kind:'error',code:'RCC_ABORTED'});};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{child.kill();deliver({kind:'error',code:'RCC_DEADLINE'});},Math.max(1,binding.expiresAtUnixMs-Date.now()+1000));
  exit.then(()=>{closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);deliver({kind:'exit'});});
  const endpoint={pid:child.pid,exit,send(value){const body=JSON.stringify(value);if(Buffer.byteLength(body)>262144)fail('RCC_FRAME_TOO_LARGE');child.stdin.write(body+'\n');},
    async next(){return queue.length?queue.shift():closed?{kind:'exit'}:new Promise(done=>waiters.push(done));},
    async expect(kind){const value=await this.next();if(value.kind!==kind)fail(/^RCC_[A-Z_]+$/.test(value.code||'')?value.code:'RCC_ENDPOINT_EXIT');return value;},
    async close(){child.stdin.end();if(!closed)child.kill();await exit;}};
  try{endpoint.send(policy);return endpoint;}catch(error){await endpoint.close();throw error;}
}
export async function openControlCredentialChannel(options){
  const endpoint=await credentialEndpoint({...options,mode:'client'});
  try{await endpoint.expect('identity');const authenticated=await endpoint.expect('authenticated');let used=false;
    return {peer:authenticated.facts,async send(payload){if(used)fail('RCC_ALREADY_USED');used=true;endpoint.send(payload);
      const result=await endpoint.expect('result');if(await endpoint.exit!==0)fail('RCC_DELIVERY_UNCONFIRMED');return result.outcome;},close:()=>endpoint.close()};
  }catch(error){await endpoint.close();throw error;}
}
export async function listenExecutorCredentialChannel(options){
  const endpoint=await credentialEndpoint({...options,mode:'server'});
  try{await endpoint.expect('identity');const ready=await endpoint.expect('ready');return {ready,endpoint,
    async receive(){const auth=await endpoint.expect('authenticated'),request=await endpoint.expect('request');return {peer:auth.facts,payload:request.payload};},
    async respond(value){endpoint.send(value);if(await endpoint.exit!==0)fail('RCC_DELIVERY_UNCONFIRMED');},close:()=>endpoint.close()};
  }catch(error){await endpoint.close();throw error;}
}
