// Provider Profile -> harness protocol declarations and configuration bridge.
// Native codex/claude/agy homes remain handled by their existing paths; their
// declarations are also exposed to the UI so a provider form can explain the
// supported API formats before a user enters a URL.

const PROTOCOLS = Object.freeze({
  codex: ['openai-responses', 'openai-chat'],
  claude: ['anthropic-messages'],
  agy: ['agy'],
  // openai-responses is accepted as an OpenAI-compatible source profile.
  // The selected harness still determines the concrete endpoint shape; an
  // endpoint that exposes Responses only must be fronted by a conversion
  // gateway before it can be used by a Chat-Completions harness.
  pi: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  'qwen-code': ['openai-chat', 'openai-responses', 'anthropic-messages'],
  opencode: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  'kimi-code': ['openai-chat', 'openai-responses', 'anthropic-messages'],
  goose: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  openhands: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  copilot: ['github-copilot', 'openai-chat', 'openai-responses', 'anthropic-messages'],
  hermes: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  cline: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  kilo: ['openai-chat', 'openai-responses', 'anthropic-messages'],
});

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

export function getHarnessProviderProtocols(harnessId) {
  return [...(PROTOCOLS[text(harnessId)] || [])];
}

export function resolveHarnessProviderCompatibility(harnessId, profile) {
  const harness = text(harnessId);
  const protocol = text(profile?.protocol).toLowerCase();
  const supported = getHarnessProviderProtocols(harness);
  if (!supported.length) return { ok: false, reason: 'harness-provider-unsupported', supportedProtocols: supported };
  if (!supported.includes(protocol)) {
    return { ok: false, reason: 'provider-protocol-unsupported', supportedProtocols: supported, protocol };
  }
  return { ok: true, protocol, supportedProtocols: supported };
}

function json(value) { return JSON.stringify(value, null, 2) + '\n'; }

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

// The returned files are written below an isolated per-Run home. Secrets are
// never returned to the launcher environment and are not placed in a global
// user config. Harnesses that only accept environment variables receive a
// harness-local dotenv file and an explicit path variable at spawn time.
export function buildHarnessProviderFiles(harnessId, snapshot, secret) {
  const harness = text(harnessId);
  if (secret?.authType !== 'api-key' || !text(secret.apiKey)) {
    return { ok: false, reason: 'harness-provider-api-key-required' };
  }
  const protocol = text(snapshot?.protocol).toLowerCase();
  const baseUrl = text(snapshot?.baseUrl);
  const model = text(snapshot?.model);
  const apiKey = text(secret.apiKey);
  if ((protocol !== 'github-copilot' && !baseUrl) || !model) {
    return { ok: false, reason: 'harness-provider-config-incomplete' };
  }
  const common = {
    RAGENT_PROVIDER_API_KEY: apiKey,
    RAGENT_PROVIDER_BASE_URL: baseUrl,
    RAGENT_PROVIDER_MODEL: model,
    RAGENT_PROVIDER_PROTOCOL: protocol,
  };
  // Official GitHub Copilot auth is a GitHub PAT, not an OpenAI credential.
  // Do not expose it under generic provider names that Copilot or a child
  // process could interpret as a different upstream integration.
  if (harness !== 'copilot') {
    if (protocol === 'anthropic-messages') {
      common.ANTHROPIC_API_KEY = apiKey;
      common.ANTHROPIC_BASE_URL = baseUrl;
    } else {
      common.OPENAI_API_KEY = apiKey;
      common.OPENAI_BASE_URL = baseUrl;
    }
  }
  const env = Object.entries(common).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  const files = [{ name: '.ragent-provider.env', content: env }];
  if (harness === 'copilot') {
    // GitHub-hosted Copilot is authenticated with a GitHub token. Custom
    // providers use Copilot CLI's own provider namespace and must not receive
    // a GH_TOKEN accidentally.
    if (protocol === 'github-copilot') {
      files[0].content += `GH_TOKEN=${JSON.stringify(apiKey)}\n`;
      if (model) files[0].content += `COPILOT_MODEL=${JSON.stringify(model)}\n`;
    } else {
      files[0].content += `COPILOT_PROVIDER_BASE_URL=${JSON.stringify(baseUrl)}\n`;
      files[0].content += `COPILOT_PROVIDER_TYPE=${JSON.stringify(protocol === 'anthropic-messages' ? 'anthropic' : 'openai')}\n`;
      files[0].content += `COPILOT_PROVIDER_API_KEY=${JSON.stringify(apiKey)}\n`;
      files[0].content += `COPILOT_MODEL=${JSON.stringify(model)}\n`;
    }
  } else if (harness === 'qwen-code') {
    const providerId = protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
    files.push({ name: '.qwen/settings.json', content: json({
      modelProviders: {
        [providerId]: [{ id: model, envKey: 'RAGENT_PROVIDER_API_KEY', baseUrl }],
      },
      security: { auth: { selectedType: providerId } },
      model: { name: model },
    }) });
  } else if (harness === 'kimi-code') {
    const providerType = protocol === 'anthropic-messages' ? 'anthropic'
      : (protocol === 'openai-responses' ? 'openai_responses' : 'openai');
    // Kimi 2.3 uses `openai` for Chat Completions; the old openai_legacy
    // discriminator causes its ACP auth readiness check to reject the model.
    // The config remains in the private per-Run home, never the user home.
    files.push({ name: '.kimi-code/config.toml', content: [
      `default_model = ${tomlString(model)}`,
      '',
      '[providers.ragent]',
      `type = ${tomlString(providerType)}`,
      `base_url = ${tomlString(baseUrl)}`,
      `api_key = ${tomlString(apiKey)}`,
      '',
      `[models.${JSON.stringify(model)}]`,
      'provider = "ragent"',
      `model = ${tomlString(model)}`,
      'max_context_size = 128000',
      '',
    ].join('\n') });
  } else if (harness === 'opencode') {
    files.push({ name: 'opencode.json', content: json({
      '$schema': 'https://opencode.ai/config.json',
      provider: {
        ragent: {
          npm: protocol === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
          name: 'Ragent Provider',
          options: { baseURL: baseUrl, apiKey },
          models: { [model]: { name: model } },
        },
      },
    }) });
  } else if (harness === 'openhands') {
    files.push({ name: '.ragent-openhands.env', content: `LLM_API_KEY=${JSON.stringify(apiKey)}\nLLM_BASE_URL=${JSON.stringify(baseUrl)}\nLLM_MODEL=${JSON.stringify(model)}\n` });
  } else if (harness === 'goose') {
    // Goose uses provider-specific names in its environment contract.  The
    // generic names above remain useful to Ragent, while these make the
    // generated isolated home directly consumable by `goose run`.
    files[0].content += `GOOSE_PROVIDER=${JSON.stringify(protocol === 'anthropic-messages' ? 'anthropic' : 'openai')}\nGOOSE_MODEL=${JSON.stringify(model)}\n`;
    if (protocol === 'anthropic-messages') {
      files[0].content += `ANTHROPIC_HOST=${JSON.stringify(baseUrl)}\n`;
    } else {
      files[0].content += `OPENAI_HOST=${JSON.stringify(baseUrl)}\n`;
    }
  } else if (harness === 'hermes') {
    // Hermes keeps model/provider/endpoint selection in config.yaml. The
    // credential stays in the generated dotenv file and is referenced by
    // key_env so it never gets duplicated into YAML.
    const transport = protocol === 'anthropic-messages'
      ? 'anthropic_messages'
      : (protocol === 'openai-responses' ? 'codex_responses' : 'chat_completions');
    files.push({ name: 'config.yaml', content: [
      'model:',
      `  provider: ${JSON.stringify('ragent')}`,
      `  default: ${JSON.stringify(model)}`,
      'providers:',
      '  ragent:',
      `    api: ${JSON.stringify(baseUrl)}`,
      '    key_env: RAGENT_PROVIDER_API_KEY',
      `    transport: ${transport}`,
      '',
    ].join('\n') });
  } else if (harness === 'cline') {
    // Cline resolves its provider settings from data/settings/providers.json.
    // Keep the credential out of that JSON: the selected built-in provider
    // reads its API key from the environment loaded by runtime-policy.mjs.
    const providerId = protocol === 'anthropic-messages' ? 'anthropic' : 'openai-native';
    const providerSettings = {
      provider: providerId,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(protocol === 'anthropic-messages'
        ? { protocol: 'anthropic', client: 'anthropic' }
        : protocol === 'openai-responses'
          ? { protocol: 'openai-responses', client: 'openai' }
          : { protocol: 'openai-chat', client: 'openai-compatible' }),
    };
    files.push({ name: 'settings/providers.json', content: json({
      version: 1,
      lastUsedProvider: providerId,
      providers: {
        [providerId]: {
          settings: providerSettings,
          updatedAt: new Date().toISOString(),
          tokenSource: 'manual',
        },
      },
    }) });
  } else if (harness === 'kilo') {
    // Kilo's provider schema names the AI SDK adapter and the environment
    // variables it may read. Keep the API key in the per-Run dotenv file
    // rather than copying it into kilo.jsonc or any global Kilo credential
    // store. Kilo's `{env:...}` apiKey form is not part of this schema.
    const providerNpm = protocol === 'anthropic-messages'
      ? '@ai-sdk/anthropic'
      : (protocol === 'openai-responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible');
    files.push({ name: 'kilo.jsonc', content: json({
      '$schema': 'https://app.kilo.ai/config.json',
      model: `ragent/${model}`,
      provider: {
        ragent: {
          npm: providerNpm,
          env: ['RAGENT_PROVIDER_API_KEY'],
          models: {
            [model]: {
              name: model,
              limit: { context: 128000, output: 16384 },
            },
          },
          options: {
            baseURL: baseUrl,
          },
        },
      },
    }) });
  }
  return { ok: true, files, envFile: '.ragent-provider.env', protocol };
}

export function isNativeHarness(harnessId) {
  return ['codex', 'claude', 'agy'].includes(text(harnessId));
}
