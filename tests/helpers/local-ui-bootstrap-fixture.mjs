import {createServer,request} from 'node:http';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createLocalUiBootstrap,createLocalUiBootstrapClaimStore} from '../../lib/local-ui-bootstrap.mjs';
export async function bootstrapFixture(t,options={}){
  const root=await mkdtemp(join(await realpath(tmpdir()),'ragent-ui-bootstrap-')),instanceId=randomUUID();
  let component,issued=0,revoked=0;
  const sessions=new Set(),observed=[];
  const server=createServer(async(req,res)=>{
    observed.push({url:req.url,referer:req.headers.referer||''});
    if(await component.handle(req,res))return;
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<title>Owner</title><p>Owner page</p>');return;}
    res.writeHead(404);res.end();
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port,origin='http://127.0.0.1:'+port;
  const store=createLocalUiBootstrapClaimStore({directory:root});
  component=createLocalUiBootstrap({instanceId,origin,claimStore:store,
    issueOwnerSession:async data=>{issued++;const token=randomBytes(32).toString('hex');sessions.add(token);return token;},
    revokeOwnerSession:async token=>{revoked++;sessions.delete(token);},
    setCookie:token=>'session_token='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=300',...options});
  t.after(async()=>{component.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
  function issue(){return component.issue({launchNonce:randomBytes(32).toString('hex'),expiresAtUnixMs:Date.now()+30000});}
  function payload(value){return Object.fromEntries(new URLSearchParams(new URL(value.url).hash.slice(1)));}
  function send(value,{headers={},method='POST',path='/api/auth/local-bootstrap',raw,bodyText}={}){
    const bytes=bodyText??JSON.stringify(payload(value));
    return new Promise((done,reject)=>{
      const req=request({host:'127.0.0.1',port,path,method,headers:raw||{Host:'127.0.0.1:'+port,Origin:origin,'Content-Type':'application/json',...headers}},res=>{
        let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>done({status:res.statusCode,headers:res.headers,text}));
      });req.on('error',reject);req.end(bytes);
    });
  }
  return {root,instanceId,origin,port,component,issue,payload,send,observed,sessions,issued:()=>issued,revoked:()=>revoked,store};
}
