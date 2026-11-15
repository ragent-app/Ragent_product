#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'ragent-label-context-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'ragent');
const memoryDir = join(tempHome, '.ragent', 'memory');
const workDir = join(tempHome, '.ragent', 'workspace');
const promptLogPath = join(tempHome, 'label-prompt.log');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

writeFileSync(
  join(memoryDir, 'projects.md'),
  `# Scope Router

## Ragent

- Type: code repo
- Path: \`~/code/ragent/\`
- Triggers: Ragent, session rename, sidebar hierarchy, prompt tuning
- First read: \`~/code/ragent/AGENTS.md\`

## Media Workflow

- Type: recurring non-repo domain
- Paths: \`~/my_docs/Media/\`, \`~/movies/\`
- Triggers: media, rough cut, transcript, review
- First read: \`~/.ragent/skills/media-review.md\`
`,
  'utf8',
);

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
const hasInlineLabels = prompt.includes('Session presentation metadata (hidden protocol)');
const delayMs = 120;

if (hasInlineLabels && process.env.PROMPT_LOG_FILE) {
  fs.appendFileSync(process.env.PROMPT_LOG_FILE, prompt + String.fromCharCode(10) + '---PROMPT---' + String.fromCharCode(10), 'utf8');
}

const text = hasInlineLabels
  ? 'main task finished\\n<ragent-session-labels>{"schemaVersion":1,"title":"Ragent Prompt Tuning","group":"Ragent","description":"Tune the auto-rename prompt using session history and scope hints."}</ragent-session-labels>'
  : 'main task finished';

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
        command: fakeCodexPath,
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
process.env.RAGENT_MEMORY_DIR = memoryDir;
process.env.RAGENT_WORK_ROOT_DIR = workDir;
process.env.RAGENT_DISABLE_SYSTEMD_DETACHED_RUNNER = '1';
process.env.PATH = `${tempBin}:${process.env.PATH}`;
process.env.PROMPT_LOG_FILE = promptLogPath;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;
const { setContextHead } = history;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}

async function safeRm(target, attempts = 6, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs * (i + 1));
    }
  }
  rmSync(target, { recursive: true, force: true });
}

try {
  await createSession(tempHome, 'fake-codex', 'Naming Flow', {
    group: 'Ragent',
    description: 'Refactor session naming and grouping.',
  });
  await createSession(tempHome, 'fake-codex', 'Rough Cut Review', {
    group: 'Video Workflow',
    description: 'Review edit decisions for the current draft.',
  });

  const target = await createSession(tempHome, 'fake-codex', '');
  await setContextHead(target.id, {
    mode: 'summary',
    summary: 'This conversation is about Ragent session grouping, rename prompts, and keeping related work under the same top-level project.',
    activeFromSeq: 0,
    compactedThroughSeq: 0,
    updatedAt: new Date().toISOString(),
    source: 'test',
  });

  await sendMessage(target.id, 'Make it feel natural and avoid creating a brand new group every time.', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const current = await getSession(target.id);
      return current?.name === 'Prompt Tuning'
        && current?.group === 'Ragent'
        && current?.description === 'Tune the auto-rename prompt using session history and scope hints.';
    },
    'session should apply inline labels from the foreground turn',
  );

  const promptLog = readFileSync(promptLogPath, 'utf8');
  assert.match(promptLog, /Session presentation metadata \(hidden protocol\)/);
  assert.match(promptLog, /<ragent-session-labels>/);
  assert.match(promptLog, /Make it feel natural and avoid creating a brand new group every time\./);
  assert.equal(
    (promptLog.match(/---PROMPT---/g) || []).length,
    1,
    'title generation must reuse the foreground Run instead of launching a second harness',
  );

  await waitFor(
    async () => (await getSession(target.id))?.activity?.run?.state === 'idle',
    'session should finish running',
  );

  console.log('test-session-label-prompt-context: ok');
} finally {
  killAll();
  await safeRm(tempHome);
}
