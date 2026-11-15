import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const root=await mkdtemp(join(tmpdir(),'ragent-relocation-fixture-'));
try{
  const exe=join(root,'fixture.exe');
  await exec('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    ['/nologo','/target:exe','/main:OwnerMsiRelocationJournalTest','/r:System.Web.Extensions.dll',
      '/out:'+exe,resolve('packaging/windows/owner-msi-relocation-journal.cs'),
      resolve('tests/fixtures/windows-msi-relocation-journal-test.cs')],
    {windowsHide:true,timeout:30000});
  const result=await exec(exe,[root],{windowsHide:true,timeout:30000});
  assert.match(result.stdout,/PASS: recovery receipts roll back/);
  console.log(result.stdout.trim());
}finally{
  await rm(root,{recursive:true,force:true});
}
