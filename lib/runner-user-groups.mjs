// Runner capability inheritance policy.
//
// Ordinary Runs intentionally keep most of the control service user's normal
// filesystem/tool reach. The runner is not a workspace-only sandbox. These
// groups are the small, fixed set of OS privilege channels that must never be
// inherited by an ordinary runner; semantic operation policy remains the
// authority for sensitive path/effect decisions.

const GROUP_NAME_RE = /^[A-Za-z0-9_.@-]+$/;

export const RUNNER_DENIED_GROUPS = Object.freeze([
  'adm',
  'ragent-privileged',
  'audio',
  'docker',
  'disk',
  'input',
  'incus-admin',
  'kvm',
  'libvirt',
  'lxd',
  'podman',
  'render',
  'root',
  'shadow',
  'sudo',
  'systemd-journal',
  'sys',
  'kmem',
  'dialout',
  'tty',
  'uucp',
  'plugdev',
  'netdev',
  'lp',
  'disk',
  'cdrom',
  'floppy',
  'tape',
  'video',
  'wheel',
]);

const DENIED_GROUP_SET = new Set(RUNNER_DENIED_GROUPS);

function groupTokens(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\s,]+/);
}

export function normalizeRunnerInheritedGroups(value) {
  const result = [];
  const seen = new Set();
  for (const raw of groupTokens(value)) {
    const group = String(raw || '').trim();
    const normalized = group.toLowerCase();
    if (!group || !GROUP_NAME_RE.test(group) || DENIED_GROUP_SET.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(group);
  }
  return result;
}

export function formatRunnerInheritedGroups(value) {
  return normalizeRunnerInheritedGroups(value).join(' ');
}
