import { collectWindowsRuntimeDiagnostics } from './windows-runtime-diagnostics.mjs';
import { collectOwnerBootstrapDiagnostics } from './windows-owner-discovery.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function writeOutput(writer, value) {
  if (typeof writer === 'function') writer(value);
  else process.stdout.write(value);
}

function parseDoctorArgs(args) {
  const values = Array.isArray(args) ? args : [];
  return {
    json: values.includes('--json'),
    scope: values.includes('--service') ? 'service' : 'user',
    help: values.includes('--help') || values.includes('-h'),
    ownerBootstrap: values.includes('--owner-bootstrap'),
  };
}

function printDoctorHelp(writer) {
  writeOutput(writer, 'Usage:\n  ragent doctor [--json]\n  ragent doctor --service [--json]\n  ragent doctor --owner-bootstrap [--json]\n');
}

export function formatDoctorText(report) {
  const lines = [`Ragent doctor: ${report.status || 'unknown'} (${report.platform || 'unknown'})`];
  if (report.scope && report.scope !== 'user') lines.push(`scope: ${report.scope}`);
  if (report.status === 'unsupported') {
    lines.push('Windows runtime diagnostics are not applicable on this platform.');
    return `${lines.join('\n')}\n`;
  }
  if (report.error) lines.push(`error: ${report.error.code || 'WINDOWS_DIAGNOSTICS_FAILED'} ${report.error.message || ''}`.trim());
  if (report.endpoint) lines.push(`endpoint: ${report.endpoint.status || 'unknown'}${report.endpoint.name ? ` ${report.endpoint.name}` : ''}`);
  if (report.identity) lines.push(`identity: ${report.identity.status || 'unknown'}${report.identity.instanceId ? ` ${report.identity.instanceId}` : ''}`);
  if (report.services) {
    lines.push(`services: ${report.services.status || 'unknown'}`);
    for (const [name, state] of Object.entries(report.services.states || {})) {
      lines.push(`service.${name}: ${state}`);
    }
  }
  const tools = report.tools || {};
  for (const [name, tool] of Object.entries(tools)) {
    if (name === 'providers') {
      for (const [provider, providerTool] of Object.entries(tool || {})) {
        lines.push(`provider.${provider}: ${providerTool.status || 'unknown'}${providerTool.version ? ` ${providerTool.version}` : ''}`);
      }
      continue;
    }
    lines.push(`${name}: ${tool?.status || 'unknown'}${tool?.version ? ` ${tool.version}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function failedReport(error, platform, scope = 'user') {
  return {
    version: 'windows-runtime-diagnostics/v1',
    platform,
    supported: platform === 'win32',
    status: 'failed',
    scope,
    error: {
      code: trimString(error?.code) || 'WINDOWS_DIAGNOSTICS_FAILED',
      message: trimString(error?.message) || String(error),
    },
  };
}

export async function runDoctorCommand(args = [], {
  platform = process.platform,
  env = process.env,
  diagnosticsImpl = collectWindowsRuntimeDiagnostics,
  ownerBootstrapDiagnosticsImpl = collectOwnerBootstrapDiagnostics,
  writer,
} = {}) {
  const options = parseDoctorArgs(args);
  if (options.help) {
    printDoctorHelp(writer);
    return 0;
  }
  let report;
  try {
    report = options.ownerBootstrap
      ? await ownerBootstrapDiagnosticsImpl({platform})
      : await diagnosticsImpl({ platform, env, scope: options.scope });
  } catch (error) {
    report = failedReport(error, platform, options.scope);
  }
  writeOutput(writer, options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorText(report));
  return report.status === 'invalid' || report.status === 'failed' ? 2 : 0;
}
