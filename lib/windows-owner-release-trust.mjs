// PRIVATE fixed OS inspector facts only. A hash does not authenticate an Internet
// publisher: v2 trusts bytes approved by the local administrative installation.
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const ADMIN_INSTALLED_OWNER_TRUST='admin-installed-sha256';
export const ownerTrustFields=o=>o?.version===2?['trustMode']:['signatureStatus','publisherSha256'];
export function validOwnerTrustFacts(o){
 return o?.aclVerified===true&&hex(o.helperSha256)&&(o.version===2?o.trustMode===ADMIN_INSTALLED_OWNER_TRUST:o.version===1&&o.signatureStatus==='Valid'&&hex(o.publisherSha256));
}
export function validOwnerReleaseBinding(release,o,{protocols=[2]}={}){
 if(!validOwnerTrustFacts(o)||!release||!protocols.includes(release.protocolVersion)||release.helperFile!=='Ragent.OwnerBootstrap.exe'||release.helperSha256!==o.helperSha256)return false;
 if(o.version===2)return exact(release,['version','protocolVersion','helperFile','helperSha256','trustMode'])&&release.version===2&&release.protocolVersion===2&&release.trustMode===ADMIN_INSTALLED_OWNER_TRUST;
 return exact(release,['version','protocolVersion','helperFile','helperSha256','publisherSha256'])&&release.version===1&&release.publisherSha256===o.publisherSha256;
}
