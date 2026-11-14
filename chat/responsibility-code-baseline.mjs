import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureResponsibilityProject, verifyCurrentResponsibilityProject } from './responsibility-project.mjs';
import { captureResponsibilityRepository, verifyCurrentResponsibilityRepository } from './responsibility-repository.mjs';
import { read, transaction, newId, now, digest, error } from './responsibility-store.mjs';

const exec=promisify(execFile);
async function inspect(projectFact,requireClean) {
  const env={...process.env};for(const key of Object.keys(env)) if(/^GIT_/i.test(key)) delete env[key];
  env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL=process.platform==='win32'?'NUL':'/dev/null';env.GIT_TERMINAL_PROMPT='0';env.GIT_OPTIONAL_LOCKS='0';
  const options={cwd:projectFact.rootRealPath,env,timeout:10000,maxBuffer:1048576,windowsHide:true};
  const head=(await exec('git',['rev-parse','--verify','HEAD'],options)).stdout.trim(),branch=(await exec('git',['symbolic-ref','--quiet','--short','HEAD'],options)).stdout.trim();
  if(!/^[a-f0-9]{40,64}$/i.test(head)||!branch) throw error('Git baseline is unavailable',409,'RESPONSIBILITY_BASELINE_UNVERIFIED');
  if(requireClean && (await exec('git',['status','--porcelain=v1','--untracked-files=all'],options)).stdout.trim()) throw error('Project workspace must be clean when authorizing a code baseline',409,'RESPONSIBILITY_BASELINE_UNVERIFIED');
  return {head,branch};
}
export async function captureResponsibilityCodeBaseline(organizationId,projectId) {
  const project=await captureResponsibilityProject(organizationId,projectId),repository=await captureResponsibilityRepository(projectId);
  if(process.platform==='win32'?project.rootRealPath.toLowerCase()!==repository.rootPath.toLowerCase():project.rootRealPath!==repository.rootPath) throw error('Project and repository roots differ',409,'RESPONSIBILITY_BASELINE_UNVERIFIED');
  const git=await inspect(project,true), facts={organizationId,projectId,projectFactId:project.id,repositoryFactId:repository.id,head:git.head,branch:git.branch}, hash=digest(facts);
  return transaction(db=>{const old=db.prepare('SELECT * FROM responsibility_code_baselines WHERE organization_id=? AND project_id=? AND digest=? LIMIT 1').get(organizationId,projectId,hash);if(old)return {...facts,repository:repository.repository,id:old.id,digest:hash};const id=newId('code_baseline');db.prepare('INSERT INTO responsibility_code_baselines VALUES(?,?,?,?,?,?,?,?,?)').run(id,organizationId,projectId,project.id,repository.id,git.head,git.branch,hash,now());return {...facts,repository:repository.repository,id,digest:hash};});
}
export async function verifyCurrentResponsibilityCodeBaseline(id) {
  const saved=await read(db=>db.prepare('SELECT * FROM responsibility_code_baselines WHERE id=?').get(id));if(!saved) throw error('Code baseline unavailable',409,'RESPONSIBILITY_BASELINE_UNVERIFIED');
  const project=await verifyCurrentResponsibilityProject(saved.project_fact_id),repository=await verifyCurrentResponsibilityRepository(saved.repository_fact_id),git=await inspect(project,false);
  const facts={organizationId:saved.organization_id,projectId:saved.project_id,projectFactId:project.id,repositoryFactId:repository.id,head:git.head,branch:git.branch};if(digest(facts)!==saved.digest) throw error('Code baseline changed',409,'RESPONSIBILITY_BASELINE_UNVERIFIED');return {...facts,id:saved.id,digest:saved.digest};
}
