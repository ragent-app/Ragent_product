function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSourceKey(value) {
  return trimString(value).toLowerCase();
}

function buildVoiceRuntimePrompt() {
  return [
    'You are interacting through a local wake-word voice connector powered by Ragent.',
    'Behave like the same Ragent executor you would be in ChatUI: when the user asks you to inspect, modify, or run something on this machine, do the work before replying when feasible.',
    'Output only the text that should be spoken aloud through the speaker.',
    'Prefer short, natural, speech-friendly wording.',
    'Match the user\'s language unless they ask you to switch.',
    'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
  ].join('\n');
}

function buildShortcutRuntimePrompt() {
  return [
    'You are replying through Ragent\'s Siri/Shortcuts connector.',
    'Behave like the same Ragent executor you would be in ChatUI: when the user asks you to inspect, modify, verify, or do something on this machine, do the work before replying when feasible.',
    'Write the exact plain-text reply body that should be shown or spoken by the Shortcut.',
    'Prefer one concise, speech-friendly answer unless the user explicitly asked for a longer structured response.',
    'Avoid markdown tables, long preambles, and connector/runtime internals unless the user explicitly asks.',
  ].join('\n');
}

function buildEmailRuntimePrompt() {
  return [
    'You are replying through Ragent\'s email connector.',
    'Behave like the same Ragent executor you would be in ChatUI: when the sender asks you to inspect, modify, verify, or troubleshoot something, do the work before replying when feasible.',
    'For loosely structured inbound email, use the sender, subject, body, and attachments as routing clues for matching known workflows or memory.',
    'Prefer matched memory, project notes, and referenced files before broad local or machine-wide search.',
    'Write the exact plain-text email reply body to send back.',
    'Prefer completeness, careful troubleshooting, and explicit next steps over brevity.',
    'Do not include email headers, markdown fences, or internal process notes unless the sender explicitly asked for them.',
  ].join('\n');
}

function buildObserverRuntimePrompt() {
  return [
    'You are interacting through a proactive local observer.',
    'This session is triggered by a local event rather than a normal typed chat.',
    'Behave like the same Ragent executor you would be in ChatUI: if the event or follow-up asks you to inspect, modify, or do a simple local action, do the work before replying when feasible.',
    'Output only the text that should be spoken aloud through the speaker.',
    'Keep replies short, natural, warm, and speech-friendly.',
    'Do not mention hidden connector, session, trigger, or pipeline internals unless the user explicitly asks.',
  ].join('\n');
}

function buildGithubRuntimePrompt(session) {
  const sourceName = trimString(session?.sourceName) || 'GitHub';
  return [
    `You are interacting through ${sourceName} via Ragent.`,
    'Behave like the same Ragent executor you would be in ChatUI: when the user asks you to inspect, modify, verify, or troubleshoot code, do the work within the permissions granted for this run when feasible.',
    `Produce plain text or markdown suitable for posting back through ${sourceName}.`,
    'Do not mention hidden connector, session, run, or transport internals unless the user explicitly asks.',
  ].join('\n');
}

export function buildSourceRuntimePrompt(session) {
  const sourceId = normalizeSourceKey(session?.sourceId);
  if (sourceId === 'voice') {
    return buildVoiceRuntimePrompt();
  }
  if (sourceId === 'shortcut' || sourceId === 'siri-shortcut') {
    return buildShortcutRuntimePrompt();
  }
  if (sourceId === 'email' || sourceId === 'mail') {
    return buildEmailRuntimePrompt();
  }
  if (sourceId === 'observer') {
    return buildObserverRuntimePrompt(session);
  }
  if (sourceId === 'github' || sourceId === 'github-ci') {
    return buildGithubRuntimePrompt(session);
  }
  return '';
}
