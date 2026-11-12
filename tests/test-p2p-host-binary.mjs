import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveP2PHostBinary } from '../lib/p2p-host-binary.mjs';

const root = mkdtempSync(join(tmpdir(), 'agentoc-p2p-host-binary-'));
const bin = join(root, 'bin');
mkdirSync(bin);

const currentMachine = process.arch === 'x64' ? 0x3e : process.arch === 'arm64' ? 0xb7 : null;
if (currentMachine === null) {
  rmSync(root, { recursive: true, force: true });
  console.log(`test-p2p-host-binary: skipped on ${process.arch}`);
  process.exit(0);
}

const foreignMachine = currentMachine === 0x3e ? 0xb7 : 0x3e;
const writeElf = (path, machine) => {
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  header[18] = machine & 0xff;
  header[19] = machine >>> 8;
  writeFileSync(path, header);
  chmodSync(path, 0o755);
};

const writePe = (path, machine) => {
  const header = Buffer.alloc(128);
  header[0] = 0x4d;
  header[1] = 0x5a;
  header.writeUInt32LE(0x40, 0x3c);
  header.set([0x50, 0x45, 0, 0], 0x40);
  header.writeUInt16LE(machine, 0x44);
  writeFileSync(path, header);
  chmodSync(path, 0o755);
};

const canonical = join(bin, 'agentoc-p2p-host');
const variant = join(bin, 'agentoc-p2p-host-amd64');
const renamed = join(bin, 'ragent-p2p-host');

writeElf(canonical, currentMachine);
writeElf(variant, currentMachine);
writeElf(renamed, currentMachine);
assert.equal(resolveP2PHostBinary(root, { platform: 'linux' }), renamed, 'renamed package binary wins over a legacy binary');
rmSync(renamed);
assert.equal(resolveP2PHostBinary(root, { platform: 'linux' }), canonical, 'canonical package binary wins over a stale same-architecture variant');

writeElf(canonical, foreignMachine);
assert.equal(resolveP2PHostBinary(root, { platform: 'linux' }), variant, 'source checkout falls back to the matching architecture variant');

const windowsCanonical = join(bin, 'agentoc-p2p-host.exe');
const windowsVariant = join(bin, 'agentoc-p2p-host-amd64.exe');
const windowsRenamed = join(bin, 'ragent-p2p-host.exe');
writeElf(windowsCanonical, currentMachine);
writePe(windowsVariant, 0x8664);
assert.equal(
  resolveP2PHostBinary(root, { platform: 'win32', arch: 'x64' }),
  windowsVariant,
  'Windows must reject an ELF .exe and fall back to a matching PE variant',
);
writePe(windowsCanonical, 0x8664);
writePe(windowsRenamed, 0x8664);
assert.equal(resolveP2PHostBinary(root, { platform: 'win32', arch: 'x64' }), windowsRenamed, 'Windows prefers the renamed package binary');
rmSync(windowsRenamed);
assert.equal(
  resolveP2PHostBinary(root, { platform: 'win32', arch: 'x64' }),
  windowsCanonical,
  'Windows must prefer the canonical matching PE executable',
);
writePe(windowsCanonical, 0xaa64);
rmSync(windowsVariant, { force: true });
assert.throws(
  () => resolveP2PHostBinary(root, { platform: 'win32', arch: 'x64' }),
  /No compatible Windows P2P host PE32\+ executable found/,
  'Windows must fail closed when only a foreign-architecture PE remains',
);

const macVariant = join(bin, 'agentoc-p2p-host-darwin-arm64');
const mach = Buffer.alloc(32);
mach.writeUInt32LE(0xfeedfacf, 0);
mach.writeUInt32LE(0x0100000c, 4);
writeFileSync(macVariant, mach);
chmodSync(macVariant, 0o755);
assert.equal(resolveP2PHostBinary(root, { platform: 'darwin', arch: 'arm64' }), macVariant);
writeFileSync(canonical, mach);
assert.equal(resolveP2PHostBinary(root, { platform: 'linux', arch: 'x64' }), variant, 'Linux must reject a Mach-O binary');
assert.throws(() => resolveP2PHostBinary(root, { platform: 'darwin', arch: 'x64' }), /No compatible/);
rmSync(root, { recursive: true, force: true });
console.log('test-p2p-host-binary: 8 assertions passed');
