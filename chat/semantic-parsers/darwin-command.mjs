/**
 * macOS command recognition for the semantic approval preview.
 *
 * This is deliberately non-authorizing: macOS target resolution, execution
 * identity and executor-side revalidation do not exist yet. Every result is a
 * refusal, including recognized commands. The output is only a structured
 * indication of the candidate operation, not a complete effect enumeration.
 * Never use these candidates to execute a command or construct a capability.
 */
const UNAVAILABLE = 'platform:macos-authorization-unavailable';

function result(candidate) {
  const unknowns = [UNAVAILABLE, ...(candidate.unknowns || [])];
  return {
    candidates: [{
      ...candidate,
      confidence: 'unknown',
      effectsComplete: false,
      unknowns,
    }],
    unknowns,
    confidence: 'unknown',
  };
}

function unsupported(reason = 'parser:macos-command-unrecognized') {
  return result({
    primaryAction: 'unknown.host_effect',
    effects: [],
    target: { kind: 'unknown' },
    evidence: ['macos:shadow-only'],
    unknowns: [reason],
  });
}

function isStaticSimpleCommand(facts) {
  return Boolean(facts && typeof facts.command === 'string'
    && !facts.composite && !facts.complex && !facts.sudo
    && Array.isArray(facts.wrappers) && facts.wrappers.length === 0
    && Array.isArray(facts.environmentAssignments) && facts.environmentAssignments.length === 0
    // Do not interpret shell expansion, quoting, redirection or escapes. The
    // product must never authorize a command on this preliminary recognition.
    && !/[\u0000-\u001f\u007f;'"\\`$|&<>*?\[\]{}()!~]/u.test(facts.command));
}

function launchdService(value) {
  if (typeof value !== 'string') return null;
  const match = /^(system|gui\/(?:0|[1-9][0-9]*)|user\/(?:0|[1-9][0-9]*))\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(value);
  return match ? { domain: match[1], label: match[2] } : null;
}

export function mapDarwinFactsToCandidates(facts) {
  if (!isStaticSimpleCommand(facts)) return unsupported('parser:macos-complex-command');
  const program = facts.program;
  const args = facts.args;
  if (!Array.isArray(args)) return unsupported();

  if (program === 'launchctl' || program === '/bin/launchctl') {
    const verb = args[0];
    const target = verb === 'kickstart'
      ? (args.length === 2 ? args[1] : args.length === 3 && args[1] === '-k' ? args[2] : '')
      : ['enable', 'disable'].includes(verb) && args.length === 2 ? args[1] : '';
    const service = launchdService(target);
    if (!service) return unsupported('target:launchd-service-unresolved');
    return result({
      primaryAction: 'service.control',
      effects: ['process.execute'],
      target: { kind: 'launchd_service', ...service, verb, restart: verb === 'kickstart' && args[1] === '-k' },
      evidence: ['macos:shadow-only', 'launchctl', verb],
      unknowns: ['target:launchd-service-unverified', 'execution:macos-helper-unavailable'],
    });
  }

  if ((program === 'installer' || program === '/usr/sbin/installer')
      && args.length === 4 && args[0] === '-pkg' && args[2] === '-target'
      && args[3] === '/' && /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\.pkg$/i.test(args[1])
      && !args[1].split('/').some((part) => part === '.' || part === '..')) {
    return result({
      primaryAction: 'package.install',
      effects: ['process.execute'],
      target: { kind: 'package_artifact', manager: 'installer', root: args[1], installTarget: '/' },
      evidence: ['macos:shadow-only', 'installer'],
      unknowns: ['target:package-artifact-unverified', 'execution:macos-helper-unavailable'],
    });
  }

  if ((program === 'brew' || program === '/opt/homebrew/bin/brew' || program === '/usr/local/bin/brew')
      && args.length === 2 && args[0] === 'install'
      && /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,127}$/.test(args[1])) {
    return result({
      primaryAction: 'package.install',
      effects: ['process.execute'],
      target: { kind: 'package', manager: 'brew', packages: [args[1]] },
      evidence: ['macos:shadow-only', 'brew'],
      unknowns: ['target:brew-formula-unverified', 'execution:macos-helper-unavailable'],
    });
  }
  return unsupported();
}
