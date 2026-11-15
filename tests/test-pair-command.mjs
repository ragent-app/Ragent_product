#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSpawnSpecFromResolvedPath } from '../lib/executable-resolution.mjs';
import { renderQr } from '../lib/pair-command.mjs';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? ` :: ${detail}` : ''}`);
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.input = '';
  child.stdin = {
    end(value) {
      child.input = String(value);
    },
  };
  return child;
}

{
  const calls = [];
  const child = createFakeChild();
  const rendered = await renderQr('ragent://pair?value=1', 'qrcode-terminal', {
    resolveCommand: async (command) => {
      check('pair QR resolves the requested command', command === 'qrcode-terminal');
      return 'C:\\tools\\qrcode-terminal.cmd';
    },
    buildSpawnSpec: buildSpawnSpecFromResolvedPath,
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      queueMicrotask(() => {
        child.stdout.end('QR-OUTPUT\n');
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  });

  check('pair QR returns renderer stdout', rendered === 'QR-OUTPUT\n');
  check('pair QR sends the URI through stdin', child.input === 'ragent://pair?value=1\n');
  check('pair QR uses cmd.exe for a Windows .cmd shim', calls[0]?.file === 'C:\\Windows\\System32\\cmd.exe');
  check('pair QR preserves the fixed cmd wrapper argv', JSON.stringify(calls[0]?.args) === JSON.stringify([
    '/d', '/s', '/c', '""C:\\tools\\qrcode-terminal.cmd""',
  ]));
  check('pair QR disables shell execution', calls[0]?.options?.shell === false);
  check('pair QR preserves Windows verbatim argv', calls[0]?.options?.windowsVerbatimArguments === true);
}

{
  await assert.rejects(
    () => renderQr('payload', 'missing-qrcode-terminal', {
      resolveCommand: async () => null,
    }),
    (error) => error?.code === 'QR_RENDERER_NOT_FOUND',
  );
  passed += 1;
}

if (process.platform !== 'win32') {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ragent-pair-command-'));
  const command = join(tempRoot, 'qrcode-terminal');
  writeFileSync(command, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => process.stdout.write('REAL:' + input.trim() + '\\n'));
`);
  chmodSync(command, 0o755);
  try {
    const rendered = await renderQr('ragent://pair?real=1', command);
    check('pair QR invokes a real POSIX renderer', rendered === 'REAL:ragent://pair?real=1\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

console.log(`test-pair-command: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
