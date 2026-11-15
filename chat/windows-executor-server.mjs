/**
 * PowerShell-owned Windows named-pipe executor server.
 *
 * The controlled executor connects to `\\.\pipe\<name>`. A fixed PowerShell
 * server owns the named pipe (Node cannot reliably reach the pipe HANDLE from
 * a net.Socket on Windows), accepts the connection, asks the OS which process
 * holds the client end (GetNamedPipeClientProcessId), and resolves that
 * client's SID / integrity / same-user from its token — the exact trusted fact
 * source the executor-peer gate requires. PowerShell then relays the executor's
 * request line to this module (stdout) and relays this module's verdict back to
 * the executor (stdin -> pipe), so all peer facts are OS-resolved and never
 * caller-declared.
 *
 * Security boundary (handoff §3, §10.3): the gate only ever receives facts from
 * this trusted, connection-bound resolver. On a non-win32 host this module is
 * not used; the privileged-executor path fails closed with
 * WINDOWS_PEER_TRANSPORT_UNSUPPORTED.
 */

import net from 'net';

import { WINDOWS_PIPE_PEER_NATIVE_HELPER } from './windows-named-pipe-peer-facts.mjs';
import { validateWindowsExecutorPeerConnect } from './semantic-windows-executor-peer.mjs';
import { spawnManagedProcess } from '../lib/windows-managed-spawn.mjs';
import { resolveWindowsSystemPaths } from './windows-system-paths.mjs';

export const WINDOWS_EXECUTOR_SERVER_VERSION = 'windows-executor-server/v1';
const systemPaths = resolveWindowsSystemPaths();
export const WINDOWS_EXECUTOR_POWERSHELL = systemPaths?.powershell || '';
export const WINDOWS_EXECUTOR_ENV = Object.freeze(systemPaths?.env || { LANG: 'C' });
export const WINDOWS_EXECUTOR_CONNECT_TIMEOUT_MS = 20_000;
const MAX_EXECUTOR_SERVER_LINE_BYTES = 1 * 1024 * 1024;

function encodeWindowsCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// The PowerShell server is a fixed script; the only dynamic value is the pipe
// name, carried as an environment value (never PowerShell source).
export const WINDOWS_EXECUTOR_SERVER_SCRIPT = String.raw`
${WINDOWS_PIPE_PEER_NATIVE_HELPER}

$pipeName = $env:RAGENT_EXECUTOR_PIPE
$server = New-Object System.IO.Pipes.NamedPipeServerStream($pipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None)
try {
  if (-not $server.WaitForConnectionAsync().Wait(20000)) { throw 'executor connection timed out' }
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
  $reader = New-Object System.IO.StreamReader($server)
  $readTask = $reader.ReadLineAsync()
  if (-not $readTask.Wait(20000)) { throw 'executor request read timed out' }
  $request = $readTask.GetAwaiter().GetResult()
  ConvertTo-Json -Compress @{ ok = $true; facts = $facts; request = $request; clientPid = $clientPid } | Write-Output
  $verdict = [Console]::In.ReadLine()
  $writer = New-Object System.IO.StreamWriter($server)
  $writer.WriteLine($verdict)
  $writer.Flush()
  Start-Sleep -Milliseconds 300
} catch {
  ConvertTo-Json -Compress @{ ok = $false; code = 'WINDOWS_EXECUTOR_TRANSPORT_FAILED'; error = $_.Exception.Message } | Write-Output
} finally {
  if ($server) { $server.Dispose() }
}
`;

export function buildWindowsExecutorServerInvocation({
  pipeName,
  powershellExecutable = WINDOWS_EXECUTOR_POWERSHELL,
  env = WINDOWS_EXECUTOR_ENV,
  cwd = systemPaths?.system32 || '',
  script = WINDOWS_EXECUTOR_SERVER_SCRIPT,
} = {}) {
  return {
    file: powershellExecutable,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodeWindowsCommand(script)],
    cwd,
    env: { ...env, RAGENT_EXECUTOR_PIPE: pipeName },
  };
}

function connectNamedPipe(fullPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect({ path: fullPath });
      const onError = (error) => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`named-pipe connect timed out: ${error?.message || error}`));
        else setTimeout(attempt, 100);
      };
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        resolve(socket);
      });
      socket.once('error', onError);
    };
    attempt();
  });
}

/**
 * Start the fixed PowerShell peer server through the platform lifecycle
 * boundary. The `spawnImpl` hook remains available for deterministic unit
 * tests; production uses the managed facade so a waiting or stalled server
 * cannot outlive the Windows control-plane operation as an orphan.
 */
export async function spawnWindowsExecutorServerProcess({
  invocation,
  spawnImpl = null,
  spawnManagedImpl = spawnManagedProcess,
} = {}) {
  const built = invocation || buildWindowsExecutorServerInvocation();
  const options = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  if (typeof spawnImpl === 'function') {
    return await spawnImpl(built.file, built.args, {
      cwd: built.cwd,
      env: built.env,
      ...options,
    });
  }
  return await spawnManagedImpl({
    file: built.file,
    args: built.args,
    cwd: built.cwd,
    env: built.env,
    shell: false,
    ...(built.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  }, {
    stdio: options.stdio,
    preserveOnControllerExit: false,
  });
}

/**
 * Run one executor request over a fresh named-pipe server connection.
 *
 * Spawns the fixed PowerShell server, connects as the controlled executor,
 * sends `request`, and waits for the server to (a) resolve the connected
 * client's OS peer facts and (b) relay this module's gate verdict back. The
 * verdict is `validateWindowsExecutorPeerConnect(facts, { sid: expectedSid })`.
 *
 * Returns `{ ok, code, peer?, error?, clientResponse?, facts?, serverPid?,
 * windowsJobObjectManaged?, windowsJobObjectCreation? }`. Any transport failure
 * (spawn error, malformed server output, connect timeout, server ok:false)
 * rejects with a `WINDOWS_EXECUTOR_*` error — callers fail closed.
 */
export async function runWindowsExecutorRequest({
  pipeName,
  request = '',
  expectedSid = '',
  spawn = null,
  spawnManagedImpl = spawnManagedProcess,
  connectImpl = connectNamedPipe,
  validate = validateWindowsExecutorPeerConnect,
  dispatch = null,
  invocation = null,
  timeoutMs = WINDOWS_EXECUTOR_CONNECT_TIMEOUT_MS,
} = {}) {
  if (!pipeName || !/^[A-Za-z0-9._-]{1,120}$/.test(pipeName)) {
    throw new Error('A valid executor pipe name is required');
  }
  const built = invocation || buildWindowsExecutorServerInvocation({ pipeName });
  const fullPath = `\\\\.\\pipe\\${pipeName}`;

  const child = await spawnWindowsExecutorServerProcess({
    invocation: built,
    spawnImpl: spawn,
    spawnManagedImpl,
  });

  let stdoutBuffer = '';
  const stdoutLines = [];
  const serverReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Windows executor server produced no output')), timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_EXECUTOR_SERVER_LINE_BYTES) {
        clearTimeout(timer);
        reject(new Error(`Windows executor server output exceeded ${MAX_EXECUTOR_SERVER_LINE_BYTES} bytes`));
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('{')) {
          try {
            stdoutLines.push(JSON.parse(trimmed));
          } catch { /* ignore non-JSON noise */ }
        }
      }
      // The server emits one JSON line: { ok, facts, request } or { ok:false }.
      if (stdoutLines.length > 0) {
        clearTimeout(timer);
        resolve(stdoutLines[stdoutLines.length - 1]);
      }
    });
    child.stderr?.on('data', () => {});
    child.stdin?.on?.('error', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (stdoutLines.length === 0) {
        reject(new Error(`Windows executor server exited early (code=${code} signal=${signal})`));
      }
    });
  });

  let client = null;
  try {
    client = await connectImpl(fullPath, timeoutMs);
    // Send the request line, then await the relayed verdict.
    client.write(`${request}\n`);

    const serverMessage = await serverReady;
    if (serverMessage?.ok !== true || !serverMessage?.facts) {
      const error = new Error(serverMessage?.error || 'Windows executor server rejected the connection');
      error.code = serverMessage?.code || 'WINDOWS_EXECUTOR_TRANSPORT_FAILED';
      throw error;
    }

    const facts = serverMessage.facts;
    const verdict = validate(facts, { sid: expectedSid });

    // A semantic-exec request continues past the peer gate into the dispatch
    // hook (capability verify -> nonce -> revalidate -> fixed-argv exec). The
    // response relayed back is the dispatch result; any dispatch failure is
    // still relayed (fail-closed) rather than swallowed.
    let response = verdict;
    if (verdict.ok && typeof dispatch === 'function') {
      try {
        response = await dispatch(request, { facts });
      } catch (error) {
        response = {
          ok: false,
          code: 'WINDOWS_EXECUTOR_DISPATCH_FAILED',
          error: error?.message || String(error),
        };
      }
    }

    // Relay the response to the executor: the PowerShell server reads it from
    // stdin and writes it to the connected client. Order matters — the client
    // response only arrives after the verdict is relayed, so write first.
    child.stdin.write(`${JSON.stringify(response)}\n`);

    const clientResponse = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('executor client response timed out')), timeoutMs);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > MAX_EXECUTOR_SERVER_LINE_BYTES) {
          clearTimeout(timer);
          client.removeListener('data', onData);
          reject(new Error(`executor client response exceeded ${MAX_EXECUTOR_SERVER_LINE_BYTES} bytes`));
          return;
        }
        const nl = buffer.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          client.removeListener('data', onData);
          resolve(buffer.slice(0, nl));
        }
      };
      client.on('data', onData);
    });

    // With dispatch, `response` is the dispatch result (capability/exec) rather
    // than the bare peer-gate verdict; return what was actually relayed so
    // callers see the full decision, not just the gate admit.
    return {
      ...response,
      clientResponse,
      facts,
      clientPid: serverMessage.clientPid,
      serverPid: Number.isInteger(child?.pid) ? child.pid : null,
      windowsJobObjectManaged: child?.__ragentWindowsManaged === true,
      windowsJobObjectCreation: typeof child?.__ragentWindowsJobObjectCreation === 'string'
        ? child.__ragentWindowsJobObjectCreation
        : '',
    };
  } finally {
    if (client && !client.destroyed) client.destroy();
    try { child.stdin.end(); } catch {}
    child.kill();
  }
}
