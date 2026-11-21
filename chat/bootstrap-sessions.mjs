import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CHAT_PORT, INSTANCE_ROOT, MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import {
  buildCalendarSubscribeHelperPath,
  getFeedInfo,
} from '../lib/connector-calendar-feed.mjs';
import { loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';
import {
  WELCOME_STARTER_MESSAGE,
  WELCOME_STARTER_SYSTEM_PROMPT,
  resolveStarterToolSelection,
} from './starter-session-content.mjs';
import { WELCOME_STARTER_PRESET } from './session-starter-preset.mjs';

import { publishLocalFileAssetFromPath } from './file-assets.mjs';
import { appendEvents, forEachStoredEvent, readEventBody } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { SESSION_ENTRY_MODE_READ } from './session-entry-mode.mjs';
import {
  createSession,
  getSession,
  listSessions,
  setSessionPinned,
  updateSessionEntryMode,
  updateSessionGrouping,
  updateSessionLastReviewedAt,
} from './session-manager.mjs';

export const OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:welcome';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_ASSETS_DIR = join(MODULE_DIR, 'bootstrap-assets');
const RAW_SPREADSHEET_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.raw.xlsx');
const CLEANED_SPREADSHEET_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.cleaned.xlsx');
const CLEANUP_NOTES_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.notes.md');
const DIGEST_SHOWCASE_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'ai-coding-agent-digest.sample.md');
const SHORTCUT_VOICE_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'ragent-voice.shortcut');
const SHORTCUT_TEXT_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'ragent-text.shortcut');
const SHORTCUT_OPEN_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'ragent-open.shortcut');
const OWNER_BOOTSTRAP_FILE_SHOWCASE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:file_cleanup';
const OWNER_BOOTSTRAP_DIGEST_SHOWCASE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:digest_email_delivery';
const OWNER_BOOTSTRAP_INSTANCE_EMAIL_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:instance_email';
const OWNER_BOOTSTRAP_CALENDAR_SUBSCRIBE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:guide:calendar_subscribe';
const OWNER_BOOTSTRAP_SHORTCUTS_GUIDE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:guide:shortcuts';
const OWNER_BOOTSTRAP_GUEST_MIGRATION_GUIDE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:guide:guest_local_migration';

async function safeReadJson(filePath, fallbackValue = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function normalizeMailboxName(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    : '';
}

function buildGuestMailboxAddress(instanceName, ownerIdentity) {
  const normalizedInstanceName = normalizeMailboxName(instanceName);
  const localPart = typeof ownerIdentity?.localPart === 'string' ? ownerIdentity.localPart.trim() : '';
  const domain = typeof ownerIdentity?.domain === 'string' ? ownerIdentity.domain.trim() : '';
  const addressMode = typeof ownerIdentity?.instanceAddressMode === 'string' ? ownerIdentity.instanceAddressMode.trim() : '';
  if (!normalizedInstanceName || !localPart || !domain) return '';
  if (addressMode === 'local_part') {
    return `${normalizedInstanceName}@${domain}`;
  }
  return `${localPart}+${normalizedInstanceName}@${domain}`;
}

async function resolveCurrentMailboxAddress() {
  const normalizedPort = Number.parseInt(`${CHAT_PORT || 0}`, 10) || 0;
  const registry = await loadMailboxRuntimeRegistry({ homeDir: homedir() });
  const matchedRuntime = registry.find((record) => Number.parseInt(`${record?.port || 0}`, 10) === normalizedPort) || null;
  const runtimeMailboxAddress = typeof matchedRuntime?.mailboxAddress === 'string'
    ? matchedRuntime.mailboxAddress.trim()
    : '';
  if (runtimeMailboxAddress) return runtimeMailboxAddress;

  const ownerIdentity = await safeReadJson(join(homedir(), '.config', 'ragent', 'agent-mailbox', 'identity.json'), null);
  const guestMailboxAddress = buildGuestMailboxAddress(basename(INSTANCE_ROOT || ''), ownerIdentity);
  if (guestMailboxAddress) return guestMailboxAddress;
  const ownerMailboxAddress = typeof ownerIdentity?.address === 'string' ? ownerIdentity.address.trim() : '';
  return ownerMailboxAddress;
}

function buildInboundEmailSetupHint(mailboxAddress) {
  if (mailboxAddress) {
    return [
      'To test whether incoming mail creates a session, first enable email integration and configure allowed senders. Tell me the sender address and I can help configure it within the current permissions. Rely on the actual configuration and delivery result.',
      `The current inbound address for this instance is \`${mailboxAddress}\`.`,
    ].join('\n\n');
  }

  return 'To test whether incoming mail creates a session, first enable email integration and configure allowed senders. Tell me the sender address and I can help configure it within the current permissions. Rely on the actual configuration and delivery result.';
}

function buildEmailShowcaseIntro(mailboxAddress) {
  if (mailboxAddress) {
    return [
      'This built-in email integration example shows how it works after successful configuration.',
      `The current inbound address for this instance is \`${mailboxAddress}\`. When email integration is working and the sender is allowed, incoming mail can create a new session.`,
      'Before testing, confirm the email integration and allowed sender settings. I can help configure them within the current permissions.',
      'The user message below shows an example of the format for email received in a session.',
    ].join('\n\n');
  }

  return [
    'This built-in email integration example shows how it works after successful configuration.',
    'Once email integration is enabled and the sender is allowed, incoming mail can create a new session.',
    'Before testing, confirm the email integration and allowed sender settings. I can help configure them within the current permissions.',
    'The user message below shows an example of the format for email received in a session.',
  ].join('\n\n');
}

function buildEmailShowcaseUserMessage(mailboxAddress) {
  return [
    'Inbound email.',
    '- From: person-1@example.test',
    '- Subject: Built-in example email',
    '- Date: (no date)',
    '- Message-ID: (no message id)',
    '',
    'User message:',
    'This is a built-in example email.',
    '',
    mailboxAddress
      ? `If the integration works, email sent to ${mailboxAddress} will automatically enter a new session.`
      : 'If the integration works, email sent to this instance address will automatically enter a new session.',
  ].join('\n');
}

function buildDigestShowcaseIntro() {
  return [
    'This built-in example illustrates a possible workflow and result.',
    'This example shows the intended workflow of gathering industry news and emailing a summary to a specified address.',
  ].join('\n\n');
}

function isGuestBootstrapContext() {
  const instanceName = basename(INSTANCE_ROOT || '').trim().toLowerCase();
  return !!instanceName && instanceName !== 'owner';
}

function buildGuestMigrationGuideMessages() {
  return [
    {
      role: 'assistant',
      content: [
        'This instance supports local migration. I can inspect project directories on your old computer, read a small number of explanatory files, and bring useful files into this instance.',
        'The goal is to bring the project context from your old computer into this instance so we can continue collaborating here, without making you decide what to upload alone.',
        'You can ask, for example:',
        '- "Connect to my local files, find project xxx on the computer, and list the most relevant RVT, DWG, PDF, and XLSX files."',
        '- "Do not upload everything yet. Inventory the directory structure first, then bring the most important files into this instance."',
        '- "First bring in the old project README, delivery notes, tables, and drawings that explain its background."',
      ].join('\n\n'),
    },
    {
      role: 'assistant',
      content: [
        'A typical migration proceeds as follows:',
        '1. Install the local assistant and connect it to this instance.',
        '2. I list directories, search keywords, and read a few explanatory files, then investigate further if needed.',
        '3. Once their value is confirmed, bring files into this instance as needed.',
        '4. After migration, continue communication and delivery in this instance.',
        'An approximate drive or directory location is enough to start. I can inventory and filter the rest.',
      ].join('\n\n'),
    },
  ];
}

async function hasCalendarSubscriptionGuide() {
  try {
    const feedInfo = await getFeedInfo();
    return !!feedInfo?.feedToken;
  } catch {
    return false;
  }
}

function buildCalendarGuideMessages() {
  return [
    {
      role: 'assistant',
      content: [
        'This instance supports calendar subscriptions. Created calendar events are written to an iCal feed. Subscribe once and new events can sync to your calendar app.',
        `**Recommended subscription link:**\n[Subscribe to the calendar](${buildCalendarSubscribeHelperPath()})`,
        `Manual subscription link:\n[Subscribe using HTTPS](${buildCalendarSubscribeHelperPath({ format: 'https' })})`,
        'Open the link above and confirm the calendar subscription prompt.',
        '**Platform instructions:**',
        '- **iOS**: Settings > Calendar > Accounts > Add Account > Other > Add Subscribed Calendar, then paste the address.',
        '- **macOS**: Calendar > File > New Calendar Subscription, then paste the address.',
        '- **Android**: [One Calendar](https://play.google.com/store/apps/details?id=com.degenhardt.android.onecalendar) supports importing subscription links.',
        'Refresh frequency and settings vary by calendar app. Follow the options shown by your client.',
        'After subscribing, supported sessions can create events. The client refresh time depends on its settings.',
      ].join('\n\n'),
    },
  ];
}

async function getOwnerBootstrapSessionDefinitions() {
  const [mailboxAddress, calendarGuideEnabled, starterTool] = await Promise.all([
    resolveCurrentMailboxAddress(),
    hasCalendarSubscriptionGuide(),
    resolveStarterToolSelection(),
  ]);
  const defaultToolId = starterTool.toolId;
  const definitions = [];
  let sidebarOrder = 1;
  const pushDefinition = (definition) => {
    definitions.push({
      ...definition,
      sidebarOrder,
    });
    sidebarOrder += 1;
  };

  pushDefinition({
      starterPreset: WELCOME_STARTER_PRESET,
      tool: defaultToolId,
      systemPrompt: WELCOME_STARTER_SYSTEM_PROMPT,
      externalTriggerId: OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID,
      name: 'Welcome',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: [
        {
          role: 'assistant',
          content: WELCOME_STARTER_MESSAGE,
        },
      ],
      extraMessages: [
        ...(!starterTool.available ? [{
          role: 'assistant',
          content: 'No available harness was detected during initialization or bootstrap recovery. To begin tasks, install or configure an available runtime in Harness management and check its current status.',
        }] : []),
        {
          role: 'assistant',
          content: buildInboundEmailSetupHint(mailboxAddress),
        },
      ],
    });

  if (isGuestBootstrapContext()) {
    pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_GUEST_MIGRATION_GUIDE_EXTERNAL_TRIGGER_ID,
      name: '[Guide] Connect local files and migrate material from an old computer',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: buildGuestMigrationGuideMessages(),
    });
  }

  pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_FILE_SHOWCASE_EXTERNAL_TRIGGER_ID,
      name: '[Example] Upload a spreadsheet and receive a cleaned file',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: [
        {
          role: 'assistant',
          content: [
            'This built-in example illustrates a possible workflow and result.',
            'Open the attachments to see the deliverable. The original uploaded spreadsheet appears above and the returned result below.',
          ].join('\n\n'),
        },
        {
          role: 'user',
          content: 'I will upload a sample sales spreadsheet with inconsistent dates, mixed contact and phone fields, and duplicate customers.',
          attachments: [
            {
              localPath: RAW_SPREADSHEET_ASSET_PATH,
              originalName: 'sales-march.raw.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              renderAs: 'file',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            'The sample result below contains a cleaned spreadsheet and cleanup notes.',
            'After you send your own spreadsheet, I will prepare a first version in the same way and then assess whether a reusable workflow is needed.',
          ].join('\n\n'),
          attachments: [
            {
              localPath: CLEANED_SPREADSHEET_ASSET_PATH,
              originalName: 'sales-march.cleaned.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              renderAs: 'file',
            },
            {
              localPath: CLEANUP_NOTES_ASSET_PATH,
              originalName: 'Cleanup notes.md',
              mimeType: 'text/markdown',
              renderAs: 'file',
            },
          ],
        },
      ],
    });
  pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_DIGEST_SHOWCASE_EXTERNAL_TRIGGER_ID,
      name: '[Example] Summarize recent industry news and email it',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: [
        {
          role: 'assistant',
          content: buildDigestShowcaseIntro(),
        },
        {
          role: 'user',
          content: 'I want to follow industry news about AI coding assistants and remote agents. First give me a summary for today and send it to my email. If the format works, make it daily at 8 a.m.',
        },
        {
          role: 'assistant',
          content: [
            'This is a built-in summary attachment. Sending email requires a configured and authorized mailbox.',
            'If you confirm the format and delivery work, I can set it up for automatic daily delivery.',
          ].join('\n\n'),
          attachments: [
            {
              localPath: DIGEST_SHOWCASE_ASSET_PATH,
              originalName: 'AI coding assistant news summary (example).md',
              mimeType: 'text/markdown',
              renderAs: 'file',
            },
          ],
        },
      ],
    });
  pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_INSTANCE_EMAIL_EXTERNAL_TRIGGER_ID,
      name: '[Example] Send email to this instance to create a session',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: [
        {
          role: 'assistant',
          content: buildEmailShowcaseIntro(mailboxAddress),
        },
        {
          role: 'user',
          content: buildEmailShowcaseUserMessage(mailboxAddress),
        },
        {
          role: 'assistant',
          content: 'This example shows successful email integration: eligible incoming mail can enter a separate session for further handling. Session creation depends on the current configuration and mail processing result.',
        },
      ],
    });
  if (calendarGuideEnabled) {
    pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_CALENDAR_SUBSCRIBE_EXTERNAL_TRIGGER_ID,
      name: '[Guide] Subscribe to calendar events created by AI',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: buildCalendarGuideMessages(),
    });
  }
  pushDefinition({
      tool: defaultToolId,
      externalTriggerId: OWNER_BOOTSTRAP_SHORTCUTS_GUIDE_EXTERNAL_TRIGGER_ID,
      name: '[Guide] Install shortcuts to launch Ragent with Siri or one tap',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      messages: [
        {
          role: 'assistant',
          content: [
            'These three shortcuts can launch Ragent from an iPhone or Mac. Download and install them from the attachments below.',
            '**Ragent Voice**\nSpeak a question, submit it automatically, and open Ragent to view the streaming response. This is suitable for Siri.',
            '**Ragent Text**\nType a question, submit it, and open Ragent. This is suitable for a Home Screen widget.',
            '**Open Ragent**\nOpen Ragent directly with one tap.',
          ].join('\n\n'),
          attachments: [
            {
              localPath: SHORTCUT_VOICE_ASSET_PATH,
              originalName: 'Ragent Voice.shortcut',
              mimeType: 'application/octet-stream',
              renderAs: 'file',
            },
            {
              localPath: SHORTCUT_TEXT_ASSET_PATH,
              originalName: 'Ragent Text.shortcut',
              mimeType: 'application/octet-stream',
              renderAs: 'file',
            },
            {
              localPath: SHORTCUT_OPEN_ASSET_PATH,
              originalName: 'Open Ragent.shortcut',
              mimeType: 'application/octet-stream',
              renderAs: 'file',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            '**Installation**',
            'iOS: Download an attachment and confirm the Shortcuts import prompt.',
            'Mac: Download and double-click the file to import it into Shortcuts, then sync it to the iPhone through iCloud.',
            'The first installation may require allowing untrusted shortcuts in Settings > Shortcuts.',
            '**After installation**',
            '- Add Voice to Siri from the shortcut details in the Shortcuts app.',
            '- Add Text or Open to a Home Screen widget or the lock screen.',
            '- All three shortcuts are available through Spotlight search.',
          ].join('\n\n'),
        },
      ],
    });

  return definitions;
}

const WELCOME_SHOWCASE_HINT = [
  'The sidebar contains built-in example sessions for spreadsheet cleanup, emailed industry summaries, and incoming email.',
  'Open whichever interests you to see examples of a request, delivery process, and result.',
  'If an example matches your situation, send me your own request in a similar form.',
].join('\n\n');

function getStarterMessagesForDefinition(definition) {
  return Array.isArray(definition.messages) ? definition.messages : [];
}

function resolveBootstrapSessionEntryMode(_session, definition) {
  return definition?.entryMode === SESSION_ENTRY_MODE_READ
    ? SESSION_ENTRY_MODE_READ
    : '';
}

async function applyBootstrapSessionPresentation(session, definition) {
  let nextSession = session;
  if (Number.isInteger(definition.sidebarOrder) && definition.sidebarOrder > 0) {
    nextSession = await updateSessionGrouping(nextSession.id, { sidebarOrder: definition.sidebarOrder }) || nextSession;
  }
  nextSession = await updateSessionEntryMode(
    nextSession.id,
    resolveBootstrapSessionEntryMode(nextSession, definition),
  ) || nextSession;
  if (definition.pinned === true) {
    nextSession = await setSessionPinned(nextSession.id, true) || nextSession;
  }
  if (nextSession?.updatedAt) {
    nextSession = await updateSessionLastReviewedAt(nextSession.id, nextSession.updatedAt) || nextSession;
  }
  return nextSession;
}

async function loadMessageContents(sessionId, { stopWhen = null } = {}) {
  // Bootstrap only needs to compare seeded user/assistant message text.  Do
  // not hydrate tool/reasoning bodies from the entire session: a historical
  // session may contain tens of thousands of events and multi-GB bodies.
  const contents = [];
  const seen = new Set();
  await forEachStoredEvent(sessionId, async (event) => {
    if (event?.type !== 'message') return true;
    let content = typeof event.content === 'string' ? event.content : '';
    if (event.bodyAvailable && event.bodyLoaded === false) {
      const body = await readEventBody(sessionId, event.seq).catch(() => null);
      if (body?.field === 'content' && typeof body.value === 'string') content = body.value;
    }
    const normalized = content.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      contents.push(normalized);
    }
    if (typeof stopWhen === 'function' && stopWhen(contents)) return false;
    return true;
  });
  return contents;
}

async function appendMissingBootstrapMessages(sessionId, messages = [], existingContents = null) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const contents = Array.isArray(existingContents)
    ? existingContents
    : await loadMessageContents(sessionId, {
      stopWhen: (current) => messages.every((message) => {
        const content = typeof message?.content === 'string' ? message.content.trim() : '';
        return !content || current.includes(content);
      }),
    });
  const pendingMessages = messages.filter((message) => {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    return content && !contents.includes(content);
  });
  if (pendingMessages.length === 0) return 0;
  const pendingEvents = await buildMessageEvents(sessionId, pendingMessages);
  if (pendingEvents.length === 0) return 0;
  await appendEvents(sessionId, pendingEvents);
  return pendingEvents.length;
}

async function backfillWelcomeGuideMessages(session, mailboxAddress) {
  const hasShowcaseHint = (content) => /预置示例会话|3 个真实跑通过的示例会话|发邮件进实例自动开新会话|The sidebar contains built-in example sessions/u.test(content);
  const existingContents = await loadMessageContents(session.id, {
    stopWhen: (current) => current.some(hasShowcaseHint)
      && current.some((content) => /允许发件人|安全机制会先把邮件拦掉|configure allowed senders/u.test(content)),
  });
  const followups = [];
  if (!existingContents.some(hasShowcaseHint)) {
    followups.push({ role: 'assistant', content: WELCOME_SHOWCASE_HINT });
  }
  if (!existingContents.some((content) => /允许发件人|安全机制会先把邮件拦掉|configure allowed senders/u.test(content))) {
    followups.push({ role: 'assistant', content: buildInboundEmailSetupHint(mailboxAddress) });
  }
  await appendMissingBootstrapMessages(session.id, followups, existingContents);
}

async function publishMessageAttachments(sessionId, attachments = []) {
  const publishedAttachments = [];
  for (const attachment of attachments) {
    if (!(attachment && typeof attachment === 'object')) continue;
    const published = await publishLocalFileAssetFromPath({
      sessionId,
      localPath: attachment.localPath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      createdBy: 'assistant',
    });
    publishedAttachments.push({
      assetId: published.id,
      originalName: attachment.originalName || published.originalName,
      mimeType: attachment.mimeType || published.mimeType,
      ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
      ...(attachment.renderAs ? { renderAs: attachment.renderAs } : {}),
    });
  }
  return publishedAttachments;
}

async function buildMessageEvents(sessionId, messages = []) {
  const events = [];
  for (const message of messages) {
    if (!(message && typeof message.content === 'string' && message.content.trim())) continue;
    const attachments = Array.isArray(message.attachments) && message.attachments.length > 0
      ? await publishMessageAttachments(sessionId, message.attachments)
      : [];
    events.push(messageEvent(
      message.role === 'user' ? 'user' : 'assistant',
      message.content,
      attachments,
    ));
  }
  return events;
}

async function createOwnerBootstrapSession(definition) {
  let session = await createSession(MANAGED_WORK_ROOT_DIR, definition.tool || 'codex', definition.name || 'Session', {
    sourceId: 'chat',
    sourceName: 'Chat',
    externalTriggerId: definition.externalTriggerId,
    starterPreset: definition.starterPreset || '',
    systemPrompt: typeof definition.systemPrompt === 'string' ? definition.systemPrompt : '',
  });
  session = await getSession(session.id) || session;

  if (Number(session?.messageCount || 0) === 0) {
    const starterMessages = getStarterMessagesForDefinition(definition);
    const extraMessages = Array.isArray(definition.extraMessages) ? definition.extraMessages : [];
    const starterEvents = await buildMessageEvents(session.id, [...starterMessages, ...extraMessages]);
    if (starterEvents.length > 0) {
      await appendEvents(session.id, starterEvents);
      session = await getSession(session.id) || session;
    }
  }

  return applyBootstrapSessionPresentation(session, definition);
}

export async function backfillOwnerBootstrapSessions() {
  const [ownerBootstrapSessions, mailboxAddress] = await Promise.all([
    getOwnerBootstrapSessionDefinitions(),
    resolveCurrentMailboxAddress(),
  ]);
  const ownerSessions = await listSessions();
  const sessionsByTrigger = new Map(
    ownerSessions
      .filter((session) => typeof session?.externalTriggerId === 'string' && session.externalTriggerId.trim())
      .map((session) => [session.externalTriggerId.trim(), session]),
  );

  const created = [];
  const updated = [];
  let welcomeSession = sessionsByTrigger.get(OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) || null;

  for (const definition of ownerBootstrapSessions) {
    let session = sessionsByTrigger.get(definition.externalTriggerId) || null;
    // A missing old seed phrase does not prove a conversation is untouched.
    if (!session) {
      session = await createOwnerBootstrapSession(definition);
      if (!session) continue;
      sessionsByTrigger.set(definition.externalTriggerId, session);
      created.push(definition.name);
    } else {
      session = await applyBootstrapSessionPresentation(session, definition);
      updated.push(definition.name);
    }

    if (definition.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) {
      await backfillWelcomeGuideMessages(session, mailboxAddress);
      welcomeSession = await getSession(session.id) || session;
    }
  }

  return {
    welcomeSession,
    created,
    updated,
  };
}
