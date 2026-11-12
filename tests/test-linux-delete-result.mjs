import assert from 'node:assert/strict';
import { classifyLinuxDeleteNativeResult } from '../scripts/linux-target-inspection.mjs';

assert.deepEqual(classifyLinuxDeleteNativeResult({ code: 0, signal: null, stdout: '{"removed":true}\n' }), { state: 'completed' });
assert.deepEqual(classifyLinuxDeleteNativeResult({ code: 1, signal: null, stderr: 'SNAPSHOT_MISMATCH\n' }),
  { state: 'rejected', code: 'SNAPSHOT_MISMATCH' });
for (const result of [
  null,
  { uncertain: true },
  { code: 1, signal: null, stderr: 'DELETE_DURABILITY_UNKNOWN\n' },
  { code: 1, signal: null, stderr: 'DELETE_FAILED\n' },
  { code: 0, signal: null, stdout: 'invalid' },
  { code: 0, signal: null, stdout: '{"removed":true,"extra":1}' },
  { code: null, signal: 'SIGKILL', stderr: 'SNAPSHOT_MISMATCH' },
]) assert.deepEqual(classifyLinuxDeleteNativeResult(result), { state: 'unknown', code: 'LINUX_DELETE_RESULT_UNKNOWN' });
console.log('linux delete result: ambiguous outcomes remain unknown');
