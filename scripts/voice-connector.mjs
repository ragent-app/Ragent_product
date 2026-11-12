#!/usr/bin/env node

import { appendFile, mkdir, readFile } from 'fs/promises'
import { createInterface } from 'readline'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { pathToFileURL } from 'url'

import { CHAT_PORT } from '../lib/config.mjs'
import {
  buildExternalTriggerId,
  buildAgentoCMessage,
  ensureAuthCookie,
  generateAgentoCReply,
  loginWithToken,
  normalizeSpokenReplyText,
  readOwnerToken,
} from './voice-connector-agentoc.mjs'
import {
  parseCommandPayload,
  runSay,
  runShellCommand,
} from './voice-connector-shell.mjs'

const DEFAULT_STORAGE_DIR = join(homedir(), '.config', 'agentoc', 'voice-connector')
const DEFAULT_CONFIG_PATH = join(DEFAULT_STORAGE_DIR, 'config.json')
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`
const DEFAULT_SESSION_TOOL = 'codex'
const DEFAULT_APP_ID = 'voice'
const DEFAULT_APP_NAME = 'Voice'
const DEFAULT_GROUP_NAME = 'Voice'
const DEFAULT_SESSION_MODE = 'stable'
const DEFAULT_CAPTURE_TIMEOUT_MS = 90 * 1000
const DEFAULT_STT_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_TTS_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_TTS_RATE = 185
const LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are replying through a local wake-word voice connector powered by AgentoC.',
  'For each assistant turn, output exactly the text that should be spoken aloud through the speaker.',
  'Keep replies concise, natural, and conversational.',
  'Prefer short sentences that sound good when spoken.',
  'Match the user\'s language unless they ask you to switch.',
  'Avoid markdown tables, code fences, bullet-heavy formatting, and raw URLs unless the user explicitly asks for them.',
  'If you need to mention structured information, say it in speech-first language.',
  'Do not mention hidden connector, session, or run internals unless the user explicitly asks.',
].join('\n')
const DEFAULT_SESSION_SYSTEM_PROMPT = [
  'You are interacting through a local wake-word voice connector on the user\'s own machine.',
  'Keep connector-specific overrides minimal and only describe constraints not already owned by Ragent backend prompt logic.',
].join('\n')

function normalizeSystemPrompt(value) {
  const normalized = trimString(value)
  if (!normalized || normalized === DEFAULT_SESSION_SYSTEM_PROMPT || normalized === DEFAULT_SESSION_SYSTEM_PROMPT.replace('Ragent', 'AgentoC') || normalized === LEGACY_DEFAULT_SESSION_SYSTEM_PROMPT) {
    return ''
  }
  return normalized
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeBaseUrl(value) {
  const normalized = trimString(value || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '')
  return normalized || DEFAULT_CHAT_BASE_URL
}

function resolveHomePath(value, fallback = '') {
  const trimmed = trimString(value || fallback)
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeEnvMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [trimString(key), entryValue])
      .filter(([key, entryValue]) => key && entryValue !== undefined && entryValue !== null)
      .map(([key, entryValue]) => [key, String(entryValue)]),
  )
}

function normalizeCommandStage(value, defaultTimeoutMs) {
  if (typeof value === 'string') {
    return {
      command: trimString(value),
      timeoutMs: defaultTimeoutMs,
      env: {},
    }
  }
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    command: trimString(normalized.command || normalized.cmd),
    timeoutMs: parsePositiveInteger(normalized.timeoutMs, defaultTimeoutMs),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeWakeConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const command = trimString(normalized.command)
  const requestedMode = trimString(normalized.mode).toLowerCase()
  const mode = requestedMode || (command ? 'command' : 'stdin')
  if (!['command', 'stdin'].includes(mode)) {
    throw new Error(`Unsupported wake mode: ${normalized.mode}`)
  }
  if (mode === 'command' && !command) {
    throw new Error('wake.command is required when wake.mode is "command"')
  }
  return {
    mode,
    command,
    keyword: trimString(normalized.keyword),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeTtsConfig(value) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const command = trimString(normalized.command)
  const requestedMode = trimString(normalized.mode).toLowerCase()
  const defaultMode = command ? 'command' : (process.platform === 'darwin' ? 'say' : 'disabled')
  const mode = requestedMode || defaultMode
  if (!['command', 'say', 'disabled', 'off'].includes(mode)) {
    throw new Error(`Unsupported tts.mode: ${normalized.mode}`)
  }
  if (mode === 'command' && !command) {
    throw new Error('tts.command is required when tts.mode is "command"')
  }
  return {
    enabled: normalized.enabled !== false && mode !== 'disabled' && mode !== 'off',
    mode: mode === 'off' ? 'disabled' : mode,
    command,
    voice: trimString(normalized.voice),
    rate: parsePositiveInteger(normalized.rate, DEFAULT_TTS_RATE),
    timeoutMs: parsePositiveInteger(normalized.timeoutMs, DEFAULT_TTS_TIMEOUT_MS),
    env: normalizeEnvMap(normalized.env),
  }
}

function normalizeConfig(value, options = {}) {
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const resolvedConfigPath = resolveHomePath(options.configPath || DEFAULT_CONFIG_PATH, DEFAULT_CONFIG_PATH)
  const storageDir = resolveHomePath(normalized.storageDir || dirname(resolvedConfigPath), DEFAULT_STORAGE_DIR)
  const connectorId = trimString(normalized.connectorId || normalized.deviceId || normalized.name || 'voice-main') || 'voice-main'
  const roomName = trimString(normalized.roomName || normalized.room)
  const sessionName = trimString(normalized.sessionName)
  const description = trimString(normalized.description)
  const sessionMode = trimString(normalized.sessionMode).toLowerCase() === 'per-wake' ? 'per-wake' : DEFAULT_SESSION_MODE
  const queueMode = trimString(normalized.queueMode).toLowerCase() === 'ignore' ? 'ignore' : 'queue'
  const hasCustomSystemPrompt = Object.prototype.hasOwnProperty.call(normalized, 'systemPrompt')
  return {
    configPath: resolvedConfigPath,
    storageDir,
    connectorId,
    roomName,
    chatBaseUrl: normalizeBaseUrl(normalized.chatBaseUrl),
    sessionFolder: resolveHomePath(normalized.sessionFolder || homedir(), homedir()),
    sessionTool: trimString(normalized.sessionTool || DEFAULT_SESSION_TOOL) || DEFAULT_SESSION_TOOL,
    model: trimString(normalized.model),
    effort: trimString(normalized.effort),
    thinking: normalized.thinking === true,
    systemPrompt: hasCustomSystemPrompt ? normalizeSystemPrompt(normalized.systemPrompt) : '',
    appId: trimString(normalized.appId || DEFAULT_APP_ID) || DEFAULT_APP_ID,
    appName: trimString(normalized.appName || DEFAULT_APP_NAME) || DEFAULT_APP_NAME,
    group: trimString(normalized.group || DEFAULT_GROUP_NAME) || DEFAULT_GROUP_NAME,
    sessionMode,
    sessionName,
    description,
    queueMode,
    wake: normalizeWakeConfig(normalized.wake),
    capture: normalizeCommandStage(normalized.capture, DEFAULT_CAPTURE_TIMEOUT_MS),
    stt: normalizeCommandStage(normalized.stt, DEFAULT_STT_TIMEOUT_MS),
    tts: normalizeTtsConfig(normalized.tts),
    errorSpeech: trimString(normalized.errorSpeech),
  }
}

async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedPath = resolveHomePath(configPath, DEFAULT_CONFIG_PATH)
  let raw = ''
  try {
    raw = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Voice connector config not found at ${resolvedPath}`)
    }
    throw error
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${resolvedPath}: ${error?.message || error}`)
  }
  return normalizeConfig(parsed, { configPath: resolvedPath })
}

function printUsage(exitCode) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  node scripts/voice-connector.mjs [options]

Options:
  --config <path>        Config file path (default: ${DEFAULT_CONFIG_PATH})
  --text <text>          Submit one direct transcript and exit
  --stdin                Read one transcript per stdin line
  --no-speak             Skip TTS playback
  -h, --help             Show this help

Wake command contract:
  - The wake command should emit one line per activation on stdout.
  - Each line may be plain text (treated as a transcript) or JSON.
  - JSON may include: eventId, wakeWord, transcript, audioPath, detectedAt, connectorId, roomName, metadata.

Stage command contract:
  - capture.command is optional. It receives AGENTOC_VOICE_* env vars and may output either a plain audio path or JSON with { audioPath, transcript }.
  - stt.command is optional. It receives AGENTOC_VOICE_AUDIO_PATH and should output either plain transcript text or JSON with { text } / { transcript }.
  - tts.command receives AGENTOC_VOICE_REPLY_TEXT and also gets the reply on stdin.

Config shape:
  {
    "connectorId": "living-room-speaker",
    "roomName": "Living Room",
    "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
    "sessionFolder": "${homedir()}",
    "sessionTool": "${DEFAULT_SESSION_TOOL}",
    "model": "",
    "effort": "",
    "thinking": false,
    "sessionMode": "${DEFAULT_SESSION_MODE}",
    "systemPrompt": "${DEFAULT_SESSION_SYSTEM_PROMPT.replace(/"/g, '\\"')}",
    "wake": {
      "mode": "command",
      "command": "python3 your-wake-loop.py --phrase \"Hello World\" --transcript-mode full",
      "keyword": "Hello World"
    },
    "tts": {
      "mode": "say",
      "voice": "Tingting",
      "rate": ${DEFAULT_TTS_RATE}
    }
  }
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    text: '',
    stdin: false,
    noSpeak: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      options.configPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--text') {
      options.text = argv[index + 1] || ''
      index += 1
      continue
    }
    if (arg === '--stdin') {
      options.stdin = true
      continue
    }
    if (arg === '--no-speak') {
      options.noSpeak = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      printUsage(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function isMainModule() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

function parseJsonIfPossible(text) {
  const normalized = trimString(text)
  if (!normalized) return null
  if (!/^[\[{]/.test(normalized)) return null
  try {
    return JSON.parse(normalized)
  } catch {
    return null
  }
}

function normalizeMultilineText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function normalizeIngressEvent(value, defaults = {}) {
  let normalized = value
  if (typeof normalized === 'string') {
    const parsed = parseJsonIfPossible(normalized)
    normalized = parsed || { transcript: normalized }
  }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return null
  }
  const eventId = trimString(normalized.eventId || normalized.id) || `voice-${randomUUID()}`
  const transcript = normalizeMultilineText(normalized.transcript || normalized.text)
  const audioPath = resolveHomePath(normalized.audioPath)
  const metadata = normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
    ? normalized.metadata
    : {}
  return {
    eventId,
    detectedAt: trimString(normalized.detectedAt || normalized.timestamp) || nowIso(),
    wakeWord: trimString(normalized.wakeWord || normalized.keyword || defaults.wakeWord),
    transcript,
    audioPath,
    connectorId: trimString(normalized.connectorId || normalized.deviceId || defaults.connectorId),
    roomName: trimString(normalized.roomName || normalized.room || defaults.roomName),
    source: trimString(normalized.source || defaults.source || 'voice'),
    metadata,
  }
}

function buildProcessEnv(runtime, summary, extra = {}) {
  return {
    AGENTOC_VOICE_CONNECTOR_ID: trimString(summary?.connectorId || runtime.config.connectorId),
    AGENTOC_VOICE_ROOM_NAME: trimString(summary?.roomName || runtime.config.roomName),
    AGENTOC_VOICE_WAKE_WORD: trimString(summary?.wakeWord || runtime.config.wake.keyword),
    AGENTOC_VOICE_EVENT_ID: trimString(summary?.eventId),
    AGENTOC_VOICE_DETECTED_AT: trimString(summary?.detectedAt),
    AGENTOC_VOICE_AUDIO_PATH: trimString(summary?.audioPath),
    AGENTOC_VOICE_TRANSCRIPT: trimString(summary?.transcript),
    AGENTOC_VOICE_REPLY_TEXT: trimString(extra.replyText),
    AGENTOC_VOICE_METADATA_JSON: JSON.stringify(summary?.metadata || {}),
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)])),
  }
}

async function appendJsonLine(pathname, payload) {
  await mkdir(dirname(pathname), { recursive: true })
  await appendFile(pathname, `${JSON.stringify(payload)}\n`, 'utf8')
}

function createRuntimeContext(config, storagePaths = null) {
  return {
    config,
    storagePaths: storagePaths || {
      eventsLogPath: join(config.storageDir, 'events.jsonl'),
    },
    authToken: '',
    authCookie: '',
    processing: false,
    queue: Promise.resolve(),
    wakeProcess: null,
    shuttingDown: false,
    readOwnerToken,
    loginWithToken,
  }
}

async function logConnectorEvent(runtime, type, payload = {}) {
  await appendJsonLine(runtime.storagePaths.eventsLogPath, {
    ts: nowIso(),
    type,
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
    ...payload,
  })
}

async function captureAudio(runtime, summary) {
  if (!runtime.config.capture.command) {
    return {
      audioPath: trimString(summary.audioPath),
      transcript: '',
    }
  }
  const result = await runShellCommand(runtime.config.capture.command, {
    env: {
      ...runtime.config.wake.env,
      ...runtime.config.capture.env,
      ...buildProcessEnv(runtime, summary),
    },
    timeoutMs: runtime.config.capture.timeoutMs,
  })
  const payload = parseCommandPayload(result.stdout)
  if (payload) {
    return {
      audioPath: resolveHomePath(payload.audioPath),
      transcript: normalizeMultilineText(payload.transcript || payload.text),
    }
  }
  return {
    audioPath: resolveHomePath(result.stdout),
    transcript: '',
  }
}

async function transcribeAudio(runtime, audioPath, summary) {
  if (!trimString(audioPath)) return ''
  if (!runtime.config.stt.command) {
    throw new Error('stt.command is required when no transcript is provided by the wake/capture pipeline')
  }
  const result = await runShellCommand(runtime.config.stt.command, {
    env: {
      ...runtime.config.stt.env,
      ...buildProcessEnv(runtime, { ...summary, audioPath }),
    },
    timeoutMs: runtime.config.stt.timeoutMs,
  })
  const payload = parseCommandPayload(result.stdout)
  if (payload) {
    return normalizeMultilineText(payload.transcript || payload.text)
  }
  return normalizeMultilineText(result.stdout)
}

async function resolveTranscript(runtime, summary) {
  const directTranscript = normalizeMultilineText(summary.transcript)
  if (directTranscript) {
    return {
      transcript: directTranscript,
      audioPath: trimString(summary.audioPath),
    }
  }

  let audioPath = trimString(summary.audioPath)
  let transcript = ''

  if (!audioPath || runtime.config.capture.command) {
    const captured = await captureAudio(runtime, summary)
    audioPath = trimString(captured.audioPath || audioPath)
    transcript = normalizeMultilineText(captured.transcript)
  }

  if (!transcript && audioPath) {
    transcript = await transcribeAudio(runtime, audioPath, summary)
  }

  return {
    transcript,
    audioPath,
  }
}

async function speakReply(runtime, replyText, summary) {
  if (!runtime.config.tts.enabled || !trimString(replyText)) return
  if (runtime.config.tts.mode === 'say') {
    await runSay(replyText, runtime.config.tts)
    return
  }
  if (runtime.config.tts.mode === 'command') {
    await runShellCommand(runtime.config.tts.command, {
      env: {
        ...runtime.config.tts.env,
        ...buildProcessEnv(runtime, summary, { replyText }),
      },
      stdin: replyText,
      timeoutMs: runtime.config.tts.timeoutMs,
    })
  }
}

async function processVoiceTurn(runtime, rawSummary, options = {}) {
  const summary = normalizeIngressEvent(rawSummary, {
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
    wakeWord: runtime.config.wake.keyword,
  })
  if (!summary) {
    return {
      ignored: true,
      reason: 'invalid_event',
    }
  }

  await logConnectorEvent(runtime, 'wake_detected', {
    eventId: summary.eventId,
    wakeWord: summary.wakeWord,
    transcriptPresent: Boolean(summary.transcript),
    audioPath: summary.audioPath,
  })

  try {
    const resolvedInput = await resolveTranscript(runtime, summary)
    const transcript = normalizeMultilineText(resolvedInput.transcript)
    if (!transcript) {
      await logConnectorEvent(runtime, 'empty_transcript', {
        eventId: summary.eventId,
      })
      return {
        eventId: summary.eventId,
        silent: true,
        reason: 'empty_transcript',
      }
    }

    const turn = {
      ...summary,
      transcript,
      audioPath: resolvedInput.audioPath,
    }

    await logConnectorEvent(runtime, 'transcript_ready', {
      eventId: turn.eventId,
      transcript,
      audioPath: turn.audioPath,
    })

    const reply = await generateAgentoCReply(runtime, turn)
    await logConnectorEvent(runtime, 'reply_ready', {
      eventId: turn.eventId,
      sessionId: reply.sessionId,
      runId: reply.runId,
      requestId: reply.requestId,
      silent: reply.silent,
      replyText: reply.replyText,
    })

    if (!options.noSpeak && reply.replyText) {
      await speakReply(runtime, reply.replyText, turn)
    }

    return {
      ...reply,
      eventId: turn.eventId,
      transcript,
      audioPath: turn.audioPath,
    }
  } catch (error) {
    await logConnectorEvent(runtime, 'turn_failed', {
      eventId: summary.eventId,
      error: error?.stack || error?.message || String(error),
    })
    if (!options.noSpeak && trimString(runtime.config.errorSpeech)) {
      try {
        await speakReply(runtime, runtime.config.errorSpeech, summary)
      } catch {}
    }
    throw error
  }
}

function enqueueVoiceTurn(runtime, rawSummary, options = {}) {
  const preview = normalizeIngressEvent(rawSummary, {
    connectorId: runtime.config.connectorId,
    roomName: runtime.config.roomName,
    wakeWord: runtime.config.wake.keyword,
  })
  if (!preview) {
    return Promise.resolve({ ignored: true, reason: 'invalid_event' })
  }

  if (runtime.config.queueMode === 'ignore' && runtime.processing) {
    return logConnectorEvent(runtime, 'wake_ignored_busy', {
      eventId: preview.eventId,
      transcriptPresent: Boolean(preview.transcript),
    }).then(() => ({ ignored: true, reason: 'busy' }))
  }

  const run = async () => {
    runtime.processing = true
    try {
      return await processVoiceTurn(runtime, preview, options)
    } finally {
      runtime.processing = false
    }
  }

  const queued = runtime.queue
    .catch(() => {})
    .then(run)

  runtime.queue = queued.catch(() => {})
  return queued
}

async function runStdinLoop(runtime, options = {}) {
  console.log('[voice-connector] stdin mode ready; send one transcript per line')
  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  for await (const line of reader) {
    const transcript = normalizeMultilineText(line)
    if (!transcript) continue
    try {
      const result = await enqueueVoiceTurn(runtime, {
        source: 'stdin',
        transcript,
      }, options)
      if (result.replyText) {
        console.log(`[voice-connector] reply: ${result.replyText}`)
      }
    } catch (error) {
      console.error('[voice-connector] turn failed:', error?.stack || error?.message || error)
    }
  }

  await runtime.queue.catch(() => {})
}

async function runWakeLoop(runtime, options = {}) {
  const command = runtime.config.wake.command
  const child = spawn('bash', ['-lc', command], {
    env: {
      ...process.env,
      ...runtime.config.wake.env,
      AGENTOC_VOICE_CONNECTOR_ID: runtime.config.connectorId,
      AGENTOC_VOICE_ROOM_NAME: runtime.config.roomName,
      AGENTOC_VOICE_WAKE_WORD: runtime.config.wake.keyword,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runtime.wakeProcess = child
  const stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity })
  const stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity })

  const stderrTask = (async () => {
    for await (const line of stderrReader) {
      const normalized = trimString(line)
      if (!normalized) continue
      console.error(`[voice-connector:wake] ${normalized}`)
    }
  })()

  for await (const line of stdoutReader) {
    const normalized = trimString(line)
    if (!normalized) continue
    try {
      const result = await enqueueVoiceTurn(runtime, normalized, options)
      if (result.replyText) {
        console.log(`[voice-connector] reply: ${result.replyText}`)
      }
    } catch (error) {
      console.error('[voice-connector] turn failed:', error?.stack || error?.message || error)
    }
  }

  await stderrTask.catch(() => {})
  const exitCode = await new Promise((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code))
  })
  runtime.wakeProcess = null
  if (!runtime.shuttingDown && exitCode !== 0) {
    throw new Error(`wake command exited with code ${exitCode}`)
  }
}

function installSignalHandlers(runtime) {
  let closing = false
  const handleSignal = (signal) => {
    if (closing) return
    closing = true
    runtime.shuttingDown = true
    console.log(`[voice-connector] shutting down (${signal})`)
    if (runtime.wakeProcess) {
      runtime.wakeProcess.kill('SIGTERM')
    }
    Promise.resolve(runtime.queue)
      .catch(() => {})
      .finally(() => {
        process.exit(0)
      })
  }
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const config = await loadConfig(options.configPath)
  const runtime = createRuntimeContext(config)
  installSignalHandlers(runtime)

  console.log(`[voice-connector] AgentoC base URL: ${config.chatBaseUrl}`)
  console.log(`[voice-connector] connector id: ${config.connectorId}`)
  console.log(`[voice-connector] room: ${config.roomName || '(unspecified)'}`)
  console.log(`[voice-connector] wake mode: ${config.wake.mode}`)
  console.log(`[voice-connector] session tool: ${config.sessionTool}`)
  console.log(`[voice-connector] events log: ${runtime.storagePaths.eventsLogPath}`)

  if (trimString(options.text)) {
    const result = await enqueueVoiceTurn(runtime, {
      source: 'cli_text',
      transcript: options.text,
    }, options)
    if (result.replyText) {
      console.log(result.replyText)
    }
    return
  }

  if (options.stdin || config.wake.mode === 'stdin') {
    await runStdinLoop(runtime, options)
    return
  }

  await runWakeLoop(runtime, options)
}

export {
  DEFAULT_APP_ID,
  DEFAULT_APP_NAME,
  DEFAULT_SESSION_SYSTEM_PROMPT,
  buildExternalTriggerId,
  buildAgentoCMessage,
  createRuntimeContext,
  enqueueVoiceTurn,
  ensureAuthCookie,
  generateAgentoCReply,
  loadConfig,
  normalizeConfig,
  normalizeIngressEvent,
  normalizeSpokenReplyText,
  processVoiceTurn,
  speakReply,
}

if (isMainModule()) {
  main().catch((error) => {
    console.error('[voice-connector] failed to start:', error?.stack || error?.message || error)
    process.exit(1)
  })
}
