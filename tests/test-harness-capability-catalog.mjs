import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtureRoot = tmpdir();
await mkdir(fixtureRoot, { recursive: true });
const root = await mkdtemp(join(fixtureRoot, 'harness-capability-catalog-'));
const configRoot = join(root, 'config');
process.env.RAGENT_CONFIG_DIR = configRoot;
const { listAgyCapabilities, listHarnessCapabilities, resolveHarnessCapabilityInstructions } =
  await import('../chat/harness-capability-catalog.mjs');
const { CODEX_MANAGED_HOME_DIR } = await import('../lib/config.mjs');
const { createSecretStore } = await import('../lib/provider-runtime/secret-store.mjs');
const { managedCodexMcpAccountBinding } = await import('../lib/provider-runtime/codex-mcp-config.mjs');
const { saveCodexSkillPreference } = await import('../lib/provider-runtime/codex-skill-preferences.mjs');
const project = join(root, 'project');
const claudeHome = join(root, 'claude-home');
const platformSkills = join(root, 'platform-skills');
const plugin = join(claudeHome, 'plugins', 'cache', 'market', 'review-tools', '1.0.0');

async function put(pathname, body) {
  await mkdir(join(pathname, '..'), { recursive: true });
  await writeFile(pathname, body, 'utf8');
}

try {
  await put(join(project, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review changes carefully.\n---\nInstructions');
  await put(join(project, '.claude', 'commands', 'deploy.md'),
    '---\ndescription: Deploy the project.\n---\nInstructions');
  await put(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { projectDb: { command: 'node', env: { TOKEN: 'never-return-this' } } },
  }));
  await put(join(claudeHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      userDocs: { url: 'https://example.invalid', env: { SECRET: 'never-return-this-either' } },
      ragent: { command: 'node', args: ['ragent-mcp-server.mjs'] },
    },
  }));
  await put(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'review-tools@market': true } }));
  await put(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'review-tools@market': [{ installPath: plugin, version: '1.0.0' }] },
  }));
  await put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'review-tools', description: 'Review helper bundle',
  }));
  await put(join(plugin, 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review skill from plugin.\n---\nInstructions');
  await put(join(plugin, 'commands', 'audit.md'), '---\ndescription: Audit code.\n---\nInstructions');
  await put(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { pluginSearch: { command: 'node' } } }));
  await put(join(platformSkills, 'calendar-write.md'), '# Calendar Write\nAdd an event to the calendar.');

  await put(join(configRoot, 'native-provider-runtime', 'providers.json'), JSON.stringify({
    profiles: [{
      id: 'codex-official-qa',
      agentType: 'codex',
      protocol: 'openai-responses',
      authProfileId: 'auth-profile-qa',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    }],
  }));
  await put(join(configRoot, 'native-provider-runtime', 'auth-profiles.json'), JSON.stringify({
    profiles: [{ id: 'auth-profile-qa', agentType: 'codex', authType: 'oauth', storageRef: 'secret-qa' }],
  }));
  await createSecretStore({ configDir: configRoot }).writeSecret('secret-qa', {
    authType: 'oauth', tokens: { account_id: 'account-qa', access_token: 'fixture' },
  });

  const claude = await listHarnessCapabilities({
    session: { tool: 'claude' }, cwd: project, claudeConfigDir: claudeHome,
    platformSkillsDir: platformSkills, listCodexCapabilities: async () => ({}),
  });
  const claudeByTitle = new Map(claude.items.map((item) => [item.title, item]));
  assert.equal(claudeByTitle.get('review')?.invocationText, '/review ');
  assert.equal(claudeByTitle.get('deploy')?.invocationText, '/deploy ');
  assert.equal(claudeByTitle.get('review-tools:review')?.invocationText, '/review-tools:review ');
  assert.equal(claudeByTitle.get('review-tools:audit')?.invocationText, '/review-tools:audit ');
  assert.equal(claudeByTitle.get('projectDb')?.kind, 'mcp');
  assert.equal(claudeByTitle.get('userDocs')?.kind, 'mcp');
  assert.equal(claudeByTitle.get('ragent')?.source, 'ragent');
  assert.equal(claudeByTitle.get('pluginSearch')?.source, 'claude-plugin');
  assert.equal(claudeByTitle.get('calendar-write')?.source, 'ragent');
  assert.ok(!JSON.stringify(claude).includes('never-return-this'));
  assert.ok(!JSON.stringify(claude).includes(claudeHome));
  const selectedInstructions = await resolveHarnessCapabilityInstructions({
    ids: [claudeByTitle.get('calendar-write').id, claudeByTitle.get('ragent').id],
    session: { tool: 'claude' },
    cwd: project,
    claudeConfigDir: claudeHome,
    platformSkillsDir: platformSkills,
    listCodexCapabilities: async () => ({}),
  });
  assert.match(selectedInstructions, /Add an event to the calendar/);
  assert.match(selectedInstructions, /already configured ragent MCP server/);
  await assert.rejects(
    resolveHarnessCapabilityInstructions({
      ids: ['ragent:skill:stale'], session: { tool: 'claude' }, cwd: project,
      claudeConfigDir: claudeHome, platformSkillsDir: platformSkills,
      listCodexCapabilities: async () => ({}),
    }),
    (error) => error.code === 'HARNESS_CAPABILITY_STALE' && error.statusCode === 409,
  );

  const nativeSkillPath = join(root, 'codex-skills', 'test-skill', 'SKILL.md');
  await saveCodexSkillPreference(configRoot, 'codex-official-qa', managedCodexMcpAccountBinding({ authType: 'oauth', tokens: { account_id: 'account-qa' } }), nativeSkillPath, false);
  const codex = await listHarnessCapabilities({
    session: { tool: 'codex' }, cwd: project, platformSkillsDir: '',
    listCodexCapabilities: async () => ({
      skills: { ok: true, data: [{ skills: [{ name: 'test-skill', path: nativeSkillPath, shortDescription: 'Test skill' }] }] },
      plugins: { ok: true, data: { marketplaces: [{ name: 'market', plugins: [{ id: 'p@market', name: 'Demo', enabled: false }] }] } },
      mcp: { ok: true, data: { servers: [{ name: 'docs', status: 'ready', authStatus: { token: 'private' } }, { name: 'unknown' }] } },
      apps: { ok: true, data: { data: [{ id: 'drive', name: 'Drive', isAccessible: true }] } },
      installedApps: { ok: true, data: { apps: [{ id: 'drive', enabled: true, callable: true }] } },
    }),
  });
  const codexByTitle = new Map(codex.items.map((item) => [item.title, item]));
  assert.equal(codexByTitle.get('test-skill')?.invocationText, '$test-skill ');
  assert.equal(codexByTitle.get('test-skill')?.state.desiredConfiguration, 'disabled');
  assert.equal(codexByTitle.get('test-skill')?.state.manageable, true);
  assert.ok(!JSON.stringify(codex).includes(nativeSkillPath), 'native skill paths must not be exposed to clients');
  assert.equal(codexByTitle.get('docs')?.invocationText, '');
  assert.equal(codexByTitle.get('Demo')?.enabled, false);
  assert.equal(codexByTitle.get('unknown')?.state.runtime, 'unknown');
  assert.equal(codexByTitle.get('unknown')?.enabled, true, 'unknown readiness must not prevent asking to use a configured server');
  assert.equal(codexByTitle.get('Drive')?.state.runtime, 'callable');
  assert.equal(codexByTitle.get('Drive')?.state.authorization, 'unknown');
  assert.ok(!JSON.stringify(codex).includes('private'));

  let scopedCodexHome = '';
  await listHarnessCapabilities({
    session: { tool: 'codex' },
    providerProfileId: 'codex-official-qa',
    cwd: project,
    platformSkillsDir: '',
    listCodexCapabilities: async ({ codexHomeDir }) => {
      scopedCodexHome = codexHomeDir;
      return { skills: { ok: true, data: [] }, plugins: { ok: true, data: { marketplaces: [] } }, mcp: { ok: true, data: { servers: [] } } };
    },
  });
  const providerKey = createHash('sha256').update('codex:codex-official-qa').digest('hex').slice(0, 32);
  assert.equal(scopedCodexHome, join(dirname(CODEX_MANAGED_HOME_DIR), 'by-provider', providerKey, 'codex'));

  let modelScopedHome = '';
  const modelScoped = await listHarnessCapabilities({
    session: { tool: 'codex' }, model: 'example@codex-official-qa', cwd: project, platformSkillsDir: '',
    listCodexCapabilities: async ({ codexHomeDir, refresh }) => {
      modelScopedHome = codexHomeDir;
      assert.equal(refresh, true);
      return {};
    }, refresh: true,
  });
  assert.equal(modelScopedHome, scopedCodexHome);
  assert.equal(modelScoped.providerProfileId, 'codex-official-qa');

  const unavailable = await listHarnessCapabilities({
    session: { tool: 'codex' }, platformSkillsDir: '',
    listCodexCapabilities: async () => { throw new Error(`secret path ${root}`); },
  });
  assert.ok(!JSON.stringify(unavailable).includes(root));
  assert.equal(unavailable.errors.codex, 'Codex capability catalog is unavailable.');

  // AgY workspace skills, .agents/skills.json, controlled ~/.gemini/config/skills, plugins/, and MCP servers
  const agyHome = join(root, 'agy-home');
  const agyWsSkill = '---\nname: agy-ws-audit\ndescription: Workspace AgY skill\n---\nBody';
  const agyUserSkill = '---\nname: agy-user-plan\ndescription: User AgY skill\n---\nUser body';
  const agyPluginSkill = '---\nname: plug-helper\ndescription: Plugin AgY skill\n---\nPlug body';
  await put(join(project, '.agents', 'skills', 'agy-ws-audit', 'SKILL.md'), agyWsSkill);
  await put(join(project, '.agents', 'skills', 'agy-disabled', 'SKILL.md'), '---\nname: agy-disabled\ndescription: Disabled via manifest\n---\nDisabled body');
  await put(join(project, '.agents', 'skills', 'declared-only', 'SKILL.md'), '---\nname: declared-only\ndescription: Declared via manifest\n---\nManifest body');
  const outsideSkillDir = join(root, 'outside-symlink-target');
  await put(join(outsideSkillDir, 'SKILL.md'), '---\nname: outside-secret-skill\ndescription: LEAKED_OUTSIDE_SYMLINK_DESC\n---\nSecret');
  try {
    await symlink(
      outsideSkillDir,
      join(project, '.agents', 'linked-escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    /* ignore if platform forbids symlinks */
  }
  await put(join(project, '.agents', 'skills.json'), JSON.stringify({
    disabled: ['agy-disabled'],
    skills: [
      { name: 'declared-manifest', path: '.agents/skills/declared-only/SKILL.md', description: 'Declared from manifest' },
      { name: 'escaped-secret', path: '../../outside/SKILL.md', description: 'Outside skill must not read external file' },
      { name: 'symlink-intermediate', path: '.agents/linked-escape/SKILL.md' },
    ],
  }));
  await put(join(agyHome, '.gemini', 'config', 'skills', 'agy-user-plan', 'SKILL.md'), agyUserSkill);
  await put(join(agyHome, '.gemini', 'config', 'plugins', 'demo-agy-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-agy-plugin',
    description: 'Demo AgY Plugin',
  }));
  await put(join(agyHome, '.gemini', 'config', 'plugins', 'demo-agy-plugin', 'skills', 'plug-helper', 'SKILL.md'), agyPluginSkill);
  await put(join(agyHome, '.gemini', 'config', 'plugins', 'demo-agy-plugin', '.mcp.json'), JSON.stringify({
    mcpServers: { pluginAgyTool: { command: 'node', env: { PLUGIN_SECRET: 'must-not-leak-plugin' } } },
  }));
  await put(join(agyHome, '.gemini', 'config', 'plugins', 'disabled-plugin', 'plugin.json'), JSON.stringify({
    name: 'disabled-plugin',
    enabled: false,
  }));
  await put(join(agyHome, '.gemini', 'config', 'plugins', 'disabled-plugin', 'skills', 'hidden-skill', 'SKILL.md'), '---\nname: hidden-skill\n---\nHidden');
  await put(join(agyHome, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      extDocs: { serverUrl: 'https://docs.example.invalid/mcp', headers: { Authorization: 'Bearer never-leak-header' }, disabled: false },
      extStdio: { command: 'node', args: ['s.mjs'], env: { API_TOKEN: 'never-leak-env' }, disabled: false },
      extLegacySse: { type: 'sse', url: 'https://sse.example.invalid/sse', disabled: false },
    },
  }));

  const agyDirect = await listAgyCapabilities({ cwd: project, agyHomeDir: agyHome });
  const agyFull = await listHarnessCapabilities({
    session: { tool: 'agy-acp' },
    cwd: project,
    agyHomeDir: agyHome,
    platformSkillsDir: platformSkills,
  });
  assert.ok(agyDirect.items.length > 0);
  const agyByTitle = new Map(agyFull.items.map((item) => [item.title, item]));
  assert.equal(agyByTitle.get('agy-ws-audit')?.invocationText, '/agy-ws-audit ');
  assert.equal(agyByTitle.get('agy-ws-audit')?.state?.provenance, 'agy_workspace');
  assert.equal(agyByTitle.get('agy-ws-audit')?.state?.contentHash, createHash('sha256').update(agyWsSkill, 'utf8').digest('hex'));
  assert.equal(agyByTitle.get('agy-disabled')?.enabled, false);
  assert.equal(agyByTitle.get('agy-disabled')?.invocationText, '');
  assert.equal(agyByTitle.get('declared-manifest')?.enabled, true);
  assert.equal(agyByTitle.get('declared-manifest')?.state?.provenance, 'agy_workspace_manifest');
  assert.equal(agyByTitle.get('symlink-intermediate')?.description, '');
  assert.ok(!JSON.stringify(agyFull).includes('LEAKED_OUTSIDE_SYMLINK_DESC'), 'Intermediate symlink must not escape workspace root');
  assert.equal(agyByTitle.get('agy-user-plan')?.state?.provenance, 'agy_user_config');
  assert.equal(agyByTitle.get('demo-agy-plugin:plug-helper')?.invocationText, '/demo-agy-plugin:plug-helper ');
  assert.equal(agyByTitle.get('demo-agy-plugin:plug-helper')?.state?.provenance, 'agy_plugin');
  assert.equal(agyByTitle.get('demo-agy-plugin')?.kind, 'plugin');
  assert.equal(agyByTitle.get('disabled-plugin')?.enabled, false);
  assert.equal(agyByTitle.get('disabled-plugin:hidden-skill'), undefined);
  assert.equal(agyByTitle.get('pluginAgyTool')?.source, 'agy-plugin');
  assert.equal(agyByTitle.get('extDocs')?.enabled, true);
  assert.equal(agyByTitle.get('extDocs')?.state?.transport, 'http');
  assert.equal(agyByTitle.get('extStdio')?.state?.transport, 'stdio');
  assert.ok(agyByTitle.get('extStdio')?.state?.contentHash);
  assert.equal(agyByTitle.get('extLegacySse')?.enabled, false);
  assert.ok(!JSON.stringify(agyFull).includes('never-leak-header'));
  assert.ok(!JSON.stringify(agyFull).includes('never-leak-env'));
  assert.ok(!JSON.stringify(agyFull).includes('must-not-leak-plugin'));
  assert.ok(!JSON.stringify(agyFull).includes(agyHome));

  const agyInstructions = await resolveHarnessCapabilityInstructions({
    ids: [agyByTitle.get('agy-ws-audit').id, agyByTitle.get('extDocs').id],
    session: { tool: 'agy-acp' },
    cwd: project,
    agyHomeDir: agyHome,
    platformSkillsDir: platformSkills,
  });
  assert.match(agyInstructions, /agy-ws-audit/);
  assert.match(agyInstructions, /extDocs/);

  console.log('Harness capability catalog tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
