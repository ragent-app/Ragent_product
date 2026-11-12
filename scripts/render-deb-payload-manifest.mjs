import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function renderDebPayloadManifest(root) {
  const paths = [];
  function visit(dir, relative = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!relative && entry.name === 'DEBIAN') continue;
      const name = `${relative}/${entry.name}`;
      if (/[\r\n]/.test(name)) throw new Error('Package paths cannot contain line breaks');
      if (entry.isDirectory()) visit(join(dir, entry.name), name);
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(name);
      else throw new Error(`Unsupported package payload entry: ${name}`);
    }
  }
  visit(root);
  return `${paths.sort().join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: render-deb-payload-manifest.mjs STAGING_DIRECTORY');
    process.stdout.write(renderDebPayloadManifest(process.argv[2]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
