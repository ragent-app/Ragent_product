import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32' || process.env.RAGENT_RUN_CODEX_LOCAL_GATE !== '1') {
  console.log('codex-managed-install-live: skipped (opt-in Windows integration test)'); process.exit(0);
}
if (!process.env.RAGENT_TEST_CODEX_BINARY || !path.isAbsolute(process.env.RAGENT_TEST_CODEX_BINARY)) throw new Error('absolute test Codex binary path required');
const home = await mkdtemp(path.join(tmpdir(), 'ragent-codex-mcp-discovery-'));
process.env.RAGENT_INSTANCE_ROOT=path.join(home,'instance');process.env.RAGENT_CONFIG_DIR=path.join(home,'instance','config');process.env.RAGENT_WORK_ROOT_DIR=path.join(home,'instance','workspace');process.env.RAGENT_MEMORY_DIR=path.join(home,'instance','memory');process.env.RAGENT_PROVIDER_HOMES_DIR=path.join(home,'instance','provider-homes');process.env.RAGENT_RUN_SPOOL_DIR=path.join(home,'instance','data','chat-runs');
const { createRun }=await import('../chat/runs.mjs');
const { trackCodexAppServerApprovalRequest }=await import('../chat/runner-sidecar.mjs');
const run=await createRun({status:{sessionId:'fixture-session',requestId:'fixture-request',state:'accepted',tool:'codex'},manifest:{sessionId:'fixture-session',requestId:'fixture-request',folder:home,tool:'codex',runtimeFamily:'codex-app-server-json',prompt:'fixture',options:{}}});
const server = createServer((req, res) => {
  let data = ''; req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(data);
    if (req.url === '/api/internal/approved-actions/propose') {
      if(req.headers['x-ragent-approved-action-token']!=='fixture-token'||payload.requestKey!=='fixture-key'||payload.actions?.[0]?.command!=='winget install Vendor.App'){process.stderr.write('mock control binding mismatch\n');process.exitCode=1;res.writeHead(400).end();return;}
      res.writeHead(202, { 'content-type':'application/json' }).end(JSON.stringify({kind:'automatic_install',status:'succeeded',requestId:'fixture-install'})); return;
    }
    const tools = payload.tools || [];
    if (!tools.some(t => t.name === 'mcp__ragent_actions' && t.tools?.some(x => x.name === 'ragent_request_actions'))) { process.stderr.write('MCP missing\n'); process.exitCode=1; res.writeHead(400).end(); child.kill(); server.close(); return; }
    const args = JSON.stringify({ requestKey:'fixture-key', actions:[{command:'winget install Vendor.App'}] });
    const call = { id:'fc_fixture',type:'function_call',namespace:'mcp__ragent_actions',name:'ragent_request_actions',call_id:'call_fixture',arguments:args,status:'completed' };
    const response = {id:'resp_fixture',object:'response',created_at:1,status:'completed',model:'gpt-5.4',output:[call],usage:{input_tokens:0,output_tokens:0,total_tokens:0}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...call,arguments:'',status:'in_progress'}},{type:'response.function_call_arguments.delta',item_id:call.id,output_index:0,delta:args},{type:'response.function_call_arguments.done',item_id:call.id,output_index:0,arguments:args},{type:'response.output_item.done',output_index:0,item:call},{type:'response.completed',response}]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const script = fileURLToPath(new URL('../scripts/ragent-approved-actions-mcp.mjs', import.meta.url));
const vars = { RAGENT_APPROVED_ACTIONS_ENABLED:'1', RAGENT_APPROVED_ACTIONS_ENDPOINT:`http://127.0.0.1:${port}/api/internal/approved-actions/propose`, RAGENT_APPROVED_ACTIONS_TOKEN:'fixture-token', RAGENT_APPROVED_ACTIONS_SESSION_ID:'fixture-session', RAGENT_APPROVED_ACTIONS_RUN_ID:'fixture-run', RAGENT_APPROVED_ACTIONS_TURN_ID:'fixture-turn' };
const env = Object.entries(vars).map(([k,v]) => `${k} = ${JSON.stringify(v)}`).join(', ');
await writeFile(path.join(home,'config.toml'), `model_provider = "ragent_fixture"\nmodel = "gpt-5.4"\n[model_providers.ragent_fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "RAGENT_QA_PROVIDER_KEY"\n[mcp_servers.ragent_actions]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\nenv = { ${env} }\n`);
const childEnv = { ...process.env, CODEX_HOME:home, XDG_CACHE_HOME:home, XDG_CONFIG_HOME:home, RAGENT_QA_PROVIDER_KEY:'fixture', HTTP_PROXY:'http://127.0.0.1:9', HTTPS_PROXY:'http://127.0.0.1:9', ALL_PROXY:'http://127.0.0.1:9', NO_PROXY:'127.0.0.1,localhost', http_proxy:'http://127.0.0.1:9', https_proxy:'http://127.0.0.1:9', all_proxy:'http://127.0.0.1:9', no_proxy:'127.0.0.1,localhost' }; delete childEnv.OPENAI_API_KEY;
const child = spawn(process.env.RAGENT_TEST_CODEX_BINARY, ['app-server','--disable','plugins','--disable','remote_plugin','--disable','plugin_sharing','--listen','stdio://'], { cwd:home, env:childEnv, stdio:['pipe','pipe','pipe'], windowsHide:true });
child.stderr.resume(); let stage=0;
const timer=setTimeout(()=>{ process.stderr.write('timeout\n'); process.exitCode=1; child.kill(); server.close(); },30000);
createInterface({input:child.stdout}).on('line',async line=>{
 let msg;try{msg=JSON.parse(line);}catch{return;}
 if(stage===0&&msg.id===1){stage=1;child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');child.stdin.write(JSON.stringify({id:2,method:'thread/start',params:{cwd:home,model:'gpt-5.4',modelProvider:'ragent_fixture',approvalPolicy:'untrusted',approvalsReviewer:'user',sandbox:'danger-full-access',config:{allow_login_shell:false}}})+'\n');}
 else if(stage===1&&msg.id===2){if(msg.error){process.stderr.write('thread error\n');process.exitCode=1;child.kill();server.close();return;}stage=2;child.stdin.write(JSON.stringify({id:3,method:'turn/start',params:{threadId:msg.result.thread.id,cwd:home,input:[{type:'text',text:'Fixture',text_elements:[]}],approvalPolicy:'untrusted',approvalsReviewer:'user',sandboxPolicy:{type:'dangerFullAccess'}}})+'\n');}
 else if(stage===2 && msg.method==='mcpServer/elicitation/request'){
   const sent=[];const proc={stdin:{writable:true,write(value){sent.push(JSON.parse(value));return true;}}};
   const state={riskMode:'recommended',cwd:home,riskContextValid:true,riskContext:{trustedWorkspaceRoot:home},threadId:msg.params.threadId,turnId:msg.params.turnId,pendingApprovals:new Map(),activeItems:new Map(),autoApprovedMcpRequestIds:new Set(),startedTurn:true,mcpRequired:true,mcpAutoApproveServerNames:new Set(['ragent_actions'])};
   await trackCodexAppServerApprovalRequest(run.id,state,msg,proc);
   if(sent[0]?.result?.action!=='accept'){process.stderr.write('managed tool not auto-approved\n');process.exitCode=1;child.kill();server.close();return;}
   child.stdin.write(JSON.stringify(sent[0])+'\n');
 }
 else if(stage===2 && msg.method==='item/completed' && msg.params?.item?.type==='mcpToolCall'){
   stage=3;let result;try{result=JSON.parse(msg.params.item.result?.content?.[0]?.text||'');}catch{}
   if(msg.params.item.status!=='completed'||result?.kind!=='automatic_install'||result.status!=='succeeded'||result.requestKey!=='fixture-key'){process.stderr.write('managed tool result mismatch\n');process.exitCode=1;}
   else process.stdout.write('codex-managed-install-live: mock installation completed\n');child.kill();server.close();
 }
});
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  clearTimeout(timer);
  server.close();
  await rm(home, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
}
child.on('exit',()=>{if(stage!==3&&!process.exitCode)process.exitCode=1;void cleanup().catch(error=>{process.stderr.write(`fixture cleanup failed: ${error.message}\n`);process.exitCode=1;});});
child.on('error',()=>{process.exitCode=1;void cleanup().catch(error=>{process.stderr.write(`fixture cleanup failed: ${error.message}\n`);});});
child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'ragent-qa',version:'0.0.1'},capabilities:{experimentalApi:true}}})+'\n');
