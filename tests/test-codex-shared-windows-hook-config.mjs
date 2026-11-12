import assert from 'node:assert/strict';
import { buildSharedCodexWindowsHook } from '../chat/codex-shared-windows-hook.mjs';

const socketPath = '\\\\.\\pipe\\agentoc-codex-fixture';
const hook = buildSharedCodexWindowsHook({ socketPath, nodePath: "G:\\Apps O'Brien\\node.exe", scriptPath: 'G:\\Ragent\\hook.mjs', systemDrive: 'C:' });
assert.equal(hook.sourcePath, 'C:\\<session-flags>\\config.toml');
assert.equal(hook.source, 'sessionFlags');
assert.equal(hook.shared, true);
assert.match(hook.command, /O''Brien/);
assert.equal(hook.args[0], '-c');
assert.ok(hook.args[1].includes(JSON.stringify(hook.command)));
for (const invalid of ['', 'bad-pipe', `${socketPath}\nother`]) {
  assert.throws(() => buildSharedCodexWindowsHook({ socketPath: invalid, nodePath: 'G:\\node.exe', scriptPath: 'G:\\hook.mjs' }));
}
console.log('test-codex-shared-windows-hook-config: fixed hook identity and quoting');
