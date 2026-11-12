import assert from 'node:assert/strict';
import { createLinuxTargetBinding, hashLinuxTargetBinding } from '../chat/linux-target-binding.mjs';

const snapshot = {
  version: 1,
  mountId: '18446744073709551615',
  parentDevice: '2049',
  parentInode: '9007199254740993',
  device: '2049',
  inode: '9007199254740995',
  size: '9223372036854775807',
  ctimeSeconds: '-9223372036854775808',
  ctimeNanoseconds: '999999999',
  mtimeSeconds: '9223372036854775807',
  mtimeNanoseconds: '0',
};
const target = '/var/lib/example/fixture';
const binding = createLinuxTargetBinding(target, snapshot);
assert.equal(binding.inode, '9007199254740995');
assert.equal(binding.mountId, '18446744073709551615');
const original = hashLinuxTargetBinding(target, snapshot);
assert.match(original, /^[a-f0-9]{64}$/);
assert.notEqual(original, hashLinuxTargetBinding('/var/lib/example/other', snapshot));
for (const field of Object.keys(snapshot).filter((key) => key !== 'version')) {
  const value = field.endsWith('Nanoseconds') ? '1' : '2';
  assert.notEqual(original, hashLinuxTargetBinding(target, { ...snapshot, [field]: value }), field);
}
for (const invalidPath of ['', '/', 'relative', '/a/../b', '/a//b', '/a/', '/a/./b', '/a/\nfoo', '/a/\ud800', '/a/\udc00', '/' + 'a'.repeat(4095)]) {
  assert.throws(() => createLinuxTargetBinding(invalidPath, snapshot), { code: 'LINUX_TARGET_BINDING_INVALID' });
}
assert.equal(createLinuxTargetBinding('/a/\ud83d\ude00', snapshot).path, '/a/\ud83d\ude00');
for (const invalid of [
  { ...snapshot, inode: 9007199254740995 },
  { ...snapshot, inode: '01' },
  { ...snapshot, inode: '0' },
  { ...snapshot, mountId: '18446744073709551616' },
  { ...snapshot, size: '-1' },
  { ...snapshot, ctimeSeconds: '-0' },
  { ...snapshot, ctimeSeconds: '-9223372036854775809' },
  { ...snapshot, mtimeNanoseconds: '1000000000' },
  { ...snapshot, version: 2 },
  { ...snapshot, extra: 'ignored' },
  Object.assign(Object.create({ version: 1 }), Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'version')), { extra: 1 }),
  Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'device')),
]) {
  assert.throws(() => createLinuxTargetBinding(target, invalid), { code: 'LINUX_TARGET_BINDING_INVALID' });
}
console.log('linux target binding: canonical identity checks passed');
