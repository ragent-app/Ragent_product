import { error, digest } from './responsibility-store.mjs';

// Called inside the caller's existing transaction/fence; no I/O or transaction is started here.
export function verifyResponsibilityAuthority(db, input) {
  const deny = message => { throw error(message,403,'RESPONSIBILITY_AUTHORITY_DENIED'); };
  const r=db.prepare('SELECT * FROM responsibilities WHERE id=?').get(input.responsibilityId);
  if (!r || r.lifecycle!=='active' || r.organization_id!==input.organizationId || r.project_id!==input.projectId || r.revision!==input.responsibilityRevision || r.policy_revision!==input.policyRevision) deny('Responsibility authority changed or is inactive');
  const p=db.prepare('SELECT * FROM responsibility_policy_revisions WHERE responsibility_id=? AND revision=?').get(r.id,r.policy_revision);
  if (!p || !p.valid_until || !Number.isFinite(Date.parse(p.valid_until)) || Date.parse(p.valid_until)<=Date.now()) deny('Responsibility policy expired');
  const policy=JSON.parse(p.policy_json);
  const decision=db.prepare('SELECT * FROM responsibility_decisions WHERE id=? AND responsibility_id=? AND wake_id=?').get(input.decisionId,r.id,input.wakeId);
  const wake=db.prepare('SELECT * FROM responsibility_wakes WHERE id=? AND responsibility_id=?').get(input.wakeId,r.id);
  if (!decision || decision.state!=='approved' || decision.responsibility_revision!==r.revision || decision.policy_revision!==r.policy_revision || !wake || wake.decision_id!==decision.id || wake.responsibility_revision!==r.revision || wake.policy_revision!==r.policy_revision) deny('Decision or wake is stale');
  const proposal=JSON.parse(decision.proposal_json);
  if(!input.repositoryFactId || proposal.repositoryFactId!==input.repositoryFactId) deny('Repository fact mismatch');
  const fact=db.prepare('SELECT * FROM responsibility_repository_facts WHERE id=?').get(input.repositoryFactId);
  if(!fact || fact.project_id!==r.project_id || fact.repository!==input.repository) deny('Repository fact does not match project');
  const keys=['repository','templateId','templateVersion','templateDigest','targetBranch','allowedPaths','candidateScope','maxAttempts','maxCost','nodeBindings'];
  if(keys.some(key=>input[key]===undefined || proposal[key]===undefined || policy[key]===undefined)) deny('Authority fields are incomplete');
  for (const key of keys) if (digest(input[key])!==digest(proposal[key])) deny(`Decision mismatch: ${key}`);
  for (const key of ['repository','templateId','templateVersion','templateDigest','targetBranch','candidateScope','nodeBindings']) if (digest(input[key])!==digest(policy[key])) deny(`Policy mismatch: ${key}`);
  if(input.templateVersion===3 && (typeof input.checkActionId!=='string'||!input.checkActionId || input.checkActionId!==proposal.checkActionId || input.checkActionId!==policy.checkActionId)) deny('Registered check action is not authorized');
  if(typeof input.repository!=='string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) deny('Invalid repository identity');
  if(!input.nodeBindings || typeof input.nodeBindings!=='object' || Array.isArray(input.nodeBindings) || !Object.keys(input.nodeBindings).length || Object.values(input.nodeBindings).some(binding=>!binding || typeof binding.nodeId!=='string' || !binding.nodeId || !Number.isSafeInteger(binding.bindingGeneration) || binding.bindingGeneration<1)) deny('Invalid node bindings');
  if (!Array.isArray(input.allowedPaths) || !input.allowedPaths.length || !Array.isArray(policy.allowedPaths) || input.allowedPaths.some(path=>!policy.allowedPaths.includes(path)) || !Number.isInteger(input.maxAttempts) || input.maxAttempts<1 || input.maxAttempts>policy.maxAttempts || !Number.isFinite(input.maxCost) || input.maxCost<=0 || input.maxCost>policy.maxCost) deny('Policy resources exceeded');
  return {responsibilityId:r.id,organizationId:r.organization_id,projectId:r.project_id,responsibilityRevision:r.revision,policyRevision:r.policy_revision,policy};
}
