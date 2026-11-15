import { readProotAccountLink, readProotAccountLinkKey, commitProotAccountEvent, signOutProotAccountLink, reserveProotAccountInvitation } from '../lib/proot-account-link-state.mjs';
import { authenticateProotRequest } from '../lib/proot-local-pairing.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { getOwnerAccountBinding } from '../lib/owner-account-auth.mjs';
import { allowsBindingAuthority, refreshCurrentOwnerBindingAuthority, authorizeDeviceBinding } from '../lib/binding-authority-runtime.mjs';
import { verifyDeviceAuthSignature, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { getTrustedDeviceStatus, getTrustedDevicePublicKey } from './trusted-devices.mjs';
import { readBody } from '../lib/utils.mjs';

const fields = ['version','action','instanceId','linkId','deviceId','accountId','eventId','expectedGeneration','issuedAt','expiresAt','signature'];
const fail = (code,statusCode=400) => Object.assign(new Error(code),{code,statusCode});
function valid(event) {
  return event && typeof event === 'object' && !Array.isArray(event)
    && Object.keys(event).sort().join(',') === [...fields].sort().join(',') && event.version === 1
    && ['link','logout','invite'].includes(event.action) && /^inst_[A-Za-z0-9_-]{16,128}$/.test(event.instanceId || '')
    && /^lnk_[A-Za-z0-9_-]{16,128}$/.test(event.linkId || '')
    && /^[A-Za-z0-9_-]{8,160}$/.test(event.deviceId || '') && /^[A-Za-z0-9_-]{8,160}$/.test(event.accountId || '')
    && /^[A-Za-z0-9_-]{16,128}$/.test(event.eventId || '') && Number.isSafeInteger(event.expectedGeneration) && event.expectedGeneration >= 0
    && Number.isSafeInteger(event.issuedAt) && Number.isSafeInteger(event.expiresAt)
    && event.expiresAt > event.issuedAt && event.expiresAt - event.issuedAt <= 300000
    && typeof event.signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(event.signature) && event.signature.length <= 256;
}
function message(e) {
  return JSON.stringify(['ragent-local-account-link-v1',1,e.instanceId,e.linkId,e.deviceId,e.accountId,e.action,e.eventId,e.expectedGeneration,e.issuedAt,e.expiresAt]);
}
export async function handleProotAccountLinkRequest(req,res,{onChange=async()=>{}}={}) {
  if (process.env.RAGENT_RUNTIME_MODE !== 'proot' || !['/api/local/account-link','/api/local/account-link/logout'].includes(req.url)) return false;
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if (!(await authenticateProotRequest(req))) { send(401,{code:'account_link_unauthorized'}); return true; }
  try {
    const identity = await loadOrCreateInstanceIdentity();
    if (req.url === '/api/local/account-link/logout') {
      if (req.method !== 'POST') { send(405,{code:'account_link_method_not_allowed'}); return true; }
      let body; try { body = JSON.parse(await readBody(req,1024)); } catch { throw fail('account_link_invalid'); }
      if (!body || Object.keys(body).sort().join(',') !== 'confirm,version' || body.version !== 1 || body.confirm !== true) throw fail('account_link_invalid');
      const result = signOutProotAccountLink();
      await onChange(result);
      send(200,{version:1,instanceId:identity.instanceId,...result}); return true;
    }
    if (req.method === 'GET') {
      const binding = await getOwnerAccountBinding();
      const state = readProotAccountLink();
      const active = binding?.accountId && binding?.bindingAuthorityRevision && allowsBindingAuthority({
        principalKind:'trusted_device',accountId:binding.accountId,bindingAuthorityRevision:binding.bindingAuthorityRevision,expiry:Date.now()+1000 });
      send(200,{version:1,instanceId:identity.instanceId,...state,ownerAccountId:binding?.accountId || null,
        ownerAuthority:binding?.accountId ? (active ? 'active' : 'unavailable') : 'unbound'}); return true;
    }
    if (req.method !== 'POST') { send(405,{code:'account_link_method_not_allowed'}); return true; }
    let event; try { event = JSON.parse(await readBody(req,8192)); } catch { throw fail('account_link_invalid'); }
    if (!valid(event) || event.instanceId !== identity.instanceId || event.issuedAt > Date.now()+30000 || event.expiresAt <= Date.now()) throw fail('account_link_invalid');
    const device = event.action === 'link' ? await getTrustedDeviceStatus(event.deviceId) : null;
    const stored = event.action !== 'link' ? readProotAccountLinkKey() : null;
    const key = event.action === 'link' ? await getTrustedDevicePublicKey(event.deviceId) : stored.publicKey;
    const algorithm = event.action === 'link' ? device?.keyAlgorithm : stored.algorithm;
    if (!key || !verifyDeviceAuthSignature({publicKey:key,algorithm,message:message(event),signature:event.signature})) throw fail('account_link_proof_invalid',403);
    if (event.action === 'invite') {
      const state = reserveProotAccountInvitation(event);
      const fingerprint = createDevicePublicKeyFingerprint(key);
      if (!fingerprint) throw fail('account_link_proof_invalid',403);
      const { getAccountPairingService } = await import('./account-pairing-service.mjs');
      const service = await getAccountPairingService();
      const invitation = await service.create({ ...state, fingerprint });
      const current = readProotAccountLink();
      if (current.state !== 'login_pending' || current.generation !== state.generation) {
        await service.revoke(invitation.id).catch(() => {});
        throw fail('account_link_generation_conflict',409);
      }
      send(200,{version:1,instanceId:identity.instanceId,...state,eventId:event.eventId,replay:false,invitation}); return true;
    }
    if (event.action === 'link') {
      const verifiedDevice = device || await getTrustedDeviceStatus(event.deviceId);
      if (!verifiedDevice || verifiedDevice.revokedAt || verifiedDevice.status !== 'bound' || verifiedDevice.accountId !== event.accountId || verifiedDevice.workspaceAccess) throw fail('account_link_proof_invalid',403);
      const binding = await getOwnerAccountBinding();
      if (!binding || binding.accountId !== event.accountId || !binding.bindingAuthorityRevision || binding.bindingAuthorityRevision !== verifiedDevice.bindingAuthorityRevision) throw fail('account_link_conflict',409);
      const proof = await refreshCurrentOwnerBindingAuthority();
      if (!proof?.active || proof.revision !== binding.bindingAuthorityRevision) throw fail('account_link_authority_unavailable',503);
      await authorizeDeviceBinding(verifiedDevice);
      const finalBinding = await getOwnerAccountBinding();
      if (event.expiresAt <= Date.now() || finalBinding?.accountId !== event.accountId
          || finalBinding?.bindingAuthorityRevision !== binding.bindingAuthorityRevision
          || !allowsBindingAuthority({ ...verifiedDevice, principalKind:'trusted_device', expiry:Date.now()+1000 })) throw fail('account_link_authority_unavailable',503);
    }
    const result = commitProotAccountEvent({ ...event, devicePublicKey:key, keyAlgorithm:algorithm });
    await onChange(result);
    send(200,{version:1,instanceId:identity.instanceId,...result});
  } catch (error) { send(error.statusCode || 503,{code:/^account_link_[a-z_]+$/.test(error.code || '') ? error.code : 'account_link_unavailable'}); }
  return true;
}
