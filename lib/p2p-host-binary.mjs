import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readElfMachine(path) {
  try {
    const header = readFileSync(path, { encoding: null, flag: 'r' });
    if (header.length < 20 || header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      return null;
    }
    return header[5] === 2
      ? (header[18] << 8) | header[19]
      : header[18] | (header[19] << 8);
  } catch {
    return null;
  }
}

function readPeMachine(path) {
  try {
    const header = readFileSync(path, { encoding: null, flag: 'r' });
    if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return null;
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 0 || peOffset + 6 > header.length) return null;
    if (header[peOffset] !== 0x50 || header[peOffset + 1] !== 0x45 || header[peOffset + 2] !== 0 || header[peOffset + 3] !== 0) return null;
    return header.readUInt16LE(peOffset + 4);
  } catch {
    return null;
  }
}

function expectedMachine(arch, platform) {
  if (platform === 'darwin') return arch === 'x64' ? 0x01000007 : arch === 'arm64' ? 0x0100000c : null;
  if (platform === 'win32') {
    return arch === 'x64'
      ? 0x8664
      : arch === 'arm64'
        ? 0xaa64
        : null;
  }
  return arch === 'x64'
    ? 0x3e
    : arch === 'arm64'
      ? 0xb7
      : null;
}

function isCompatibleExecutable(path, { platform = process.platform, arch = process.arch } = {}) {
  if (!isExecutable(path)) return false;
  const machine = platform === 'win32' ? readPeMachine(path) : platform === 'darwin' ? readMachMachine(path) : readElfMachine(path);
  const expected = expectedMachine(arch, platform);
  if (platform === 'win32') return machine !== null && machine === expected;
  return machine !== null && machine === expected;
}

function readMachMachine(path) {
  try {
    const header = readFileSync(path);
    if (header.length < 8) return null;
    if (header.readUInt32LE(0) === 0xfeedfacf) return header.readUInt32LE(4);
    if (header.readUInt32BE(0) === 0xfeedfacf) return header.readUInt32BE(4);
    return null;
  } catch { return null; }
}

// Source checkouts keep architecture-specific binaries next to the canonical
// package path. Debian packages install the selected binary as the canonical
// `bin/ragent-p2p-host`; prefer it when present so an orphaned architecture
// variant from an older package cannot shadow the newly installed Host.
export function resolveP2PHostBinary(root = SOURCE_ROOT, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'win32') {
    const canonical = join(root, 'bin/ragent-p2p-host.exe');
    const legacy = join(root, 'bin/agentoc-p2p-host.exe');
    const variant = arch === 'x64'
      ? join(root, 'bin/agentoc-p2p-host-amd64.exe')
      : arch === 'arm64'
        ? join(root, 'bin/agentoc-p2p-host-arm64.exe')
        : '';
    if (isCompatibleExecutable(canonical, { platform, arch })) return canonical;
    if (isCompatibleExecutable(legacy, { platform, arch })) return legacy;
    if (variant && variant !== canonical && isCompatibleExecutable(variant, { platform, arch })) return variant;
    throw new Error(`No compatible Windows P2P host PE32+ executable found at ${canonical}`);
  }
  const canonical = join(root, 'bin/ragent-p2p-host');
  const legacy = join(root, 'bin/agentoc-p2p-host');
  const variant = platform === 'darwin'
    ? join(root, `bin/agentoc-p2p-host-darwin-${arch}`)
    : arch === 'x64'
    ? join(root, 'bin/agentoc-p2p-host-amd64')
    : arch === 'arm64'
      ? join(root, 'bin/agentoc-p2p-host')
      : '';
  if (isCompatibleExecutable(canonical, { platform, arch })) return canonical;
  if (isCompatibleExecutable(legacy, { platform, arch })) return legacy;
  if (variant && variant !== canonical && isCompatibleExecutable(variant, { platform, arch })) return variant;
  throw new Error(`No compatible ${platform}/${arch} P2P host executable found at ${canonical}`);
}
