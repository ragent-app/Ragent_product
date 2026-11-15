#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-rename-fallback-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'ragent');
const workRoot = join(tempHome, 'workspace');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(workRoot, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const delayMs = 120;
const text = 'main task finished\\n<ragent-session-labels>{bad json}</ragent-session-labels>';

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'run-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delayMs);
setTimeout(() => process.exit(0), delayMs + 20);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
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
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);

async function waitFor(predicate, description, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

const session = await createSession(tempHome, 'fake-codex', '');

await sendMessage(session.id, 'Refactor the naming flow so automatic rename failures do not show as user-facing errors.', [], {
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
  'session should finish running',
);

await waitFor(
  async () => {
    const current = await getSession(session.id);
    return current?.name === 'Refactor the naming flow…'
      && current?.autoRenamePending === true
      && current?.activity?.rename?.state === 'idle';
  },
  'session should retain retry eligibility without a rename failure state',
);

const finished = await getSession(session.id);
assert.equal(finished.name, 'Refactor the naming flow…', 'semantic provisional title should be retained as the fallback');
assert.equal(finished.autoRenamePending, true, 'failed generation should remain eligible for a later retry');
assert.equal(finished.activity.rename.state, 'idle', 'failed generation should not expose a rename failure state');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-rename-fallback: ok');
