#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-label-oneshot-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'ragent');
const workRoot = join(tempHome, 'workspace');
const inaccessibleFolder = join(tempHome, 'inaccessible-workspace');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(workRoot, { recursive: true });
mkdirSync(inaccessibleFolder, { recursive: true });
chmodSync(inaccessibleFolder, 0o000);

const fakeCodexPath = join(tempBin, 'fake-codex');
const fakeClaudePath = join(tempBin, 'fake-claude');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.CODEX_HOME !== process.env.RAGENT_EXPECT_CODEX_HOME) {
  console.error('missing managed CODEX_HOME');
  process.exit(2);
}
if (!args.includes('exec')) {
  process.exit(0);
}
const prompt = args[args.length - 1] || '';
const isTitlePrompt = prompt.includes('You are naming a developer session');
const text = isTitlePrompt
  ? JSON.stringify({
      title: 'Ragent Rename Flow',
      group: 'Ragent',
      description: 'Name sessions with one-shot Codex prompts.',
    })
  : '{}';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'title-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  fakeClaudePath,
  `#!/usr/bin/env node
if (process.env.CLAUDE_CONFIG_DIR !== process.env.RAGENT_EXPECT_CLAUDE_HOME) {
  console.error('missing managed CLAUDE_CONFIG_DIR');
  process.exit(2);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const text = prompt.includes('You are naming a developer session')
    ? JSON.stringify({
        title: 'Claude Rename Flow',
        group: 'Ragent',
        description: 'Name sessions with one-shot Claude prompts.',
      })
    : '{}';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-title-session' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: { id: 'claude-title-message', role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 'claude-title-session',
  }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: 'claude-title-session',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
});
`,
  'utf8',
);
chmodSync(fakeClaudePath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-app-server-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
      },
      {
        id: 'fake-claude-bidi',
        name: 'Fake Claude Bidi',
        command: 'fake-claude',
        runtimeFamily: 'claude-stream-json-bidi',
        models: [{ id: 'fake-model', label: 'Fake model' }],
      },
    ],
    null,
    2,
  ),
  'utf8',
);

process.env.HOME = tempHome;
process.env.RAGENT_CONFIG_DIR = configDir;
process.env.RAGENT_WORK_ROOT_DIR = workRoot;
process.env.RAGENT_EXPECT_CODEX_HOME = join(configDir, 'provider-runtime-homes', 'codex-control');
process.env.RAGENT_EXPECT_CLAUDE_HOME = join(configDir, 'provider-runtime-homes', 'claude');
process.env.RAGENT_SESSION_LABEL_SUGGESTIONS = 'on';
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const { createSession, renameSession, getSession, killAll } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const { appendEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const { messageEvent } = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const { triggerSessionLabelSuggestion } = await import(pathToFileURL(join(repoRoot, 'chat', 'summarizer.mjs')).href);

const session = await createSession(tempHome, 'fake-codex', '');
await appendEvent(session.id, messageEvent('user', 'Fix Ragent automatic session naming.'));
await appendEvent(session.id, messageEvent('assistant', 'I will repair the rename path.'));

const result = await triggerSessionLabelSuggestion({
  id: session.id,
  folder: tempHome,
  name: session.name,
  autoRenamePending: session.autoRenamePending,
  tool: 'fake-codex',
  model: 'fake-model',
}, (newName) => renameSession(session.id, newName));

const renamed = await getSession(session.id);
assert.equal(result.ok, true, 'label suggestion should succeed');
assert.equal(result.rename.renamed, true, 'label suggestion should rename through the callback');
assert.equal(renamed.name, 'Rename Flow', 'generated title should be applied and group prefix removed');
assert.equal(renamed.autoRenamePending, false, 'successful rename should clear pending rename');

const inaccessibleSession = await createSession(inaccessibleFolder, 'fake-codex', '');
await appendEvent(inaccessibleSession.id, messageEvent('user', 'Rename from an inaccessible legacy workspace.'));
await appendEvent(inaccessibleSession.id, messageEvent('assistant', 'I will use the managed fallback workspace.'));

const inaccessibleResult = await triggerSessionLabelSuggestion({
  id: inaccessibleSession.id,
  folder: inaccessibleFolder,
  name: inaccessibleSession.name,
  autoRenamePending: inaccessibleSession.autoRenamePending,
  tool: 'fake-codex',
  model: 'fake-model',
}, (newName) => renameSession(inaccessibleSession.id, newName));

assert.equal(inaccessibleResult.ok, true, 'label suggestion should fall back from inaccessible cwd');

const claudeSession = await createSession(tempHome, 'fake-claude-bidi', '');
await appendEvent(claudeSession.id, messageEvent('user', 'Fix Claude Bidi automatic session naming.'));
await appendEvent(claudeSession.id, messageEvent('assistant', 'I will repair the structured prompt path.'));

const claudeResult = await triggerSessionLabelSuggestion({
  id: claudeSession.id,
  folder: tempHome,
  name: claudeSession.name,
  autoRenamePending: claudeSession.autoRenamePending,
  tool: 'fake-claude-bidi',
  model: 'fake-model',
}, (newName) => renameSession(claudeSession.id, newName));

const renamedClaude = await getSession(claudeSession.id);
assert.equal(claudeResult.ok, true, 'Claude bidi label suggestion should succeed through one-shot runtime');
assert.equal(claudeResult.rename.renamed, true, 'Claude bidi label suggestion should rename through the callback');
assert.equal(renamedClaude.name, 'Claude Rename Flow');
assert.equal(renamedClaude.autoRenamePending, false);

killAll();
chmodSync(inaccessibleFolder, 0o700);
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-label-oneshot-runtime: ok');
