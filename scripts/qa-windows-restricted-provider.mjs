// Candidate QA only: no product Run gate or production service integration.
// Uses an existing static-key internal Harness profile without registry changes.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile, copyFile, lstat, realpath, unlink, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { createNativeProviderRegistry } from '../lib/provider-runtime/registry.mjs';
import { createSecretStore } from '../lib/provider-runtime/secret-store.mjs';

export async function runRestrictedProviderCandidate({harness='codex',cancelBoundary=false,runInput=null,signal,quiet=false}={}) {
if (process.platform !== 'win32') throw new Error('Windows candidate QA requires Windows');
await assertOrdinaryWindowsExecutionIdentity();
const exec = promisify(execFile), source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = randomBytes(16).toString('hex'), profile = `ragent.restricted.${id}`;
const localAppData = runInput?.hostLocalAppData || process.env.LOCALAPPDATA;
const root = join(localAppData, 'Ragent', 'restricted-runs', id);
const evidence = join(source, 'artifacts/showcase/T2-current-20261017/restricted-provider');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const windows = process.env.SystemRoot || 'C:/Windows';
const binaries = {
  'node.exe': 'C:/Program Files/Ragent/payload/node.exe',
  [harness + '.exe']: harness === 'claude' ? 'C:/ProgramData/Ragent/harnesses/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe' : 'C:/ProgramData/Ragent/harnesses/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
};
const report = { schemaVersion: 1, caseId: id, root, profile, pass: false,
  startedAt: new Date().toISOString(), sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim(),
  productionChanged: false, phoneTouched: false, productGateEnabled: false,
  network: { capabilities: ['internetClient'], endpointRestricted: false, loopbackExemptionAdded: false },
  runId: runInput?.runId || `run_${randomBytes(16).toString('hex')}`, grantId: runInput?.grantId || `rtg_${randomBytes(16).toString('hex')}`,
  requestId: runInput?.requestId || `request_${randomBytes(16).toString('hex')}`, harness, authority: runInput ? 'isolated-message-run' : 'synthetic-local-qa',
  expectedCancellation: cancelBoundary };
let apiKey = '', endpoint = '', copied = [], rootReady = false, tcpServer, unexpectedLoopbackConnections = 0, countLoopback = false;
const redact = value => String(value).split(apiKey || '\0NO_SECRET').join('[REDACTED]')
  .split(endpoint || '\0NO_ENDPOINT').join('[PROVIDER_ENDPOINT]')
  .replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]');
async function noReparse(path) {
  let current = resolve(path);
  for (;;) {
    const facts = await lstat(current);
    if (facts.isSymbolicLink() || (await realpath(current)).toLowerCase() !== current.toLowerCase()) throw new Error('Reparse path rejected');
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
async function save(relative, text) { await writeFile(join(root, relative), text, { flag: 'wx' }); }
try {
  await mkdir(evidence, { recursive: true });
  await mkdir(root, { recursive: true }); await noReparse(root);
  await exec(join(windows, 'System32/icacls.exe'), [root, '/inheritance:r', '/grant:r',
    `*${(await assertOrdinaryWindowsExecutionIdentity()).sid}:(OI)(CI)F`], { windowsHide: true });
  await save('.ragent-restricted-run', profile); rootReady = true;
  for (const name of ['runtime', 'workspace', 'control', 'other-grant', 'evidence', 'state']) await mkdir(join(root, name));
  for (const name of ['workspace', 'state']) await exec(join(windows, 'System32/icacls.exe'),
    [join(root, name), '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true });
  await save('control/secret.txt', `SYNTHETIC-CONTROL-${id}`);
  await save('other-grant/secret.txt', `SYNTHETIC-OTHER-${id}`);
  const values = [...randomBytes(4)].map(n => n + 1);
  const expected = runInput?.expected || { alpha: values[0] + values[2], beta: values[1] + values[3] };
  const input = runInput?.inputCSV || `name,amount\nalpha,${values[0]}\nbeta,${values[1]}\nalpha,${values[2]}\nbeta,${values[3]}\n`;
  report.expected = expected;
  await save('workspace/input.csv', input);
  const prompt = runInput?.prompt || 'Read input.csv in the current workspace. Use a tool to create output.json with the numeric sum of amount grouped by name. Derive the sums from the file. Return a flat JSON object mapping each name to its numeric sum. Then respond with CANDIDATE_DONE. Do not change input.csv. Use only this workspace. Do not inspect environment variables, credentials, or other directories.';
  await save('control/prompt.txt', prompt);
  await symlink(join(root, 'other-grant'), join(root, 'workspace/escape-junction'), 'junction');
  tcpServer = net.createServer(socket => { if (countLoopback) unexpectedLoopbackConnections++; socket.end(); });
  await new Promise((done, reject) => { tcpServer.once('error', reject); tcpServer.listen(0, '127.0.0.1', done); });
  const tcpPort = tcpServer.address().port;
  await new Promise((done, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: tcpPort });
    socket.once('error', reject); socket.once('connect', () => { socket.end(); done(); });
  });
  report.loopbackPositive = true; countLoopback = true;
  // Synthetic checks use the SAME profile/capabilities as the real Harness.
  const probe = `import fs from 'node:fs';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
const root=${JSON.stringify(root)},checks={};
fs.writeFileSync(root+'/workspace/probe-write.txt','ok'); checks.workspaceWrite=true;
for(const [name,path,write] of [['controlReadDenied','control/secret.txt'],['otherGrantReadDenied','other-grant/secret.txt'],['controlWriteDenied','control/no.txt',true],['runtimeWriteDenied','runtime/no.txt',true],['junctionEscapeDenied','workspace/escape-junction/secret.txt']]) {
 try{if(write)fs.writeFileSync(root+'/'+path,'no');else fs.readFileSync(root+'/'+path);checks[name]=false}catch(e){checks[name]=['EPERM','EACCES'].includes(e.code)}
}
checks.noControlEnvironment=!Object.keys(process.env).some(k=>/RAGENT_CONFIG|OWNER|OAUTH|OPENAI_API_KEY|TOKEN|SECRET/.test(k));
await new Promise(done=>{
 const socket=net.createConnection({host:'127.0.0.1',port:${tcpPort}});
 const timer=setTimeout(()=>{checks.loopbackDenied=true;socket.destroy();done()},1800);
 socket.once('connect',()=>{clearTimeout(timer);checks.loopbackDenied=false;socket.destroy();done()});
 socket.once('error',e=>{clearTimeout(timer);checks.loopbackDenied=['EPERM','EACCES','ETIMEDOUT'].includes(e.code);done()});
});
const pathReport=root+'/workspace/path-facts.json';
const out=fs.openSync(pathReport,'w');
const pathProcess=spawnSync(root+'/runtime/RestrictedProviderCandidate.exe',['path-facts',root+'/state'],{stdio:['inherit',out,'inherit'],windowsHide:true});
fs.closeSync(out);
const pathFacts=pathProcess.status===0?JSON.parse(fs.readFileSync(pathReport,'utf8')):{exitCode:pathProcess.status};
${cancelBoundary ? `const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true,detached:true});
await new Promise((done,reject)=>{descendant.once('spawn',done);descendant.once('error',reject)}); descendant.unref();
fs.writeFileSync(root+'/workspace/boundary-ready',JSON.stringify({descendantPid:descendant.pid}));
await new Promise(()=>{setInterval(()=>{},1000)});` : ''}
console.log(JSON.stringify({checks,pathFacts,pass:Object.values(checks).every(Boolean)}));
process.exitCode=Object.values(checks).every(Boolean)?0:1;
`;
  await save('runtime/probe.mjs', probe);
  const sourceFiles = ['native/windows-restricted-provider-candidate.cs', 'scripts/qa-windows-restricted-provider.mjs'];
  report.sourceFiles = await Promise.all(sourceFiles.map(async path => ({ path, sha256: hash(await readFile(join(source, path))) })));
  report.binaries = [];
  for (const [name, path] of Object.entries(binaries)) {
    const dest = join(root, 'runtime', name); await copyFile(path, dest); copied.push(name);
    const digest = hash(await readFile(path));
    if (hash(await readFile(dest)) !== digest) throw new Error('Internal runtime copy mismatch');
    report.binaries.push({ name, source: path, sha256: digest });
  }
  const helper = join(root, 'runtime/RestrictedProviderCandidate.exe');
  const build = await exec(join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${helper}`,
      join(source, 'native/windows-restricted-provider-candidate.cs')], { windowsHide: true });
  copied.push('RestrictedProviderCandidate.exe');
  report.helperSha256 = hash(await readFile(helper));
  report.compilerSha256 = hash(await readFile(join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')));
  report.harnessVersion = JSON.parse(await readFile(harness === 'claude'
    ? 'C:/ProgramData/Ragent/harnesses/claude/node_modules/@anthropic-ai/claude-code/package.json'
    : 'C:/ProgramData/Ragent/harnesses/codex/node_modules/@openai/codex/package.json', 'utf8')).version;
  await save('evidence/build.log', build.stdout + build.stderr);
  const configDir = runInput?.configDir || 'C:/ProgramData/Ragent/instances/owner/config';
  const registry = createNativeProviderRegistry({ configDir });
  const providers = await registry.listProviderProfiles();
  const provider = providers.find(p => p.agentType === harness && (!runInput || p.id === runInput.providerProfileId) && p.enabled !== false && p.status === 'ready' && !p.baseUrl?.startsWith('https://chatgpt.com'));
  if (!provider) throw new Error('Ready internal Codex provider required');
  const auth = await registry.getAuthProfile(provider.authProfileId);
  if (auth?.authType !== 'api-key' || provider.protocol !== (harness === 'claude' ? 'anthropic-messages' : 'openai-responses')) throw new Error('Static Responses provider required; OAuth not copied');
  const url = new URL(provider.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Public credential-free HTTPS endpoint required');
  const addresses = await lookup(url.hostname, { all: true });
  const privateIp = ip => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|f[cd]|fe80:)/i.test(ip);
  if (!addresses.length || addresses.some(a => privateIp(a.address))) throw new Error('Non-public endpoint rejected');
  endpoint = url.href;
  if(runInput && (provider.id !== runInput.providerProfileId || provider.modelPolicy.defaultModel !== runInput.model)) throw new Error('Frozen candidate Provider selection changed');
  report.provider = { profileIdHash: hash(provider.id), authType: 'api-key', protocol: provider.protocol,
    model: provider.modelPolicy.defaultModel, endpointHash: hash(url.href), endpointClass: 'public-https', oauthCopied: false };
  if (!cancelBoundary) {
    const credential = await createSecretStore({ configDir }).resolveSecret(auth.storageRef);
    if (!credential.ok || !credential.apiKey) throw new Error('Static credential unavailable');
    apiKey = credential.apiKey;
    await save('control/credential.json', JSON.stringify({ apiKey }));
  }
  report.credentialsUsed = !cancelBoundary;
  const snapshot = JSON.stringify({model:provider.modelPolicy.defaultModel,baseUrl:url.href});
  await save('runtime/provider.json', snapshot);
  const launch = { version: 1, harness, authorityHash: runInput?.authorityHash || hash(['qa',report.runId,report.grantId].join(':')), caseId: id, runId: report.runId, grantId: report.grantId, requestId: report.requestId,
    expiresAtUnixMs: Math.min(runInput?.expiresAtUnixMs || Infinity, Date.now() + 120000), configSha256: hash(snapshot), inputSha256: hash(input), promptSha256: hash(prompt), probeSha256: hash(probe) };
  await save('control/launch.json', JSON.stringify(launch)); report.authorityHash = launch.authorityHash; report.launchHash = hash(JSON.stringify(launch));
  let abortWrite;
  if(signal){
    abortWrite=()=>{report.stopRequested=true;save('control/cancel','host-cancellation').catch(error=>{if(error.code!=='EEXIST')report.cancelError=error.code||error.name})};
    signal.addEventListener('abort',abortWrite,{once:true});
    if(signal.aborted)await save('control/cancel','host-cancellation').catch(error=>{if(error.code!=='EEXIST')throw error});
  }
  const child = spawn(helper, [root, profile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { SystemRoot: windows, WINDIR: windows, LOCALAPPDATA: localAppData,
      USERPROFILE: runInput?.hostUserProfile || process.env.USERPROFILE, PATH: join(windows, 'System32'), TEMP: process.env.TEMP, TMP: process.env.TMP } });
  let out = '', err = '', timer, cancelPoll;
  if (cancelBoundary) {
    let polling = false;
    cancelPoll = setInterval(async () => {
      if (polling) return; polling = true;
      try {
        const path = join(root, 'workspace/boundary-ready'); await noReparse(path);
        report.deliberateDescendant = JSON.parse(await readFile(path, 'utf8')).descendantPid;
        await save('control/cancel', 'candidate-cancellation');
        clearInterval(cancelPoll);
      } catch (error) { if (error.code !== 'ENOENT') report.cancelError = error.code || error.name; }
      finally { polling = false; }
    }, 100);
  }
  const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
  for (const [stream, add] of [[child.stdout, b => { out = (out + b).slice(-64000); }], [child.stderr, b => { err = (err + b).slice(-16000); }]]) stream.on('data', add);
  try {
    report.nativeExitCode = await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native worker exceeded outer deadline')), 140000);
    })]);
  } finally { clearTimeout(timer); clearInterval(cancelPoll); if(signal&&abortWrite)signal.removeEventListener('abort',abortWrite); if (child.exitCode === null) { child.kill(); await closed; } }
  report.launcherOutput = redact(out); report.launcherError = redact(err);
  report.native = JSON.parse((await readFile(join(root, 'evidence/native-report.json'), 'utf8')).replace(/^\uFEFF/, ''));
  for (const label of ['boundary', harness]) {
    for (const extension of ['stdout', 'stderr']) {
      const path = join(root, `evidence/${label}.${extension}`);
      try {
        const bytes = await readFile(path, 'utf8');
        await writeFile(join(evidence, `${id}-${label}.${extension}`), redact(bytes));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  let output;
  try {
    const path = join(root, 'workspace/output.json'); await noReparse(path);
    const facts = await lstat(path);
    if (!facts.isFile() || facts.nlink !== 1 || facts.size > 256 * 1024) throw new Error('Output file shape rejected');
    output = JSON.parse(await readFile(path, 'utf8'));
  }
  catch { output = null; }
  report.output = output;
  await noReparse(join(root, 'workspace/input.csv'));
  report.inputUnchanged = hash(await readFile(join(root, 'workspace/input.csv'))) === launch.inputSha256;
  const stdout = await readFile(join(root, `evidence/${harness}.stdout`), 'utf8').catch(() => '');
  const frames = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  report.frameTypes = [...new Set(frames.filter(Boolean).map(f => f.type))];
  report.toolTypes = frames.filter(f => f?.type === 'item.completed').map(f => ({ type: f.item?.type, status: f.item?.status, exitCode: f.item?.exit_code }));
  report.turnCompleted = frames.some(f => f?.type === 'turn.completed' || (f?.type === 'result' && !f.is_error && f.subtype === 'success'));
  report.claudeToolNames = frames.flatMap(f=>f?.message?.content||[]).filter(c=>c.type==='tool_use').map(c=>c.name);
  report.outputCorrect = output?.alpha === expected.alpha && output?.beta === expected.beta && Object.keys(output).length === 2;
  report.unexpectedLoopbackConnections = unexpectedLoopbackConnections;
  report.pass = report.nativeExitCode === 0 && report.native.pass && report.turnCompleted && report.outputCorrect && report.inputUnchanged && !unexpectedLoopbackConnections;
  if (cancelBoundary) {
    const boundary = report.native.cases?.[0];
    report.pass = report.nativeExitCode === 1 && report.native.profileDeleted && report.native.cases.length === 1
      && boundary.cancelled && !boundary.timedOut && boundary.remainingOwnedProcesses === 0
      && boundary.descendantTokens.some(token => token.pid === report.deliberateDescendant && token.isAppContainer
        && token.packageSid === report.native.packageSid);
  }
  if (report.pass && !cancelBoundary) {
    const receipt = { version: 1, runId: report.runId, grantId: report.grantId, requestId: report.requestId,
      authorityHash: report.authorityHash, launchHash: report.launchHash, resultSha256: hash(JSON.stringify(output)), result: output, producer: 'candidate-host' };
    await save('control/result-receipt.json', JSON.stringify(receipt));
    report.resultReceipt = receipt;
  }
} catch (error) { report.error = redact(error.message); }
finally {
  if (tcpServer) await new Promise(done => tcpServer.close(done));
  report.removed = [];
  if (rootReady) {
    try {
      await noReparse(root);
      if ((await readFile(join(root, '.ragent-restricted-run'), 'utf8')) !== profile) throw new Error('Cleanup marker mismatch');
      for (const relative of ['control/credential.json', ...copied.map(name => `runtime/${name}`)]) {
        const path = join(root, relative);
        try { await noReparse(path); await unlink(path); report.removed.push(relative); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error) { report.cleanupError = redact(error.message); report.pass = false; }
  }
  report.finishedAt = new Date().toISOString();
  const reportPath = join(evidence, `case-${id}.json`);
  await mkdir(evidence, { recursive: true });
  await writeFile(reportPath, redact(JSON.stringify(report, null, 2)));
  if(!quiet) console.log(JSON.stringify({ pass: report.pass, report: reportPath, error: report.error, outputCorrect: report.outputCorrect, frames: report.frameTypes }));
}
return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.argv.includes('--live')) throw new Error('Candidate QA requires explicit --live');
 const report=await runRestrictedProviderCandidate({harness:process.argv.includes('--claude')?'claude':'codex',cancelBoundary:process.argv.includes('--cancel-during-boundary')});
 if(!report.pass)process.exitCode=1;
}
