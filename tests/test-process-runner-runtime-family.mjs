#!/usr/bin/env node
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'ragent-runtime-family-'));
process.env.RAGENT_INSTANCE_ROOT = fixtureRoot;
process.env.RAGENT_CONFIG_DIR = join(fixtureRoot, 'config');
process.env.RAGENT_HARNESS_ROOT = join(fixtureRoot, 'harnesses');
process.env.RAGENT_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
const fixtureBin = join(process.env.RAGENT_HARNESS_ROOT, 'claude', 'node_modules', '.bin');
mkdirSync(fixtureBin, { recursive: true });
const fixtureCommand = join(fixtureBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
writeFileSync(fixtureCommand, process.platform === 'win32'
  ? '@echo off\r\necho 2.1.310\r\n'
  : '#!/bin/sh\necho 2.1.310\n');
chmodSync(fixtureCommand, 0o700);
process.on('exit', () => rmSync(fixtureRoot, { recursive: true, force: true }));

const {
  buildRuntimeInvocation,
  createToolInvocation,
  guardHarnessAdapter,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'process-runner.mjs')).href);

{
  const guarded = guardHarnessAdapter({
    parseLine() { throw new Error('readline was closed'); },
    flush() { return null; },
  }, 'codex-app-server-json');
  const parseEvents = guarded.parseLine('{}');
  assert.equal(parseEvents.length, 1);
  assert.equal(parseEvents[0].type, 'status');
  assert.equal(parseEvents[0].adapterError, true);
  assert.equal(parseEvents[0].runState, 'failed');
  assert.match(parseEvents[0].content, /readline was closed/);
  const flushEvents = guarded.flush();
  assert.equal(flushEvents[0].adapterError, true);
}

// Keep invocation assertions independent from the runner's inherited default.
const previousServiceTier = process.env.RAGENT_CODEX_SERVICE_TIER;
delete process.env.RAGENT_CODEX_SERVICE_TIER;

assert.throws(
  () => buildRuntimeInvocation('', 'Ping', {}, 'missing-runtime'),
  /missing runtimeFamily/,
);

assert.throws(
  () => buildRuntimeInvocation('custom-json', 'Ping', {}, 'broken-runtime'),
  /unsupported runtimeFamily "custom-json"/,
);
assert.throws(
  () => buildRuntimeInvocation('codex-json', 'Ping', { riskMode: 'recommended' }, 'codex-cli'),
  (error) => error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME',
);
assert.throws(
  () => buildRuntimeInvocation('cline-json', 'Ping', { riskMode: 'recommended' }, 'cline'),
  (error) => error?.code === 'PRIVILEGED_GATE_UNSUPPORTED_RUNTIME',
);
assert.throws(
  () => buildRuntimeInvocation('opencode-json', 'Ping', { riskMode: 'conservative-auto' }, 'opencode'),
  (error) => error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME',
);
for (const runtimeFamily of ['hermes-acp']) {
  assert.throws(
    () => buildRuntimeInvocation(runtimeFamily, 'Ping', { riskMode: 'full-auto' }, runtimeFamily),
    (error) => error?.code === 'PERMISSION_PROFILE_UNSUPPORTED_RUNTIME',
  );
}

const codexInvocation = buildRuntimeInvocation('codex-json', 'Ping', { model: 'fake-model', effort: 'low' }, 'fake-codex');
assert.equal(codexInvocation.isCodexFamily, true);
assert.equal(codexInvocation.isClaudeFamily, false);
assert.equal(codexInvocation.runtimeFamily, 'codex-json');
assert.ok(Array.isArray(codexInvocation.args) && codexInvocation.args.length > 0);

const codexFastInvocation = buildRuntimeInvocation('codex-json', 'Ping', {
  model: 'fake-model',
  serviceTier: 'fast',
}, 'fake-codex');
assert.ok(codexFastInvocation.args.includes('service_tier="fast"'));

const codexStandardInvocation = buildRuntimeInvocation('codex-json', 'Ping', {
  model: 'fake-model',
  serviceTier: 'standard',
}, 'fake-codex');
assert.equal(codexStandardInvocation.args.includes('service_tier="fast"'), false);
assert.ok(codexStandardInvocation.args.includes('service_tier="default"'));

const codexFreshInvocation = buildRuntimeInvocation('codex-json', 'Ping', {
  codexThreadId: 'thread-test-1',
  model: 'fake-model',
  effort: 'low',
}, 'fake-codex');
assert.equal(
  codexFreshInvocation.args.includes('resume'),
  false,
  'Codex runtime should avoid provider resume by default',
);

const codexResumeInvocation = buildRuntimeInvocation('codex-json', 'Ping', {
  codexThreadId: 'thread-test-1',
  codexResume: true,
  model: 'fake-model',
  effort: 'low',
}, 'fake-codex');
assert.ok(codexResumeInvocation.args.includes('resume'), 'explicit Codex resume should remain available');

const codexPlanInvocation = buildRuntimeInvocation('codex-json', 'Plan this.', {
  interactionMode: 'plan',
  model: 'fake-model',
}, 'fake-codex');
assert.ok(
  codexPlanInvocation.args.includes('mode=plan'),
  'Codex runtime invocation should propagate Plan interaction mode into CLI config',
);
assert.equal(
  codexPlanInvocation.args.includes('--dangerously-bypass-approvals-and-sandbox'),
  false,
  'Codex plan runtime should not request the dangerous bypass flag',
);
assert.equal(codexPlanInvocation.permissionMode, 'never-read-only');

const codexReadOnlyInvocation = buildRuntimeInvocation('codex-json', 'Plan this.', {
  permissionMode: 'read-only',
  model: 'fake-model',
}, 'fake-codex');
assert.ok(
  codexReadOnlyInvocation.args.includes('--sandbox') && codexReadOnlyInvocation.args.includes('read-only'),
  'explicit Codex read-only permission mode should map to the read-only sandbox',
);
assert.ok(
  codexReadOnlyInvocation.args.includes('-a') && codexReadOnlyInvocation.args.includes('never'),
  'legacy Codex read-only permission mode should preserve the never approval policy',
);

const previousSandbox = process.env.IS_SANDBOX;
process.env.IS_SANDBOX = '1';
const claudeSkipInvocation = buildRuntimeInvocation('claude-stream-json', 'Ping', {
  permissionMode: 'skip-permissions',
}, 'fake-claude');
assert.equal(claudeSkipInvocation.input, 'Ping', 'classic Claude prompt must be supplied as stdin input');
assert.equal(claudeSkipInvocation.args.includes('Ping'), false, 'classic Claude prompt must not be placed in argv');
assert.ok(
  claudeSkipInvocation.args.includes('--permission-mode')
    && claudeSkipInvocation.args.includes('bypassPermissions'),
  'Claude legacy skip-permissions mode should map to the native Claude Code permission mode',
);
const claudeDefaultInvocation = buildRuntimeInvocation('claude-stream-json', 'Ping', {
  permissionMode: 'default',
}, 'fake-claude');
assert.equal(
  claudeDefaultInvocation.args.includes('--dangerously-skip-permissions'),
  false,
  'Claude default permission mode should not use the bypass flag',
);
assert.ok(
  claudeDefaultInvocation.args.includes('--permission-mode')
    && claudeDefaultInvocation.args.includes('default'),
  'Claude default permission mode should preserve the native permission mode',
);
const claudeBidiInvocation = buildRuntimeInvocation('claude-stream-json-bidi', 'Ping', {
  permissionMode: 'default',
  model: 'fake-model',
  effort: 'low',
}, 'fake-claude-bidi');
assert.equal(claudeBidiInvocation.runtimeFamily, 'claude-stream-json-bidi');
assert.equal(claudeBidiInvocation.isClaudeFamily, true);
assert.equal(claudeBidiInvocation.isClaudeBidiFamily, true);
assert.equal(claudeBidiInvocation.capabilities?.supportsSteer, true);
assert.equal(claudeBidiInvocation.capabilities?.supportsInterrupt, true);
assert.ok(claudeBidiInvocation.args.includes('--input-format'));
assert.ok(claudeBidiInvocation.args.includes('stream-json'));
assert.ok(
  claudeBidiInvocation.args.includes('--permission-mode')
    && claudeBidiInvocation.args.includes('default'),
  'Claude bidi must preserve the native default permission mode for its approval channel',
);
assert.equal(claudeBidiInvocation.args.includes('Ping'), false, 'bidi prompt must be sent on stdin');
const oversizedClaudeBidiPrompt = 'x'.repeat(165 * 1024);
const resolvedClaudeBidiInvocation = await createToolInvocation('claude-bidi', oversizedClaudeBidiPrompt, {
  model: 'fake-model',
});
assert.equal(
  resolvedClaudeBidiInvocation.runtimeFamily,
  'claude-stream-json-bidi',
  'the concrete claude-bidi tool id must not be downgraded through a harness alias',
);
assert.equal(resolvedClaudeBidiInvocation.isClaudeBidiFamily, true);
assert.equal(resolvedClaudeBidiInvocation.args.includes(oversizedClaudeBidiPrompt), false);
assert.ok(
  resolvedClaudeBidiInvocation.args.every((arg) => Buffer.byteLength(String(arg), 'utf8') < 128 * 1024),
  'Claude bidi argv must stay below the per-argument limit for oversized prompts',
);
if (previousSandbox === undefined) delete process.env.IS_SANDBOX;
else process.env.IS_SANDBOX = previousSandbox;

const appServerInvocation = buildRuntimeInvocation('codex-app-server-json', 'Plan this.', {
  interactionMode: 'plan',
  model: 'fake-model',
}, 'fake-codex-app-server');
assert.equal(appServerInvocation.runtimeFamily, 'codex-app-server-json');
assert.equal(appServerInvocation.isCodexFamily, true);
assert.equal(appServerInvocation.isCodexAppServerFamily, true);
assert.deepEqual(
  appServerInvocation.args,
  ['app-server', '--stdio'],
  'Codex app-server runtime should launch the app-server stdio transport',
);

const appServerFastInvocation = buildRuntimeInvocation('codex-app-server-json', 'Plan this.', {
  model: 'fake-model',
  serviceTier: 'fast',
}, 'fake-codex-app-server');
assert.deepEqual(appServerFastInvocation.args, [
  'app-server', '--stdio', '-c', 'service_tier="fast"',
]);

const copilotInvocation = buildRuntimeInvocation('copilot-json', 'Run the task.', {
  model: 'gpt-4o',
}, 'copilot');
assert.deepEqual(copilotInvocation.args, [
  '--output-format', 'json', '--allow-all-tools', '--no-ask-user', '--model', 'gpt-4o',
  '--prompt', 'Run the task.',
]);
assert.equal(copilotInvocation.capabilities?.provider, 'copilot');
assert.equal(copilotInvocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);

const copilotResumeInvocation = buildRuntimeInvocation('copilot-json', 'Continue.', {
  providerResumeId: 'copilot-thread-1',
  model: 'gpt-4o',
}, 'copilot');
assert.deepEqual(copilotResumeInvocation.args, [
  '--output-format', 'json', '--allow-all-tools', '--no-ask-user', '--model', 'gpt-4o',
  '--resume', 'copilot-thread-1', '--prompt', 'Continue.',
]);

const agyInvocation = buildRuntimeInvocation('agy-stream-json', 'Say OK.', {
  model: 'gemini-3.7-flash-low',
  effort: 'low',
}, 'agy');
assert.equal(agyInvocation.runtimeFamily, 'agy-stream-json');
assert.equal(agyInvocation.isAgyFamily, true);
assert.equal(agyInvocation.capabilities?.supportsToolEvents, true);
assert.ok(agyInvocation.args.includes('--output-format') && agyInvocation.args.includes('stream-json'));
assert.ok(agyInvocation.args.includes('--print='), 'AgY print mode must use an attached empty value');
assert.equal(agyInvocation.args.includes('--print'), false, 'AgY must not pass --print as a valueless flag');
assert.equal(agyInvocation.args.includes('Say OK.'), false, 'AgY prompt must not be passed in argv');
assert.deepEqual(JSON.parse(agyInvocation.input.trim()), {
  event: 'user',
  message: { role: 'user', content: 'Say OK.' },
});
const oversizedAgyPrompt = 'x'.repeat(256 * 1024);
const oversizedAgyInvocation = buildRuntimeInvocation('agy-stream-json', oversizedAgyPrompt, {
  model: 'gemini-3.7-flash',
}, 'agy');
assert.equal(
  JSON.parse(oversizedAgyInvocation.input.trim()).message.content,
  oversizedAgyPrompt,
);
assert.ok(
  oversizedAgyInvocation.args.every((arg) => Buffer.byteLength(String(arg), 'utf8') < 128 * 1024),
  'AgY argv must stay below the per-argument limit for oversized prompts',
);
assert.deepEqual(
  agyInvocation.args.slice(agyInvocation.args.indexOf('--print-timeout'), agyInvocation.args.indexOf('--print-timeout') + 2),
  ['--print-timeout', '24h'],
);

const hermesInvocation = buildRuntimeInvocation('hermes-acp', 'Run the task.', {}, 'hermes-acp');
assert.deepEqual(hermesInvocation.args, []);
assert.equal(hermesInvocation.acp, true);
assert.equal(hermesInvocation.isHermesFamily, true);
assert.equal(hermesInvocation.capabilities?.provider, 'hermes');
assert.equal(hermesInvocation.capabilities?.supportsResume, true);
assert.equal(hermesInvocation.capabilities?.supportsApproval, false);

const clineInvocation = buildRuntimeInvocation('cline-json', 'Run the task.', {
  model: 'gpt-5@provider-a',
}, 'cline');
assert.deepEqual(clineInvocation.args, [
  '--json', '--yolo', '--model', 'gpt-5', 'Run the task.',
]);
assert.equal(clineInvocation.isClineFamily, true);
assert.equal(clineInvocation.capabilities?.provider, 'cline');
const clineGuardedInvocation = buildRuntimeInvocation('cline-json', 'Run the task.', {
  riskMode: 'conservative-auto',
}, 'cline');
assert.deepEqual(clineGuardedInvocation.args, [
  '--json', '--auto-approve', 'false', 'Run the task.',
]);
assert.equal(clineGuardedInvocation.permissionMode, 'headless-deny');
const clineResumeInvocation = buildRuntimeInvocation('cline-json', 'Continue.', {
  model: 'gpt-5@provider-a', providerResumeId: 'cline-session-1',
}, 'cline');
assert.ok(clineResumeInvocation.args.includes('--id'));
assert.ok(clineResumeInvocation.args.includes('cline-session-1'));

const kiloInvocation = buildRuntimeInvocation('kilo-json', 'Run the task.', {
  model: 'gpt-5@provider-a',
}, 'kilo');
assert.deepEqual(kiloInvocation.args, [
  'run', '--format', 'json', '--auto', '--model', 'ragent/gpt-5', 'Run the task.',
]);
assert.equal(kiloInvocation.isKiloFamily, true);
assert.equal(kiloInvocation.capabilities?.provider, 'kilo');
const kiloGuardedInvocation = buildRuntimeInvocation('kilo-json', 'Run the task.', {
  riskMode: 'conservative-auto',
}, 'kilo');
assert.deepEqual(kiloGuardedInvocation.args, [
  'run', '--format', 'json', 'Run the task.',
]);
assert.equal(kiloGuardedInvocation.permissionMode, 'headless-deny');
const kiloResumeInvocation = buildRuntimeInvocation('kilo-json', 'Continue.', {
  model: 'gpt-5@provider-a', providerResumeId: 'kilo-session-1',
}, 'kilo');
assert.ok(kiloResumeInvocation.args.includes('--session'));
assert.ok(kiloResumeInvocation.args.includes('kilo-session-1'));

const manifestFallbackInvocation = await createToolInvocation('missing-runtime', 'Ping', {
  runtimeFamily: 'codex-json',
  model: 'fake-model',
  effort: 'low',
});
assert.equal(manifestFallbackInvocation.runtimeFamily, 'codex-json');
assert.equal(manifestFallbackInvocation.isCodexFamily, true);

console.log('test-process-runner-runtime-family: ok');

if (previousServiceTier === undefined) delete process.env.RAGENT_CODEX_SERVICE_TIER;
else process.env.RAGENT_CODEX_SERVICE_TIER = previousServiceTier;
