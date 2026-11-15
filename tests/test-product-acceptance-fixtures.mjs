// These tests exercise the oracle, never the product or a model. Reference
// artifacts are constructed locally and must never be reported as real Runs.
import assert from 'node:assert/strict';import {test,after} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,unlink,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {loadProductCases,prepareProductCases,verifyProductCase,parseFixtureCsv} from './helpers/product-acceptance.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'ragent-product-oracle-'))),cases=(await loadProductCases()).cases;
async function reference(id){
 const destination=join(root,randomUUID());await prepareProductCases(destination);const dir=join(destination,id),task=cases.find(c=>c.id===id);
 for(const [path,rule]of Object.entries(task.outputs)){
  await mkdir(dirname(join(dir,path)),{recursive:true});
  const data=rule.json?JSON.stringify(rule.json):rule.copyOf?task.inputs[rule.copyOf]:rule.text||'# 周报\n## 进展\n来源input/minutes-1.md、input/minutes-2.md。\n## 风险\n导出空白未修复。\n## 行动\n赵宁、周敏按期处理。\n## 待确认\n试点待定。\n';
  await writeFile(join(dir,path),data);
 }
 return dir;
}
after(async()=>{assert.equal(dirname(root),await realpath(tmpdir()));assert(root.includes('ragent-product-oracle-'));await rm(root,{recursive:true,force:true});});
test('prepare copies inputs and prompts, never expected outputs; occupied roots refuse',async()=>{
 const destination=join(root,randomUUID()),result=await prepareProductCases(destination);assert.equal(result.expectedOutputsExposed,false);assert.equal(result.actualProviderRunVerified,false);
 for(const task of cases){await assert.rejects(readFile(join(destination,task.id,'output/summary.json')),{code:'ENOENT'});assert.equal(await readFile(join(destination,task.id,'PROMPT.txt'),'utf8'),task.prompt+'\n');}
 await assert.rejects(prepareProductCases(destination),{code:'EEXIST'});
});
test('reference artifacts pass with human and real-Run gates still open',async()=>{
 for(const task of cases){const result=await verifyProductCase(task.id,await reference(task.id));assert.equal(result.artifactChecksPassed,true);assert.equal(result.actualProviderRunVerified,false);assert.equal(result.humanReviewRequired,true);assert.equal(result.releaseAccepted,false);}
});
test('quoted CSV cells, BOM and Windows line endings are representation-compatible',async()=>{
 const dir=await reference('table-cleanup'),csv=(await readFile(join(dir,'output/cleaned.csv'),'utf8')).trimEnd().split('\n').map(line=>line.split(',').map(v=>'"'+v+'"').join(',')).join('\r\n');await writeFile(join(dir,'output/cleaned.csv'),'\uFEFF'+csv);assert.equal((await verifyProductCase('table-cleanup',dir)).artifactChecksPassed,true);
 assert.throws(()=>parseFixtureCsv('"unterminated'),/CSV_INVALID/);
});
test('plausible wrong totals and unresolved-ID decisions refuse',async()=>{
 const dir=await reference('table-cleanup'),path=join(dir,'output/summary.json'),value=JSON.parse(await readFile(path));value.totalCents++;await writeFile(path,JSON.stringify(value));await assert.rejects(verifyProductCase('table-cleanup',dir),/OUTPUT_JSON_MISMATCH/);
 value.totalCents--;value.acceptedIds.push('E-004');await writeFile(path,JSON.stringify(value));await assert.rejects(verifyProductCase('table-cleanup',dir),/OUTPUT_JSON_MISMATCH/);
 value.acceptedIds.pop();await writeFile(path,JSON.stringify(value));const csv=join(dir,'output/cleaned.csv');await writeFile(csv,(await readFile(csv,'utf8'))+'E-004,2026-09-04,行政,50.00\n');await assert.rejects(verifyProductCase('table-cleanup',dir),/OUTPUT_CSV_MISMATCH/);
});
test('altered originals refuse even if output or a workspace manifest claims success',async()=>{
 const dir=await reference('table-cleanup');await writeFile(join(dir,'input/expenses.csv'),'id,date,team,amount\n');await writeFile(join(dir,'manifest.json'),'{"allInputsUnchanged":true}');await assert.rejects(verifyProductCase('table-cleanup',dir),/INPUT_CHANGED/);
});
test('a lost collision member and overwritten file body refuse',async()=>{
 const dir=await reference('file-archive'),path=join(dir,'output/archive/2026-09/研发-2026-09-02-02.txt');await writeFile(path,'覆盖了方案B');await assert.rejects(verifyProductCase('file-archive',dir),/COPY_CHANGED/);await rm(path);await assert.rejects(verifyProductCase('file-archive',dir),/OUTPUT_SET_MISMATCH/);
});
test('invented commitment and missing report evidence refuse',async()=>{
 const dir=await reference('meeting-brief'),path=join(dir,'output/facts.json'),value=JSON.parse(await readFile(path));value.pilotDate='2026-11-12';await writeFile(path,JSON.stringify(value));await assert.rejects(verifyProductCase('meeting-brief',dir),/OUTPUT_JSON_MISMATCH/);
 value.pilotDate=null;await writeFile(path,JSON.stringify(value));await writeFile(join(dir,'output/brief.md'),'# 周报\n一切完成');await assert.rejects(verifyProductCase('meeting-brief',dir),/DOCUMENT_SECTION_MISSING/);
});
test('unexpected output and symlink result refuse without reading the target',async()=>{
 const dir=await reference('table-cleanup');await writeFile(join(dir,'output/extra.txt'),'extra');await assert.rejects(verifyProductCase('table-cleanup',dir),/OUTPUT_SET_MISMATCH/);await rm(join(dir,'output/extra.txt'));
 const output=join(dir,'output/cleaned.csv');await rm(output);const foreign=join(root,'foreign.csv');await writeFile(foreign,'private fixture');
 // Windows unprivileged symlink creation may be unavailable; a directory
 // junction gives the same escaping-directory refusal without elevation.
 const linked=join(dir,'output/linked');await symlink(root,linked,process.platform==='win32'?'junction':'dir');try{await assert.rejects(verifyProductCase('table-cleanup',dir),/FIXTURE_LINK_REFUSED/);}finally{await unlink(linked);}
 assert.equal(await readFile(foreign,'utf8'),'private fixture');
});
