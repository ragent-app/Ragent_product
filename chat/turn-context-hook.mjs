import { ensureDir } from './fs-utils.mjs';
import { renderPromptAsset } from './prompt-asset-loader.mjs';
import { buildLocalBridgePromptBlock } from './local-bridge-prompt.mjs';
import { buildPromptPathMap, MODEL_CONTEXT_DIR } from './prompt-paths.mjs';
import { buildSessionAgreementsPromptBlock } from './session-agreements.mjs';
import { buildTaskCardPromptBlock } from './session-task-card.mjs';
import { buildSessionLabelsPromptBlock } from './session-labels.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { buildRootLeadershipTurnContext } from './organization-leader-ingress.mjs';
import { buildCollaborationLeaderTurnContext } from './collaboration-leader-ingress.mjs';
import { buildOrganizationRoleTurnContext } from './organization-role-prompts.mjs';
import { buildOrganizationIdentityContext } from './organization-identity-context.mjs';
import { ORG_PROJECTION_V2_ENABLED } from '../lib/config.mjs';
import { buildOrganizationContextProjection, renderOrganizationContextProjection } from './organization-context-projection.mjs';

const TURN_CONTEXT_HOOK_ASSET = 'turn/context-hook.md';

export async function buildTurnContextHook(session = {}, { organizationIdentity } = {}) {
  await ensureDir(MODEL_CONTEXT_DIR);
  let sessionLabels = buildSessionLabelsPromptBlock(session);
  if (sessionLabels) {
    const knownGroups = await loadSessionsMeta()
      .then((sessions) => sessions
        .filter((candidate) => candidate?.archived !== true && candidate?.id !== session?.id)
        .map((candidate) => candidate?.group || ''))
      .catch(() => []);
    sessionLabels = buildSessionLabelsPromptBlock(session, { knownGroups });
  }
  let organizationStatus = '';
  if (ORG_PROJECTION_V2_ENABLED && (session?.sessionPlane === 'organization' || session?.organizationId || session?.sessionClass === 'ROOT_LEADERSHIP')) {
    try {
      organizationStatus = renderOrganizationContextProjection(await buildOrganizationContextProjection({ session }));
    } catch (error) {
      console.warn(`[organization] turn status projection unavailable: ${error.message}`);
    }
  }
  return [
    await renderPromptAsset(TURN_CONTEXT_HOOK_ASSET, buildPromptPathMap()),
    buildLocalBridgePromptBlock(session),
    buildSessionAgreementsPromptBlock(session?.activeAgreements || []),
    buildTaskCardPromptBlock(session?.taskCard),
    sessionLabels,
    organizationIdentity === undefined ? await buildOrganizationIdentityContext(session) : organizationIdentity,
    buildOrganizationRoleTurnContext(session),
    await buildRootLeadershipTurnContext(session),
    await buildCollaborationLeaderTurnContext({ session }),
    organizationStatus,
  ].map((section) => String(section || '').trim()).filter(Boolean).join('\n\n');
}
