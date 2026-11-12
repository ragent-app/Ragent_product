import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

// ServiceHost validates both the service identity and the pipe server PID in
// the kernel before granting access to the two installed service identities.
export async function secureWindowsCodexBrokerPipe(socketPath, serverPid, {
  platform = process.platform,
  serviceMode = false,
  executable = join(dirname(process.execPath), '..', 'AgentoC.ServiceHost.exe'),
  spawnImpl = spawn,
} = {}) {
  if (platform !== 'win32' || !serviceMode) return;
  const match = /^\\\\\.\\pipe\\(agentoc-codex-[a-f0-9]{32})$/i.exec(String(socketPath || ''));
  if (!match || !Number.isSafeInteger(serverPid) || serverPid <= 0) {
    throw Object.assign(new Error('Invalid Codex broker pipe identity'), { code: 'CODEX_BROKER_PIPE_SECURITY_INVALID' });
  }
  await new Promise((resolve, reject) => {
    let child;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const failure = () => Object.assign(new Error('Could not secure the Codex broker pipe for the installed services'),
      { code: 'CODEX_BROKER_PIPE_SECURITY_FAILED' });
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(failure()); }, 10_000);
    try {
      child = spawnImpl(executable, ['--codex-broker-pipe-security', match[1].toLowerCase(), String(serverPid)],
        { windowsHide: true, stdio: 'ignore' });
      child.once('error', () => finish(failure()));
      child.once('exit', (code) => finish(code === 0 ? null : failure()));
    } catch { finish(failure()); }
  });
}
