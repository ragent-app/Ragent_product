import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('windows-package-version: skipped (requires Windows)');
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ragent-package-version-'));
  const script = fileURLToPath(new URL('../packaging/windows/write-package-version.ps1', import.meta.url));
  const shells = [path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ...(process.env.RAGENT_TEST_PWSH ? [process.env.RAGENT_TEST_PWSH] : [])];
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PayloadRoot', root, '-Version', '0.0.1.0'];
  try {
    for (const shell of shells) {
      execFileSync(shell, [...args, '-BuildVersion', '0.0.24'], { windowsHide: true });
      assert.equal(await readFile(path.join(root, '.ragent-package-version'), 'utf8'), '0.0.1\n');
      assert.equal((await readFile(path.join(root, '.ragent-package-build'), 'utf8')).trim(), '0.0.24');
      assert.throws(() => execFileSync(shell, [...args, '-BuildVersion', '0.0.024'], { windowsHide: true, stdio: 'ignore' }));
      assert.equal((await readFile(path.join(root, '.ragent-package-build'), 'utf8')).trim(), '0.0.24');
      const versionArgs = args.slice(0, -1);
      execFileSync(shell, [...versionArgs, '0.3.18.60'], { windowsHide: true });
      assert.equal(await readFile(path.join(root, '.ragent-package-version'), 'utf8'), '0.3.18.60\n');
      assert.throws(() => execFileSync(shell, [...versionArgs, '0.0.1'], { windowsHide: true, stdio: 'ignore' }));
      const msi = path.join(root, 'fixture.msi'), setup = path.join(root, 'fixture.exe');
      const sha = bytes => createHash('sha256').update(bytes).digest('hex');
      await writeFile(msi, 'fixture-msi'); await writeFile(setup, 'fixture-setup');
      await writeFile(`${msi}.build.json`, JSON.stringify({ schemaVersion: 1, publicVersion: '0.0.1', buildVersion: '0.0.24',
        sourceCommit: 'a'.repeat(40), msiSha256: sha('fixture-msi') }));
      const helper = fileURLToPath(new URL('../packaging/windows/write-setup-metadata.ps1', import.meta.url));
      const metaArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-MsiPath', msi, '-SetupPath', setup];
      execFileSync(shell, metaArgs, { windowsHide: true });
      const result = JSON.parse(await readFile(`${setup}.build.json`, 'utf8'));
      assert.equal(result.setupSha256, sha('fixture-setup'));
      assert.equal(result.releaseBodyMarker, `<!-- ragent-build:0.0.24:${'a'.repeat(40)}:sha256:${sha('fixture-setup')} -->`);
      await writeFile(msi, 'modified-msi');
      assert.throws(() => execFileSync(shell, metaArgs, { windowsHide: true, stdio: 'ignore' }));
    }
    console.log('windows-package-version: public and internal versions verified');
  } finally { await rm(root, { recursive: true, force: true }); }
}
