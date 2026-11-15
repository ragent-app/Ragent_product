/**
 * Fixed-argv Windows package adapters.
 *
 * Builders only derive invocations from a signed semantic capability. They do
 * not execute anything. Execution remains disabled until a Windows executor
 * provides peer identity, service, ACL, and package revalidation primitives.
 */

import { discoverWindowsWinget } from './windows-winget-discovery.mjs';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';
import path from 'node:path';

// Non-Windows processes use this module for offline policy tests. On Windows,
// never manufacture a C: system root when the installation facts are missing.
const SYSTEM_ROOT = resolveWindowsSystemPaths()?.root || (process.platform === 'win32' ? '' : 'C:\\Windows');

export const SEMANTIC_ADAPTER_WINGET_INSTALL_V1 = 'windows-winget-install/v1';
export const SEMANTIC_ADAPTER_MSI_INSTALL_V1 = 'windows-msi-install/v1';
// The executable is server-owned configuration (fixed-argv invariant: never a
// requester-provided executable). Defaults are the canonical system paths; a
// deployment where winget/msiexec live elsewhere (e.g. WindowsApps only, or a
// non-standard install) overrides via env without touching the invocation
// grammar.
//
// Security (adversarial acceptance I-3/I-4): the override is read only from
// the trusted process environment (systemd EnvironmentFile on the privileged
// executor; the transport's allowlisted spawn env), never from a request
// payload or CLI argument — the adapters never accept an executable from the
// caller. The value must be an absolute drive-rooted Windows path; a relative,
// UNC, or syntactically invalid override fails closed at import (service will
// not start with a bad deployment value). Existence + executability are
// enforced at the point of use: revalidation and dispatch execFile the path,
// and a missing/non-executable binary fails closed.
export const WINGET_EXECUTABLE = resolveConfiguredExecutable(
  'RAGENT_WINGET_EXECUTABLE',
  SYSTEM_ROOT ? path.win32.join(SYSTEM_ROOT, 'System32', 'winget.exe') : '',
);
export const MSIEXEC_EXECUTABLE = resolveConfiguredExecutable(
  'RAGENT_MSIEXEC_EXECUTABLE',
  SYSTEM_ROOT ? path.win32.join(SYSTEM_ROOT, 'System32', 'msiexec.exe') : '',
);

function resolveConfiguredExecutable(envKey, defaultPath) {
  const candidate = trimString(process.env?.[envKey]) || defaultPath;
  if (!candidate) return '';
  if (!/^[A-Za-z]:\\[^:*?"<>|]+$/i.test(candidate)) {
    throw new Error(`${envKey} must be an absolute Windows executable path`);
  }
  return candidate;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(error) {
  const result = new Error(error);
  result.code = 'SEMANTIC_WINDOWS_ADAPTER_DENIED';
  throw result;
}

function safePackageId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimString(value));
}

function safeVersion(value) {
  return !value || /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/.test(trimString(value));
}

function verifiedWingetSource(output) {
  let source;
  try { source = JSON.parse(String(output || '').trim()); } catch { return false; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const trust = Array.isArray(source.TrustLevel) ? source.TrustLevel : String(source.TrustLevel || '').split('|');
  let endpoint;
  try { endpoint = new URL(source.Arg); } catch { return false; }
  return source.Name === 'winget' && source.Type === 'Microsoft.PreIndexed.Package'
    && source.Identifier === 'Microsoft.Winget.Source_8wekyb3d8bbwe'
    && trust.some((entry) => String(entry).trim().toLowerCase() === 'trusted')
    && endpoint.protocol === 'https:' && (endpoint.hostname === 'winget.microsoft.com' || endpoint.hostname.endsWith('.winget.microsoft.com'))
    && !endpoint.username && !endpoint.password && (!endpoint.port || endpoint.port === '443');
}

function outputHasPackage(output, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[${escaped}\\]`, 'i').test(String(output || ''));
}

async function verifiedSourceForExecutable(executable, execFile) {
  const result = await execFile(executable, ['source', 'export', 'winget', '--disable-interactivity'], { cwd: SYSTEM_ROOT, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  return verifiedWingetSource(result?.stdout);
}

async function resolveTrustedWingetExecutable(execFile, resolveExecutable) {
  const resolver = resolveExecutable || (process.env.RAGENT_WINGET_EXECUTABLE
    ? async () => WINGET_EXECUTABLE
    : () => discoverWindowsWinget({ execFile }));
  const executable = await resolver();
  if (typeof executable !== 'string' || !/^[A-Za-z]:\\[^:*?"<>|]+$/i.test(executable)) throw new Error('invalid winget executable');
  return executable;
}

// Resolve a single exact package before capability construction. The version
// table is interpreted structurally (not by translated headings); ambiguous
// output remains unresolved. The manager/source and executable are server-owned.
export async function getWindowsWingetPackageFacts({ manager, packages, requestedVersion = '' } = {}, { execFile, resolveExecutable } = {}) {
  if (manager !== 'winget' || !Array.isArray(packages) || packages.length !== 1
      || !safePackageId(packages[0]) || !safeVersion(requestedVersion) || typeof execFile !== 'function' || !SYSTEM_ROOT) return null;
  try {
    const executable = await resolveTrustedWingetExecutable(execFile, resolveExecutable);
    if (!await verifiedSourceForExecutable(executable, execFile)) return null;
    const argv = ['show', '--id', packages[0], '--exact', '--source', 'winget'];
    if (requestedVersion) argv.push('--version', requestedVersion); else argv.push('--versions');
    argv.push('--disable-interactivity', '--accept-source-agreements');
    const result = await execFile(executable, argv, { cwd: SYSTEM_ROOT, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const output = String(result?.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
    if (!outputHasPackage(output, packages[0])) return null;
    let version = requestedVersion;
    if (!version) {
      const lines = output.split(/\r?\n/);
      const divider = lines.findIndex((line) => /^\s*-{3,}(?:\s+-+)*\s*$/.test(line));
      const row = divider < 0 ? '' : (lines.slice(divider + 1).find((line) => line.trim()) || '').trim();
      version = row.split(/\s+/)[0] || '';
      if (!version || !safeVersion(version)) return null;
    }
    return { manager: 'winget', source: 'winget', sourceTrust: 'configured',
      packages: [{ name: packages[0], requestedVersion, availableVersion: version }],
      repositories: [{ id: 'winget', trust: 'configured' }] };
  } catch { return null; }
}

function validateOperation(entry, adapter, predicate) {
  if (!entry || entry.platform !== 'win32' || entry.primaryAction !== 'package.install'
    || entry.executionClass !== 'host'
    || JSON.stringify([...(entry.effects || [])].map(trimString).sort()) !== JSON.stringify(['process.execute'])
    || !predicate(entry.adapterInput || {})) {
    fail(`Operation is not supported by ${adapter}`);
  }
}

export function buildWindowsWingetInstallInvocation(capability = {}) {
  if (!SYSTEM_ROOT || !WINGET_EXECUTABLE) fail('Windows system installation path is unavailable');
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_WINGET_INSTALL_V1) fail('Unsupported Windows adapter');
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  // winget's install grammar is single-id. Do not concatenate multiple
  // owner selections into an ambiguous argv; a future batch adapter can issue
  // one independently revalidated invocation per package.
  if (operations.length !== 1) fail('winget adapter accepts exactly one package');
  const inputs = operations.map((entry) => {
    validateOperation(entry, SEMANTIC_ADAPTER_WINGET_INSTALL_V1, (input) => (
      input.manager === 'winget'
      && input.source === 'winget'
      && input.requestedInstallScope === 'machine'
      && input.exact === true
      && Array.isArray(input.packages)
      && input.packages.length === 1
      && input.packages.every(safePackageId)
      && Array.isArray(input.requestedVersions)
      && input.requestedVersions.length === 1
      && input.requestedVersions.every(safeVersion)
      && Array.isArray(input.resolvedVersions)
      && input.resolvedVersions.length === 1
      && input.resolvedVersions.every((value) => trimString(value) && safeVersion(value))
      && input.sourceTrust === 'configured'
    ));
    return entry.adapterInput;
  });
  const argv = ['install'];
  for (const input of inputs) {
    argv.push('--id', input.packages[0], '--exact', '--source', 'winget');
    if (input.resolvedVersions[0]) argv.push('--version', input.resolvedVersions[0]);
  }
  // The broker runs without an interactive desktop; an installer prompt here
  // would leave an unattended run hanging indefinitely.
  argv.push('--scope', 'machine', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements');
  return { executable: WINGET_EXECUTABLE, argv, cwd: SYSTEM_ROOT };
}

// This only builds argv. The caller must verify the signed capability and
// revalidate package/source facts, discover the Microsoft-signed executable,
// and execute under the ordinary run identity before using the result.
export function buildWindowsUserWingetInstallInvocation(capability = {}, { executable = '', cwd = '' } = {}) {
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_WINGET_INSTALL_V1) fail('Unsupported Windows adapter');
  const normalizedExecutable = path.win32.normalize(trimString(executable));
  const normalizedCwd = path.win32.normalize(trimString(cwd));
  if (!/^[A-Za-z]:\\/.test(normalizedExecutable) || path.win32.basename(normalizedExecutable).toLowerCase() !== 'winget.exe'
      || !/^[A-Za-z]:\\/.test(normalizedCwd)) fail('User installation executable or working directory is unavailable');
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  if (operations.length !== 1) fail('winget adapter accepts exactly one package');
  validateOperation(operations[0], SEMANTIC_ADAPTER_WINGET_INSTALL_V1, (input) => (
    input.manager === 'winget' && input.source === 'winget' && input.sourceTrust === 'configured' && input.exact === true
    && ['', 'user'].includes(input.requestedInstallScope)
    && Array.isArray(input.packages) && input.packages.length === 1 && input.packages.every(safePackageId)
    && Array.isArray(input.requestedVersions) && input.requestedVersions.length === 1 && input.requestedVersions.every(safeVersion)
    && Array.isArray(input.resolvedVersions) && input.resolvedVersions.length === 1
    && input.resolvedVersions.every((value) => trimString(value) && safeVersion(value))
  ));
  const input = operations[0].adapterInput;
  const argv = ['install', '--id', input.packages[0], '--exact', '--source', 'winget', '--version', input.resolvedVersions[0]];
  if (input.requestedInstallScope === 'user') argv.push('--scope', 'user');
  argv.push('--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements');
  return { executable: normalizedExecutable, argv, cwd: normalizedCwd };
}

export function buildWindowsMsiInstallInvocation(capability = {}) {
  if (!SYSTEM_ROOT || !MSIEXEC_EXECUTABLE) fail('Windows system installation path is unavailable');
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_MSI_INSTALL_V1) fail('Unsupported Windows adapter');
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  if (operations.length !== 1) fail('MSI adapter accepts exactly one artifact');
  const entry = operations[0];
  validateOperation(entry, SEMANTIC_ADAPTER_MSI_INSTALL_V1, (input) => (
    input.manager === 'msiexec'
    && input.source === 'local_artifact'
    && typeof input.artifactPath === 'string'
    && /^([A-Za-z]):\\[^:*?"<>|]+$/i.test(input.artifactPath)
    && /^[0-9a-f]{64}$/.test(trimString(input.artifactDigest))
  ));
  return {
    executable: MSIEXEC_EXECUTABLE,
    argv: ['/i', entry.adapterInput.artifactPath, '/qn', '/norestart'],
    cwd: SYSTEM_ROOT,
  };
}

export async function revalidateWindowsWingetInstall(capability, { execFile, resolveExecutable } = {}) {
  if (typeof execFile !== 'function') return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'winget metadata revalidation provider is required' };
  if (capability?.operations?.some((entry) => entry?.adapterInput?.selectedInstaller)) return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'selected installer execution binding is unavailable' };
  let invocation;
  try { invocation = buildWindowsWingetInstallInvocation(capability); } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
  try {
    // The trusted service may pin a configured binary. Otherwise, discover the
    // signed App Installer package rather than assuming System32 contains it.
    invocation.executable = await resolveTrustedWingetExecutable(execFile, resolveExecutable);
  } catch (error) {
    return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: error?.message || 'verified winget executable unavailable' };
  }
  try {
    if (!await verifiedSourceForExecutable(invocation.executable, execFile)) return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'winget source identity is unverified' };
  } catch (error) {
    return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: error?.message || 'winget source is unavailable' };
  }
  for (const entry of capability.operations) {
    const input = entry.adapterInput;
    try {
      const result = await execFile(invocation.executable, ['show', '--id', input.packages[0], '--exact', '--source', 'winget', '--version', input.resolvedVersions[0], '--disable-interactivity', '--accept-source-agreements'], { cwd: SYSTEM_ROOT, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
      const output = String(result?.stdout || '');
      // The exact ID and pinned version are enforced by winget's arguments.
      // Do not parse translated field labels; the stable [package.id] marker
      // confirms a single package was displayed rather than an empty result.
      if (!outputHasPackage(output, input.packages[0])) {
        return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: `winget metadata changed for ${input.packages[0]}` };
      }
    } catch (error) {
      return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: error?.message || String(error) };
    }
  }
  return { ok: true, invocation };
}

export async function revalidateWindowsUserWingetInstall(capability, { execFile, resolveExecutable, cwd = '' } = {}) {
  if (typeof execFile !== 'function') return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'winget metadata revalidation provider is required' };
  if (capability?.operations?.some((entry) => entry?.adapterInput?.selectedInstaller)) return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'selected installer execution binding is unavailable' };
  try {
    // The ordinary Run environment is not trusted deployment configuration.
    const executable = await resolveTrustedWingetExecutable(execFile,
      resolveExecutable || (() => discoverWindowsWinget({ execFile })));
    const invocation = buildWindowsUserWingetInstallInvocation(capability, { executable, cwd });
    if (!await verifiedSourceForExecutable(executable, execFile)) {
      return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'winget source identity is unverified' };
    }
    const input = capability.operations[0].adapterInput;
    const result = await execFile(executable, ['show', '--id', input.packages[0], '--exact', '--source', 'winget',
      '--version', input.resolvedVersions[0], '--disable-interactivity', '--accept-source-agreements'],
    { cwd: invocation.cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (!outputHasPackage(String(result?.stdout || ''), input.packages[0])) {
      return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'winget package metadata changed' };
    }
    return { ok: true, invocation };
  } catch (error) {
    return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: error?.message || 'winget revalidation failed' };
  }
}

export async function revalidateWindowsMsiInstall(capability, { artifactFacts } = {}) {
  if (typeof artifactFacts !== 'function') return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'MSI artifact revalidation provider is required' };
  let invocation;
  try { invocation = buildWindowsMsiInstallInvocation(capability); } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
  const input = capability.operations[0].adapterInput;
  const current = await artifactFacts(input.artifactPath).catch(() => null);
  if (!current || trimString(current.identity) !== trimString(input.artifactIdentity)
    || trimString(current.digest).toLowerCase() !== trimString(input.artifactDigest).toLowerCase()) {
    return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'MSI artifact identity or digest changed' };
  }
  return { ok: true, invocation };
}
