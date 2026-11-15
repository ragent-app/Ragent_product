import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

if (process.platform !== 'win32') { console.log('windows-msi-same-version-upgrade: skipped off Windows'); process.exit(0); }
const source = await readFile(new URL('../packaging/windows/Ragent.ActivatedOwner.wxs', import.meta.url), 'utf8');
const rows = [...source.matchAll(/<MajorUpgrade\b[^>]*\/>/g)].map(match => match[0]);
assert.equal(rows.length, 2);
for (const row of rows) assert.match(row, /\bAllowSameVersionUpgrades="yes"/);
const root = await mkdtemp(path.join(tmpdir(), 'ragent-sameversion-msi-'));
const wxs = path.join(root, 'fixture.wxs'), payload = path.join(root, 'payload.txt'), msi = path.join(root, 'fixture.msi');
await writeFile(payload, 'isolated fixture');
await writeFile(wxs, `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Name="Ragent Version Fixture" Manufacturer="Ragent QA" Version="0.0.1" UpgradeCode="${randomUUID()}"><MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="Newer"/><MediaTemplate EmbedCab="yes"/><StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="Ragent-Version-Fixture"><Component Id="Payload" Guid="${randomUUID()}"><File Source="${payload.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" /></Component></Directory></StandardDirectory><Feature Id="Main"><ComponentRef Id="Payload"/></Feature></Package></Wix>`);
execFileSync('wix.exe', ['--acceptEula', 'wix7', 'build', '-arch', 'x64', wxs, '-o', msi], { windowsHide: true, stdio: 'pipe' });
const script = `$i=New-Object -ComObject WindowsInstaller.Installer; $d=$i.OpenDatabase($env:RAGENT_QA_MSI,0); $v=$d.OpenView('SELECT \`VersionMax\`,\`Attributes\`,\`ActionProperty\` FROM \`Upgrade\`'); $v.Execute(); while($r=$v.Fetch()){ if($r.StringData(3) -eq 'WIX_UPGRADE_DETECTED'){ [pscustomobject]@{max=$r.StringData(1); attributes=$r.IntegerData(2)} | ConvertTo-Json -Compress } }`;
const shell = resolveWindowsSystemPaths()?.powershell;
assert.ok(shell, 'Windows system PowerShell path must be discoverable');
const raw = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { env: { ...process.env, RAGENT_QA_MSI: msi }, encoding: 'utf8', windowsHide: true });
const record = JSON.parse(raw.trim());
assert.equal(record.max, '0.0.1');
assert.equal(record.attributes & 0x200, 0x200);
console.log('windows-msi-same-version-upgrade: same-version detection table verified without installing');
