import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'ragent-internal-harness-'));
const external = join(root, 'external'); const managed = join(root, 'managed'); const bundled = join(root, 'bundled');
await Promise.all([mkdir(external), mkdir(bundled)]);
process.env.RAGENT_CONFIG_DIR = join(root, 'config'); process.env.RAGENT_INSTANCE_ROOT = root;
process.env.RAGENT_HARNESS_ROOT = managed; process.env.RAGENT_PACKAGED_HARNESS_ROOT = bundled;
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1'; process.env.RAGENT_HARNESS_POLICY_URL = 'http://invalid.test';
process.env.PATH = external + delimiter + process.env.PATH;
const win = process.platform === 'win32'; const marker = join(root, 'external-was-executed');
async function cli(dir, name, body) {
 await mkdir(dir, {recursive:true}); const script = join(dir,name+'.mjs');
 await writeFile(script, body);
 const command = join(dir,name+(win?'.cmd':''));
 await writeFile(command, win ? '@echo off\r\n"'+process.execPath+'" "'+script+'" %*\r\n' : '#!/bin/sh\nexec "'+process.execPath+'" "'+script+'" "$@"\n');
 await chmod(command,0o700); return command;
}
const commands=['codex','claude','agy','pi','dsh','qwen','opencode','kimi','goose','agent-canvas','copilot','hermes-acp','cline','kilo'];
for (const c of commands) await cli(external,c, 'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(marker)+',"wrong");console.log("9.9.9");');
const {resolveExecutableCommandPathAsync}=await import('../lib/executable-resolution.mjs');
const {resolveExecutableCommandPathAsync: shellResolve}=await import('../lib/user-shell-env.mjs');
const registry=await import('../lib/harness-registry.mjs');
for(const c of commands){assert.equal(await resolveExecutableCommandPathAsync(c),null);assert.equal(await shellResolve(c),null);}
assert.ok((await registry.listHarnesses()).every(h=>!h.installed && h.installationSource===null),'external-only commands cannot appear installed');
const { createToolInvocation } = await import('../chat/process-runner.mjs');
await assert.rejects(createToolInvocation('qwen-code', 'fixture', { toolCommand: join(external,'qwen'+(win?'.cmd':'')), runtimeFamily: 'qwen-code-acp' }),
  (error) => error.code === 'HARNESS_RUNTIME_UNAVAILABLE', 'a Run manifest cannot substitute an external executable for a missing internal Harness');
const ownedCodex=await cli(bundled,'codex','console.log("codex-cli 0.153.4");');
let codex=await registry.getHarnessDefinition('codex');assert.equal(codex.path,ownedCodex);assert.equal(codex.installationSource,'bundled');
assert.equal(await resolveExecutableCommandPathAsync(join(external,'codex.cmd')),ownedCodex,'a legacy external absolute path cannot select the external CLI');
const qwenLauncher = win ? '@echo off\r\necho Qwen Code 0.22.2\r\n' : '#!/bin/sh\nprintf "Qwen Code 0.22.2\\n"\n';
const npm = await cli(external, 'npm', [
 'import fs from "node:fs";import path from "node:path";',
 'const root=process.argv[process.argv.indexOf("--prefix")+1];',
 'const bin=path.join(root,"node_modules/.bin");fs.mkdirSync(bin,{recursive:true});',
 'const file=path.join(bin,'+JSON.stringify('qwen'+(win?'.cmd':''))+');',
 'fs.writeFileSync(file,'+JSON.stringify(qwenLauncher)+');fs.chmodSync(file,0o700);',
].join('\n'));
process.env.RAGENT_NPM_COMMAND=npm;
await registry.upgradeHarness('qwen-code','0.22.2');const qwen=await registry.getHarnessDefinition('qwen-code');
assert.equal(qwen.installationSource,'managed');assert.equal(qwen.detectedVersion,'0.22.2');assert.ok(qwen.path.startsWith(managed));
await registry.uninstallHarness('qwen-code');assert.equal(await resolveExecutableCommandPathAsync('qwen'),null);await access(join(external,'qwen'+(win?'.cmd':'')));
const goose=await cli(join(managed,'goose','bin'),'goose','console.log("goose 1.47.0");');
assert.equal((await registry.getHarnessDefinition('goose')).path,goose);await registry.uninstallHarness('goose');await assert.rejects(access(goose));await access(join(external,'goose'+(win?'.cmd':'')));
const {buildInternalHarnessInstallerEnvironment}=await import('../lib/harness-paths.mjs');
for(const id of ['agy','goose','hermes']){const env=buildInternalHarnessInstallerEnvironment(id,'1.0.0');for(const field of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','HERMES_HOME','GOOSE_BIN_DIR'])assert.ok(!relative(managed,env[field]).startsWith('..'));}
await assert.rejects(access(marker),{code:'ENOENT'},'no external Harness was executed');
console.log('PASS: 14 external Harness commands ignored; internal/bundled selection, managed install, scoped uninstall, script installer roots');
