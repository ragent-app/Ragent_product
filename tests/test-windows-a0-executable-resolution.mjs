#!/usr/bin/env node
// Windows A0 P0-2 — executable-resolution contract tests.
//
// Off-win32 (Linux dev / CI): pure-contract checks.  The win32-only entry
// points must fail closed, and the pure PATH/PATHEXT / spawn-spec machinery is
// exercised with real fixture files.  Nothing here pretends to be Windows live
// evidence — the real asus traces live in
// /var/lib/ragent/workspace/windows-a0-evidence/p0-2-*.output.txt.

import assert from 'node:assert/strict';
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {
  isWindows,
  EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED,
  WINDOWS_POWERSHELL_EXECUTABLE,
  WINDOWS_CMD_EXECUTABLE,
  SPAWN_KIND,
  parsePathExt,
  collectPathDirs,
  hasDotInLastSegment,
  resolveWithPathExtAsync,
  resolveExecutableCommandPathAsync,
  resolveWin32ExecutablePathAsync,
  classifyExecutablePath,
  buildSpawnSpecFromResolvedPath,
  buildWin32SpawnSpec,
  encodePowerShellCommand,
  DEFAULT_PATHEXT,
} = await import(pathToFileURL(path.join(repoRoot, 'lib', 'executable-resolution.mjs')).href);

let passed = 0;
let failed = 0;
function ok(label, cond, extra = '') {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}${extra ? ` :: ${extra}` : ''}`);
  }
}
function eq(label, actual, expected) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText === expectedText) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}\n  actual:   ${actualText}\n  expected: ${expectedText}`);
  }
}
async function rejects(label, promise, code) {
  try {
    await promise;
    failed += 1;
    console.error(`FAIL: ${label} :: expected rejection with code ${code}`);
  } catch (error) {
    if (String(error?.code || '') === code) {
      passed += 1;
    } else {
      failed += 1;
      console.error(`FAIL: ${label} :: got code ${error?.code} (${error?.message})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

eq('parsePathExt(undefined) -> default PATHEXT', parsePathExt(undefined), DEFAULT_PATHEXT.split(';'));
eq('parsePathExt("") -> default PATHEXT', parsePathExt(''), DEFAULT_PATHEXT.split(';'));
eq('parsePathExt trims and drops empties', parsePathExt('.COM; .EXE;.PS1;'), ['.COM', '.EXE', '.PS1']);

eq('collectPathDirs splits on ; and dedupes', collectPathDirs('C:\\a;C:\\b;C:\\a;'), ['C:\\a', 'C:\\b']);
eq('collectPathDirs strips quotes and drops empty', collectPathDirs('"C:\\Program Files";  ;D:\\x'), ['C:\\Program Files', 'D:\\x']);

eq('hasDotInLastSegment claude', hasDotInLastSegment('claude'), false);
eq('hasDotInLastSegment claude.cmd', hasDotInLastSegment('claude.cmd'), true);
eq('hasDotInLastSegment win abs', hasDotInLastSegment('C:\\a\\b.exe'), true);
eq('hasDotInLastSegment posix rel', hasDotInLastSegment('a/b'), false);
eq('hasDotInLastSegment dotfile', hasDotInLastSegment('.bashrc'), true);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

eq('classify .exe -> exe', classifyExecutablePath('C:\\x\\a.exe'), SPAWN_KIND.EXE);
eq('classify .com -> exe', classifyExecutablePath('C:\\x\\a.com'), SPAWN_KIND.EXE);
eq('classify .cmd -> cmd-bat', classifyExecutablePath('C:\\x\\a.cmd'), SPAWN_KIND.CMD_BAT);
eq('classify .bat -> cmd-bat', classifyExecutablePath('C:\\x\\a.bat'), SPAWN_KIND.CMD_BAT);
eq('classify .ps1 -> ps1', classifyExecutablePath('C:\\x\\a.ps1'), SPAWN_KIND.PS1);
eq('classify extensionless -> unknown', classifyExecutablePath('C:\\x\\a'), SPAWN_KIND.UNKNOWN);
eq('classify is case-insensitive (.CMD)', classifyExecutablePath('C:\\x\\a.CMD'), SPAWN_KIND.CMD_BAT);

// ---------------------------------------------------------------------------
// Spawn-spec construction
// ---------------------------------------------------------------------------

const exeSpec = buildSpawnSpecFromResolvedPath('C:\\tools\\node.exe', ['--version'], { cwd: 'C:\\work', env: { PATH: 'C:\\tools' } });
eq('exe spec keeps file + fixed argv', { file: exeSpec.file, args: exeSpec.args }, { file: 'C:\\tools\\node.exe', args: ['--version'] });
eq('exe spec kind + shell:false + cwd/env', { kind: exeSpec.kind, shell: exeSpec.shell, cwd: exeSpec.cwd, env: exeSpec.env }, { kind: SPAWN_KIND.EXE, shell: false, cwd: 'C:\\work', env: { PATH: 'C:\\tools' } });

const cmdSpec = buildSpawnSpecFromResolvedPath('C:\\Users\\asus\\AppData\\Roaming\\npm\\claude.cmd', ['--version']);
eq('cmd-bat spec uses explicit cmd.exe wrapper (no shell:true)', { file: cmdSpec.file, kind: cmdSpec.kind, shell: cmdSpec.shell }, { file: WINDOWS_CMD_EXECUTABLE, kind: SPAWN_KIND.CMD_BAT, shell: false });
eq('cmd-bat spec preserves verbatim Windows argv', cmdSpec.windowsVerbatimArguments, true);
ok('cmd-bat wrapper has outer cmd.exe /c quote boundary', cmdSpec.args[3].startsWith('"') && cmdSpec.args[3].endsWith('"'), cmdSpec.args[3]);
eq('cmd-bat spec has fixed /d /s /c argv', cmdSpec.args, ['/d', '/s', '/c', '""C:\\Users\\asus\\AppData\\Roaming\\npm\\claude.cmd" "--version""']);

const hostileCmdSpec = buildSpawnSpecFromResolvedPath('C:\\tools\\provider.cmd', ['&whoami', '100%', 'a|b']);
ok('cmd-bat wrapper escapes command metacharacters', hostileCmdSpec.args[3].includes('^&whoami') && hostileCmdSpec.args[3].includes('100%%') && hostileCmdSpec.args[3].includes('a^|b'));

const psSpec = buildSpawnSpecFromResolvedPath('C:\\scripts\\run.ps1', ['-Name', 'x']);
eq('ps1 spec routes to powershell.exe', psSpec.file, WINDOWS_POWERSHELL_EXECUTABLE);
eq('ps1 spec fixed -File template', psSpec.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\scripts\\run.ps1', '-Name', 'x']);
eq('ps1 spec kind + shell:false', { kind: psSpec.kind, shell: psSpec.shell }, { kind: SPAWN_KIND.PS1, shell: false });
eq('cmd wrapper uses the actual Windows root', buildSpawnSpecFromResolvedPath('D:\\tools\\provider.cmd', [], { systemEnv: { SystemRoot: 'D:\\WinNT' }, env: { SystemRoot: 'C:\\untrusted' } }).file, 'D:\\WinNT\\System32\\cmd.exe');
eq('PowerShell wrapper uses the actual Windows root', buildSpawnSpecFromResolvedPath('E:\\tools\\run.ps1', [], { systemEnv: { WINDIR: 'E:\\Windows' } }).file, 'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
assert.throws(() => buildSpawnSpecFromResolvedPath('D:\\tools\\provider.cmd', [], { systemEnv: {} }), { code: 'WINDOWS_SYSTEM_PATH_UNAVAILABLE' });

// ---------------------------------------------------------------------------
// EncodedCommand (UTF-16LE base64)
// ---------------------------------------------------------------------------

const encoded = encodePowerShellCommand('Write-Output "hi"');
const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
eq('encodePowerShellCommand is UTF-16LE base64 round-trip', decoded, 'Write-Output "hi"');

// ---------------------------------------------------------------------------
// PATH/PATHEXT resolution with real fixture files
// ---------------------------------------------------------------------------

const fixtureDir = mkdtempSync(path.join(tmpdir(), 'ragent-exe-res-'));
const binDir = path.join(fixtureDir, 'bin');
const spacedDir = path.join(fixtureDir, 'dir with space');
// The resolver models Windows CreateProcess/PATH semantics with path.win32.
// Map Windows-shaped fixture paths to real Linux files for the off-win32 test.
const windowsFixtureRoot = 'C:\\ragent\\fixture';
const windowsBinDir = path.win32.join(windowsFixtureRoot, 'bin');
const windowsSpacedDir = path.win32.join(windowsFixtureRoot, 'dir with space');
mkdirSync(binDir, { recursive: true });
mkdirSync(spacedDir, { recursive: true });

// The exact npm-shim shape observed on the real asus host:
//   claude (extensionless bash shim) + claude.cmd + claude.ps1
writeFileSync(path.join(binDir, 'claude'), '#!/usr/bin/env bash\nexec node "$@"\n', 'utf8');
writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\necho claude-cmd\r\n', 'utf8');
writeFileSync(path.join(binDir, 'claude.ps1'), 'Write-Output "claude-ps1"\n', 'utf8');
// Native .exe + wrapper variants for PATHEXT ordering
writeFileSync(path.join(binDir, 'realtool.exe'), 'MZ-fake-exe', 'binary');
writeFileSync(path.join(binDir, 'realtool.bat'), '@echo off\r\necho bat\r\n', 'utf8');
writeFileSync(path.join(binDir, 'realtool.cmd'), '@echo off\r\necho cmd\r\n', 'utf8');
writeFileSync(path.join(binDir, 'script.ps1'), 'Write-Output "script"\n', 'utf8');
writeFileSync(path.join(spacedDir, 'spaced.exe'), 'MZ-fake-spaced', 'binary');

const windowsFixtureKey = (value) => path.win32.normalize(String(value)).toUpperCase();
const localByWindowsPath = new Map([
  [path.win32.join(windowsBinDir, 'claude'), path.join(binDir, 'claude')],
  [path.win32.join(windowsBinDir, 'claude.cmd'), path.join(binDir, 'claude.cmd')],
  [path.win32.join(windowsBinDir, 'claude.ps1'), path.join(binDir, 'claude.ps1')],
  [path.win32.join(windowsBinDir, 'realtool.exe'), path.join(binDir, 'realtool.exe')],
  [path.win32.join(windowsBinDir, 'realtool.bat'), path.join(binDir, 'realtool.bat')],
  [path.win32.join(windowsBinDir, 'realtool.cmd'), path.join(binDir, 'realtool.cmd')],
  [path.win32.join(windowsBinDir, 'script.ps1'), path.join(binDir, 'script.ps1')],
  [path.win32.join(windowsSpacedDir, 'spaced.exe'), path.join(spacedDir, 'spaced.exe')],
].map(([windowsPath, localPath]) => [windowsFixtureKey(windowsPath), localPath]));
const fixtureExists = (candidate) => {
  const localPath = localByWindowsPath.get(windowsFixtureKey(candidate));
  if (!localPath) return false;
  try {
    accessSync(localPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const dirs = [windowsBinDir, windowsSpacedDir];
const extensions = parsePathExt(undefined); // .COM;.EXE;.BAT;.CMD
const defaultOpts = { dirs, extensions, fileExists: fixtureExists };

try {
  // Known point: bare `claude` must resolve to claude.cmd — never the
  // extensionless claude shim, never claude.ps1 (not in PATHEXT).
  const claudeResolved = await resolveWithPathExtAsync('claude', defaultOpts);
  eq('claude -> claude.cmd (not extensionless shim, not .ps1)', claudeResolved, path.win32.join(windowsBinDir, 'claude.CMD'));

  // Bare extensionless shim is not spawnable via CreateProcess -> not matched.
  const shimResolved = await resolveWithPathExtAsync('claude', { dirs: [binDir], extensions: [] });
  eq('extensionless shim never matched when PATHEXT empty', shimResolved, null);

  // PATHEXT order: .EXE before .BAT/.CMD.
  eq('realtool -> realtool.exe (PATHEXT order)', await resolveWithPathExtAsync('realtool', defaultOpts), path.win32.join(windowsBinDir, 'realtool.EXE'));

  // Explicit extension -> exact match.
  eq('realtool.cmd exact', await resolveWithPathExtAsync('realtool.cmd', defaultOpts), path.win32.join(windowsBinDir, 'realtool.cmd'));
  eq('realtool.bat exact', await resolveWithPathExtAsync('realtool.bat', defaultOpts), path.win32.join(windowsBinDir, 'realtool.bat'));
  // Explicit .ps1 is accepted as an exact path; extensionless discovery is
  // governed by PATHEXT. Spawn-spec construction routes it through PowerShell.
  eq('explicit claude.ps1 resolves exactly', await resolveWithPathExtAsync('claude.ps1', defaultOpts), path.win32.join(windowsBinDir, 'claude.ps1'));

  // Missing command -> null.
  eq('missing command -> null', await resolveWithPathExtAsync('definitely-missing', defaultOpts), null);

  // Absolute path with extension -> direct.
  const absCmd = path.win32.join(windowsBinDir, 'claude.cmd');
  eq('absolute .cmd path resolves', await resolveWithPathExtAsync(absCmd, defaultOpts), absCmd);

  // Absolute path without extension -> PATHEXT applied.
  eq('absolute extless applies PATHEXT', await resolveWithPathExtAsync(path.win32.join(windowsBinDir, 'realtool'), defaultOpts), path.win32.join(windowsBinDir, 'realtool.EXE'));

  // Path with spaces.
  eq('spaced dir resolves', await resolveWithPathExtAsync('spaced', defaultOpts), path.win32.join(windowsSpacedDir, 'spaced.EXE'));

  // Relative path with separator resolves against cwd.
  const rel = path.win32.relative(windowsFixtureRoot, path.win32.join(windowsBinDir, 'claude.cmd'));
  eq('relative path resolves', await resolveWithPathExtAsync(rel, { ...defaultOpts, cwd: windowsFixtureRoot }), path.win32.join(windowsBinDir, 'claude.cmd'));
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

// Case-insensitive lookup is a Windows filesystem property; encode the
// expectation via an injected case-insensitive fileExists probe.
{
  const insensitive = new Set([
    path.win32.join(windowsBinDir, 'CLAUDE.CMD'),
    path.win32.join(windowsBinDir, 'CLAUDE.EXE'),
  ].map((value) => value.toUpperCase()));
  const fakeExists = async (candidate) => insensitive.has(candidate.toUpperCase());
  const upper = await resolveWithPathExtAsync('claude', {
    dirs,
    extensions,
    fileExists: fakeExists,
  });
  // PATHEXT order: .COM then .EXE — so an upper-case CLAUDE.EXE wins over
  // CLAUDE.CMD, mirroring real Windows case-insensitive filesystems.
  eq('case-insensitive fs honours PATHEXT order', upper, path.win32.join(windowsBinDir, 'claude.EXE'));
}

// ---------------------------------------------------------------------------
// Cross-platform resolver (off-win32 delegates to the legacy shell resolver)
// ---------------------------------------------------------------------------

ok('isWindows matches the host platform', isWindows === (process.platform === 'win32'), `platform=${process.platform}`);
if (!isWindows) {
  const nodePath = await resolveExecutableCommandPathAsync('node');
  ok('cross-platform resolver finds node on PATH', typeof nodePath === 'string' && nodePath.length > 0, String(nodePath));
  eq('cross-platform resolver returns null for missing command', await resolveExecutableCommandPathAsync('definitely-not-a-real-command-xyz-123'), null);

  // win32-only entry points fail closed off-win32.
  await rejects('resolveWin32ExecutablePathAsync fails closed off-win32', resolveWin32ExecutablePathAsync('node'), EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED);
  await rejects('buildWin32SpawnSpec fails closed off-win32', buildWin32SpawnSpec('node', []), EXECUTABLE_RESOLUTION_PLATFORM_REQUIRED);
}

console.log(`\ntest-windows-a0-executable-resolution: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
