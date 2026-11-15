// Private control-parent owner of two fixed purpose channels. Installation trust
// and actual directory ACLs must already be established by the caller. No HTTP
// input or environment override enters this lifecycle.
import {randomBytes} from 'node:crypto';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,ownerDiscoveryPurposePath} from './windows-owner-discovery.mjs';
import {validateOwnerBootstrapPolicy} from './windows-owner-bootstrap-protocol.mjs';
import {createOwnerDiscoveryController,createOwnerDiscoveryFileStore} from './windows-owner-discovery-publication.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const allPurposes=Object.freeze(['cli','browser']);
export const OWNER_DISCOVERY_SET_MAX_GENERATIONS=16; // At most 32 endpoints in this authority window.
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export async function createOwnerDiscoverySetController({releaseJson,installationJson,issueOwnerSession,revokeOwnerSession,
  issueBrowserTicket,revokeBrowserTicket,confirmBrowserTicket,executablePath=OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,
  publisherStore=createOwnerDiscoveryFileStore({filePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.publisher}),
  stores=Object.fromEntries(allPurposes.map(purpose=>[purpose,createOwnerDiscoveryFileStore({filePath:ownerDiscoveryPurposePath(purpose)})])),
  serveEndpoint,clock=Date.now,enabledPurposes=['cli','browser']}={}){
  if(!Array.isArray(enabledPurposes)||![1,2].includes(enabledPurposes.length)||enabledPurposes[0]!=='cli'
    ||(enabledPurposes.length===2&&enabledPurposes[1]!=='browser'))fail('OBS_CONFIGURATION_REQUIRED');
  const purposes=Object.freeze([...enabledPurposes]);
  // Unused browser stores remain unacquired; localweb needs no native ticket.
  if(!stores||!purposes.every(p=>typeof stores[p]?.acquire==='function')||Object.keys(stores).some(p=>!['cli','browser'].includes(p))||typeof publisherStore?.acquire!=='function'
    ||![issueOwnerSession,revokeOwnerSession,...purposes.includes('browser')?[issueBrowserTicket,revokeBrowserTicket,confirmBrowserTicket]:[]].every(value=>typeof value==='function'))fail('OBS_CONFIGURATION_REQUIRED');
  let release;try{release=JSON.parse(releaseJson);}catch{fail('OBS_METADATA_INVALID');}
  if(release?.protocolVersion!==2)fail('OBS_PROTOCOL_REQUIRED');
  const lease=await publisherStore.acquire(),controllers={},slots=Object.fromEntries(purposes.map(p=>[p,null])),generations={cli:0,browser:0};
  let authority=null,admitted=false,closing=false,closed=false,queue=Promise.resolve();
  const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  function gate(purpose){
    if(!admitted||closing||!slots[purpose]?.admitted||clock()>=authority.expiresAtUnixMs)fail('OBS_NOT_ADMITTED');
  }
  const guarded=(purpose,issue,revoke)=>async(...args)=>{
    gate(purpose);const value=await issue(...args);
    try{gate(purpose);}catch(error){if(value)await revoke(value);throw error;}
    return value;
  };
  async function drain(){
    admitted=false;for(const slot of Object.values(slots))if(slot)slot.admitted=false;
    // Both descriptors withdraw promptly, even when one endpoint cannot drain.
    const outcomes=await Promise.allSettled(Object.values(controllers).map(controller=>controller.close()));
    const failed=outcomes.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    await lease.close();closed=true;
  }
  try{
    for(const purpose of purposes)controllers[purpose]=await createOwnerDiscoveryController({releaseJson,installationJson,store:stores[purpose],executablePath,clock,serveEndpoint,
      ...purpose==='cli'?{issueOwnerSession:guarded(purpose,issueOwnerSession,revokeOwnerSession),revokeOwnerSession}:
        {issueBrowserTicket:guarded(purpose,issueBrowserTicket,revokeBrowserTicket),revokeBrowserTicket,confirmBrowserTicket}});
  }catch(error){closing=true;await drain();throw error;}
  function policy(purpose){
    if(generations[purpose]>=OWNER_DISCOVERY_SET_MAX_GENERATIONS)fail('OBS_CAPACITY');
    return validateOwnerBootstrapPolicy({...authority,protocolVersion:2,purpose,
      pipeName:'ragent-owner-bootstrap-'+randomBytes(16).toString('hex'),requestId:randomBytes(16).toString('hex')},{clock});
  }
  async function launch(purpose,first){
    const next=policy(purpose),slot={admitted:false,endpoint:null};generations[purpose]++;slots[purpose]=slot;
    try{
      const endpoint=await controllers[purpose][first?'start':'refresh'](next);
      const completion=endpoint.completion.then(value=>{slot.admitted=false;return value;},error=>{slot.admitted=false;throw error;});completion.catch(()=>{});
      slot.endpoint=endpoint;slot.admitted=endpoint.isActive();
      if(!slot.admitted)fail('OBS_ENDPOINT_ENDED');
      return Object.freeze({...endpoint,completion,purpose});
    }catch(error){slot.admitted=false;throw error;}
  }
  return Object.freeze({
    start(value){return serial(async()=>{
      if(closing||closed)fail('OBS_CLOSED');if(authority)fail('OBS_ALREADY_STARTED');
      if(!exact(value,['instanceId','controlSid','ownerSid','ownerSessionId','expiresAtUnixMs']))fail('OBS_AUTHORITY_INVALID');
      authority=Object.freeze(structuredClone(value));
      try{
        // Validate both before exposing either. Outer gate stays closed until
        // both native-ready descriptors are published; partial startup cannot mint.
        for(const purpose of purposes)policy(purpose);
        const endpoints={};for(const purpose of purposes)endpoints[purpose]=await launch(purpose,true);
        if(closing)fail('OBS_CLOSED');
        if(clock()>=authority.expiresAtUnixMs)fail('OBS_EXPIRED');
        if(!purposes.every(purpose=>slots[purpose]?.admitted&&slots[purpose]?.endpoint?.isActive()))fail('OBS_ENDPOINT_ENDED');
        admitted=true;return Object.freeze(endpoints);
      }catch(error){closing=true;await drain();throw error;}
    });},
    refresh(purpose){return serial(async()=>{
      ownerDiscoveryPurposePath(purpose);
      if(!purposes.includes(purpose))fail('OBS_PURPOSE_DISABLED');
      if(closing||closed)fail('OBS_CLOSED');if(!admitted)fail('OBS_NOT_STARTED');
      if(clock()>=authority.expiresAtUnixMs)fail('OBS_EXPIRED');
      // New random pipe/request, same frozen authority and deadline. The other
      // purpose keeps its original endpoint, publisher and issuer eligibility.
      return launch(purpose,false);
    });},
    close(){
      // Revocation intent takes effect before a pending start/refresh drains.
      // Filesystem/endpoint cleanup remains serialized behind that operation.
      closing=true;admitted=false;for(const slot of Object.values(slots))if(slot)slot.admitted=false;
      return serial(async()=>{if(closed)return;await drain();});
    },
  });
}
