/**
 * Server-owned Windows runtime facts provider.
 *
 * The provider has one host boundary: an absolute, system PowerShell binary
 * invoked with a fixed encoded script. Dynamic values are environment values,
 * never PowerShell source or a shell command. Every response is one JSON value
 * and malformed, ambiguous, or incomplete output fails closed.
 */

import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { getWindowsWingetPackageFacts } from './semantic-windows-adapter.mjs';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

const defaultExecFile = promisify(execFileCallback);

export const WINDOWS_RUNTIME_FACTS_PROVIDER_VERSION = 'windows-runtime-facts/v1';
const systemPaths = resolveWindowsSystemPaths();
export const WINDOWS_POWERSHELL_CWD = systemPaths?.system32 || '';
export const WINDOWS_POWERSHELL_EXECUTABLE = systemPaths?.powershell || '';
export const WINDOWS_FACTS_TIMEOUT_MS = 5_000;

const WINDOWS_FACTS_ENV = Object.freeze(systemPaths?.env || { LANG: 'C' });

const POWERSHELL_PREFIX = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
]);

// This C# is part of the fixed provider script. It obtains the NT identity
// and final path without calling an external helper or any caller-controlled
// executable. Failure to obtain either fact is an unresolved resource.
const WINDOWS_NATIVE_HELPER = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class RagentWindowsFacts {
  private const uint GENERIC_READ = 0x80000000;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint FILE_SHARE_DELETE = 0x00000004;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public uint CreationTimeLow;
    public uint CreationTimeHigh;
    public uint LastAccessTimeLow;
    public uint LastAccessTimeHigh;
    public uint LastWriteTimeLow;
    public uint LastWriteTimeHigh;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFile(
    string name, uint access, uint share, IntPtr security, uint creation,
    uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    IntPtr handle, out BY_HANDLE_FILE_INFORMATION info);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(
    IntPtr handle, System.Text.StringBuilder path, uint length, uint flags);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static string[] Identity(string path) {
    IntPtr handle = CreateFile(path, GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) return null;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) return null;
      ulong fileId = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
      return new[] {
        info.VolumeSerialNumber.ToString("x8"),
        fileId.ToString("x16"),
      };
    } finally {
      CloseHandle(handle);
    }
  }

  public static string FinalPath(string path) {
    IntPtr handle = CreateFile(path, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == INVALID_HANDLE_VALUE) return null;
    try {
      var buffer = new System.Text.StringBuilder(32768);
      uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
      if (length == 0 || length >= buffer.Capacity) return null;
      return buffer.ToString(0, (int)length);
    } finally {
      CloseHandle(handle);
    }
  }
}
'@
function Get-Hash([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}
function Normalize-FinalPath([string]$Value) {
  if ($Value.StartsWith('\\?\UNC\')) { return ('\\' + $Value.Substring(8)) }
  if ($Value.StartsWith('\\?\')) { return $Value.Substring(4) }
  return $Value
}
`;

const PATH_REALPATH_SCRIPT = String.raw`${WINDOWS_NATIVE_HELPER}
$path = $env:RAGENT_FACTS_PATH
try { $null = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { @{ platform = 'win32'; notFound = $true } | ConvertTo-Json -Compress; return }
$final = [RagentWindowsFacts]::FinalPath($path)
if ([string]::IsNullOrWhiteSpace($final)) { throw 'Windows final path unavailable' }
[ordered]@{ platform = 'win32'; canonicalPath = (Normalize-FinalPath $final) } | ConvertTo-Json -Compress
`;

const PATH_STAT_SCRIPT = String.raw`${WINDOWS_NATIVE_HELPER}
$path = $env:RAGENT_FACTS_PATH
try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop }
catch [System.Management.Automation.ItemNotFoundException] { @{ platform = 'win32'; notFound = $true } | ConvertTo-Json -Compress; return }
$identity = [RagentWindowsFacts]::Identity($item.FullName)
if ($null -eq $identity) { throw 'Windows file identity unavailable' }
$final = [RagentWindowsFacts]::FinalPath($item.FullName)
if ([string]::IsNullOrWhiteSpace($final)) { throw 'Windows final path unavailable' }
$attributes = [IO.File]::GetAttributes($item.FullName)
$type = if ($item.PSIsContainer) { 'dir' } elseif ($item -is [IO.FileInfo]) { 'file' } else { 'other' }
$size = if ($type -eq 'file') { [int64]$item.Length } else { 0 }
[ordered]@{
  platform = 'win32'
  canonicalPath = (Normalize-FinalPath $final)
  type = $type
  size = $size
  reparsePoint = (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  volumeSerial = $identity[0]
  fileId = $identity[1]
  identity = ($identity[0] + ':' + $identity[1])
} | ConvertTo-Json -Compress
`;

const DIRECTORY_SCRIPT = String.raw`${WINDOWS_NATIVE_HELPER}
$path = $env:RAGENT_FACTS_PATH
$items = @(Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop | ForEach-Object {
  $attributes = [IO.File]::GetAttributes($_.FullName)
  [ordered]@{
    name = $_.Name
    type = if ($_.PSIsContainer) { 'dir' } elseif ($_ -is [IO.FileInfo]) { 'file' } else { 'other' }
    reparsePoint = (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  }
})
ConvertTo-Json -InputObject $items -Compress
`;

// Fixed script: SHA-256 digest of a file by absolute path (env value, never
// PowerShell source). The MSI adapter's artifact revalidation requires this.
const ARTIFACT_DIGEST_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$p = $env:RAGENT_FACTS_PATH
try {
  $hash = Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop
  [ordered]@{ exists = $true; digest = $hash.Hash.ToLower() } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ exists = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

const SERVICE_SCRIPT = String.raw`${WINDOWS_NATIVE_HELPER}
$name = $env:RAGENT_SERVICE_NAME
$matches = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | Where-Object { $_.Name -ceq $name })
if ($matches.Count -gt 1) { throw 'Ambiguous Windows service identity' }
if ($matches.Count -eq 0) {
  [ordered]@{ platform = 'win32'; manager = 'windows-service'; serviceName = $name; exists = $false; definitionHash = '' } | ConvertTo-Json -Compress
  exit 0
}
$service = $matches[0]
$definition = [ordered]@{
  name = [string]$service.Name
  displayName = [string]$service.DisplayName
  description = [string]$service.Description
  pathName = [string]$service.PathName
  startMode = [string]$service.StartMode
  startName = [string]$service.StartName
  serviceType = [string]$service.ServiceType
  desktopInteract = [bool]$service.DesktopInteract
  errorControl = [string]$service.ErrorControl
  delayedAutoStart = [bool]$service.DelayedAutoStart
}
$definitionJson = $definition | ConvertTo-Json -Compress
[ordered]@{
  platform = 'win32'
  manager = 'windows-service'
  serviceName = [string]$service.Name
  exists = $true
  definitionHash = (Get-Hash $definitionJson)
} | ConvertTo-Json -Compress
`;

const ACL_SCRIPT = String.raw`${WINDOWS_NATIVE_HELPER}
$path = $env:RAGENT_FACTS_PATH
$item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
$acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
$sddl = [string]$acl.Sddl
if ([string]::IsNullOrWhiteSpace($sddl)) { throw 'Windows ACL descriptor unavailable' }
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$final = [RagentWindowsFacts]::FinalPath($item.FullName)
if ([string]::IsNullOrWhiteSpace($final)) { throw 'Windows ACL canonical path unavailable' }
[ordered]@{
  platform = 'win32'
  provider = 'windows-acl'
  canonicalPath = (Normalize-FinalPath $final)
  ownerSid = [string]$owner
  protected = [bool]$acl.AreAccessRulesProtected
  descriptorHash = (Get-Hash $sddl)
} | ConvertTo-Json -Compress
`;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertWindowsPath(value) {
  const input = trimString(value);
  const lower = input.toLowerCase();
  if (!input || input.includes('\0') || !path.win32.isAbsolute(input)
    || lower.startsWith('hk') || lower.startsWith('\\\\.\\')
    || lower.startsWith('\\\\?\\globalroot\\')) {
    throw fail('WINDOWS_FACTS_INPUT_INVALID', 'Windows facts require an absolute filesystem path');
  }
  return input;
}

function assertServiceName(value) {
  const input = trimString(value);
  if (!input || input.includes('\0') || input.includes('\r') || input.includes('\n') || input.length > 256) {
    throw fail('WINDOWS_FACTS_INPUT_INVALID', 'Windows facts require a bounded service name');
  }
  return input;
}

function normalizeFinalPath(value) {
  const input = trimString(value);
  if (input.startsWith('\\\\?\\UNC\\')) return `\\\\${input.slice(8)}`;
  if (input.startsWith('\\\\?\\')) return input.slice(4);
  return input;
}

function parseJsonOutput(stdout, { array = false } = {}) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text) throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows facts output is empty');
  let value;
  try { value = JSON.parse(text); } catch {
    throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows facts output is not JSON');
  }
  if (array ? !Array.isArray(value) : (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw fail('WINDOWS_FACTS_OUTPUT_AMBIGUOUS', 'Windows facts output has the wrong shape');
  }
  return value;
}

function validateHash(value) {
  return /^[0-9a-f]{64}$/i.test(trimString(value));
}

export function parseWindowsPathFacts(stdout) {
  const value = parseJsonOutput(stdout);
  const canonicalPath = normalizeFinalPath(value.canonicalPath);
  const type = trimString(value.type);
  const identity = trimString(value.identity) || `${trimString(value.volumeSerial)}:${trimString(value.fileId)}`;
  const expectedIdentity = `${trimString(value.volumeSerial)}:${trimString(value.fileId)}`;
  if (value.platform !== 'win32' || !path.win32.isAbsolute(canonicalPath)
    || !['dir', 'file', 'other'].includes(type)
    || !identity || !trimString(value.volumeSerial) || !trimString(value.fileId)
    || identity !== expectedIdentity
    || typeof value.reparsePoint !== 'boolean'
    || !Number.isFinite(Number(value.size)) || Number(value.size) < 0) {
    throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows path facts are incomplete');
  }
  return {
    platform: 'win32',
    canonicalPath,
    type,
    size: Number(value.size),
    reparsePoint: value.reparsePoint,
    volumeSerial: trimString(value.volumeSerial),
    fileId: trimString(value.fileId),
    identity,
    mountId: trimString(value.volumeSerial),
  };
}

export function parseWindowsArtifactFacts(stdout) {
  const value = parseJsonOutput(stdout);
  if (value?.exists !== true || !/^[0-9a-f]{64}$/.test(trimString(value.digest))) {
    throw fail('WINDOWS_FACTS_UNAVAILABLE', 'Windows artifact digest is unavailable');
  }
  return { digest: trimString(value.digest), exists: true };
}

export function parseWindowsRealpathFacts(stdout) {
  const value = parseJsonOutput(stdout);
  const canonicalPath = normalizeFinalPath(value.canonicalPath);
  if (value.platform !== 'win32' || !path.win32.isAbsolute(canonicalPath)) {
    throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows canonical path facts are incomplete');
  }
  return canonicalPath;
}

export function parseWindowsDirectoryFacts(stdout) {
  const values = parseJsonOutput(stdout, { array: true });
  return values.map((value) => {
    const name = trimString(value?.name);
    const type = trimString(value?.type);
    if (!name || name === '.' || name === '..' || name.includes('\\') || name.includes('/')
      || !['dir', 'file', 'other'].includes(type) || typeof value.reparsePoint !== 'boolean') {
      throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows directory facts are incomplete');
    }
    return { name, type, reparsePoint: value.reparsePoint };
  });
}

export function parseWindowsServiceFacts(stdout, expectedName = '') {
  const value = parseJsonOutput(stdout);
  const serviceName = trimString(value.serviceName);
  if (value.platform !== 'win32' || value.manager !== 'windows-service'
    || !serviceName || serviceName !== trimString(expectedName)
    || typeof value.exists !== 'boolean'
    || (value.exists && !validateHash(value.definitionHash))
    || (!value.exists && trimString(value.definitionHash))) {
    throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows service facts are incomplete or ambiguous');
  }
  return {
    platform: 'win32',
    manager: 'windows-service',
    serviceName,
    exists: value.exists,
    definitionHash: trimString(value.definitionHash),
  };
}

export function parseWindowsAclFacts(stdout, expectedPath = '') {
  const value = parseJsonOutput(stdout);
  const canonicalPath = normalizeFinalPath(value.canonicalPath);
  if (value.platform !== 'win32' || value.provider !== 'windows-acl'
    || !path.win32.isAbsolute(canonicalPath)
    || canonicalPath.toLowerCase() !== normalizeFinalPath(expectedPath).toLowerCase()
    || !trimString(value.ownerSid) || typeof value.protected !== 'boolean'
    || !validateHash(value.descriptorHash)) {
    throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows ACL facts are incomplete or ambiguous');
  }
  return {
    platform: 'win32',
    provider: 'windows-acl',
    canonicalPath,
    ownerSid: trimString(value.ownerSid),
    protected: value.protected,
    descriptorHash: trimString(value.descriptorHash).toLowerCase(),
  };
}

function samePath(left, right) {
  return path.win32.normalize(trimString(left)).toLowerCase()
    === path.win32.normalize(trimString(right)).toLowerCase();
}

function sameValue(left, right) {
  return trimString(left) === trimString(right);
}

function revalidationFailure(detail) {
  return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_FAILED', error: detail };
}

export async function revalidateWindowsPathFacts(snapshot = {}, { provider } = {}) {
  if (!provider || typeof provider.realpath !== 'function' || typeof provider.stat !== 'function') {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_REQUIRED', error: 'Windows path facts provider is required' };
  }
  const expectedPath = trimString(snapshot.canonical);
  if (!expectedPath || !trimString(snapshot.identity)) return revalidationFailure('path snapshot is incomplete');
  try {
    if (snapshot.noFollow === true) {
      const segments = snapshot.missingPathSegments;
      if (!path.win32.isAbsolute(expectedPath) || snapshot.reparsePoint === true || snapshot.parentIsDirectory !== true
          || !Array.isArray(segments) || !segments.length || segments.some((part) => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/\0:]/.test(part))) {
        return revalidationFailure('missing path snapshot is invalid');
      }
      let parentPath = expectedPath;
      for (const _segment of segments) parentPath = path.win32.dirname(parentPath);
      if (!samePath(path.win32.join(parentPath, ...segments), expectedPath)) return revalidationFailure('missing path components changed');
      const canonicalParent = await provider.realpath(parentPath);
      if (!samePath(canonicalParent, parentPath)) return revalidationFailure('parent path changed');
      const parent = await provider.stat(canonicalParent);
      if ((parent?.canonicalPath && !samePath(parent.canonicalPath, parentPath)) || parent?.type !== 'dir' || parent?.reparsePoint === true || !sameValue(parent?.identity, snapshot.expectedParentIdentity)
          || !sameValue(parent?.mountId || parent?.volumeSerial, snapshot.mountId)
          || snapshot.identity !== `no-follow:${parent.identity}:${segments.join('\\')}`) return revalidationFailure('parent identity changed');
      try {
        await provider.stat(path.win32.join(parentPath, segments[0]));
        return revalidationFailure('missing path now exists');
      } catch (error) {
        if (error?.code !== 'ENOENT') return revalidationFailure('missing path cannot be verified');
      }
      return { ok: true, code: '', facts: parent };
    }
    const currentCanonical = await provider.realpath(expectedPath);
    if (!samePath(currentCanonical, expectedPath)) return revalidationFailure('canonical path changed');
    const current = await provider.stat(currentCanonical);
    if ((current?.canonicalPath && !samePath(current.canonicalPath, expectedPath))
      || !sameValue(current?.identity, snapshot.identity)
      || !sameValue(current?.mountId || current?.volumeSerial, snapshot.mountId)
      || current?.reparsePoint !== (snapshot.reparsePoint === true)) {
      return revalidationFailure('path identity, volume, or reparse facts changed');
    }
    if (trimString(snapshot.expectedParentIdentity)) {
      const parent = await provider.stat(path.win32.dirname(expectedPath));
      if (!sameValue(parent?.identity, snapshot.expectedParentIdentity)) return revalidationFailure('parent identity changed');
    }
    return { ok: true, code: '', facts: current };
  } catch {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_FAILED', error: 'path facts unavailable during revalidation' };
  }
}

export async function revalidateWindowsServiceFacts(snapshot = {}, { provider } = {}) {
  if (!provider || typeof provider.serviceFacts !== 'function') {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_REQUIRED', error: 'Windows service facts provider is required' };
  }
  const serviceName = trimString(snapshot.serviceName);
  const definitionHash = trimString(snapshot.definitionHash).toLowerCase();
  if (!serviceName || !definitionHash) return revalidationFailure('service snapshot is incomplete');
  try {
    const current = await provider.serviceFacts({ serviceName, ...(snapshot.action ? { action: snapshot.action } : {}) });
    if (current?.platform !== 'win32' || current?.manager !== 'windows-service'
      || current?.exists !== true || !sameValue(current.serviceName, serviceName)
      || trimString(current.definitionHash).toLowerCase() !== definitionHash) {
      return revalidationFailure('service identity or definition hash changed');
    }
    return { ok: true, code: '', facts: current };
  } catch {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_FAILED', error: 'service facts unavailable during revalidation' };
  }
}

export async function revalidateWindowsAclFacts(snapshot = {}, { provider } = {}) {
  if (!provider || typeof provider.aclFacts !== 'function') {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_REQUIRED', error: 'Windows ACL facts provider is required' };
  }
  const expectedPath = trimString(snapshot.canonicalPath || snapshot.paths?.[0]?.canonical);
  const expectedHash = trimString(snapshot.descriptorHash || snapshot.acl?.descriptorHash).toLowerCase();
  if (!expectedPath || !expectedHash) return revalidationFailure('ACL snapshot is incomplete');
  try {
    const current = await provider.aclFacts({ canonicalPath: expectedPath });
    if (!current || current.platform !== 'win32' || current.provider !== 'windows-acl'
      || !samePath(current.canonicalPath, expectedPath)
      || trimString(current.descriptorHash).toLowerCase() !== expectedHash
      || (snapshot.acl?.ownerSid && !sameValue(current.ownerSid, snapshot.acl.ownerSid))
      || (typeof snapshot.acl?.protected === 'boolean' && current.protected !== snapshot.acl.protected)) {
      return revalidationFailure('ACL path, owner, or descriptor hash changed');
    }
    return { ok: true, code: '', facts: current };
  } catch {
    return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_FAILED', error: 'ACL facts unavailable during revalidation' };
  }
}

export async function revalidateWindowsResourceSnapshot(snapshot = {}, { provider } = {}) {
  if (Array.isArray(snapshot.paths) && snapshot.paths.length > 0) {
    for (const entry of snapshot.paths) {
      const result = await revalidateWindowsPathFacts(entry, { provider });
      if (!result.ok) return result;
    }
  }
  if (trimString(snapshot.serviceName)) return revalidateWindowsServiceFacts(snapshot, { provider });
  if (snapshot.acl || trimString(snapshot.canonicalPath)) return revalidateWindowsAclFacts(snapshot, { provider });
  return { ok: false, code: 'WINDOWS_FACTS_REVALIDATION_REQUIRED', error: 'No revalidatable Windows resource facts' };
}

function encodedScript(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runError(error) {
  return fail('WINDOWS_FACTS_UNAVAILABLE', error?.killed ? 'Windows facts command timed out' : 'Windows facts command failed');
}

export function createWindowsRuntimeFactsProvider({
  execFile = defaultExecFile,
  platform = process.platform,
  timeoutMs = WINDOWS_FACTS_TIMEOUT_MS,
  serviceInspector = null,
} = {}) {
  const run = async (script, envValues, { array = false } = {}) => {
    if (platform !== 'win32') throw fail('WINDOWS_FACTS_PLATFORM_REQUIRED', 'Windows facts provider requires win32');
    if (!WINDOWS_POWERSHELL_EXECUTABLE || !WINDOWS_POWERSHELL_CWD) throw fail('WINDOWS_FACTS_SYSTEM_UNAVAILABLE', 'Windows system path is unavailable');
    const env = { ...WINDOWS_FACTS_ENV, ...envValues };
    try {
      // PowerShell 5.1 encodes redirected stdout with [Console]::OutputEncoding,
      // which defaults to the OEM codepage (e.g. 936/GBK on a Chinese system).
      // Without forcing UTF-8 here, any non-ASCII path fact (CJK, accents) is
      // decoded as UTF-8 by Node into mojibake and silently corrupts the
      // boundary decision. The declaration must precede every script body.
      const result = await execFile(WINDOWS_POWERSHELL_EXECUTABLE, [
        ...POWERSHELL_PREFIX,
        encodedScript(
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;\n${script}`,
        ),
      ], {
        cwd: WINDOWS_POWERSHELL_CWD,
        env,
        shell: false,
        windowsHide: true,
        timeout: Math.max(1_000, Number(timeoutMs) || WINDOWS_FACTS_TIMEOUT_MS),
        maxBuffer: 256 * 1024,
      });
      if (trimString(result?.stderr)) throw fail('WINDOWS_FACTS_OUTPUT_INVALID', 'Windows facts command wrote to stderr');
      return parseJsonOutput(result?.stdout, { array });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('WINDOWS_FACTS_')) throw error;
      throw runError(error);
    }
  };

  return {
    name: WINDOWS_RUNTIME_FACTS_PROVIDER_VERSION,
    async realpath(input) {
      const requested = assertWindowsPath(input);
      const facts = await run(PATH_REALPATH_SCRIPT, { RAGENT_FACTS_PATH: requested });
      if (facts?.platform === 'win32' && facts?.notFound === true && Object.keys(facts).length === 2) throw Object.assign(new Error('Windows path not found'), { code: 'ENOENT' });
      return parseWindowsRealpathFacts(JSON.stringify(facts));
    },
    async stat(input) {
      const requested = assertWindowsPath(input);
      const facts = await run(PATH_STAT_SCRIPT, { RAGENT_FACTS_PATH: requested });
      if (facts?.platform === 'win32' && facts?.notFound === true && Object.keys(facts).length === 2) throw Object.assign(new Error('Windows path not found'), { code: 'ENOENT' });
      return parseWindowsPathFacts(JSON.stringify(facts));
    },
    async lstat(input) {
      return this.stat(input);
    },
    async readdir(input) {
      const requested = assertWindowsPath(input);
      return parseWindowsDirectoryFacts(JSON.stringify(await run(DIRECTORY_SCRIPT, { RAGENT_FACTS_PATH: requested }, { array: true })));
    },
    async packageFacts(input) {
      if (platform !== 'win32') return null;
      return getWindowsWingetPackageFacts(input, { execFile });
    },
    async artifactFacts(input) {
      // MSI artifact revalidation: identity (volume:fileId) from stat plus a
      // SHA-256 digest. Any failure to resolve either is an unresolved artifact.
      const requested = assertWindowsPath(typeof input === 'string' ? input : input?.canonicalPath);
      const stat = parseWindowsPathFacts(JSON.stringify(await run(PATH_STAT_SCRIPT, { RAGENT_FACTS_PATH: requested })));
      if (stat.type !== 'file' || stat.reparsePoint) throw fail('WINDOWS_FACTS_UNAVAILABLE', 'Windows artifact must be a regular file');
      const artifact = parseWindowsArtifactFacts(JSON.stringify(await run(ARTIFACT_DIGEST_SCRIPT, { RAGENT_FACTS_PATH: requested })));
      const after = parseWindowsPathFacts(JSON.stringify(await run(PATH_STAT_SCRIPT, { RAGENT_FACTS_PATH: requested })));
      if (after.type !== 'file' || after.reparsePoint || after.identity !== stat.identity
          || after.size !== stat.size || !samePath(after.canonicalPath, stat.canonicalPath)) {
        throw fail('WINDOWS_FACTS_UNAVAILABLE', 'Windows artifact changed during inspection');
      }
      return { exists: true, identity: stat.identity, digest: artifact.digest, size: stat.size };
    },
    async serviceFacts({ serviceName, action } = {}) {
      const requested = assertServiceName(serviceName);
      if (typeof serviceInspector === 'function' && ['start-service', 'stop-service', 'restart-service'].includes(action)) {
        if (platform !== 'win32') throw fail('WINDOWS_FACTS_PLATFORM_REQUIRED', 'Windows facts provider requires win32');
        return parseWindowsServiceFacts(JSON.stringify(await serviceInspector({ serviceName: requested })), requested);
      }
      return parseWindowsServiceFacts(JSON.stringify(await run(SERVICE_SCRIPT, { RAGENT_SERVICE_NAME: requested })), requested);
    },
    async aclFacts({ canonicalPath } = {}) {
      const requested = assertWindowsPath(canonicalPath);
      return parseWindowsAclFacts(JSON.stringify(await run(ACL_SCRIPT, { RAGENT_FACTS_PATH: requested })), requested);
    },
  };
}
