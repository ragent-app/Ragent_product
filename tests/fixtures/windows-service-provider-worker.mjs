// Fixed internal Claude worker for the isolated service QA only.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile, lstat, readdir, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
export async function serviceProviderWorker(qaRoot, spec, request, { boundaryOnly = false } = {}) {
  const id = randomBytes(16).toString('hex'), root = join(qaRoot, 'state/executor/restricted-runs', id);
  const report = { pass: false, boundaryOnly, workerCaseId: id, modelInvocations: 0, credentialsRemoved: false, runtimeRemoved: false };
  const key = boundaryOnly ? '' : request.apiKey;
  let server, sourceBinaries = ['node.exe', 'claude.exe', 'RestrictedProviderCandidate.exe'];
  try {
    await mkdir(join(qaRoot,'state/executor/restricted-runs'), { recursive: true });
    await mkdir(root);
    await exec('C:/Windows/System32/icacls.exe', [root, '/inheritance:r', '/grant:r', `*${spec.executorSid}:(OI)(CI)F`], { windowsHide: true, timeout: 10000 });
    for (const name of ['runtime', 'workspace', 'control', 'state', 'evidence', 'other-grant']) await mkdir(join(root, name));
    for (const name of ['workspace', 'state']) await exec('C:/Windows/System32/icacls.exe', [join(root, name), '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true, timeout: 10000 });
    await writeFile(join(root, '.ragent-restricted-run'), 'ragent.restricted.' + id);
    await writeFile(join(root, 'control/secret.txt'), 'SYNTHETIC-SERVICE-WORKER');
    await writeFile(join(root, 'other-grant/secret.txt'), 'SYNTHETIC-OTHER-GRANT');
    await symlink(join(root, 'other-grant'), join(root, 'workspace/escape-junction'), 'junction');
    for (const file of sourceBinaries) await copyFile(join(qaRoot, 'runtime', file), join(root, 'runtime', file));
    let unexpected = 0, counting = false;
    server = net.createServer(socket => { if (counting) unexpected++; socket.end(); });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port;
    await new Promise((done, reject) => { const socket = net.connect(port, '127.0.0.1'); socket.once('error', reject); socket.once('connect', () => { socket.end(); done(); }); });
    counting = true;
    const probe = `import fs from 'node:fs';import net from 'node:net';const root=${JSON.stringify(root)},qa=${JSON.stringify(qaRoot)},checks={};
fs.writeFileSync(root+'/workspace/boundary.txt','ok');checks.workspaceWrite=true;
for(const [name,path] of [['controlReadDenied',root+'/control/secret.txt'],['otherGrantDenied',root+'/other-grant/secret.txt'],['junctionDenied',root+'/workspace/escape-junction/secret.txt'],['serviceControlDenied',qa+'/control/secret.txt'],['serviceStateDenied',qa+'/state/control/private-state.txt']]){try{fs.readFileSync(path);checks[name]=false}catch(e){checks[name]=['EACCES','EPERM'].includes(e.code)}}
try{const fd=fs.openSync(root+'/runtime/node.exe','r+');fs.closeSync(fd);checks.runtimeWriteDenied=false}catch(e){checks.runtimeWriteDenied=['EACCES','EPERM'].includes(e.code)}
checks.noCredentialEnvironment=!Object.keys(process.env).some(k=>/API_KEY|TOKEN|SECRET|OAUTH|RAGENT_CONFIG/.test(k));
await new Promise(done=>{const socket=net.connect(${port},'127.0.0.1');const timer=setTimeout(()=>{checks.loopbackDenied=true;socket.destroy();done()},1800);socket.once('connect',()=>{clearTimeout(timer);checks.loopbackDenied=false;socket.destroy();done()});socket.once('error',e=>{clearTimeout(timer);checks.loopbackDenied=['EPERM','EACCES','ETIMEDOUT'].includes(e.code);done()})});
console.log(JSON.stringify({pass:Object.values(checks).every(Boolean),checks}));process.exitCode=Object.values(checks).every(Boolean)?0:1;`;
    const csv = boundaryOnly ? 'name,amount\nalpha,17\nbeta,11\nalpha,25\n' : request.inputCSV;
    const prompt = boundaryOnly ? 'Boundary preflight only' : request.frame.payload.text;
    const provider = boundaryOnly ? { model: 'qa-boundary', baseUrl: 'https://example.com/' } : { model: request.provider.model, baseUrl: request.provider.baseUrl };
    const snapshot = JSON.stringify(boundaryOnly ? { boundaryOnly: true } : request.provider);
    const config = JSON.stringify(provider);
    await writeFile(join(root, 'runtime/probe.mjs'), probe);
    await writeFile(join(root, 'runtime/provider.json'), config);
    await writeFile(join(root, 'workspace/input.csv'), csv);
    await writeFile(join(root, 'control/prompt.txt'), prompt);
    await writeFile(join(root, 'control/provider-binding.json'), snapshot);
    const launch = { version: 1, caseId: id, harness: 'claude',
      runId: boundaryOnly ? 'run_' + randomBytes(16).toString('hex') : request.policy.runId,
      grantId: boundaryOnly ? 'rtg_' + randomBytes(24).toString('base64url') : request.policy.grantId,
      requestId: boundaryOnly ? 'service-preflight-' + id : request.policy.requestId,
      authorityHash: boundaryOnly ? hash(id) : request.policy.authorityHash,
      expiresAtUnixMs: boundaryOnly ? Date.now() + 20000 : request.policy.expiresAtUnixMs,
      configSha256: hash(config), inputSha256: hash(csv), promptSha256: hash(prompt), probeSha256: hash(probe), providerSnapshotHash: hash(snapshot) };
    await writeFile(join(root, 'control/launch.json'), JSON.stringify(launch));
    if (!boundaryOnly) {
      assert.equal(typeof key, 'string'); assert.ok(key.length > 0 && !key.includes('\0'));
      assert.equal(hash(snapshot), request.providerSnapshotHash);
      await writeFile(join(root, 'control/credential.json'), JSON.stringify({ apiKey: key }), { flag: 'wx' });
    }
    const windows = 'C:/Windows';
    let nativeOutput='';
    try {
      ({stdout:nativeOutput}=await exec(join(root, 'runtime/RestrictedProviderCandidate.exe'), [boundaryOnly ? '--service-boundary' : '--service-run', root, 'ragent.restricted.' + id],
        { windowsHide: true, timeout: 105000, maxBuffer: 65536, env: { SystemRoot: windows, WINDIR: windows, PATH: windows + '/System32',
          ProgramData: 'C:/ProgramData', USERPROFILE: join(root,'state'), LOCALAPPDATA: join(root,'state'), APPDATA: join(root,'state'),
          HOME: join(root,'state'), TEMP: join(root,'state'), TMP: join(root,'state') } }));
    } catch (error) { report.nativeExit = typeof error.code === 'number' ? error.code : -1;nativeOutput=String(error.stdout||''); }
    const nativeRaw=await readFile(join(root,'evidence/native-report.json'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;report.nativeReportMissing=true;return nativeOutput;});
    const native = JSON.parse(nativeRaw.split(key||'\0NO_KEY').join('[REDACTED]').trim());
    report.native = native;
    if(!native.pass){report.nativeFailure={type:native.errorType||'',message:native.error||''};throw new Error('NATIVE_WORKER_PREFLIGHT_FAILED');}
    assert.equal(native.hostToken.sessionId, 0); assert.equal(native.hostToken.userSidHash, hash(spec.executorSid));
    assert.equal(native.hostToken.isElevated, false);
    assert.equal(native.providerSnapshotHash, launch.providerSnapshotHash);
    const boundary = JSON.parse(await readFile(join(root, 'evidence/boundary.stdout'), 'utf8'));
    report.boundary = boundary; assert.equal(boundary.pass, true); assert.equal(unexpected, 0);
    report.loopbackPositive = true; report.unexpectedLoopbackConnections = unexpected;
    report.modelInvocations = native.cases.filter(item => item.label === 'claude' && item.pid > 0).length;
    report.stopped = native.profileDeleted === true && native.cases.every(item => item.remainingOwnedProcesses === 0);
    if (boundaryOnly) { assert.equal(native.boundaryOnly, true); assert.equal(report.modelInvocations, 0); }
    else {
      const outputPath = join(root, 'workspace/output.json'), facts = await lstat(outputPath);
      assert.ok(facts.isFile() && !facts.isSymbolicLink() && facts.nlink === 1 && facts.size <= 262144);
      report.output = JSON.parse(await readFile(outputPath, 'utf8'));
      assert.equal(hash(await readFile(join(root, 'workspace/input.csv'))), launch.inputSha256);
      const frames = (await readFile(join(root, 'evidence/claude.stdout'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
      report.turnCompleted = frames.some(frame => frame?.type === 'result' && frame.subtype === 'success' && !frame.is_error);
      report.toolNames = frames.flatMap(frame => frame?.message?.content || []).filter(item => item.type === 'tool_use').map(item => item.name);
      assert.equal(report.turnCompleted, true); assert.equal(report.modelInvocations, 1);
      assert.ok(report.toolNames.includes('Read')&&report.toolNames.includes('Write'));
      const expected = {}; for (const row of csv.trim().split(/\r?\n/).slice(1)) { const [name, amount] = row.split(','); expected[name] = (expected[name] || 0) + Number(amount); }
      assert.deepEqual(report.output, expected); report.inputUnchanged = true;
    }
    assert.equal(native.pass, true); assert.equal(report.stopped, true); report.pass = true;
  } catch (error) { report.error = error.code || error.name; }
  finally {
    if (server) await new Promise(done => server.close(done));
    try {
      await unlink(join(root, 'control/credential.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      report.credentialsRemoved = true;
      for (const file of sourceBinaries) await unlink(join(root, 'runtime', file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      report.runtimeRemoved = true;
      let redacted = 0, checked = 0, reparseSkipped = 0;
      async function scan(dir) {
        for (const name of await readdir(dir)) {
          const path = join(dir, name), facts = await lstat(path);
          if (facts.isSymbolicLink()) { reparseSkipped++; continue; }
          if (facts.isDirectory()) await scan(path);
          else {
            assert.ok(facts.isFile() && facts.nlink === 1 && facts.size <= 2097152);
            const bytes = await readFile(path); checked++;
            if (key && bytes.includes(Buffer.from(key))) { const value = bytes.toString('utf8'); redacted += value.split(key).length - 1; await writeFile(path, value.split(key).join('[REDACTED]')); assert.ok(!(await readFile(path)).includes(Buffer.from(key))); }
          }
        }
      }
      await scan(root); report.retainedSecretScan = { files: checked, redacted, reparseSkipped, remainingMatches: 0 };
    } catch (error) { report.cleanupError = error.code || error.name; report.pass = false; }
  }
  return report;
}
