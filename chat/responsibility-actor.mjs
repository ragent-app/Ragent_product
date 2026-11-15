import { hasValidInstanceOwnerCredential } from '../lib/auth.mjs';
import { getOwnerAccountBinding } from '../lib/owner-account-auth.mjs';
import { authorizeDeviceBinding } from '../lib/binding-authority-runtime.mjs';

// Map only authenticated instance-owner credentials to the server's stable
// principal. Device identity is not itself an account identity.
export async function resolveResponsibilityActor(req,authSession) {
  const owner=String(process.env.RAGENT_FACTORY_SCHEDULER_OWNER_ID||'').trim();
  if(!owner) return null;
  if(hasValidInstanceOwnerCredential(req)) return {kind:'user',role:'owner',principalId:owner};
  if(authSession?.role!=='owner'||authSession?.workspaceAccess) return null;
  const device=authSession.principalKind==='trusted_device' && req?._bearerAuthSession?.principalKind==='trusted_device';
  const accountCookie=['google_accounts','google_accounts_poll'].includes(authSession.authMethod) && !req?._bearerAuthSession;
  if(!device&&!accountCookie) return null;
  try { const binding=await getOwnerAccountBinding(); if(!binding?.accountId||!authSession.accountId||binding.accountId!==authSession.accountId) return null; const authority=await authorizeDeviceBinding(authSession,device?{credential:true,tokenRevision:authSession.bindingAuthorityRevision}:{}); if(authority?.accountId!==binding.accountId) return null; }
  catch { return null; }
  return {kind:'user',role:'owner',principalId:owner};
}
