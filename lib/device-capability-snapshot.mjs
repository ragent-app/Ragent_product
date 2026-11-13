// Device reports are observations, not grants. Unknown is deliberately distinct
// from false: neither is sufficient for unattended scheduling.
const fact = value => value === true || value === 'yes' ? 'yes'
  : value === false || value === 'no' ? 'no' : 'unknown';

export function normalizeDeviceCapabilitySnapshot(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const capacity = Number.isSafeInteger(source.availableSlots) && source.availableSlots >= 0
    ? source.availableSlots : null;
  return Object.freeze({
    installed: fact(source.installed),
    online: fact(source.online),
    authorized: fact(source.authorized),
    isolationEnforced: fact(source.isolationEnforced),
    availableSlots: capacity,
  });
}

// Callers must obtain these facts from a trusted local source or a verified
// remote receipt. A catalog entry or a device's unverified claim is not one.
export function assessDeviceAdmission({ facts, requiredIsolation = true } = {}) {
  if (!facts || !['local', 'verified_remote'].includes(facts.source)) {
    return { allowed: false, reason: 'device_facts_unsupported' };
  }
  const snapshot = normalizeDeviceCapabilitySnapshot(facts);
  for (const key of ['installed', 'online', 'authorized', ...(requiredIsolation ? ['isolationEnforced'] : [])]) {
    if (snapshot[key] !== 'yes') return { allowed: false, reason: `device_${key}_${snapshot[key]}` };
  }
  if (snapshot.availableSlots === null) return { allowed: false, reason: 'device_capacity_unknown' };
  if (snapshot.availableSlots < 1) return { allowed: false, reason: 'device_capacity_exhausted' };
  return { allowed: true, reason: null };
}
