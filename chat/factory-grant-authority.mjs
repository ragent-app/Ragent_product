// Shared current-authority check used at claim, send, and running revocation.
const within = (child, root) => {
  if (typeof child !== 'string' || typeof root !== 'string') return false;
  const c=child.replace(/\\/g,'/').replace(/\/+$/,''), r=root.replace(/\\/g,'/').replace(/\/+$/,'');
  return !!c && !!r && (c===r || c.startsWith(`${r}/`));
};
export function factoryGrantDenial(db, organization, node, item) {
  let grant;
  try { grant=JSON.parse(node.grant_json || '{}'); } catch { return 'Assignee grant is unreadable'; }
  const contract=item.contract || {}, declared=contract.accessMode;
  if (declared && !['read','write'].includes(declared)) return 'Unsupported access mode';
  const paths=Array.isArray(contract.allowedPaths) ? contract.allowedPaths : [];
  const writing=declared==='write' || (!declared && paths.length>0);
  const required=['read','run',...(writing?['write']:[]),...(String(node.node_role).toLowerCase()==='reviewer'?['review']:[])];
  if (!Array.isArray(grant.allowedCapabilities) || required.some(cap=>!grant.allowedCapabilities.includes(cap))) return 'Assignee capability is missing';
  if (writing && (grant.canWrite!==true || !Array.isArray(grant.writablePaths) || paths.some(p=>!grant.writablePaths.some(root=>within(p,root))))) return 'Assignee write authority is insufficient';
  if (required.includes('review') && grant.canReview!==true) return 'Assignee review authority is missing';
  for (const capability of required) {
    const effective=db.prepare('SELECT * FROM organization_grants WHERE organization_id=? AND node_id=? AND capability=? AND revision<=? ORDER BY revision DESC,id DESC LIMIT 1').get(organization.id,node.id,capability,organization.current_revision);
    if (!effective?.allow) return `Assignee ${capability} grant is missing or revoked`;
    let scope; try { scope=JSON.parse(effective.scope_json || '{}'); } catch { return 'Assignee grant scope is unreadable'; }
    if (!scope || typeof scope!=='object' || Array.isArray(scope) || Object.keys(scope).some(k=>!['projectId','writablePaths'].includes(k)) || (scope.projectId && scope.projectId!==item.projectId)) return 'Assignee grant scope is invalid';
    if (capability==='write' && (!Array.isArray(scope.writablePaths) || paths.some(p=>!scope.writablePaths.some(root=>within(p,root))))) return 'Assignee write scope is insufficient';
  }
  return '';
}
