import { redactSensitiveText } from './tool-call-schema.mjs';

// Provider text is display data, never an execution or authorization signal.
export function safeActivityDescription(value) {
  if (typeof value !== 'string') return '';
  const clean = redactSensitiveText(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ''))
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > 120 ? `${chars.slice(0, 119).join('').trimEnd()}…` : clean;
}

export function claudeBashDescription(name, input) {
  if (name !== 'Bash') return {};
  let value = input;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  const description = safeActivityDescription(value?.description);
  return description ? { activityDescription: description, activityDescriptionSource: 'tool_input_description' } : {};
}

export function acpTitleDescription(title, toolName = '') {
  const description = safeActivityDescription(title);
  const compare = (value) => value.toLocaleLowerCase().replace(/[\s_.-]+/g, ' ').trim();
  const normalized = compare(description);
  if (!normalized || (toolName && normalized === compare(toolName))
    || /^(tool|using tool|running tool|executing tool|execute|command|running command|pending|in progress|working)$/i.test(normalized)) return {};
  return { activityDescription: description, activityDescriptionSource: 'provider_title' };
}
