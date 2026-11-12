import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildSharedCodexWindowsHook({ socketPath, nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL('../scripts/agentoc-codex-shared-hook.mjs', import.meta.url)),
  systemDrive = process.env.SystemDrive || 'C:' } = {}) {
  if (!win32.isAbsolute(nodePath || '') || !win32.isAbsolute(scriptPath || '')
      || !/^\\\\\.\\pipe\\[^\r\n\0]+$/i.test(socketPath || '') || !/^[a-z]:$/i.test(systemDrive)) {
    throw new Error('Shared Codex Windows hook launch specification is invalid');
  }
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const invocation = `& ${quote(nodePath)} ${quote(scriptPath)} --socket ${quote(socketPath)}`;
  // The npm codex.cmd wrapper forwards this argument through cmd.exe. Encode
  // the fixed PowerShell invocation so cmd cannot reinterpret its metacharacters
  // or corrupt quotes. The decoded string contains only validated local paths.
  const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
  const command = `Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))`;
  const matcher = '\\ABash\\z';
  return {
    command,
    matcher,
    sourcePath: `${systemDrive}\\<session-flags>\\config.toml`,
    source: 'sessionFlags',
    shared: true,
    args: ['-c', `hooks.PreToolUse=[{matcher='${matcher}',hooks=[{type='command',command='''${command}'''}]}]`],
  };
}
