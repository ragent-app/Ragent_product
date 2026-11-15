import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';

const host = process.env.RAGENT_TEST_SERVICE_HOST;
if (process.platform !== 'win32' || !host || !path.isAbsolute(host)) {
  console.log('windows-broker-pipe-server-identity: skipped (isolated Windows service host required)');
  process.exit(0);
}
const pipeName = `ragent-fake-broker-${randomUUID()}`;
const pipe = String.raw`\\.\pipe` + '\\' + pipeName;
let bytesReceived = 0; let connected = false;
const server = createServer((socket) => { connected = true; socket.on('data', (chunk) => { bytesReceived += chunk.length; }); });
const listening = await new Promise((resolve) => {
  server.once('error', (error) => resolve(error));
  server.listen(pipe, () => resolve(null));
});
if (listening) {
  throw listening;
}
try {
  const shell = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom($env:RAGENT_TEST_SERVICE_HOST)
$type = $assembly.GetType('Ragent.ServiceHost.BrokerPipeServerIdentity', $true)
$method = $type.GetMethod('Verify', [Reflection.BindingFlags]'Static,NonPublic')
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $env:RAGENT_TEST_PIPE_NAME, [IO.Pipes.PipeDirection]::InOut)
try {
  $pipe.Connect(5000)
  try { $method.Invoke($null, @($pipe.SafePipeHandle)); exit 2 }
  catch {
    $cause = $_.Exception
    while ($cause) {
      if ($cause.Message -eq 'BROKER_PIPE_SERVER_IDENTITY_REFUSED') { exit 0 }
      $cause = $cause.InnerException
    }
    throw
  }
} finally { $pipe.Dispose() }
`;
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, env: { ...process.env, RAGENT_TEST_PIPE_NAME: pipeName }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('service host timed out')); }, 10000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(result, 0, `a pipe not owned by the registered broker must be rejected: ${stderr}`);
  assert.equal(connected, true, 'the test must connect to the fake pipe');
  assert.equal(bytesReceived, 0, 'no request may be sent to the fake pipe');
  console.log('windows-broker-pipe-server-identity: fake server rejected before request');
} finally { await new Promise((resolve) => server.close(resolve)); }
