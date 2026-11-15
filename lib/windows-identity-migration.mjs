// Read-only migration assessment, never an installation/execution admission.
// ACL rows are inventory observations, not an effective-token access check.
export function assessWindowsIdentityMigration(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.readOnly !== true
      || snapshot.credentialContentsRead !== false || snapshot.ownerIpcConnected !== false
      || !Array.isArray(snapshot.services) || !Array.isArray(snapshot.paths)) {
    throw Object.assign(new Error('Invalid migration inventory'), { code: 'WINDOWS_MIGRATION_INVENTORY_INVALID' });
  }
  const blockers = [], add = (code, resource) => blockers.push({ code, resource });
  const names = ['Ragent-ControlPlane', 'Ragent-RunnerSupervisor'];
  for (const name of names) {
    const rows = snapshot.services.filter(row => row.name === name);
    if (rows.length !== 1 || !rows[0].present) { add('SERVICE_NOT_OBSERVED', name); continue; }
    const row = rows[0];
    if (row.configuredAccount?.toLowerCase() !== `nt service\\${name}`.toLowerCase()) add('SERVICE_IDENTITY_NOT_SEPARATED', name);
    if (!/^S-1-5-80-(?:\d+-){4}\d+$/.test(row.serviceSid || '')) add('SERVICE_SID_UNAVAILABLE', name);
    if (row.tokenDirectlyVerified !== true) add('INSTALLED_TOKEN_NOT_VERIFIED', name);
    if (!row.commandUsesOwnedHost) add('OWNED_SERVICE_COMMAND_NOT_CONFIRMED', name);
  }
  const control = snapshot.services.find(row => row.name === names[0]), executor = snapshot.services.find(row => row.name === names[1]);
  if (control?.serviceSid && control.serviceSid === executor?.serviceSid) add('SERVICE_SIDS_NOT_DISTINCT', 'services');
  const allowedControl = new Set(['S-1-5-18', 'S-1-5-32-544', control?.serviceSid].filter(Boolean));
  const observations = [];
  for (const label of ['control-config', 'control-auth-key']) {
    const rows = snapshot.paths.filter(row => row.label === label);
    if (rows.length !== 1 || !rows[0].present || !rows[0].aclRead || rows[0].reparse) { add('CONTROL_ACL_NOT_OBSERVED', label); continue; }
    const path = rows[0];
    if (label === 'control-config' && !path.protected) add('CONTROL_ACL_INHERITANCE_ENABLED', label);
    if (!allowedControl.has(path.ownerSid)) add('CONTROL_OBJECT_OWNER_REQUIRES_MIGRATION', label);
    // Detect a forbidden allow, even if a deny might reduce effective access.
    // This deliberately cannot certify effective denial for a service token.
    const foreign = (path.rules || []).filter(rule => rule.type === 'Allow' && !allowedControl.has(rule.sid)
      && !String(rule.propagation).split(',').map(x => x.trim()).includes('InheritOnly') && (Number(rule.mask) & 0xd011f) !== 0);
    observations.push({ resource: label, foreignAllowAces: foreign.length, effectiveAccessTested: false });
    if (foreign.length) add('CONTROL_ACL_HAS_NONCONTROL_ALLOW', label);
    if (!(path.rules || []).some(rule => rule.type === 'Allow' && rule.sid === control?.serviceSid && (Number(rule.mask) & 1) !== 0)) add('CONTROL_SERVICE_ACCESS_NOT_OBSERVED', label);
  }
  const before = snapshot.services.map(row => [row.name, row.configuredAccount, row.pid, row.state]);
  const after = (snapshot.serviceObservationAfter || []).map(row => [row.name, row.configuredAccount, row.pid, row.state]);
  if (JSON.stringify(before) !== JSON.stringify(after)) add('SERVICE_STATE_CHANGED_DURING_AUDIT', 'services');
  // Hard gates cannot be satisfied by caller-supplied audit metadata. Runtime
  // token, cross-account file/pipe and migration tests are separate evidence.
  for (const code of ['PRODUCTION_OWNER_IPC_NOT_VALIDATED', 'PRODUCTION_CREDENTIAL_BROKER_NOT_INTEGRATED',
    'SERVICE_HOST_TOKEN_REDUCTION_NOT_INTEGRATED', 'PRODUCTION_DESKTOP_PREPARATION_NOT_INTEGRATED',
    'MIGRATION_ROLLBACK_REBOOT_LOGOFF_UNINSTALL_NOT_VALIDATED']) add(code, 'release');
  const labels=['control-config','control-auth-key','instance-runtime','run-spool','provider-homes','harness-root','installed-host'];
  const metadataComplete=labels.every(label=>{const rows=snapshot.paths.filter(row=>row.label===label);return rows.length===1&&rows[0].present&&rows[0].aclRead&&!rows[0].reparse;});
  return { schemaVersion: 1, auditCompleted: true, metadataComplete, migrationReady: false, mutationPerformed: false,
    credentialContentsRead: false, effectiveAccessProven: false, blockers, observations,
    nextSteps: [
      'Install an authenticated Owner bootstrap transport bound to actual Windows owner/control tokens and instance.',
      'Move credential selection/refresh and Run signing to the control identity; transfer only a frozen Run capability and selected credential.',
      'Integrate fixed noninteractive desktop preparation and irreversible business-service token reduction.',
      'Stage explicit SID ACLs and granted work directories; validate under the actual installed execution token before cutover.',
      'Drain existing Runs, preserve an ACL/account snapshot, and test stopped-state migration/rollback without SYSTEM execution fallback.',
    ] };
}
