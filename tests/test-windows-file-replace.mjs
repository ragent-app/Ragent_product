import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm,realpath,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {renameWithWindowsRetry} from '../lib/windows-file-replace.mjs';
import {rmWithWindowsRetry,writeJsonAtomic,writeTextAtomic} from '../chat/fs-utils.mjs';

test('Windows sharing failures retry bounded rename; other platforms/errors fail immediately',async()=>{
  for(const code of ['EPERM','EBUSY']){let calls=0;const waits=[];
    await renameWithWindowsRetry('source','target',{platform:'win32',jitterImpl:()=>0,renameImpl:async()=>{if(++calls<3)throw Object.assign(new Error(code),{code});},waitImpl:async ms=>{waits.push(ms);}});
    assert.equal(calls,3);assert.deepEqual(waits,[50,100]);}
  for(const [platform,code] of [['linux','EPERM'],['darwin','EPERM'],['win32','EACCES'],['win32','ENOENT']]){
    const error=Object.assign(new Error(code),{code});let calls=0;
    await assert.rejects(renameWithWindowsRetry('a','b',{platform,renameImpl:async()=>{calls++;throw error;},waitImpl:()=>assert.fail()}),value=>value===error);assert.equal(calls,1);}
});
test('persistent denial keeps original error; cancellation stops the backoff',async()=>{
  const error=Object.assign(new Error('locked'),{code:'EPERM'});let calls=0,waits=[];
  await assert.rejects(renameWithWindowsRetry('a','b',{platform:'win32',jitterImpl:()=>0,renameImpl:async()=>{calls++;throw error;},waitImpl:async ms=>{waits.push(ms);}}),value=>value===error);
  assert.equal(calls,6);assert.equal(waits.reduce((a,b)=>a+b,0),1550);
  const abort=new AbortController();calls=0;
  await assert.rejects(renameWithWindowsRetry('a','b',{platform:'win32',signal:abort.signal,renameImpl:async()=>{calls++;throw error;},waitImpl:async()=>{abort.abort();}}),{code:'ABORT_ERR'});assert.equal(calls,1);
});
async function fixture(t){const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'ragent-file-replace-'));
  t.after(async()=>{const actual=await realpath(root);assert.equal(dirname(actual).toLowerCase(),parent.toLowerCase());await rm(actual,{recursive:true,force:true});});return root;}
async function hold(path){
  const quoted="'"+path.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop';$qaFile=[IO.File]::Open(${quoted},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{$qaFile.Dispose()}`;
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const done=new Promise(resolve=>child.once('close',resolve));child.stdin.on('error',()=>{});child.stderr.resume();const timer=setTimeout(()=>child.kill(),10000);
  try{await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',b=>{output+=b;if(output.includes('READY'))resolve();});child.once('error',reject);child.once('close',()=>reject(new Error('QA file holder ended before ready')));});}
  catch(error){child.kill();await done;clearTimeout(timer);throw error;}
  let released=false;return {async release(){if(released)return;released=true;child.stdin.end('\n');const code=await done;clearTimeout(timer);assert.equal(code,0);}};
}
test('actual Windows handle denies first rename; releasing it allows the bounded retry',{skip:process.platform!=='win32'},async t=>{
  const root=await fixture(t),target=join(root,'state.json'),temp=join(root,'new.json');await writeFile(target,'OLD');await writeFile(temp,'NEW');
  const held=await hold(target);let attempts=0,firstCode;
  try{await renameWithWindowsRetry(temp,target,{renameImpl:async(a,b)=>{attempts++;try{await rename(a,b);}catch(error){firstCode??=error.code;await held.release();throw error;}}});
    assert.ok(['EPERM','EBUSY'].includes(firstCode));assert.ok(attempts>=2);assert.equal(await readFile(target,'utf8'),'NEW');
  }finally{await held.release();}
});
test('actual persistent Windows lock retains old JSON and removes failed durable temp',{skip:process.platform!=='win32'},async t=>{
  const root=await fixture(t),target=join(root,'state.json');await writeFile(target,'{"old":true}');const held=await hold(target);
  try{await assert.rejects(writeJsonAtomic(target,{replacement:true},{durable:true}),error=>['EPERM','EBUSY'].includes(error.code));
    assert.deepEqual(JSON.parse(await readFile(target,'utf8')),{old:true});assert.deepEqual(await readdir(root),['state.json']);
  }finally{await held.release();}
});
test('actual Windows cancelled durable text replacement retains old target and cleans temp',{skip:process.platform!=='win32'},async t=>{
  const root=await fixture(t),target=join(root,'state.txt');await writeFile(target,'OLD');const held=await hold(target),abort=new AbortController();let timer;
  try{timer=setTimeout(()=>abort.abort(),60);await assert.rejects(writeTextAtomic(target,'NEW',{durable:true,signal:abort.signal}),{code:'ABORT_ERR'});
    assert.equal(await readFile(target,'utf8'),'OLD');assert.deepEqual(await readdir(root),['state.txt']);
  }finally{clearTimeout(timer);await held.release();}
});
test('rmWithWindowsRetry retries EBUSY/EPERM on win32 with bounded backoff and fails immediately on other platforms/errors',async()=>{
  for(const code of ['EBUSY','EPERM']){
    let calls=0;const waits=[];
    await rmWithWindowsRetry('C:/fake/session',{platform:'win32',jitterImpl:()=>0,rmImpl:async()=>{if(++calls<3)throw Object.assign(new Error(code),{code});},waitImpl:async ms=>{waits.push(ms);}});
    assert.equal(calls,3);assert.deepEqual(waits,[50,100]);
  }
  const persistent=Object.assign(new Error('still locked'),{code:'EBUSY'});let calls=0;const waits=[];
  await assert.rejects(rmWithWindowsRetry('C:/fake/session',{platform:'win32',jitterImpl:()=>5,rmImpl:async()=>{calls++;throw persistent;},waitImpl:async ms=>{waits.push(ms);}}),value=>value===persistent);
  assert.equal(calls,6);assert.deepEqual(waits,[55,105,205,405,805]);
  for(const [platform,code] of [['linux','EBUSY'],['darwin','EPERM'],['win32','EACCES'],['win32','ENOENT']]){
    const error=Object.assign(new Error(code),{code});let attemptCount=0;
    await assert.rejects(rmWithWindowsRetry('/fake/session',{platform,rmImpl:async()=>{attemptCount++;throw error;},waitImpl:()=>assert.fail()}),value=>value===error);
    assert.equal(attemptCount,1);
  }
});
