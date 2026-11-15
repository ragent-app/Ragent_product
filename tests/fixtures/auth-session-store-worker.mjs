import {createInterface} from 'node:readline';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openAuthSessionStore} from '../../lib/auth-session-store.mjs';
const input=createInterface({input:process.stdin,crlfDelay:Infinity});let store,auth,direct;
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
input.on('line',async line=>{
  try{
    const command=JSON.parse(line),root=resolve(command.root||process.argv[2]);
    if(command.op==='open'){
      if(command.mode==='auth'){
        Object.assign(process.env,{RAGENT_WINDOWS_SERVICE_MODE:'1',RAGENT_INSTANCE_ROOT:root,RAGENT_CONFIG_DIR:join(root,'config'),RAGENT_MEMORY_DIR:join(root,'memory'),RAGENT_WORK_ROOT_DIR:join(root,'workspace'),RAGENT_AUTH_SESSION_SECRET:command.secret,RAGENT_LOCAL_WEB_AUTH:'0'});
        const config=await import('../../lib/config.mjs');if(resolve(config.CONFIG_DIR)!==join(root,'config'))throw new Error('Isolation failed');auth=await import('../../lib/auth.mjs');
      }else store=openAuthSessionStore({legacyFile:join(root,'auth-sessions.json'),databaseFile:join(root,'auth-sessions.sqlite'),secret:command.secret});
      emit({ready:true});return;
    }
    if(command.op==='insert'){store.insert(command.key,command.session);emit({ok:true});}
    if(command.op==='revoke'){emit({removed:store.revoke(command.key)});}
    if(command.op==='refresh'){emit({refreshed:store.refresh(command.key,{force:true,windowMs:1000,expiryMs:60000})});}
    if(command.op==='snapshot')emit({keys:[...store.snapshot().keys()]});
    if(command.op==='hold'){
      direct=new DatabaseSync(join(root,auth?'config/auth-sessions.sqlite':'auth-sessions.sqlite'));direct.exec('BEGIN IMMEDIATE');
      if(command.key)direct.prepare('INSERT INTO sessions VALUES(?,?,?)').run(command.key,command.session.expiry,JSON.stringify(command.session));
      emit({held:true});
    }
    if(command.op==='issue')emit({token:await auth.issueSession({role:'owner',authMethod:'local_bootstrap'})});
    if(command.op==='auth-count')emit({count:auth.sessions.size});
    if(command.op==='validate')emit({allowed:auth.isAuthenticated({url:'/api/proof',headers:{cookie:'session_token='+command.token},socket:{remoteAddress:'127.0.0.1'}})});
    if(command.op==='auth-revoke')emit({removed:auth.revokeSession(command.token)});
    if(command.op==='auth-refresh')emit({refreshed:!!await auth.refreshAuthSession({url:'/api/proof',headers:{cookie:'session_token='+command.token},socket:{remoteAddress:'127.0.0.1'}},{force:true})});
    if(command.op==='stop'){auth?.closeAuthSessionStore();store?.close();direct?.close();emit({stopped:true});input.close();}
  }catch(error){emit({error:/^AUTH_SESSION_/.test(error.code||'')?error.code:'WORKER_FAILURE'});}
});
