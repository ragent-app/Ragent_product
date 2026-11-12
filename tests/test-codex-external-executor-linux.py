import hashlib, http.server, json, os, pathlib, queue, secrets, shutil, socket, subprocess, sys, tempfile, threading, time

if sys.platform != 'linux' or os.environ.get('AGENTOC_TEST_CODEX_EXTERNAL_EXECUTOR') != '1':
    print('test-codex-external-executor-linux: skipped (opt-in Linux integration test)')
    sys.exit(0)
codex = os.environ.get('AGENTOC_TEST_CODEX_BINARY', '')
if not os.path.isabs(codex) or not os.path.isfile(codex):
    raise RuntimeError('AGENTOC_TEST_CODEX_BINARY must be an absolute Codex executable')
root = pathlib.Path(tempfile.mkdtemp(prefix='ragent-codex-exec-'))
home = root / 'app-home'; home.mkdir(exist_ok=True)
workspace = root / 'workspace'; workspace.mkdir(exist_ok=True)
protected = workspace / 'protected.txt'; protected.write_text('original', encoding='utf-8')
event_queue = queue.Queue()

class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['content-length'])))
        shell = next((x for x in request.get('tools', []) if x.get('name') in ('shell_command', 'exec_command')), None)
        props = (shell or {}).get('parameters', {}).get('properties', {})
        field = 'cmd' if 'cmd' in props else 'command' if 'command' in props else None
        completed = 'function_call_output' in json.dumps(request.get('input'))
        command = f"printf compromised > '{protected}' 2>/dev/null || printf SANDBOX_WRITE_BLOCKED"
        if not completed and field:
            item = {'id':'fixture-call','type':'function_call','name':shell['name'],'call_id':'fixture-call','arguments':json.dumps({field:command}),'status':'completed'}
        else:
            item = {'id':'fixture-answer','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'done','annotations':[]}]}
        response = {'id':'fixture-response','object':'response','created_at':1,'status':'completed','model':'gpt-5.4','output':[item],'usage':{'input_tokens':0,'output_tokens':0,'total_tokens':0}}
        events = [{'type':'response.created','response':{**response,'status':'in_progress','output':[]}},{'type':'response.output_item.added','output_index':0,'item':item},{'type':'response.output_item.done','output_index':0,'item':item},{'type':'response.completed','response':response}]
        data = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)

fixture = http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=fixture.serve_forever,daemon=True).start()
mcp = root/'mcp-probe.py'
mcp.write_text('''import json,sys\nblocked=False\ntry:\n open('''+repr(str(protected))+''','w').write('compromised')\nexcept OSError:\n blocked=True\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if m.get('method')=='initialize' else {'tools':[{'name':'write_blocked' if blocked else 'write_succeeded','description':'fixture','inputSchema':{'type':'object'}}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)\n''',encoding='utf-8')
(home/'config.toml').write_text(f'model_provider = "fixture"\nmodel = "gpt-5.4"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:{fixture.server_port}/v1"\nwire_api = "responses"\nenv_key = "FIXTURE_KEY"\n[mcp_servers.fixture]\ncommand = "/usr/bin/python3"\nargs = [{json.dumps(str(mcp))}]\n',encoding='utf-8')
env={**os.environ,'CODEX_HOME':str(home),'HOME':str(home),'TMPDIR':str(root),'TMP':str(root),'TEMP':str(root),'FIXTURE_KEY':'fixture','NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost'}
for key in ('OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN'): env.pop(key,None)
s=socket.socket(); s.bind(('127.0.0.1',0)); port=s.getsockname()[1]; s.close()
token=secrets.token_hex(32); digest=hashlib.sha256(token.encode()).hexdigest()
args=['/usr/bin/bwrap','--ro-bind','/','/','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--unshare-pid','--unshare-ipc','--unshare-uts','--ro-bind',str(workspace),str(workspace),'--dir','/tmp/home','--setenv','HOME','/tmp/home','--setenv','CODEX_HOME','/tmp/home','--setenv','TMPDIR','/tmp','--',codex,'exec-server','--listen',f'ws://127.0.0.1:{port}','--ws-auth','capability-token','--ws-token-sha256',digest]
executor=subprocess.Popen(args,cwd=str(workspace),env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
app=subprocess.Popen([codex,'app-server'],cwd=str(workspace),env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
threading.Thread(target=lambda:[event_queue.put(json.loads(line)) for line in app.stdout],daemon=True).start()
request_id=0; deferred=[]
def request(method,params):
    global request_id
    request_id+=1; rid=request_id
    app.stdin.write(json.dumps({'id':rid,'method':method,'params':params})+'\n'); app.stdin.flush()
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        item=event_queue.get(timeout=max(.1,deadline-time.monotonic()))
        if item.get('id')==rid:
            if item.get('error'): raise RuntimeError(method+': '+json.dumps(item['error']))
            return item.get('result',{})
        deferred.append(item)
    raise RuntimeError(method+' timeout')
try:
    request('initialize',{'clientInfo':{'name':'ragent-sandbox-probe','version':'1'},'capabilities':{'experimentalApi':True}})
    app.stdin.write('{"method":"initialized"}\n'); app.stdin.flush()
    request('environment/add',{'environmentId':'sandbox','execServerUrl':f'ws://127.0.0.1:{port}','authBearerToken':token,'connectTimeoutMs':3000})
    request('environment/info',{'environmentId':'sandbox'})
    request('environment/add',{'environmentId':'wrong-token','execServerUrl':f'ws://127.0.0.1:{port}','authBearerToken':'invalid-fixture-token','connectTimeoutMs':1000})
    try:
        request('environment/info',{'environmentId':'wrong-token'})
    except RuntimeError:
        unauthorized_rejected=True
    else:
        raise RuntimeError('exec-server accepted an incorrect token')
    mcp_args=['--ro-bind','/','/','--tmpfs','/tmp','--proc','/proc','--dev','/dev','--ro-bind',str(workspace),str(workspace),'--','/usr/bin/python3',str(mcp)]
    thread=request('thread/start',{'cwd':str(workspace),'model':'gpt-5.4','modelProvider':'fixture','approvalPolicy':'never','sandbox':'danger-full-access','config':{'mcp_servers':{'fixture':{'command':'/usr/bin/bwrap','args':mcp_args}}},'environments':[{'environmentId':'sandbox','cwd':str(workspace)}]})
    mcp_status=request('mcpServerStatus/list',{'limit':100,'threadId':thread['thread']['id'],'serverName':'fixture'})
    mcp_ready=any(entry.get('name')=='fixture' and 'write_blocked' in json.dumps(entry.get('tools',{})) for entry in mcp_status.get('data',[]))
    request('turn/start',{'threadId':thread['thread']['id'],'sandboxPolicy':{'type':'externalSandbox'},'input':[{'type':'text','text':'Run the fixture command','text_elements':[]}]})
    deadline=time.monotonic()+30; output=''; status=None
    while time.monotonic()<deadline:
        event=deferred.pop(0) if deferred else event_queue.get(timeout=max(.1,deadline-time.monotonic()))
        if event.get('method')=='item/completed' and event.get('params',{}).get('item',{}).get('type')=='commandExecution': output+=event['params']['item'].get('aggregatedOutput','')
        if event.get('method')=='turn/completed': status=event['params']['turn']['status']; break
    preserved=protected.read_text(encoding='utf-8')=='original'
    print(json.dumps({'environmentConnected':True,'unauthorizedRejected':unauthorized_rejected,'mcpDiscovered':mcp_ready,'status':status,'writeBlocked':'SANDBOX_WRITE_BLOCKED' in output,'workspacePreserved':preserved}),flush=True)
    if status!='completed' or not mcp_ready or 'SANDBOX_WRITE_BLOCKED' not in output or not preserved: raise RuntimeError('sandbox boundary was not established')
finally:
    app.terminate(); executor.terminate()
    for process in (app,executor):
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    fixture.shutdown()
    shutil.rmtree(root)
