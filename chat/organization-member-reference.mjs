// Opaque member references carry identity only, never authority. Every read
// revalidates owner access, root ownership and the current binding.
export function makeMemberRef(identity) {
  return Buffer.from(JSON.stringify({ v: 1, ...identity }), 'utf8').toString('base64url');
}
export function parseMemberRef(ref) {
  if (typeof ref !== 'string' || ref.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(ref)) return null;
  try {
    const value = JSON.parse(Buffer.from(ref, 'base64url').toString('utf8'));
    if (value?.v !== 1 || !['formal', 'member'].includes(value.kind)) return null;
    if (typeof value.root !== 'string' || !value.root || typeof value.id !== 'string' || !value.id) return null;
    if (value.kind === 'formal' && (!Number.isSafeInteger(value.generation) || value.generation < 0)) return null;
    if (value.kind === 'member' && (typeof value.runId !== 'string' || !value.runId || (!Number.isSafeInteger(value.generation) || value.generation < 0))) return null;
    return value;
  } catch { return null; }
}
export function formalMemberDescriptor(root, node) {
  const generation = node.currentBinding?.generation;
  if (!Number.isSafeInteger(generation) || !node.id) return null;
  const ref = makeMemberRef({ kind: 'formal', root, id: node.id, generation });
  return { canonicalId: `formal:${node.id}`, sourceTag: 'ragent', executionHarnessId: node.executionHarnessId || null, parentCanonicalId: node.parentId ? `formal:${node.parentId}` : null,
    relationKnown: true, aliases: [{ kind: 'formal', id: node.id }],
    conversation: { ref, generation, scope: node.currentBinding?.sessionId ? 'full' : 'unavailable' } };
}
