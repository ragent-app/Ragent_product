// Isolated native transport QA only. Both endpoints inherit this ordinary
// user's token; separate virtual service identities are NOT claimed here.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createRestrictedRunIpcGrant } from '../../chat/restricted-run-ipc.mjs';

export async function compileRunPipe(root) {
  const exe=join(root,'RunPipeCandidate.exe');
  await promisify(execFile)(join(process.env.SystemRoot||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll',`/out:${exe}`,
      fileURLToPath(new URL('../../native/windows-run-pipe-candidate.cs',import.meta.url))],
    {windowsHide:true,timeout:30000,maxBuffer:32768});
  return exe;
}

export function endpoint(exe, mode, { timeoutMs = 20000 } = {}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>125000)throw new Error('QA endpoint deadline invalid');
  const child=spawn(exe,[mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{
    SystemRoot:process.env.SystemRoot||'C:\\Windows',WINDIR:process.env.SystemRoot||'C:\\Windows',
  }});
  let buffer='', stderr=''; const queue=[],waiting=[];
  const exit=new Promise(resolve=>{child.once('error',()=>resolve({code:-1}));child.once('close',code=>resolve({code}));});
  const deliver=value=>waiting.length?waiting.shift()(value):queue.push(value);
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString('utf8');
    if(Buffer.byteLength(buffer)>196608){child.kill();deliver({kind:'error',code:'QA_OUTPUT_TOO_LARGE'});return;}
    for(;;){const at=buffer.indexOf('\n');if(at<0)break;
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try{deliver(JSON.parse(line));}catch{deliver({kind:'error',code:'QA_BAD_JSON'});}}
  });
  child.stderr.on('data',c=>{stderr=(stderr+c).slice(-1000);});
  child.stdin.on('error',()=>{});
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  exit.then(({code})=>{clearTimeout(timer);deliver(code===2?{kind:'error',code:'IPC_ENDPOINT_DEADLINE'}:{kind:'exit'});});
  return {child,exit,send:value=>child.stdin.write(JSON.stringify(value)+'\n'),
    next:()=>queue.length?Promise.resolve(queue.shift()):new Promise(done=>waiting.push(done)),
    async expect(kind){const event=await this.next();if(event.kind!==kind)throw Object.assign(
      new Error(event.code?`${event.code} (${event.stage||''}/${event.type||''}/${event.hresult||event.win32||0})`:`Expected ${kind}, got ${event.kind}; ${stderr}`),
      {code:event.code||'QA_ENDPOINT_EXIT',native:event});return event;},
    async close(){child.stdin.end();if(child.exitCode===null)child.kill();await exit;},
  };
}

export async function exchangeRunPipe({exe,identity,sessionId,instanceId,lease,text='Synthetic input',execute,
  fault='',onReady,timeoutMs=15000,signal}) {
  const aborted=()=>Object.assign(new Error('RESTRICTED_IPC_ABORTED'),{code:'RESTRICTED_IPC_ABORTED'});
  if(signal?.aborted)throw aborted();
  const grant=createRestrictedRunIpcGrant({instanceId,lease});
  const frame=grant.frame(text),binding={...grant.binding,capability:frame.capability};
  const server=endpoint(exe,'server'); let client;
  const deadline=Math.min(lease.expiresAtUnixMs,Date.now()+timeoutMs);
  const pipeName='ragent-run-candidate-'+randomBytes(16).toString('hex');
  const policy={pipeName,expiresAtUnixMs:deadline,binding,localSid:identity.sid,localSessionId:sessionId,
    peerSid:fault==='client-sid'?'S-1-5-21-1-2-3-1001':identity.sid,
    peerSessionId:fault==='client-session'?sessionId+1:sessionId};
  let dispatched=0, peerFacts;
  const operation=async()=>{
    server.send(policy); await server.expect('identity'); const ready=await server.expect('ready');
    if(onReady)await onReady({pipeName,ready,async attemptDuplicateServer(){
      const duplicate=endpoint(exe,'server');
      try{duplicate.send(policy);await duplicate.expect('identity');return await duplicate.next();}
      finally{await duplicate.close();}
    }});
    if(signal?.aborted)throw aborted();
    client=endpoint(exe,'client');
    const expectedServer={...ready.facts};
    if(fault==='server-pid')expectedServer.pid=process.pid;
    if(fault==='server-created')expectedServer.createdTicks='1';
    if(fault==='server-session')expectedServer.sessionId++;
    if(fault==='server-sid')expectedServer.sid='S-1-5-21-1-2-3-1001';
    const outgoing={...frame,...(fault==='capability'?{capability:'z'.repeat(43)}:{}),
      ...(fault==='cross-run'?{runId:'run_different_12345678'}:{}),
      ...(fault==='owner-operation'?{operation:'owner.session'}:{})};
    // Capability/scope negatives reach the server: the client has its own
    // matching policy, so its local check cannot mask a missing server check.
    const clientBinding={...binding,...(fault==='capability'?{capability:outgoing.capability}:{}),
      ...(fault==='cross-run'?{runId:outgoing.runId}:{})};
    client.send({...policy,binding:clientBinding,peer:expectedServer});
    const clientIdentity=await client.expect('identity');
    const expectedClient={...clientIdentity.facts};
    if(fault==='client-pid')expectedClient.pid=process.pid;
    if(fault==='client-created')expectedClient.createdTicks='1';
    if(fault==='client-session')expectedClient.sessionId++;
    if(fault==='client-sid')expectedClient.sid=policy.peerSid;
    server.send(expectedClient);
    if(fault==='parent-disconnect'){
      client.child.stdin.end();return {event:await client.next(),dispatched};
    }
    const clientResult=client.expect('result');
    clientResult.catch(()=>{});
    if(fault.startsWith('server-'))await clientResult; // must reject before writing a frame
    if(fault==='idle-client') { /* Exercise the native watchdog with an otherwise valid pinned peer. */ }
    else if(fault==='oversized')client.child.stdin.write('x'.repeat(98305)+'\n');
    else client.send(outgoing);
    const request=await Promise.race([server.expect('request'),clientResult.then(()=>{throw new Error('Premature result');})]); peerFacts=request.facts;
    if(fault==='peer-disconnect'){
      server.child.kill();await clientResult;throw new Error('Disconnected peer must not return a result');
    }
    if(signal?.aborted)throw aborted();
    const result=await grant.accept(request.frame,async (bound,input)=>{
      dispatched++;return execute(bound,input);
    });
    if(signal?.aborted)throw aborted();
    server.send(result);
    const received=await clientResult;
    const exits=await Promise.all([server.exit,client.exit]);
    if(exits.some(v=>v.code!==0))throw new Error('IPC endpoint did not exit successfully');
    return {outcome:received.outcome,dispatched,server:ready.facts,client:peerFacts,
      protectedDacl:ready.protectedDacl,dacl:ready.dacl,rejectRemote:ready.rejectRemote,firstInstance:ready.firstInstance,
      endpointExitCodes:exits.map(v=>v.code)};
  };
  let onAbort;
  const abort=new Promise((_,reject)=>{
    onAbort=()=>reject(aborted());
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
  });
  try {return await Promise.race([operation(),abort]);}
  finally {signal?.removeEventListener('abort',onAbort);await server.close();if(client)await client.close();}
}

export async function probeRawRunPipe({exe,identity,sessionId,lease,fault}) {
  const grant=createRestrictedRunIpcGrant({instanceId:'raw-wire-qa',lease});
  const frame=grant.frame('Synthetic input');
  const server=endpoint(exe,'server');let socket;
  const pipeName='ragent-run-candidate-'+randomBytes(16).toString('hex');
  try {
    const {stdout}=await promisify(execFile)(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`],
      {windowsHide:true,timeout:10000});
    server.send({pipeName,expiresAtUnixMs:Date.now()+10000,binding:{...grant.binding,capability:frame.capability},
      localSid:identity.sid,localSessionId:sessionId,peerSid:identity.sid,peerSessionId:sessionId});
    await server.expect('identity');await server.expect('ready');
    server.send({pid:process.pid,createdTicks:stdout.trim(),sid:identity.sid,sessionId});
    socket=net.connect('\\\\.\\pipe\\'+pipeName);
    socket.on('error',()=>{});
    await new Promise((done,reject)=>{socket.once('connect',done);socket.once('error',reject);});
    const prefix=Buffer.alloc(4);
    if(fault==='raw-oversized-length'){prefix.writeInt32LE(98305);socket.write(prefix);}
    else if(fault==='raw-invalid-utf8'){prefix.writeInt32LE(1);socket.write(Buffer.concat([prefix,Buffer.from([255])]));}
    else if(fault==='raw-owner-operation'){
      const payload=Buffer.from(JSON.stringify({...frame,operation:'owner.session'}));
      prefix.writeInt32LE(payload.length);socket.write(Buffer.concat([prefix,payload]));
    }else throw new Error('Unknown raw QA case');
    const event=await server.next();
    if(event.kind!=='error')throw new Error('Raw malformed frame was admitted');
    return event;
  }finally{socket?.destroy();await server.close();}
}
