import { getOrganization } from './organization-store.mjs';
import { getFactoryFormula } from './factory-workflow.mjs';
import { PROJECT_REPORT_PROVIDER, GENERIC_PLANNER_PROVIDER } from './responsibility-providers.mjs';

// Catalog data describes available server code, not an authorization or a
// guarantee that a selected node meets runtime isolation requirements.
export async function getResponsibilityCapabilities({ organizationId, projectId } = {}, actor) {
  if (actor?.kind !== 'user' || actor.role !== 'owner' || !actor.principalId) {
    throw Object.assign(new Error('Owner required'), { statusCode: 403, code: 'RESPONSIBILITY_FORBIDDEN' });
  }
  const org = await getOrganization(organizationId);
  if (!org || (projectId && org.projectId !== projectId) || ['archived', 'lifecycle_pending'].includes(org.state)) {
    throw Object.assign(new Error('Organization or project unavailable'), { statusCode: 404, code: 'RESPONSIBILITY_NOT_FOUND' });
  }
  const report = getFactoryFormula('agentoc-project-report', 1);
  const planner = getFactoryFormula('agentoc-responsibility-planner', 1);
  const ci = getFactoryFormula('agentoc-reviewed-change', 3);
  const template = f => ({ id: f.id, version: f.version, digest: f.digest });
  return {
    schemaVersion: 1,
    features: { timeTriggerBridge:true, timeTriggerTypes:['at_time'] },
    providers: [
      { id:'github-ci', version:1, available:true, templates:[template(ci)], requiredScope:'github_repository', approvalMode:'preauthorized_template_and_manual_result' },
      { ...PROJECT_REPORT_PROVIDER, available:true, reason:'Node must enforce project filesystem read-only; denied network isolation is not currently verified',
        templates:[template(report)], requiredScope:'entire_project', networkPolicies:{ deny:'requires_verified_isolation', inherit_existing_permissions:'requires_explicit_owner_confirmation' }, approvalMode:'preauthorized_template_and_manual_result' },
      { ...GENERIC_PLANNER_PROVIDER, available:true, reason:'Configuration is available; execution requires enabled services, node grants and verified isolation. Real execution is not yet validated.', templates:[template(planner)], requiredScope:'entire_project', approvalMode:'always' },
    ],
    planCatalogDescriptors: [{ capability:'project-report', available:true, templateId:report.id, templateVersion:report.version, templateDigest:report.digest,
      requiredFields:['resource.projectId','resource.readScope','resource.networkPolicy','nodeBindings.report.nodeId','nodeBindings.report.bindingGeneration','maxAttempts','maxCost'],
      autoEligible:true, requiresHumanApproval:true },
      { capability:'project-code', available:true, reason:'Requires a verified local code baseline, scoped grants, registered check and human review; real execution is not yet validated', templateId:ci.id, templateVersion:ci.version, templateDigest:ci.digest,
        requiredFields:['codeBaselineId','repositoryFactId','repository','targetBranch','allowedPaths','candidateScope','checkActionId','nodeBindings.implementation','nodeBindings.review','nodeBindings.integration','maxAttempts','maxCost'],
        autoEligible:false, requiresHumanApproval:true }],
  };
}
