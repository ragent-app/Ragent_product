#!/usr/bin/env node
import assert from 'assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-runtime-policy-'));
const personalCodexHome = join(home, '.codex');
mkdirSync(personalCodexHome, { recursive: true });
writeFileSync(join(personalCodexHome, 'auth.json'), '{"token":"test"}\n', 'utf8');

process.env.HOME = home;

const {
  DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
  MANAGER_RUNTIME_BOUNDARY_SECTION,
  applyManagedRuntimeEnv,
  ensureManagedCodexHome,
} = await import('../chat/runtime-policy.mjs');

try {
  const managedHome = join(home, '.config', 'agentoc', 'provider-runtime-homes', 'codex-test');
  const resolvedManagedHome = await ensureManagedCodexHome({
    homeDir: managedHome,
    authSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(resolvedManagedHome, managedHome, 'managed Codex home should resolve to the requested directory');
  assert.match(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    /AgentoC-managed Codex runtime home/,
    'managed Codex home should carry a minimal manager-owned config',
  );
  assert.match(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    /model_provider\s*=\s*"openai-http"/,
    'managed Codex home should use the HTTPS-only OpenAI provider by default',
  );
  assert.match(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    /\[model_providers\.openai-http\][\s\S]*supports_websockets\s*=\s*false/,
    'managed Codex home should disable WebSocket support on the default provider',
  );
  assert.match(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    /unified_exec\s*=\s*false/,
    'managed Codex home should disable unified_exec to avoid internal exec-server reconnect retries',
  );
  const authStat = lstatSync(join(managedHome, 'auth.json'));
  assert.ok(authStat.isSymbolicLink() || authStat.isFile(), 'managed Codex home should expose auth.json');

  writeFileSync(join(managedHome, 'config.toml'), 'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:9999"\n', 'utf8');
  await ensureManagedCodexHome({
    homeDir: managedHome,
    authSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    'model_provider = "custom"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:9999"\n',
    'managed Codex home should preserve a discovered or user-provided config.toml',
  );

  const nonEmptyManagedConfig = '# AgentoC-managed Codex runtime home.\nmodel_provider = "preserved"\n';
  writeFileSync(join(managedHome, 'config.toml'), nonEmptyManagedConfig, 'utf8');
  await ensureManagedCodexHome({
    homeDir: managedHome,
    authSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(
    readFileSync(join(managedHome, 'config.toml'), 'utf8'),
    nonEmptyManagedConfig,
    'ensure should not rewrite any non-empty Codex config, including an older managed config',
  );

  const managedEnv = await applyManagedRuntimeEnv('codex', { FOO: 'bar', CODEX_HOME: '/tmp/elsewhere' }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'managed',
  });
  assert.equal(managedEnv.FOO, 'bar', 'unrelated env values should stay intact');
  assert.equal(managedEnv.CODEX_HOME, managedHome, 'managed Codex runs should use the manager-owned CODEX_HOME');

  // An interrupted bootstrap can leave a writable provider home without
  // auth.json. Repairing it must not repeat mkdir with setgid bits, which can
  // raise EPERM for an already-existing runner-owned directory.
  const authlessHome = join(home, '.config', 'agentoc', 'provider-runtime-homes', 'authless-codex');
  mkdirSync(authlessHome, { recursive: true });
  const repairedAuthlessEnv = await applyManagedRuntimeEnv('codex', {}, {
    codexHomeDir: authlessHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'managed',
  });
  assert.equal(repairedAuthlessEnv.CODEX_HOME, authlessHome, 'authless managed Codex home should be repaired in place');

  const personalEnv = await applyManagedRuntimeEnv('codex', { CODEX_HOME: '/tmp/personal' }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'personal',
  });
  assert.equal(personalEnv.CODEX_HOME, '/tmp/personal', 'personal mode should preserve the existing CODEX_HOME');

  const customCodexEnv = await applyManagedRuntimeEnv('micro-agent', { FOO: 'baz' }, {
    runtimeFamily: 'codex-json',
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
    codexHomeMode: 'managed',
  });
  assert.equal(customCodexEnv.FOO, 'baz', 'custom Codex runtime should preserve unrelated env values');
  assert.equal(customCodexEnv.CODEX_HOME, managedHome, 'custom Codex runtimes should also use the manager-owned CODEX_HOME');

  const nonCodexEnv = await applyManagedRuntimeEnv('claude', { HOME: home }, {
    codexHomeDir: managedHome,
    codexAuthSource: join(personalCodexHome, 'auth.json'),
  });
  assert.equal(nonCodexEnv.CODEX_HOME, undefined, 'non-Codex runtimes should not get a managed CODEX_HOME');

  const clineHome = join(home, 'provider-homes', 'cline');
  mkdirSync(clineHome, { recursive: true });
  writeFileSync(join(clineHome, '.agentoc-provider.env'), 'AGENTOC_PROVIDER_API_KEY="secret"\n', 'utf8');
  const clineEnv = await applyManagedRuntimeEnv('cline', { HOME: '/tmp/ambient' }, {
    runtimeFamily: 'cline-json',
    harnessHomeDir: clineHome,
  });
  assert.equal(clineEnv.HOME, clineHome);
  assert.equal(clineEnv.CLINE_DATA_DIR, clineHome);
  assert.equal(clineEnv.CLINE_PROVIDER_SETTINGS_PATH, join(clineHome, 'settings', 'providers.json'));
  assert.equal(clineEnv.AGENTOC_PROVIDER_API_KEY, 'secret');

  const kiloHome = join(home, 'provider-homes', 'kilo');
  mkdirSync(kiloHome, { recursive: true });
  const kiloEnv = await applyManagedRuntimeEnv('kilo', {}, {
    runtimeFamily: 'kilo-json',
    harnessHomeDir: kiloHome,
  });
  assert.equal(kiloEnv.HOME, kiloHome);
  assert.equal(kiloEnv.KILO_CONFIG, join(kiloHome, 'kilo.jsonc'));

  const kimiHome = join(home, 'provider-homes', 'kimi-code');
  mkdirSync(kimiHome, { recursive: true });
  const kimiEnv = await applyManagedRuntimeEnv('kimi-code', {}, {
    runtimeFamily: 'kimi-code-acp',
    harnessHomeDir: kimiHome,
  });
  assert.equal(kimiEnv.HOME, kimiHome);
  assert.equal(kimiEnv.KIMI_CODE_HOME, join(kimiHome, '.kimi-code'));

  // Control-side one-shot calls (summarizer, detached assistant) pass neither
  // codexHomeDir nor codexHomeMode.  They must NOT land on the runner-owned
  // shared home (state sqlite there is runner-owned 0640 and needs O_RDWR);
  // they get the control-owned sibling instead.
  const { CODEX_CONTROL_HOME_DIR, CONFIG_DIR } = await import('../lib/config.mjs');
  const controlSideEnv = await applyManagedRuntimeEnv('codex', {});
  assert.equal(controlSideEnv.CODEX_HOME, CODEX_CONTROL_HOME_DIR, 'control-side one-shot codex calls should use the control-owned home');
  assert.notEqual(controlSideEnv.CODEX_HOME, managedHome, 'control-side one-shot codex calls must not reuse a runner/provider home');
  assert.equal(controlSideEnv.CODEX_HOME, join(CONFIG_DIR, 'provider-runtime-homes', 'codex-control'), 'control-side home should remain under the control config root');

  // The legacy external-ownership flag is ignored. Control-side one-shot
  // calls remain on the control-owned machine-local home.
  process.env.AGENTOC_CODEX_NATIVE_EXTERNAL_OAUTH_OWNERSHIP = '1';
  process.env.AGENTOC_EXTERNAL_CODEX_HOME = personalCodexHome;
  const externalControlSideEnv = await applyManagedRuntimeEnv('codex', {});
  assert.equal(externalControlSideEnv.CODEX_HOME, CODEX_CONTROL_HOME_DIR);
  delete process.env.AGENTOC_CODEX_NATIVE_EXTERNAL_OAUTH_OWNERSHIP;
  delete process.env.AGENTOC_EXTERNAL_CODEX_HOME;

  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Ragent owns the higher-level workflow, memory policy, and reply style/,
    'default Codex developer instructions should reinforce manager ownership',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /editable seed layer rather than rigid law/,
    'default Codex developer instructions should treat startup guidance as editable seed context',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Judge pauses branch-first: the decision target is not whether to continue but whether a real logical fork, missing required input, or forced human checkpoint actually exists/,
    'default Codex developer instructions should frame pauses around real forks or blockers rather than generic caution',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /If the task remains on a single obvious track, treat the current request as standing authorization and continue without asking permission/,
    'default Codex developer instructions should keep single-track work moving without extra permission asks',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /lead with current execution state, then whether the user is needed now or the work can stay parked for later/,
    'default Codex developer instructions should enforce state-first summaries and handoffs',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Work within the permissions granted to this run; do not assume the user's device or host access/,
    'default Codex developer instructions should distinguish agent machine access from user access',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /do not assume the user's device or host access/,
    'default Codex developer instructions should frame the host as execution substrate rather than the user\'s personal app container',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /operational work yourself on this machine or another Ragent-visible surface rather than giving the user a manual how-to/,
    'default Codex developer instructions should prefer agent-side execution over manual user recipes',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /If another service needs login, access, or approval, prefer bringing that checkpoint onto this machine or another Ragent-exposed surface/,
    'default Codex developer instructions should prefer AgentoC-side login and authorization checkpoints',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /prefer instance-scoped connectors\/API integrations and explicit account bindings or delivery targets/,
    'default Codex developer instructions should prefer bound connectors over ambient host app state for external side effects',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /binding-needed state or ask for the smallest authorization checkpoint rather than silently falling back to the host owner's local accounts or app sessions/,
    'default Codex developer instructions should block silent fallback to owner-local accounts when connector bindings are missing',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /local-only file is internal working state unless the user can access it/,
    'default Codex developer instructions should prevent local-only delivery from counting as completion',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Machine-side completion alone does not mean the user already has the result|open, read, or download it from a reachable surface/,
    'default Codex developer instructions should separate machine-side completion from user-visible delivery',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Do not assume every user or task lives inside Git, GitHub, or code-repository workflows/,
    'default Codex developer instructions should avoid treating Git or repos as universal user context',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Build work habits rather than brittle branch tables: before improvising, check whether existing local skills, wrappers, notes, or prior workflows already fit the task/,
    'default Codex developer instructions should prefer reusable capabilities over ad hoc improvisation',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Shape the work yourself: if the turn contains independently actionable goals or noisy exploration, decide whether to split work, create a short scratch note, or continue in one thread based on clarity rather than a hard-coded rule/,
    'default Codex developer instructions should frame task shaping as agent judgment rather than rigid routing',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /Do not split a single bounded workflow just because the user provided a numbered checklist, triage rubric, or step sequence/,
    'default Codex developer instructions should keep bounded checklist-style workflows in one session',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /same session\/workflow or not to create another child session, treat that as a strong no-split signal/,
    'default Codex developer instructions should honor explicit same-session no-spawn instructions',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /universal product rules belong in shared startup context, this user's standing preferences belong in personal memory, and repo-specific or specialized workflows belong in repo-local instructions or on-demand skills/,
    'default Codex developer instructions should separate shared defaults, personal memory, and repo-local workflows',
  );
  assert.match(
    DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    /repo state, remotes, branches, checkpoints, and similar operator workflows as internal mechanics/,
    'default Codex developer instructions should keep internal Git and memory mechanics out of default user-facing status updates',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /host is an execution surface; do not assume whether the user can access it locally/,
    'manager runtime boundary should define the host as the agent execution surface rather than the user interface',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /do not assume whether the user can access it locally/,
    'manager runtime boundary should block treating the host as the end user\'s personal app container',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Do not assume remote users can browse local folders, inspect this computer, or pick up files from host-only paths/,
    'manager runtime boundary should block assumptions of direct host access for remote users',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /absorbing the operational work on the Ragent side instead of turning the user into the fallback operator with a recipe of manual steps/,
    'manager runtime boundary should prefer AgentoC-side execution over manual user recipes',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /When another service needs access, login, or authorization, prefer completing that checkpoint on this machine or another Ragent-exposed surface/,
    'manager runtime boundary should prefer AgentoC-side access and login checkpoints',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /use only connectors and delivery channels actually authorized for this session/,
    'manager runtime boundary should prefer bound connectors over host app state for external side effects',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /report the limitation instead of improvising an unauthorized workaround/,
    'manager runtime boundary should block silent fallback to owner-local accounts when connector bindings are missing',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Machine-side completion and user-visible delivery are separate states|open, read, or download the result from a reachable surface/,
    'manager runtime boundary should treat user delivery as distinct from machine-side completion',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /Do not assume every user or task centers on Git, GitHub, or a code repository/,
    'manager runtime boundary should avoid repo-centric assumptions as the default product model',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /shared startup\/product defaults are only for universal cross-user principles; personal memory is for this user's standing preferences and machine-local habits; repo-local instructions and on-demand skills are for technical or domain-specific workflows/,
    'manager runtime boundary should keep shared defaults, personal memory, and repo-local workflows clearly layered',
  );
  assert.match(
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    /do not volunteer implementation details about memory files, prompts, repos, remotes, branches, checkpoints, or local tooling/,
    'manager runtime boundary should keep host-side implementation details out of normal user-facing replies',
  );
  console.log('test-runtime-policy: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
