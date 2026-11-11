import { cp, lstat, mkdir, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { rcedit } from 'rcedit';

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(process.argv[5] || resolve(desktopRoot, '..'));
const destination = resolve(process.argv[2] || '');
const brandRoot = resolve(process.argv[3] || '');
const version = String(process.argv[4] || '0.0.1.0');
if (destination === desktopRoot || destination === repositoryRoot || brandRoot === desktopRoot || brandRoot === repositoryRoot) {
  throw new Error('Expected separate MSI staging and brand directories.');
}

const distRoot = dirname(electronPath);
if (process.argv[6] === '--move-staged-electron') {
  // The installer builds Electron in its own temporary staging directory.
  // Move that disposable distribution into the payload on the same volume
  // instead of keeping two copies until the whole build ends.
  const staging = await realpath(dirname(desktopRoot));
  const source = await realpath(distRoot);
  const targetParent = await realpath(dirname(destination));
  const inside = path => {
    const part = relative(staging, path);
    return part !== '' && part !== '..' && !part.startsWith(`..\\`) && !isAbsolute(part);
  };
  if (!inside(source) || !inside(targetParent) || dirname(source) !== join(desktopRoot, 'node_modules', 'electron')
      || resolve(targetParent, 'Desktop') !== destination) {
    throw new Error('Electron move must stay inside the installer staging directory.');
  }
  const destinationInfo = await lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationInfo) {
    // Windows treats the committed "desktop" source directory and the
    // generated "Desktop" runtime as the same directory. Merge only into
    // the exact source files the payload stager is allowed to create.
    const allowed = new Set(['package.json', 'package-lock.json', 'main.cjs', 'preload.cjs', 'update-check.cjs', 'wait.html']);
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error('Invalid desktop staging directory.');
    for (const name of await readdir(destination)) {
      const item = await lstat(join(destination, name));
      if (!allowed.has(name) || !item.isFile() || item.isSymbolicLink()) throw new Error('Unexpected desktop staging content.');
    }
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  } else {
    await rename(source, destination);
  }
} else {
  await mkdir(destination, { recursive: true });
  await cp(distRoot, destination, { recursive: true });
}
const originalExe = join(destination, 'electron.exe');
const brandedExe = join(destination, 'AgentoC.exe');
await rename(originalExe, brandedExe);

const appRoot = join(destination, 'resources', 'app');
const assetsRoot = join(appRoot, 'assets');
await mkdir(assetsRoot, { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'update-check.cjs', 'wait.html']) {
  await cp(join(desktopRoot, name), join(appRoot, name));
}
await cp(join(repositoryRoot, 'static', 'desktop', 'agentoc-android-logo.png'), join(assetsRoot, 'agentoc-android-logo.png'));
await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({
  name: 'agentoc-desktop-manager',
  version,
  private: true,
  main: 'main.cjs',
}, null, 2)}\n`, 'utf8');

await rcedit(brandedExe, {
  icon: join(brandRoot, 'agentoc.ico'),
  'requested-execution-level': 'asInvoker',
  'file-version': version,
  'product-version': version,
  'version-string': {
    CompanyName: 'Ragent',
    FileDescription: 'Ragent Desktop Manager',
    InternalName: 'AgentoC',
    OriginalFilename: 'AgentoC.exe',
    ProductName: 'Ragent',
  },
});
