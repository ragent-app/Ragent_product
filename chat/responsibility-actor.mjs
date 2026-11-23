import { hasValidInstanceOwnerCredential } from '../lib/auth.mjs';
import { getOwnerAccountBinding } from '../lib/owner-account-auth.mjs';
import { authorizeDeviceBinding } from '../lib/binding-authority-runtime.mjs';

// Map only authenticated instance-owner credentials to the server's stable
// principal. Device identity is not itself an account identity.
export async function inspectResponsibilityActor(req,authSession) {
  const owner=String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim();
  if(!owner) return {actor:null,reason:'namespace_unavailable'};
  if(hasValidInstanceOwnerCredential(req)) return {actor:{kind:'user',role:'owner',principalId:owner}};
  if(authSession?.role!=='owner'||authSession?.workspaceAccess) return {actor:null,reason:'owner_session_unavailable'};
  const device=authSession.principalKind==='trusted_device' && req?._bearerAuthSession?.principalKind==='trusted_device';
  const accountCookie=['google_accounts','google_accounts_poll'].includes(authSession.authMethod) && !req?._bearerAuthSession;
  if(!device&&!accountCookie) return {actor:null,reason:'authentication_method_unavailable'};
  try {
    const binding=await getOwnerAccountBinding();
    if(!binding?.accountId) return {actor:null,reason:'owner_binding_unavailable'};
    if(!authSession.accountId || binding.accountId!==authSession.accountId)
      return {actor:null,reason:'account_binding_mismatch'};
    const authority=await authorizeDeviceBinding(authSession,device?{credential:true,tokenRevision:authSession.bindingAuthorityRevision}:{});
    if(authority?.accountId!==binding.accountId) return {actor:null,reason:'authority_unavailable'};
  } catch { return {actor:null,reason:'authority_unavailable'}; }
  return {actor:{kind:'user',role:'owner',principalId:owner}};
}

export async function resolveResponsibilityActor(req,authSession) {
  return (await inspectResponsibilityActor(req,authSession)).actor;
}
