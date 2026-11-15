/**
 * Server-owned Windows named-pipe peer facts resolver.
 *
 * The controlled-executor security contract (docs/ragent-windows-named-pipe-
 * executor-handoff-2026-08-12.md §3) requires peer identity facts to come from
 * a trusted adapter resolved by the platform, never from caller-declared
 * request fields. This module is that fact source: it creates a named pipe,
 * accepts a connection, asks the OS which process holds the client end
 * (GetNamedPipeClientProcessId), then resolves that process's user SID,
 * integrity label, and same-user relation from its access token. The result
 * is exactly the fact shape `validateWindowsPeerIdentity` consumes.
 *
 * The provider has one host boundary: an absolute, system PowerShell binary
 * invoked with a fixed encoded script. Dynamic values are environment values,
 * never PowerShell source or a shell command. Every response is one JSON value
 * and malformed, ambiguous, or incomplete output fails closed.
 *
 * This module is pure fact resolution. It never executes the controlled
 * operation and never trusts a caller-supplied SID or scope.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

const defaultExecFile = promisify(execFileCallback);

export const WINDOWS_NAMED_PIPE_PEER_FACTS_VERSION = 'windows-named-pipe-peer-facts/v1';
const systemPaths = resolveWindowsSystemPaths();
export const WINDOWS_POWERSHELL_EXECUTABLE = systemPaths?.powershell || '';
export const WINDOWS_POWERSHELL_CWD = systemPaths?.system32 || '';
export const WINDOWS_PIPE_PEER_TIMEOUT_MS = 15_000;

const WINDOWS_PIPE_PEER_ENV = Object.freeze(systemPaths?.env || { LANG: 'C' });

const POWERSHELL_PREFIX = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
]);

/**
 * This C# is part of the fixed probe/server script. It obtains the client
 * process's NT identity and integrity label from the access token of the
 * process that holds the client end of a named pipe. Failure to obtain any
 * fact is an unresolved peer and the caller fails closed. Shared by the
 * self-contained probe (createWindowsNamedPipePeerFactsProvider) and the
 * PowerShell-owned executor transport server so both resolve the exact same
 * OS facts.
 */
export const WINDOWS_PIPE_PEER_NATIVE_HELPER = String.raw`
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public static class RagentPipePeer {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetTokenInformation(IntPtr token, int tokenInfoClass, IntPtr info, uint len, out uint needed);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool ConvertSidToStringSid(IntPtr sid, out string str);

  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  private const uint TOKEN_QUERY = 0x0008;
  private const int TOKEN_USER = 1;
  private const int TOKEN_INTEGRITY_LEVEL = 25;

  public static int ClientPid(IntPtr pipe) {
    int pid;
    if (!GetNamedPipeClientProcessId(pipe, out pid) || pid <= 0) {
      throw new Exception("GetNamedPipeClientProcessId failed err=" + Marshal.GetLastWin32Error());
    }
    return pid;
  }

  public static string ResolveProcessSid(int pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) {
      throw new Exception("OpenProcess failed pid=" + pid + " err=" + Marshal.GetLastWin32Error());
    }
    try {
      IntPtr token;
      if (!OpenProcessToken(process, TOKEN_QUERY, out token)) {
        throw new Exception("OpenProcessToken failed pid=" + pid + " err=" + Marshal.GetLastWin32Error());
      }
      try {
        return SidFromToken(token, TOKEN_USER);
      } finally {
        CloseHandle(token);
      }
    } finally {
      CloseHandle(process);
    }
  }

  public static string ResolveProcessIntegrity(int pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) {
      throw new Exception("OpenProcess failed pid=" + pid + " err=" + Marshal.GetLastWin32Error());
    }
    try {
      IntPtr token;
      if (!OpenProcessToken(process, TOKEN_QUERY, out token)) {
        throw new Exception("OpenProcessToken failed pid=" + pid + " err=" + Marshal.GetLastWin32Error());
      }
      try {
        return IntegrityLabelFromToken(token);
      } finally {
        CloseHandle(token);
      }
    } finally {
      CloseHandle(process);
    }
  }

  public static string CurrentProcessSid() {
    IntPtr token;
    if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TOKEN_QUERY, out token)) {
      throw new Exception("OpenProcessToken(self) failed err=" + Marshal.GetLastWin32Error());
    }
    try {
      return SidFromToken(token, TOKEN_USER);
    } finally {
      CloseHandle(token);
    }
  }

  private static string SidFromToken(IntPtr token, int infoClass) {
    uint needed = 0;
    GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out needed);
    if (needed == 0 || needed > 64 * 1024) {
      throw new Exception("GetTokenInformation size invalid (" + needed + ")");
    }
    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
    try {
      if (!GetTokenInformation(token, infoClass, buffer, needed, out needed)) {
        throw new Exception("GetTokenInformation failed err=" + Marshal.GetLastWin32Error());
      }
      // TOKEN_USER and TOKEN_MANDATORY_LABEL both begin with SID_AND_ATTRIBUTES
      // { Sid* ; Attributes } — the SID pointer is the first machine word.
      IntPtr sid = Marshal.ReadIntPtr(buffer, 0);
      string value;
      if (!ConvertSidToStringSid(sid, out value) || string.IsNullOrEmpty(value)) {
        throw new Exception("ConvertSidToStringSid failed err=" + Marshal.GetLastWin32Error());
      }
      return value;
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private static string IntegrityLabelFromToken(IntPtr token) {
    uint needed = 0;
    GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, IntPtr.Zero, 0, out needed);
    if (needed == 0 || needed > 64 * 1024) {
      throw new Exception("GetTokenInformation(size) invalid (" + needed + ")");
    }
    IntPtr buffer = Marshal.AllocHGlobal((int)needed);
    try {
      if (!GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, needed, out needed)) {
        throw new Exception("GetTokenInformation(integrity) failed err=" + Marshal.GetLastWin32Error());
      }
      IntPtr sid = Marshal.ReadIntPtr(buffer, 0);
      // Integrity SID: S-1-16-<rid>; the label is the last sub-authority.
      int count = Marshal.ReadByte(sid, 1);
      uint rid = (uint)Marshal.ReadInt32(sid, 8 + (count - 1) * 4);
      if (rid >= 16384) return "system";
      if (rid >= 12288) return "high";
      if (rid >= 8192) return "medium";
      if (rid >= 4096) return "low";
      return "untrusted";
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }
}
'@`;

const WINDOWS_PIPE_PEER_HELPER = String.raw`
${WINDOWS_PIPE_PEER_NATIVE_HELPER}

function ConvertTo-ProbeJson($value) {
  return ConvertTo-Json -Compress -InputObject $value
}

$pipeName = 'ragent-peer-probe-' + [Guid]::NewGuid().ToString('N')
$server = $null
$clientProc = $null
try {
  $server = New-Object System.IO.Pipes.NamedPipeServerStream(
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    1,
    [System.IO.Pipes.PipeTransmissionMode]::Byte,
    [System.IO.Pipes.PipeOptions]::None
  )
  $childCmd = '$client = New-Object System.IO.Pipes.NamedPipeClientStream("." , "PIPENAME", [System.IO.Pipes.PipeDirection]::InOut); $client.Connect(15000); Start-Sleep -Seconds 5'
  $childCmd = $childCmd.Replace('PIPENAME', $pipeName)
  $childB64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCmd))
  $clientProc = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList '-NoProfile', '-NonInteractive', '-EncodedCommand', $childB64 -PassThru -WindowStyle Hidden
  if (-not $server.WaitForConnectionAsync().Wait(15000)) { throw 'named-pipe connection timed out' }

  $clientPid = [RagentPipePeer]::ClientPid($server.SafePipeHandle.DangerousGetHandle())
  $clientSid = [RagentPipePeer]::ResolveProcessSid($clientPid)
  $clientIntegrity = [RagentPipePeer]::ResolveProcessIntegrity($clientPid)
  $serverSid = [RagentPipePeer]::CurrentProcessSid()

  $facts = @{
    platform = 'win32'
    transport = 'named-pipe'
    authenticated = $true
    sameUser = ($clientSid -ieq $serverSid)
    integrity = $clientIntegrity
    sid = $clientSid
  }
  ConvertTo-ProbeJson @{ ok = $true; facts = $facts; serverSid = $serverSid; clientPid = $clientPid }
} catch {
  ConvertTo-ProbeJson @{ ok = $false; code = 'WINDOWS_PIPE_PEER_RESOLUTION_FAILED'; error = $_.Exception.Message }
} finally {
  if ($clientProc -and -not $clientProc.HasExited) { try { $clientProc.Kill() } catch {} }
  if ($server) { $server.Dispose() }
}
`;

function encodeWindowsCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Build the fixed-argv PowerShell invocation for the probe. Kept separate so
 * tests can assert the exact boundary (fixed executable, encoded command, no
 * caller-controlled argv).
 */
export function buildWindowsPipePeerInvocation({
  powershellExecutable = WINDOWS_POWERSHELL_EXECUTABLE,
  cwd = WINDOWS_POWERSHELL_CWD,
  env = WINDOWS_PIPE_PEER_ENV,
  script = WINDOWS_PIPE_PEER_HELPER,
} = {}) {
  return {
    file: powershellExecutable,
    args: [...POWERSHELL_PREFIX, encodeWindowsCommand(script)],
    cwd,
    env,
    timeoutMs: WINDOWS_PIPE_PEER_TIMEOUT_MS,
  };
}

/**
 * Parse and shape-check one probe response. A missing, malformed, ambiguous, or
 * incomplete response fails closed with a `WINDOWS_PIPE_PEER_*` error. This is
 * the single choke point shared by the probe-mode resolver and the
 * connection-bound server resolver so both enforce the same contract shape.
 */
function validatePeerFacts(facts) {
  if (facts?.platform !== 'win32' || facts?.transport !== 'named-pipe' || facts?.authenticated !== true
    || !/^S-1-/.test(String(facts?.sid || '')) || typeof facts?.sameUser !== 'boolean'
    || !['system', 'high', 'medium', 'low', 'untrusted'].includes(facts?.integrity)) {
    const cause = new Error('Windows named-pipe peer facts violated the contract shape');
    cause.code = 'WINDOWS_PIPE_PEER_INVALID';
    throw cause;
  }
  return facts;
}

function parseProbeFacts({ stdout = '', stderr = '', error = null } = {}) {
  if (error) {
    const cause = new Error(`Windows named-pipe peer facts command failed: ${error?.message || String(error)}`);
    cause.code = 'WINDOWS_PIPE_PEER_FAILED';
    cause.stderr = error?.stderr != null ? String(error.stderr) : stderr;
    throw cause;
  }
  const line = String(stdout || '').trim().split(/\r?\n/).pop();
  if (!line) {
    const cause = new Error('Windows named-pipe peer facts produced no output');
    cause.code = 'WINDOWS_PIPE_PEER_UNPARSEABLE';
    throw cause;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    const cause = new Error('Windows named-pipe peer facts produced malformed JSON');
    cause.code = 'WINDOWS_PIPE_PEER_UNPARSEABLE';
    throw cause;
  }
  if (parsed?.ok !== true || !parsed?.facts || typeof parsed.facts !== 'object') {
    const cause = new Error(parsed?.error || 'Windows named-pipe peer facts probe failed');
    cause.code = parsed?.code || 'WINDOWS_PIPE_PEER_FAILED';
    throw cause;
  }
  return validatePeerFacts(parsed.facts);
}

/**
 * Create the named-pipe peer facts provider.
 *
 * `resolveClientPeerFacts()` opens a fresh probe connection and returns the
 * client-side peer facts resolved by the OS (self-contained probe mode used for
 * live verification on a real Windows host).
 *
 * `resolveClientPeerFactsForConnection(connection)` is the server-side variant
 * the executor transport calls with the *accepted* connection: peer facts must
 * be resolved from the actual connected peer, never from caller-declared
 * request fields. On a non-win32 host it always fails closed with
 * `WINDOWS_PEER_TRANSPORT_UNSUPPORTED` (Linux default DENY). On win32 the
 * provider requires an explicit transport adapter to resolve the client from
 * the accepted named-pipe handle; the independent PowerShell probe below is
 * never reused for authorization.
 *
 * Any failure — PowerShell missing, probe errors, malformed output, or an
 * `ok:false` payload — throws a `WINDOWS_PIPE_PEER_*` error so callers fail
 * closed.
 */
export function createWindowsNamedPipePeerFactsProvider({
  execFile = defaultExecFile,
  invocation = buildWindowsPipePeerInvocation(),
  resolveConnectionPeerFacts = null,
} = {}) {
  async function runProbe() {
    const { file, args, cwd, env, timeoutMs } = invocation;
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 });
      stdout = String(result?.stdout || '');
      stderr = String(result?.stderr || '');
    } catch (error) {
      return parseProbeFacts({ stderr, error });
    }
    return parseProbeFacts({ stdout, stderr });
  }
  return {
    async resolveClientPeerFacts() {
      return runProbe();
    },
    async resolveClientPeerFactsForConnection(connection) {
      if (process.platform !== 'win32') {
        const cause = new Error('Windows named-pipe peer facts require a win32 transport');
        cause.code = 'WINDOWS_PEER_TRANSPORT_UNSUPPORTED';
        throw cause;
      }
      if (!connection || typeof connection !== 'object') {
        const cause = new Error('Windows named-pipe peer facts require an accepted connection');
        cause.code = 'WINDOWS_PEER_CONNECTION_REQUIRED';
        throw cause;
      }
      // The independent probe above creates its own pipe and is suitable only
      // for host diagnostics. It must never authorize an unrelated accepted
      // connection. Production callers must supply the transport's OS-bound
      // resolver, which receives this exact accepted connection.
      if (typeof resolveConnectionPeerFacts !== 'function') {
        const cause = new Error('Windows named-pipe peer facts have no connection-bound resolver');
        cause.code = 'WINDOWS_PEER_CONNECTION_BINDING_UNAVAILABLE';
        throw cause;
      }
      return validatePeerFacts(await resolveConnectionPeerFacts(connection));
    },
  };
}
