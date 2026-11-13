import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { getProject } from './projects.mjs';
import { read, transaction, newId, now, digest, error } from './responsibility-store.mjs';
const exec=promisify(execFile);
function repositoryFromRemote(remote) {
  const m=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote);
  if(!m) throw error('Origin must identify a GitHub repository',409,'RESPONSIBILITY_REPOSITORY_UNVERIFIED');
  return m[1].toLowerCase();
}
async function inspect(projectId) {
  const project=await getProject(projectId); if(!project?.rootPath) throw error('Project root unavailable',409,'RESPONSIBILITY_REPOSITORY_UNVERIFIED');
  const rootPath=await realpath(project.rootPath); const env={...process.env};
  // Do not let inherited Git environment redirect the project or inject config.
  for(const key of Object.keys(env)) if(/^GIT_/i.test(key)) delete env[key];
  env.GIT_CONFIG_NOSYSTEM='1'; env.GIT_CONFIG_GLOBAL=process.platform==='win32'?'NUL':'/dev/null'; env.GIT_TERMINAL_PROMPT='0'; env.GIT_OPTIONAL_LOCKS='0';
  const opts={cwd:rootPath,env,timeout:10000,maxBuffer:65536,windowsHide:true};
  const gitRoot=await realpath((await exec('git',['rev-parse','--show-toplevel'],opts)).stdout.trim());
  if(process.platform==='win32' ? rootPath.toLowerCase()!==gitRoot.toLowerCase() : rootPath!==gitRoot) throw error('Project root is not the Git root',409,'RESPONSIBILITY_REPOSITORY_UNVERIFIED');
  const remoteUrl=(await exec('git',['remote','get-url','origin'],opts)).stdout.trim();
  return {projectId,rootPath,gitRoot,remoteUrl,repository:repositoryFromRemote(remoteUrl)};
}
export async function captureResponsibilityRepository(projectId) {
  const fact=await inspect(projectId), hash=digest(fact);
  return transaction(db=>{const previous=db.prepare('SELECT * FROM responsibility_repository_facts WHERE project_id=? AND digest=? ORDER BY created_at,id LIMIT 1').get(projectId,hash); if(previous) return {...fact,id:previous.id,digest:hash}; const id=newId('repository'); db.prepare('INSERT INTO responsibility_repository_facts VALUES(?,?,?,?,?,?,?,?)').run(id,fact.projectId,fact.rootPath,fact.gitRoot,fact.repository,fact.remoteUrl,hash,now()); return {...fact,id,digest:hash};});
}
export async function verifyCurrentResponsibilityRepository(factId) {
  const fact=await read(db=>db.prepare('SELECT * FROM responsibility_repository_facts WHERE id=?').get(factId));
  if(!fact) throw error('Repository fact unavailable',409,'RESPONSIBILITY_REPOSITORY_UNVERIFIED');
  const current=await inspect(fact.project_id); if(digest(current)!==fact.digest) throw error('Project or origin changed',409,'RESPONSIBILITY_REPOSITORY_UNVERIFIED'); return {id:fact.id,...current,digest:fact.digest};
}
