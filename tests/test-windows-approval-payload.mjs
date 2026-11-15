import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WINDOWS_APPROVAL_PAYLOAD_FILES, verifyWindowsApprovalPayload } from '../scripts/verify-windows-approval-payload.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'ragent-approval-payload-'));
try {
for (const file of WINDOWS_APPROVAL_PAYLOAD_FILES) {
  const target = path.join(root, ...file.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'fixture');
}
await verifyWindowsApprovalPayload(root);
const missing = 'scripts/ragent-codex-windows-install-hook.mjs';
await unlink(path.join(root, ...missing.split('/')));
await assert.rejects(verifyWindowsApprovalPayload(root), /ragent-codex-windows-install-hook/);
await writeFile(path.join(root, ...missing.split('/')), 'fixture');
await unlink(path.join(root, 'chat', 'windows-user-install-store.mjs'));
await assert.rejects(verifyWindowsApprovalPayload(root), /windows-user-install-store/);
await writeFile(path.join(root, 'chat', 'windows-user-install-store.mjs'), 'fixture');
await unlink(path.join(root, 'lib', 'windows-owner-identity-paths.mjs'));
await assert.rejects(verifyWindowsApprovalPayload(root), /windows-owner-identity-paths/);
await writeFile(path.join(root, 'lib', 'windows-owner-identity-paths.mjs'), 'fixture');
await unlink(path.join(root, 'lib', 'windows-owner-os-paths.mjs'));
await assert.rejects(verifyWindowsApprovalPayload(root), /windows-owner-os-paths/);
console.log('windows-approval-payload: incomplete package is rejected');
} finally {
  const actualRoot = await realpath(root);
  const actualParent = await realpath(tmpdir());
  assert.equal(path.dirname(actualRoot).toLowerCase(), actualParent.toLowerCase());
  assert.ok(path.basename(actualRoot).startsWith('ragent-approval-payload-'));
  await rm(actualRoot, { recursive: true, force: true });
}
