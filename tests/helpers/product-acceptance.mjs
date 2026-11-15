// Artifact correctness oracle only. It never submits a Run, calls a Provider,
// authenticates a device, or promotes an artifact check to product acceptance.
import {readFile,writeFile,mkdir,lstat,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const fixtureUrl=new URL('../fixtures/product-acceptance.json',import.meta.url);
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=(code,path='')=>{throw new Error(code+(path?': '+path:''));};
export async function loadProductCases(){return JSON.parse(await readFile(fixtureUrl,'utf8'));}
function within(root,path){const rel=relative(root,path);return !rel.startsWith('..')&&!isAbsolute(rel);}
async function noLinks(path,stop){
 for(let cur=resolve(path);;cur=dirname(cur)){
  const info=await lstat(cur);if(info.isSymbolicLink())fail('FIXTURE_LINK_REFUSED');
  if(cur===stop||dirname(cur)===cur)break;
 }
}
async function regular(root,path){
 const full=resolve(root,path);if(!within(root,full))fail('FIXTURE_ESCAPE_REFUSED');await noLinks(full,root);
 const stat=await lstat(full);if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)fail('FIXTURE_FILE_REFUSED',path);
 return readFile(full);
}
const text=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
export function parseFixtureCsv(value){
 const rows=[],row=[];let field='',quoted=false,closed=false;
 for(let i=0;i<value.length;i++){
  const c=value[i];
  if(quoted){if(c==='"'){if(value[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"'){if(field||closed)fail('CSV_INVALID');quoted=true;continue;}
  if(c===','||c==='\n'){row.push(field);field='';closed=false;if(c==='\n'){rows.push(row.splice(0));}continue;}
  if(closed)fail('CSV_INVALID');field+=c;
 }
 if(quoted)fail('CSV_INVALID');if(field||row.length||closed){row.push(field);rows.push(row);}
 return rows;
}
export async function prepareProductCases(destination){
 const root=resolve(destination),parent=dirname(root);await noLinks(parent);await mkdir(root); // Never reuse/overwrite an existing workspace.
 await writeFile(join(root,'.ragent-product-fixture.json'),JSON.stringify({schemaVersion:1,nonce:randomUUID(),synthetic:true}));
 const cases=await loadProductCases();
 for(const task of cases.cases){
  if(!/^[a-z0-9-]+$/.test(task.id))fail('FIXTURE_CASE_INVALID');const dir=join(root,task.id);await mkdir(dir);
  for(const [path,value]of Object.entries(task.inputs)){const target=resolve(dir,path);if(!within(dir,target))fail('FIXTURE_ESCAPE_REFUSED');await mkdir(dirname(target),{recursive:true});await writeFile(target,value,{flag:'wx'});}
  await writeFile(join(dir,'PROMPT.txt'),task.prompt+'\n',{flag:'wx'});
 }
 return {prepared:true,synthetic:true,root,cases:cases.cases.map(t=>t.id),expectedOutputsExposed:false,actualProviderRunVerified:false};
}
async function outputFiles(root){
 const result=[];async function visit(path){const stat=await lstat(join(root,path));if(stat.isSymbolicLink())fail('FIXTURE_LINK_REFUSED');if(stat.isDirectory()){for(const e of await readdir(join(root,path)))await visit(path+'/'+e);}else if(stat.isFile())result.push(path);else fail('FIXTURE_FILE_REFUSED',path);}
 await visit('output');return result.sort();
}
export async function verifyProductCase(caseId,workspace){
 const bytes=await readFile(fixtureUrl),spec=JSON.parse(bytes),task=spec.cases.find(t=>t.id===caseId);if(!task)fail('FIXTURE_CASE_UNKNOWN');
 const root=resolve(workspace);await noLinks(root);const inputs={},outputs={};
 for(const [path,value]of Object.entries(task.inputs)){const actual=await regular(root,path);if(sha(actual)!==sha(Buffer.from(value)))fail('INPUT_CHANGED',path);inputs[path]=sha(actual);}
 if(!isDeepStrictEqual(await outputFiles(root),Object.keys(task.outputs).sort()))fail('OUTPUT_SET_MISMATCH');
 for(const [path,rule]of Object.entries(task.outputs)){
  const actual=await regular(root,path);outputs[path]=sha(actual);
  if(rule.json){let parsed;try{parsed=JSON.parse(text(actual));}catch{fail('OUTPUT_JSON_INVALID',path);}if(!isDeepStrictEqual(parsed,rule.json))fail('OUTPUT_JSON_MISMATCH',path);}
  if(rule.copyOf&&sha(actual)!==sha(Buffer.from(task.inputs[rule.copyOf])))fail('COPY_CHANGED',path);
  if(rule.text){if(!isDeepStrictEqual(parseFixtureCsv(text(actual)),parseFixtureCsv(rule.text)))fail('OUTPUT_CSV_MISMATCH',path);}
  if(rule.headings){const value=text(actual);for(const heading of rule.headings)if(!value.split('\n').some(line=>/^#{1,6}\s/.test(line)&&line.includes(heading)))fail('DOCUMENT_SECTION_MISSING',path);for(const word of rule.includes||[])if(!value.includes(word))fail('DOCUMENT_EVIDENCE_MISSING',path);}
 }
 return {artifactChecksPassed:true,caseId,fixtureSha256:sha(bytes),inputHashes:inputs,outputHashes:outputs,
  actualProviderRunVerified:false,humanReviewRequired:true,releaseAccepted:false,
  humanReview:[...(task.humanReview||[]),'从实际产品Run核对Provider、Harness、原Session/Run/receipt身份及最终回复','在产品界面打开并下载实际结果，独立核对内容；覆盖审批/拒绝/取消/恢复另计']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2);
 try{
  if(command==='prepare'&&args.length===1)console.log(JSON.stringify(await prepareProductCases(args[0])));
  else if(command==='verify'&&args.length===2)console.log(JSON.stringify(await verifyProductCase(args[0],args[1])));
  else fail('Usage: node tests/helpers/product-acceptance.mjs prepare <new-root> | verify <case-id> <workspace>');
 }catch(error){console.error(JSON.stringify({artifactChecksPassed:false,error:error.message,actualProviderRunVerified:false,releaseAccepted:false}));process.exitCode=1;}
}
