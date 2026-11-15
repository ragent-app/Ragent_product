import { digest, error } from './responsibility-store.mjs';

// Registry entries are server-owned; request bodies cannot register code or grant authority.
export const PROJECT_REPORT_PROVIDER = Object.freeze({id:'project-report',version:1,digest:digest({id:'project-report',version:1,contract:'whole-project-readonly-result-packet-v1'})});
export const GENERIC_PLANNER_PROVIDER = Object.freeze({id:'generic-planner',version:1,digest:digest({id:'generic-planner',version:1,contract:'catalog-dag-plan-result-packet-v1'})});
export function normalizePlanCatalog(policy) {
  if(!Array.isArray(policy?.planCatalog)) return policy;
  const ids=new Set();const planCatalog=policy.planCatalog.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)) throw error('Invalid catalog entry');
    const {entryId:providedId,entryDigest:providedDigest,...scope}=entry;
    const entryId=providedId===undefined?`entry_${digest(scope).slice(0,24)}`:providedId;
    if(typeof entryId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(entryId)||ids.has(entryId)) throw error('Duplicate or invalid catalog entry identity');
    ids.add(entryId);const content={...scope,entryId},entryDigest=digest(content);
    if(providedDigest!==undefined && providedDigest!==entryDigest) throw error('Catalog entry digest mismatch');
    return {...content,entryDigest};
  });return {...policy,planCatalog};
}
export function responsibilityProvider(policy) {
  if(policy?.providerId===undefined) return {id:'github-ci',version:1}; // Existing policies retain only CI semantics.
  if(policy.providerId===PROJECT_REPORT_PROVIDER.id && policy.providerVersion===PROJECT_REPORT_PROVIDER.version && policy.providerDigest===PROJECT_REPORT_PROVIDER.digest) return PROJECT_REPORT_PROVIDER;
  if(policy.providerId===GENERIC_PLANNER_PROVIDER.id && policy.providerVersion===GENERIC_PLANNER_PROVIDER.version && policy.providerDigest===GENERIC_PLANNER_PROVIDER.digest) return GENERIC_PLANNER_PROVIDER;
  if(policy.providerId==='github-ci' && policy.providerVersion===1) return {id:'github-ci',version:1};
  throw error('Responsibility provider is unavailable or changed',409,'RESPONSIBILITY_PROVIDER_UNAVAILABLE');
}
export function validateProjectReportPolicy(policy,projectId) {
  const provider=responsibilityProvider(policy), resource=policy?.resource;
  if(!['project-report','generic-planner'].includes(provider.id) || !resource || resource.projectId!==projectId || resource.readScope!=='entire_project' || !['deny','inherit_existing_permissions'].includes(resource.networkPolicy) || Object.keys(resource).sort().join(',')!=='networkPolicy,projectId,readScope') throw error('Explicit project read and network scope are required');
  if(resource.networkPolicy==='inherit_existing_permissions' && policy.networkPermissionConfirmed!==true) throw error('Existing network and tool permissions require explicit confirmation');
  const planner=provider.id==='generic-planner', template=planner?'ragent-responsibility-planner':'ragent-project-report', key=planner?'planning':'report';
  if(policy.templateId!==template||policy.templateVersion!==1||typeof policy.templateDigest!=='string'||!policy.templateDigest || !policy.dailyBudget) throw error('Authorized template and daily budget are required');
  const bindings=policy.nodeBindings;
  if(!bindings || Object.keys(bindings).join(',')!==key || typeof bindings[key]?.nodeId!=='string' || !bindings[key].nodeId || !Number.isSafeInteger(bindings[key].bindingGeneration) || bindings[key].bindingGeneration<1) throw error('Authorized node binding is required');
  if(!Number.isSafeInteger(policy.maxAttempts)||policy.maxAttempts<1||policy.maxAttempts>10||!Number.isFinite(policy.maxCost)||policy.maxCost<=0) throw error('Report execution bounds are required');
  if(planner && (!Array.isArray(policy.planCatalog)||!policy.planCatalog.length||policy.planCatalog.length>20||!Number.isSafeInteger(policy.planExecutionMaxAttempts)||policy.planExecutionMaxAttempts<1||!Number.isFinite(policy.planExecutionMaxCost)||policy.planExecutionMaxCost<=0)) throw error('Bounded plan catalog is required');
  if(planner && policy.planApproval!==undefined && !['always','within_policy'].includes(policy.planApproval)) throw error('Invalid plan approval policy');
  if(planner && policy.planApproval==='within_policy' && policy.planAutoAdmissionConfirmed!==true) throw error('Automatic admission requires explicit confirmation');
  return provider;
}
