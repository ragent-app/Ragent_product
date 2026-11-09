import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const fixtureRoot = 'G:/AgentoC/.tmp';
await mkdir(fixtureRoot, { recursive: true });
const root = await mkdtemp(join(fixtureRoot, 'harness-capability-catalog-'));
const configRoot = join(root, 'config');
process.env.AGENTOC_CONFIG_DIR = configRoot;
const { listHarnessCapabilities, resolveHarnessCapabilityInstructions } =
  await import('../chat/harness-capability-catalog.mjs');
const { CODEX_MANAGED_HOME_DIR } = await import('../lib/config.mjs');
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
      agentoc: { command: 'node', args: ['agentoc-mcp-server.mjs'] },
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
  assert.equal(claudeByTitle.get('agentoc')?.source, 'agentoc');
  assert.equal(claudeByTitle.get('pluginSearch')?.source, 'claude-plugin');
  assert.equal(claudeByTitle.get('calendar-write')?.source, 'agentoc');
  assert.ok(!JSON.stringify(claude).includes('never-return-this'));
  assert.ok(!JSON.stringify(claude).includes(claudeHome));
  const selectedInstructions = await resolveHarnessCapabilityInstructions({
    ids: [claudeByTitle.get('calendar-write').id, claudeByTitle.get('agentoc').id],
    session: { tool: 'claude' },
    cwd: project,
    claudeConfigDir: claudeHome,
    platformSkillsDir: platformSkills,
    listCodexCapabilities: async () => ({}),
  });
  assert.match(selectedInstructions, /Add an event to the calendar/);
  assert.match(selectedInstructions, /already configured agentoc MCP server/);
  await assert.rejects(
    resolveHarnessCapabilityInstructions({
      ids: ['agentoc:skill:stale'], session: { tool: 'claude' }, cwd: project,
      claudeConfigDir: claudeHome, platformSkillsDir: platformSkills,
      listCodexCapabilities: async () => ({}),
    }),
    (error) => error.code === 'HARNESS_CAPABILITY_STALE' && error.statusCode === 409,
  );

  const codex = await listHarnessCapabilities({
    session: { tool: 'codex' }, cwd: project, platformSkillsDir: '',
    listCodexCapabilities: async () => ({
      skills: { ok: true, data: [{ skills: [{ name: 'test-skill', shortDescription: 'Test skill' }] }] },
      plugins: { ok: true, data: { marketplaces: [{ name: 'market', plugins: [{ id: 'p@market', name: 'Demo', enabled: false }] }] } },
      mcp: { ok: true, data: { servers: [{ name: 'docs', status: 'ready', authStatus: { token: 'private' } }] } },
    }),
  });
  const codexByTitle = new Map(codex.items.map((item) => [item.title, item]));
  assert.equal(codexByTitle.get('test-skill')?.invocationText, '$test-skill ');
  assert.equal(codexByTitle.get('docs')?.invocationText, '');
  assert.equal(codexByTitle.get('Demo')?.enabled, false);
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

  const unavailable = await listHarnessCapabilities({
    session: { tool: 'codex' }, platformSkillsDir: '',
    listCodexCapabilities: async () => { throw new Error(`secret path ${root}`); },
  });
  assert.ok(!JSON.stringify(unavailable).includes(root));
  assert.equal(unavailable.errors.codex, 'Codex capability catalog is unavailable.');
  console.log('Harness capability catalog tests passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
