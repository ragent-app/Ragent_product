import { getProviderCapabilities } from './provider-contract.mjs';
import { renderContextForRuntime } from './context-renderer.mjs';
import { applyContextPlanToCanonicalContext } from './context-attention-assembler.mjs';

export const RUNTIME_CONTEXT_COMPILER_VERSION = 'runtime-context-compiler-v1';

const compilerRegistry = new Map();

function text(value, maxChars = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function runtimeFamilyOf(value) {
  return text(value?.runtimeFamily || value, 160) || 'unknown';
}

function providerOf(value) {
  return text(value?.provider, 160);
}

function capabilitiesFor(runtimeFamily, fallback = null) {
  const capabilities = getProviderCapabilities(runtimeFamily) || fallback;
  return capabilities && typeof capabilities === 'object' ? { ...capabilities } : {};
}

function nativeResumeReason(binding, target, capabilities) {
  if (capabilities.supportsResume !== true) return 'NATIVE_RESUME_UNSUPPORTED';
  const bindingRuntime = text(binding?.runtimeFamily || binding?.runtime, 160);
  const targetRuntime = runtimeFamilyOf(target);
  if (bindingRuntime && targetRuntime && bindingRuntime !== targetRuntime) return 'RUNTIME_FAMILY_MISMATCH';
  const bindingProvider = text(binding?.providerProfile, 160);
  const targetProvider = text(target?.providerProfile, 160);
  if (bindingProvider && targetProvider && bindingProvider !== targetProvider) return 'PROVIDER_PROFILE_MISMATCH';
  const bindingModel = text(binding?.model, 240);
  const targetModel = text(target?.model, 240);
  if (bindingModel && targetModel && bindingModel !== targetModel) return 'MODEL_MISMATCH';
  const bindingFingerprint = text(binding?.runtimeFingerprint, 240);
  const targetFingerprint = text(target?.runtimeFingerprint, 240);
  if (bindingFingerprint && targetFingerprint && bindingFingerprint !== targetFingerprint) {
    return 'RUNTIME_FINGERPRINT_MISMATCH';
  }
  const bindingInstructions = text(binding?.instructionRevision, 240);
  const targetInstructions = text(target?.instructionRevision, 240);
  if (bindingInstructions && targetInstructions && bindingInstructions !== targetInstructions) {
    return 'INSTRUCTION_REVISION_MISMATCH';
  }
  if (!text(binding?.nativeSessionId || binding?.resumeId, 500)) return 'NO_NATIVE_SESSION_ID';
  return '';
}

function makeCompatibilityCompiler(runtimeFamily) {
  const capabilities = capabilitiesFor(runtimeFamily);
  return {
    runtimeFamily,
    capabilities(target = {}) {
      return {
        ...capabilities,
        runtimeFamily,
        provider: capabilities.provider || providerOf(target),
        supportsSemanticHydrate: true,
        supportsNativeResume: capabilities.supportsResume === true,
        compilerVersion: RUNTIME_CONTEXT_COMPILER_VERSION,
        tokenizer: 'conservative-char-estimate',
      };
    },
    resume({ binding = null, target = {} } = {}) {
      const reason = nativeResumeReason(binding, target, capabilities);
      if (reason) return { mode: 'semantic', reason };
      return {
        mode: 'native',
        nativeSessionId: text(binding.nativeSessionId || binding.resumeId, 500),
        deltaFromSeq: Number.isInteger(binding.coveredThroughSeq) ? binding.coveredThroughSeq : 0,
        reason: 'BINDING_MATCHED',
      };
    },
    buildContext({ context, options = {} } = {}) {
      return renderContextForRuntime(context, options);
    },
    hydrate({ context, options = {} } = {}) {
      return this.buildContext({ context, options });
    },
    handoff({ canonicalHandoff } = {}) {
      return canonicalHandoff || null;
    },
    extractBinding(event = {}) {
      const nativeSessionId = text(event.nativeSessionId || event.resumeId || event.providerSessionId, 500);
      if (!nativeSessionId) return null;
      return {
        runtimeFamily,
        providerProfile: text(event.providerProfile, 160),
        model: text(event.model, 240),
        nativeSessionId,
        runtimeFingerprint: text(event.runtimeFingerprint, 240),
        instructionRevision: text(event.instructionRevision, 240),
      };
    },
  };
}

function attentionContext(context, contextPlan, options) {
  return options.useAttentionPlan === true && contextPlan
    ? applyContextPlanToCanonicalContext(context, contextPlan)
    : context;
}

const STRUCTURED_FACT_TYPES = new Set([
  'task_goal',
  'task_state',
  'task_plan',
  'task_decisions',
  'task_completedWork',
  'task_failedAttempts',
  'task_blockers',
  'task_unresolved',
  'execution_state',
  'execution_files',
  'execution_validations',
  'execution_processes',
  'execution_tools',
  'execution_approvals',
  'execution_artifacts',
  'workspace_warning',
  'pending_approval',
]);

function selectedItems(contextPlan) {
  return Array.isArray(contextPlan?.selectedItems) ? contextPlan.selectedItems : [];
}

function selectedFactsText(contextPlan) {
  return selectedItems(contextPlan)
    .filter((entry) => STRUCTURED_FACT_TYPES.has(entry.type))
    .map((entry) => `[${entry.type}]\n${entry.content || ''}`)
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function selectedTranscriptText(contextPlan) {
  return selectedItems(contextPlan)
    .filter((entry) => !STRUCTURED_FACT_TYPES.has(entry.type)
      && !['current_request', 'managerTurnContext', 'planArtifact', 'goalInstructions', 'projectMemoryContext'].includes(entry.type))
    .map((entry) => `[${entry.type || 'context'}]\n${entry.content || ''}`)
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function appendBlock(left, label, value) {
  const normalized = text(value, 140_000);
  if (!normalized) return left || '';
  return [left, `${label}:\n${normalized}`].filter(Boolean).join('\n\n---\n\n');
}

function renderProviderResult(base, extra = {}) {
  return {
    ...base,
    metadata: {
      ...(base?.metadata || {}),
      ...extra,
    },
  };
}

function makeCodexCompiler(runtimeFamily) {
  const compatibility = makeCompatibilityCompiler(runtimeFamily);
  return {
    ...compatibility,
    capabilities(target = {}) {
      return {
        ...compatibility.capabilities(target),
        providerCompiler: 'codex-context-compiler-v1',
        carrier: 'codex-turn-plus-developer-instructions',
      };
    },
    hydrate({ context, contextPlan, options = {} } = {}) {
      const planned = attentionContext(context, contextPlan, options);
      const base = renderContextForRuntime(planned, options);
      const facts = selectedFactsText(contextPlan);
      const isNativeResume = planned?.hasResume === true;
      let developerInstructions = base.developerInstructions || '';
      let prompt = base.prompt || '';
      if (!isNativeResume && facts) {
        developerInstructions = appendBlock(
          developerInstructions,
          'Ragent canonical execution facts (authoritative)',
          facts,
        );
        const transcript = selectedTranscriptText(contextPlan);
        if (transcript) {
          prompt = prompt.replace(planned.sections?.continuationContext || '', transcript);
        }
      }
      return renderProviderResult({
        ...base,
        prompt,
        developerInstructions,
      }, {
        providerCompiler: 'codex-context-compiler-v1',
        providerCarrier: 'codex-turn-plus-developer-instructions',
        nativeHydration: isNativeResume ? 'delta-and-facts-only' : 'semantic-facts-in-developer-instructions',
      });
    },
  };
}

function makeClaudeCompiler(runtimeFamily) {
  const compatibility = makeCompatibilityCompiler(runtimeFamily);
  return {
    ...compatibility,
    capabilities(target = {}) {
      return {
        ...compatibility.capabilities(target),
        providerCompiler: 'claude-context-compiler-v1',
        carrier: 'claude-sectioned-handoff-prompt',
      };
    },
    hydrate({ context, contextPlan, options = {} } = {}) {
      const planned = attentionContext(context, contextPlan, options);
      const sections = planned?.sections || {};
      const parts = [];
      if (planned?.hasResume !== true) {
        if (text(sections.systemContext, 140_000)) parts.push(`Ragent system context:\n${text(sections.systemContext, 140_000)}`);
        if (text(sections.sourceRuntimePrompt, 140_000)) parts.push(`Source/runtime instructions:\n${text(sections.sourceRuntimePrompt, 140_000)}`);
        if (text(sections.templateInstructions, 140_000)) parts.push(`Template instructions:\n${text(sections.templateInstructions, 140_000)}`);
      }
      if (text(sections.continuationContext, 140_000)) {
        parts.push(`Ragent canonical handoff (authoritative facts and bounded evidence):\n${text(sections.continuationContext, 140_000)}`);
      }
      if (text(sections.managerTurnContext, 140_000)) parts.push(`<private>\n${text(sections.managerTurnContext, 140_000)}\n</private>`);
      if (text(sections.planArtifact, 140_000)) parts.push(`Current plan artifact:\n${text(sections.planArtifact, 140_000)}`);
      if (text(sections.perMessageInstruction, 140_000)) parts.push(`Agent per-message instruction (apply to this reply):\n${text(sections.perMessageInstruction, 140_000)}`);
      if (text(sections.goalInstructions, 140_000)) parts.push(text(sections.goalInstructions, 140_000));
      if (text(sections.projectMemoryContext, 30_000)) parts.push(text(sections.projectMemoryContext, 30_000));
      parts.push(`${planned?.hasResume === true ? 'Current' : 'User'} user message:\n${planned?.userText || ''}`);
      if (text(sections.visitorGuardrail, 140_000)) parts.push(text(sections.visitorGuardrail, 140_000));
      return renderProviderResult({
        prompt: parts.join('\n\n---\n\n'),
        developerInstructions: '',
        systemPrefix: '',
        metadata: {
          runtimeFamily,
          resumeUsed: planned?.hasResume === true,
          contextResumeMode: planned?.hasResume === true ? 'provider_resume' : 'remote_continuation',
          rendererStrategy: 'claude-sectioned-handoff',
          includedSections: ['continuationContext', 'managerTurnContext', 'planArtifact', 'perMessageInstruction', 'goalInstructions', 'userText'],
          includedCarrierBySection: {
            continuationContext: 'prompt',
            managerTurnContext: 'prompt',
            planArtifact: 'prompt',
            perMessageInstruction: 'prompt',
            goalInstructions: 'prompt',
            userText: 'prompt',
          },
          charCounts: {
            ...(planned?.charCounts || {}),
            continuationContext: text(sections.continuationContext, 140_000).length,
            managerTurnContext: text(sections.managerTurnContext, 140_000).length,
            prompt: parts.join('\n\n---\n\n').length,
          },
        },
      }, {
        providerCompiler: 'claude-context-compiler-v1',
        providerCarrier: 'claude-sectioned-handoff-prompt',
        nativeHydration: planned?.hasResume === true ? 'delta-and-facts-only' : 'full-semantic-handoff',
      });
    },
  };
}

function makeAgyCompiler(runtimeFamily) {
  const compatibility = makeCompatibilityCompiler(runtimeFamily);
  return {
    ...compatibility,
    capabilities(target = {}) {
      return {
        ...compatibility.capabilities(target),
        providerCompiler: 'agy-context-compiler-v1',
        carrier: 'agy-semantic-handoff-prompt',
      };
    },
    hydrate({ context, contextPlan, options = {} } = {}) {
      const planned = attentionContext(context, contextPlan, options);
      const sections = planned?.sections || {};
      const parts = [];
      if (text(sections.systemContext, 140_000)) parts.push(`Ragent system context:\n${text(sections.systemContext, 140_000)}`);
      if (text(sections.sourceRuntimePrompt, 140_000)) parts.push(`Source/runtime instructions:\n${text(sections.sourceRuntimePrompt, 140_000)}`);
      if (text(sections.templateInstructions, 140_000)) parts.push(`Template instructions:\n${text(sections.templateInstructions, 140_000)}`);
      if (text(sections.continuationContext, 140_000)) parts.push(`Canonical semantic handoff:\n${text(sections.continuationContext, 140_000)}`);
      if (text(sections.managerTurnContext, 140_000)) parts.push(`<private>\n${text(sections.managerTurnContext, 140_000)}\n</private>`);
      if (text(sections.planArtifact, 140_000)) parts.push(`Current plan artifact:\n${text(sections.planArtifact, 140_000)}`);
      if (text(sections.perMessageInstruction, 140_000)) parts.push(`Agent per-message instruction (apply to this reply):\n${text(sections.perMessageInstruction, 140_000)}`);
      if (text(sections.goalInstructions, 140_000)) parts.push(text(sections.goalInstructions, 140_000));
      if (text(sections.projectMemoryContext, 30_000)) parts.push(text(sections.projectMemoryContext, 30_000));
      parts.push(`User message:\n${planned?.userText || ''}`);
      if (text(sections.visitorGuardrail, 140_000)) parts.push(text(sections.visitorGuardrail, 140_000));
      const prompt = parts.join('\n\n---\n\n');
      return renderProviderResult({
        prompt,
        developerInstructions: '',
        systemPrefix: '',
        metadata: {
          runtimeFamily,
          resumeUsed: false,
          contextResumeMode: 'remote_continuation',
          rendererStrategy: 'agy-semantic-handoff',
          includedSections: ['continuationContext', 'managerTurnContext', 'planArtifact', 'perMessageInstruction', 'goalInstructions', 'userText'],
          includedCarrierBySection: {
            continuationContext: 'prompt',
            managerTurnContext: 'prompt',
            planArtifact: 'prompt',
            perMessageInstruction: 'prompt',
            goalInstructions: 'prompt',
            userText: 'prompt',
          },
          charCounts: {
            ...(planned?.charCounts || {}),
            continuationContext: text(sections.continuationContext, 140_000).length,
            managerTurnContext: text(sections.managerTurnContext, 140_000).length,
            prompt: prompt.length,
          },
        },
      }, {
        providerCompiler: 'agy-context-compiler-v1',
        providerCarrier: 'agy-semantic-handoff-prompt',
        nativeHydration: 'semantic-only',
      });
    },
  };
}

const PROVIDER_COMPILERS = new Map([
  ['codex-json', makeCodexCompiler('codex-json')],
  ['codex-app-server-json', makeCodexCompiler('codex-app-server-json')],
  ['claude-stream-json', makeClaudeCompiler('claude-stream-json')],
  ['claude-stream-json-bidi', makeClaudeCompiler('claude-stream-json-bidi')],
  ['agy-json', makeAgyCompiler('agy-json')],
  ['agy-stream-json', makeAgyCompiler('agy-stream-json')],
]);

export function registerRuntimeContextCompiler(runtimeFamily, compiler) {
  const key = runtimeFamilyOf(runtimeFamily);
  if (!compiler || typeof compiler !== 'object') throw new Error('runtime context compiler must be an object');
  if (typeof compiler.hydrate !== 'function' && typeof compiler.buildContext !== 'function') {
    throw new Error('runtime context compiler must provide hydrate or buildContext');
  }
  compilerRegistry.set(key, compiler);
  return compiler;
}

export function getRuntimeContextCompiler(runtimeFamily) {
  const key = runtimeFamilyOf(runtimeFamily);
  return compilerRegistry.get(key) || PROVIDER_COMPILERS.get(key) || makeCompatibilityCompiler(key);
}

export function getCompatibilityRuntimeContextCompiler(runtimeFamily) {
  return makeCompatibilityCompiler(runtimeFamilyOf(runtimeFamily));
}

export function getRuntimeContextCompilerCapabilities(runtimeFamily, target = {}) {
  const compiler = getRuntimeContextCompiler(runtimeFamily);
  return typeof compiler.capabilities === 'function'
    ? compiler.capabilities(target)
    : {
        runtimeFamily: runtimeFamilyOf(runtimeFamily),
        supportsSemanticHydrate: true,
        supportsNativeResume: false,
        compilerVersion: RUNTIME_CONTEXT_COMPILER_VERSION,
      };
}

export function resolveRuntimeContextResume({ runtimeFamily, binding = null, target = {} } = {}) {
  const compiler = getRuntimeContextCompiler(runtimeFamily);
  if (typeof compiler.resume !== 'function') return { mode: 'semantic', reason: 'COMPILER_RESUME_UNAVAILABLE' };
  return compiler.resume({ binding, target });
}

function planMetadata(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const {
    selectedItems,
    canonicalHandoff,
    ...metadata
  } = plan;
  return metadata;
}

export function compileRuntimeContext({
  context,
  contextPlan = null,
  runtimeFamily = context?.runtimeFamily,
  options = {},
} = {}) {
  const useAttentionPlan = options.useAttentionPlan === true;
  const useProviderSpecificCompiler = options.contextCompilerMode === 'provider-specific'
    || (options.contextCompilerMode !== 'compatibility' && useAttentionPlan);
  const compiler = useProviderSpecificCompiler
    ? getRuntimeContextCompiler(runtimeFamily)
    : getCompatibilityRuntimeContextCompiler(runtimeFamily);
  const inputContext = useAttentionPlan && contextPlan && !useProviderSpecificCompiler
    ? applyContextPlanToCanonicalContext(context, contextPlan)
    : context;
  const render = typeof compiler.hydrate === 'function'
    ? compiler.hydrate({ context: inputContext, contextPlan, options })
    : compiler.buildContext({ context: inputContext, contextPlan, options });
  const metadata = {
    ...(render?.metadata || {}),
    runtimeContextCompiler: RUNTIME_CONTEXT_COMPILER_VERSION,
    runtimeContextCompilerFamily: runtimeFamilyOf(runtimeFamily),
    contextPlanMode: useAttentionPlan ? 'attention-v1' : 'compatibility-shadow',
    contextCompilerMode: useProviderSpecificCompiler ? 'provider-specific' : 'compatibility',
    ...(contextPlan ? { contextPlan: planMetadata(contextPlan) } : {}),
  };
  return {
    ...(render || {}),
    metadata,
  };
}
