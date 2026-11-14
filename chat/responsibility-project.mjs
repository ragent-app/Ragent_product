import { realpath } from 'node:fs/promises';
import { getProject } from './projects.mjs';
import { getOrganization } from './organization-store.mjs';
import { getSession } from './session-manager.mjs';
import { read, transaction, newId, now, digest, error } from './responsibility-store.mjs';

async function inspect(organizationId, projectId) {
  const organization=await getOrganization(organizationId), project=await getProject(projectId);
  if(!organization || organization.projectId!==projectId || !organization.rootSessionId || !project?.rootPath) throw error('Project authority is unavailable',409,'RESPONSIBILITY_PROJECT_UNVERIFIED');
  const session=await getSession(organization.rootSessionId);
  if(!session?.folder || session.archived || session.projectId!==projectId) throw error('Project root session is unavailable',409,'RESPONSIBILITY_PROJECT_UNVERIFIED');
  const rootRealPath=await realpath(project.rootPath), sessionRoot=await realpath(session.folder);
  if(process.platform==='win32'?rootRealPath.toLowerCase()!==sessionRoot.toLowerCase():rootRealPath!==sessionRoot) throw error('Organization session does not match the project root',409,'RESPONSIBILITY_PROJECT_UNVERIFIED');
  return {organizationId,projectId,rootSessionId:organization.rootSessionId,rootRealPath};
}
export async function captureResponsibilityProject(organizationId,projectId) {
  const fact=await inspect(organizationId,projectId), hash=digest(fact);
  return transaction(db=>{const old=db.prepare('SELECT * FROM responsibility_project_facts WHERE organization_id=? AND project_id=? AND digest=? ORDER BY created_at,id LIMIT 1').get(organizationId,projectId,hash); if(old) return {...fact,id:old.id,digest:hash};const id=newId('project_fact');db.prepare('INSERT INTO responsibility_project_facts VALUES(?,?,?,?,?,?,?)').run(id,organizationId,projectId,fact.rootSessionId,fact.rootRealPath,hash,now());return {...fact,id,digest:hash};});
}
export async function verifyCurrentResponsibilityProject(factId) {
  const saved=await read(db=>db.prepare('SELECT * FROM responsibility_project_facts WHERE id=?').get(factId));
  if(!saved) throw error('Project fact unavailable',409,'RESPONSIBILITY_PROJECT_UNVERIFIED');
  const fact=await inspect(saved.organization_id,saved.project_id);if(digest(fact)!==saved.digest) throw error('Project identity changed',409,'RESPONSIBILITY_PROJECT_UNVERIFIED');return {...fact,id:saved.id,digest:saved.digest};
}
