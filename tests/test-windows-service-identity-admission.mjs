// Real native rejection checks, no elevation, SCM or credential use.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const exec=promisify(execFile),source=resolve('.');
const hash=b=>createHash('sha256').update(b).digest('hex');
const evidence=join(source,'artifacts/showcase/T2-current-20261017/service-identities');
const prepared=JSON.parse(await readFile(join(evidence,'prepared.json'),'utf8'));
const manifest=JSON.parse(await readFile(join(prepared.bundle,'manifest.json'),'utf8'));
const exe=join(prepared.bundle,'IdentityCanary.exe');
assert.equal(hash(await readFile(exe)),manifest['IdentityCanary.exe']);
const parent=join(process.env.LOCALAPPDATA,'Ragent/identity-qa'),id=randomBytes(16).toString('hex');
const root=join(parent,'case-'+id);await mkdir(root);
const report={caseId:id,preparedCaseId:manifest.caseId,nativeSha256:manifest['IdentityCanary.exe'],sourceFiles:manifest.sourceFiles,pass:false,productionChanged:false,credentialsUsed:false,servicesCreated:false,checks:[]};
async function refused(name,args,expected){
  let result;
  try{await exec(exe,args,{windowsHide:true,timeout:10000,maxBuffer:65536});assert.fail('Native request unexpectedly admitted');}
  catch(error){assert.equal(error.code,1);result=JSON.parse(error.stdout.trim());assert.equal(result.pass,false);assert.ok(result.error.includes(expected),result.error);}
  report.checks.push({name,pass:true,error:result.error,errorType:result.errorType});console.log('PASS: '+name);
}
try{
  await refused('ordinary-caller-cannot-register-service',['--register-canary',root,'control'],'CANARY_ADMINISTRATOR_REQUIRED');
  await refused('ordinary-caller-cannot-register-desktop-preparer',['--register-canary',root,'preparer'],'CANARY_ADMINISTRATOR_REQUIRED');
  await refused('outside-self-root',['--self-test',source],'ROOT_ID_INVALID');
  await refused('outside-report-root',['--read-report',join(source,'package.json')],'REPORT_PATH_DENIED');
  await refused('unknown-mode',['--unknown'],'SERVICE_ARGUMENTS_INVALID');
  await writeFile(join(root,'.ragent-identity-qa'),'wrong-marker');
  await refused('marker-mismatch',['--self-test',root],'ROOT_MARKER_INVALID');
  await writeFile(join(root,'.ragent-identity-qa'),'case-'+id);
  await writeFile(join(root,'manifest.json'),'x'.repeat(16385));
  await refused('oversized-manifest',['--self-test',root],'MANIFEST_TOO_LARGE');
  await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,caseId:'0'.repeat(32)}));
  await refused('cross-case-manifest',['--self-test',root],'MANIFEST_ID_INVALID');
  await mkdir(join(root,'runtime'));
  await writeFile(join(root,'runtime/node.exe'),'SYNTHETIC-NOT-EXECUTABLE');
  await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,caseId:id}));
  await refused('tampered-runtime',['--self-test',root],'RUNTIME_HASH_MISMATCH');
  const link=join(parent,'case-'+randomBytes(16).toString('hex'));
  await symlink(root,link,'junction');
  try{await refused('root-junction',['--self-test',link],'REPARSE_REJECTED');}
  finally{await rm(link);}
  report.pass=true;
}finally{
  await writeFile(join(evidence,'admission-'+id+'.json'),JSON.stringify(report,null,2));
  const actual=await realpath(root);assert.equal(dirname(actual).toLowerCase(),parent.toLowerCase());assert.equal(actual.toLowerCase(),root.toLowerCase());
  await rm(actual,{recursive:true,force:true});
}
