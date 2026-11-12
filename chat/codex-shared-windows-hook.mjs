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
  const command = `& ${quote(nodePath)} ${quote(scriptPath)} --socket ${quote(socketPath)}`;
  return {
    command,
    sourcePath: `${systemDrive}\\<session-flags>\\config.toml`,
    source: 'sessionFlags',
    shared: true,
    args: ['-c', `hooks.PreToolUse=[{matcher="^Bash$",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`],
  };
}
