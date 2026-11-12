import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join, win32 } from 'node:path';

// Install a Run-local launcher rather than relying on a machine-wide npm PATH.
// Runtime and entry paths are passed in the environment so characters in an
// installation directory cannot become batch-file syntax.
export async function installWindowsRunCliShim(env, { runDirectory, nodePath, entryPath } = {}) {
  if (!env || ![runDirectory, nodePath, entryPath].every(value => typeof value === 'string' && win32.isAbsolute(value))) {
    throw new TypeError('Windows Run CLI launcher requires absolute paths');
  }
  const binDir = join(runDirectory, 'cli-bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'agentoc.cmd'), '@echo off\r\n"%AGENTOC_CLI_NODE%" "%AGENTOC_CLI_ENTRY%" %*\r\n', 'utf8');
  await writeFile(join(binDir, 'ragent.cmd'), '@echo off\r\n"%AGENTOC_CLI_NODE%" "%AGENTOC_CLI_ENTRY%" %*\r\n', 'utf8');
  env.AGENTOC_CLI_NODE = nodePath;
  env.AGENTOC_CLI_ENTRY = entryPath;
  env.PATH = [binDir, env.PATH].filter(Boolean).join(delimiter);
  return binDir;
}
