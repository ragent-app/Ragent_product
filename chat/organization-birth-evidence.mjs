// Actor identity is only public when recorded by a trusted creation path and
// still bound to the same session, with an explicit organization ancestry.
export function verifiedBirthActor(event, nodes) {
  if (event?.type !== 'node.created' || event?.payload?.birthActorSource !== 'hierarchical_session') return null;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const child = byId.get(event.nodeId);
  const actor = byId.get(event.actorNodeId);
  if (!child || !actor || child.organizationId !== event.organizationId || actor.organizationId !== event.organizationId
    || !event.actorSessionId || actor.currentSessionId !== event.actorSessionId || child.id === actor.id) return null;
  const seen = new Set([child.id]);
  let parentId = child.parentNodeId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === actor.id) return actor.id;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentNodeId;
  }
  return null;
}
