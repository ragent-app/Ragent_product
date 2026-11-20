import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import path from 'node:path';

const source=await readFile(new URL('../desktop/main.cjs',import.meta.url),'utf8');
async function probe(status,location){
  let received;
  const http={get(url,options,callback){received={url,options};const req=new EventEmitter();req.destroy=()=>{};
    queueMicrotask(()=>callback({statusCode:status,headers:{location},resume(){}}));return req;}};
  const electron={app:{requestSingleInstanceLock:()=>true,on(){},whenReady:()=>({then(){}})},BrowserWindow(){},ipcMain:{},nativeImage:{},shell:{}};
  const sandbox={require:name=>name==='electron'?electron:name==='node:http'?http:name==='node:path'?path:undefined,
    Buffer,URL,process:{platform:'win32',argv:[],env:{}},setInterval,clearInterval,module:{exports:{}},console};
  runInNewContext(source+'\nmodule.exports=serviceIsReady;',sandbox);
  const result=await sandbox.module.exports();assert.equal(received.options.headers.Accept,'*/*');return result;
}
assert.equal(await probe(200),true);
assert.equal(await probe(302,'/login'),true);
assert.equal(await probe(302,'https://example.com/'),false);
assert.equal(await probe(500),false);
console.log('desktop service probe: cookie-free requests, expected redirect, and error handling passed');
