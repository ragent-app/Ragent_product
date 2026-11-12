import { homedir } from 'os';
import { join } from 'path';
import {
  CHAT_PORT,
  PLATFORM_SKILLS_DIR,
  SHARED_STARTUP_DEFAULTS_ENABLED,
} from '../lib/config.mjs';
import {
  buildCalendarSubscribeHelperPath,
  getFeedInfo,
} from '../lib/connector-calendar-feed.mjs';
import { pathExists } from './fs-utils.mjs';
import { renderPromptAsset } from './prompt-asset-loader.mjs';
import {
  BOOTSTRAP_MD,
  GLOBAL_MD,
  PROJECTS_MD,
  SKILLS_MD,
  buildPromptPathMap,
  displayPromptPath,
} from './prompt-paths.mjs';
import { MANAGER_RUNTIME_BOUNDARY_SECTION } from './runtime-policy.mjs';
import { buildSharedStartupDefaultsSection } from './shared-startup-defaults.mjs';

const SYSTEM_STARTUP_CONTEXT_ASSET = 'system/startup-context.md';

/**
 * Keep the live system prompt focused on routing decisions and stable
 * endpoint families. Detailed schemas remain in the API responses and CLI
 * help so this index does not become a second, drifting protocol document.
 */
function buildSessionControlApiAndSpawnSection({ currentSessionId, chatPort }) {
  const sessionIdSuffix = currentSessionId ? ` (current: ${currentSessionId})` : '';
  return `## Parallel Session Spawning

- Multi-session routing is a core dispatch principle; this is not primarily a user-facing UI action. Split only when a turn has 2+ independently actionable goals and the separate context or parallelism is useful; keep one bounded workflow in this Session otherwise.
- Do not split a single bounded workflow just because the user expressed it as a numbered checklist, bug-triage rubric, or ordered step sequence. If the user asks to continue in the same session/workflow or not to create another child session, treat that as a strong no-split signal; if work stays here, have a clear no-split reason. A spawned session is an independent worker that simply received bounded handoff context; a parent session may coordinate while each child session owns one goal. A delegated "Delegation handoff:" is already a focused task; do not spawn again unless it contains genuinely independent work.
- Use \`ragent session-spawn --task "<focused task>" --json\`; add \`--wait\` when the parent needs the result and \`--final-only\` when only a bounded summary should return. The handoff is just the focused task plus the parent session id; let the child fetch it from the parent session when needed.
- If the \`ragent\` command is unavailable, use \`node "$AGENTOC_PROJECT_ROOT/cli.js" session-spawn --task "<focused task>" --json\` in a POSIX shell, or \`node "$env:AGENTOC_PROJECT_ROOT/cli.js" session-spawn --task "<focused task>" --json\` in PowerShell.

## Session Control API
This is a product route index, not a grant of authority. Availability depends on the current run's principal, capability, feature flags and server authorization. Use only operations actually granted to this run; do not attempt to bypass a denial.

- Call \`ragent api <METHOD> <PATH> --body '<JSON>'\`; use \`--wait-run\` only when a started Run's terminal result is needed. Fallback: \`node "$AGENTOC_PROJECT_ROOT/cli.js" api ...\` in a POSIX shell or \`node "$env:AGENTOC_PROJECT_ROOT/cli.js" api ...\` in PowerShell.
- Use \`AGENTOC_SESSION_ID\`, \`AGENTOC_CHAT_BASE_URL\`, and \`AGENTOC_PROJECT_ROOT\`; URL-encode ids and use stable \`requestId\`/\`idempotencyKey\` values for retryable mutations.
- Responses are authoritative: 202 means accepted/queued, then inspect \`run\` or poll \`GET /api/runs/:runId\`; 401/403/409 means an auth, capability, or state boundary. \`/ws\` emits invalidation hints only; refetch the HTTP resource. Never forge headers or reuse a capability across resources.

Session lifecycle and conversation:

- \`GET /api/auth/me\`, \`GET /api/home\`, \`GET /api/sessions\`, \`POST /api/sessions\`, and \`GET/PATCH/DELETE /api/sessions/:id\` cover auth/list/create/detail and metadata/runtime preferences; restore owner sessions with \`POST /api/bootstrap/owner-sessions/restore\` only when needed.
- Submit turns with \`POST /api/sessions/:id/messages\` or \`POST /api/root-sessions/:id/messages\`; publish assistant entries with \`.../assistant-messages\`; register generated results with \`.../assets\`.
- Session controls are \`.../confirmations[/:confirmationId]\`, \`.../queue\`, \`.../cancel\`, \`.../compact\`, \`.../drop-tools\`, \`.../goal/control\`, and \`.../plans/:planId/actions\`; templates/branching are \`.../regenerate\`, \`.../resend-edited\`, \`.../apply-template\`, \`.../save-template\`, \`.../fork\`, \`.../fork-at\`, and \`.../delegate\`. Fork only from a valid idle anchor; delegate a concrete task. There is no \`GET /api/sessions/:id/messages\`.

History and projections:

- Timeline reads are \`GET /api/sessions/:id/events\`, \`.../events/delta\`, \`.../events/wait\`, \`.../events/blocks/:startSeq-:endSeq\`, and \`.../events/:seq/body\`; use cursors/pagination and fetch cold bodies only when needed. Derived reads are \`GET /api/sessions/:id/{projection,audit-projection,run-sheet,source-context}\` and \`GET .../responses/:responseId\`.

Runs, collaboration, and deferred wake:

- Run: \`GET /api/runs/:runId\`; \`POST .../cancel\`, \`.../approvals/:approvalId\`, \`.../approved-actions/:batchId/{resolve,webauthn-challenge}\`, and \`.../privileged-batches/:batchId/categories/:category{,/webauthn-challenge}\`; usage is \`GET /api/usage/summary\`. Approval decisions are stateful and may require the owner/passkey flow.
- Collaboration: \`GET/POST /api/collaborations\` and \`GET|POST /api/collaborations/:id/{dispatch,retry,cancel}\`. For a new multi-agent plan, first \`POST /api/collaborations/validate\`, keep its short-lived \`validationId\`, then \`POST /api/collaborations/dispatch-validated\` with that id and one stable idempotencyKey; do not send a different raw plan after validation. Read a collaboration's durable checkpoint from its detail response; owners can also inspect \`GET /api/orchestrations/:executionId\`. If the AgentoC MCP server is connected, \`agentoc_list_orchestrations\` and \`agentoc_get_orchestration\` provide the same read-only projection without scanning transcript bodies. Enabled Consultation V1 uses \`POST /api/consultations\`, \`GET /api/consultations/:id\`, \`POST .../{dispatch,decide,cancel}\`, and \`GET .../decisions\`.
- Projects: \`GET/POST /api/projects\`, \`GET/PATCH/DELETE /api/projects/:id\`, \`POST .../:id/delete\`, checkpoints/handoffs, \`POST /api/project-handoffs/:id/accept\`, \`POST /api/projects/:id/session-migration/export\`, \`POST /api/projects/migrate\`, and \`POST /api/session-migrations/import\`; these mutations are owner-only.
- Organizations, when enabled: \`GET /api/organizations/:id[/projection]\`, \`POST .../cancel|provision\`, \`POST .../phases/:phaseId/dispatch\`, and \`GET /api/sessions/:id/organization/projection\`; provisioning/cancel/dispatch are owner-gated.
- Wake triggers: \`GET/POST /api/triggers\` and \`GET/PATCH/DELETE /api/triggers/:id\`; list the current session with \`ragent trigger list --json\`. Use \`--session\` to select a different session; \`trigger list\` also accepts \`--source-session\`. Create \`at_time\` or event triggers for AI follow-up, e.g. \`ragent trigger create --in 2h --text "Follow up on this later" --json\`. Use trigger-created session wake-ups only when the future work genuinely requires AI reasoning, drafting, or conversation continuation. Do not create a \`collaboration_terminal\` trigger to resume the collaboration's own parent Session: Durable Collaboration already owns child-result collection, aggregation, and terminal status through its control channel. Events: \`run_terminal\`, \`collaboration_terminal\`, \`process_terminal\`, \`process_output\`, \`session_event\`.
- Managed processes: create with \`POST /api/sessions/:id/managed-processes\`, inspect with \`GET /api/managed-processes?sessionId=:id\` or \`GET /api/managed-processes/:id\`, cancel with \`POST .../:id/cancel\` or \`DELETE .../:id\`; use executable/argv and \`shell:false\`. Output is bounded and wake text has a server default.

Files, workspace, and connected surfaces:
- Assets: \`POST /api/assets/upload-intents\` -> \`PUT/POST /api/assets/:assetId/upload\` -> \`POST .../finalize\`; inspect/download with \`GET /api/assets/:assetId[/download]\`. Register generated files with \`POST /api/sessions/:id/assets\` when path parsing is unreliable.
- Workspace/runtime: \`GET /api/workspace-files[/content]\`, \`GET /api/browse\`, \`POST /api/browse/mkdir\`, \`GET /api/autocomplete\`, \`GET /api/tools\`, \`GET /api/models\`, and \`GET/POST /api/runtime-selection\`; tool registration, harness installation, and workspace writes are owner-only.
- Connected surfaces: inspect \`GET /api/connectors\`, \`GET /api/connectors/surfaces\`, and \`GET /api/connectors/:connectorId/surface\`; use only a declared \`/connectors/:connectorId/...\` proxy. Local bridge is \`GET /api/sessions/:id/local-bridge/status\`, \`POST .../{pairing-code,bootstrap,commands}\`, and \`GET .../commands/:commandId\`; MCP is \`GET/POST /api/codex/mcp-servers\` and \`GET/POST /api/claude/mcp-servers\`, plus their delete routes. Use \`POST /api/shortcut\` only for a declared shortcut surface. For deterministic external delivery such as reminders, notifications, or simple outbound pushes, prefer a direct connector action when one is available instead of waking a session just to restate the message; \`POST /api/notifications\` is the direct system notification route. Mailbox health is \`GET /api/mailbox/status\`; push subscription is \`GET /api/push/vapid-public-key\`, \`POST /api/push/subscribe\`, and owner Android token registration via \`POST /api/push/fcm/{register,unregister}\`.
- Owner/runtime administration: \`GET /api/agents\` is inspection; Agent mutations use \`agentoc_create_agent\` when available. Provider configuration is \`GET/POST /api/native-providers\` plus quota/OAuth routes; harnesses use \`GET /api/harnesses\` and \`POST .../{install,upgrade,uninstall}\`/\`DELETE .../:id\`; owner WebAuthn routes are separate. Use these only when explicitly required and never expose credentials.
- For generated files, verify existence and non-empty size before delivery, then include an explicit \`Artifacts:\` block in the final reply, with relative paths. Preferred format:

Artifacts:
- ./report.pdf
- ./charts/summary.png
Scope exclusions:

- \`/api/internal/*\`, device-auth/pairing/bootstrap, connectivity/onboarding, provider-sync, and raw connector OAuth/login routes are specialized infrastructure, not general session APIs. Use only a declared capability or dedicated command when the server prompt grants it; never invent auth, credential, cookie, or raw \`curl\` fallbacks.
- The shell environment exposes \`AGENTOC_SESSION_ID\` — current source session${sessionIdSuffix}, \`AGENTOC_CHAT_BASE_URL\` — local control plane (usually http://127.0.0.1:${chatPort}), and \`AGENTOC_PROJECT_ROOT\` — CLI fallback root. The trigger and local-bridge commands default to AGENTOC_SESSION_ID; \`--source-session\` is usually unnecessary for spawn.
- This API index is a routing aid, not a schema substitute. Let live responses, command \`--help\`, and linked contract docs define optional fields and feature flags.`;
}

function buildSessionControlSections(args) {
  const full = buildSessionControlApiAndSpawnSection(args);
  const marker = '\n## Session Control API';
  const markerIndex = full.indexOf(marker);
  return {
    spawn: markerIndex >= 0 ? full.slice(0, markerIndex) : full,
    api: markerIndex >= 0 ? full.slice(markerIndex + 1) : '',
  };
}

function buildMultiAgentGuidanceSection({ includeSessionSpawn = true } = {}) {
  const dispatchRule = includeSessionSpawn
    ? '- Use `ragent session-spawn` only for an independent or high-noise subtask that benefits from a separate context; use `--wait` when the parent needs the result and `--final-only` when only a bounded summary should return.'
    : '- This is already a delegated bounded task. Complete it in the current Session and do not create or delegate another Session.';
  return `## Multi-Agent Capability Selection

- First decide whether the current Session is the best place to finish the work.
- Keep one bounded, continuous, low-noise objective in the current Session; do not add coordination overhead just because a task has several sequential steps.
${dispatchRule}
- Use Durable Collaboration when the work needs a persistent plan, dependencies, bounded concurrency, retry policy, Workspace coordination, or an independent Reviewer. The model may propose structured plan data, but the server owns validation, idempotency, permissions, and dispatch.
- Use Autonomous Organization only when the work genuinely needs Root Leadership, managed roles, phase gates, budget or stall governance, dynamic replan, or organization Projection. A Proposal is not execution, and a Frozen Revision is not provisioning.
- If the user asks to stay in this Session or workflow, keep that boundary unless a real safety or execution constraint requires a split.

## Delegation Roles

- The parent or Root Session owns objective clarification, accepted decisions, user communication, final synthesis, and the truthfulness of execution claims.
- A Manager coordinates only the Runtime-granted task subtree; it must not create arbitrary Sessions, bypass capability checks, or change a frozen plan in place.
- A Worker owns only its bounded delegated task and returns concise evidence. A Reviewer independently checks declared acceptance criteria within a read-only boundary; review is evidence, not permission to expand scope.

## Delegation Packet Contract

When delegating, make the packet explicit even if the current mechanism stores only part of it: objective, exact scope, accepted decisions, allowed tools and permissions, Workspace or writable boundary, completion criteria, and expected result format.
Return a bounded result packet with: state (completed | failed | blocked | waiting), summary, changed files or external effects, tests and evidence, risks, blockers, acceptance notes, and unresolved items. This is a prompt-level contract unless a server response confirms a durable packet object.

## Turn-Close Check

Before closing a turn, check whether the objective is complete, partial, blocked, or still undefined; whether the next action belongs in this Session, session-spawn, Durable Collaboration, or Autonomous Organization; whether the user must decide now; and whether every execution claim is confirmed by an actual tool or Runtime result.

## Multi-Agent Truthfulness

- Never claim that a child Session, Managed Session, Run, Reviewer, Organization, provisioning action, review decision, or aggregation exists or started unless the corresponding tool or server response confirms it.
- Keep Proposal, Frozen Revision, provisioning, execution, ResultPacket, ReviewDecision, and Projection as separate facts.
- Do not invent Agent ids, capabilities, permissions, progress, result packets, or review outcomes.`;
}

function buildManagedAgentCreationSection() {
  return `## Managed Agent Creation

- This owner root session has a private managed Agent-creation channel for turning a repeatable workflow into a reusable Agent.
- Use only the provided \`agentoc_create_agent\` tool when the user asks to create an Agent. The server performs the final owner, session, and signed approved-action checks.
- Do not call \`/api/agents\`, write \`auth.json\`, use raw \`curl\`, or invent a credential/API fallback. If the private tool is not present, say that the managed creation channel is unavailable and do not pretend the Agent was created.`;
}

/**
 * Build the system context to prepend to the first message of a session.
 * This is a lightweight pointer structure — tells the model how to activate
 * memory progressively instead of front-loading unrelated context.
 */
export async function buildSystemContext(options = {}) {
  const home = homedir();
  const {
    BOOTSTRAP_PATH: bootstrapPath,
    GLOBAL_PATH: globalPath,
    PROJECTS_PATH: projectsPath,
    SKILLS_PATH: skillsPath,
    TASKS_PATH: tasksPath,
  } = buildPromptPathMap({ home });
  const currentSessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const [hasBootstrap, hasGlobal, hasProjects, hasSkills] = await Promise.all([
    pathExists(BOOTSTRAP_MD),
    pathExists(GLOBAL_MD),
    pathExists(PROJECTS_MD),
    pathExists(SKILLS_MD),
  ]);
  const isFirstTime = !hasBootstrap && !hasGlobal;
  const includeSharedStartupDefaults = typeof options?.includeSharedStartupDefaults === 'boolean'
    ? options.includeSharedStartupDefaults
    : SHARED_STARTUP_DEFAULTS_ENABLED;
  const includeSessionSpawn = options?.includeSessionSpawn !== false;
  const includeManagedAgentCreation = options?.productAgentCreateEligible === true;
  const sessionControlSections = buildSessionControlSections({
    currentSessionId,
    chatPort: String(CHAT_PORT),
  });

  let context = (await renderPromptAsset(SYSTEM_STARTUP_CONTEXT_ASSET, {
    ...buildPromptPathMap({ home }),
    MANAGER_RUNTIME_BOUNDARY_SECTION,
    CURRENT_SESSION_ID_SUFFIX: currentSessionId ? ` (current: ${currentSessionId})` : '',
    CHAT_PORT: String(CHAT_PORT),
    SESSION_SPAWN_SECTION: includeSessionSpawn
      ? sessionControlSections.spawn
      : '',
  })).trim();

  context += `\n\n${sessionControlSections.api}`;

  if (includeSharedStartupDefaults) {
    context += `\n\n${buildSharedStartupDefaultsSection()}`;
  }

  context += `\n\n${buildMultiAgentGuidanceSection({ includeSessionSpawn })}`;

  if (includeManagedAgentCreation) {
    context += `\n\n${buildManagedAgentCreationSection()}`;
  }

  if (!hasBootstrap && hasGlobal) {
    context += `

## Legacy Memory Layout Detected
This machine has ${globalPath} but no ${bootstrapPath} yet.
- Do NOT treat global.md as mandatory startup context for every conversation.
- At a natural breakpoint, backfill bootstrap.md with only the small startup index.
- Create projects.md when recurring work areas, repos, or task families need a lightweight pointer catalog.`;
  }

  if (!hasProjects && (hasBootstrap || hasGlobal)) {
    context += `

## Project Pointer Catalog Missing
If this machine has recurring work areas, repos, or task families, create ${projectsPath} as a small routing layer instead of stuffing those pointers into startup context.`;
  }

  if (!hasSkills) {
    context += `

## Skills Index Missing
If local reusable workflows exist, create ${skillsPath} as a minimal placeholder index instead of treating the absence as a hard failure.`;
  }

  if (isFirstTime) {
    context += `

## Memory Not Yet Initialized
No startup memory index was found. This does not block the user's task. Use explicit user-provided pointers and current task context; do not scan the machine merely to initialize memory. Create a small index only when it is relevant, authorized, and writable. Keep any durable memory selective.`;
  }

  context += await buildConnectorCapabilitiesSection();

  return context;
}

async function buildConnectorCapabilitiesSection() {
  const connectorSections = [];
  const agendaCommand = 'ragent agenda add --title "Title" --start "ISO8601" --duration 60';
  const agendaFallbackCommand = 'node "$AGENTOC_PROJECT_ROOT/cli.js" agenda add --title "Title" --start "ISO8601" --duration 60';
  const agendaHelpCommand = 'ragent agenda --help';
  const agendaFallbackHelpCommand = 'node "$AGENTOC_PROJECT_ROOT/cli.js" agenda --help';

  try {
    const feedInfo = await getFeedInfo();
    if (feedInfo?.feedToken) {
      const subscriptionLines = [
        `Subscription helper path: ${buildCalendarSubscribeHelperPath()}`,
        `Manual subscription helper path: ${buildCalendarSubscribeHelperPath({ format: 'https' })}`,
      ];

      connectorSections.push(`### Calendar
Calendar events default to the instance iCal subscription feed. For ordinary calendar requests, write directly to that feed with \`${agendaCommand}\`. If the \`ragent\` command is unavailable in PATH, use \`${agendaFallbackCommand}\` in a POSIX shell, or replace \`$AGENTOC_PROJECT_ROOT\` with \`$env:AGENTOC_PROJECT_ROOT\` in PowerShell. The write stays instance-local when the shell already carries \`AGENTOC_INSTANCE_ROOT\` or \`AGENTOC_CONFIG_DIR\`.

For workflow details, use \`${agendaHelpCommand}\`. If the \`ragent\` command is unavailable in PATH, use \`${agendaFallbackHelpCommand}\`. Do not create completion targets for normal interactive calendar requests.

If the user explicitly needs first-class external calendar notifications and a ready bound calendar connector is already present, you may use that bound connector instead of the feed.

${subscriptionLines.join('\n')}
Events in feed: ${feedInfo.eventCount}

If the user has not yet subscribed, send a markdown link such as \`[Subscribe to calendar](${buildCalendarSubscribeHelperPath()})\` directly in the conversation. Use \`${buildCalendarSubscribeHelperPath({ format: 'https' })}\` only as the manual fallback when the client does not handle the default subscription helper. Keep the message brief: describe what the subscription does, then provide the link. No separate setup page needed.

Do not use the host machine's local Calendar.app or any GUI calendar application.`);
    }
  } catch {}

  let section = `

## Instance Connectors

This section describes calendar feed information when available; it is not a complete connector inventory. Check the declared connector surfaces and current authorization before using a connector. Do not fall back to host-level scripts, daemons, config files, or credentials found on disk that are not declared for this session.`;

  if (connectorSections.length > 0) {
    section += '\n\n' + connectorSections.join('\n\n');
  } else {
    section += '\n\nCalendar feed information is unavailable. Other connector availability is not determined by this section.';
  }

  return section;
}
