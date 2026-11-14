import { readBody } from '../lib/utils.mjs';
import { resolveResponsibilityActor } from './responsibility-actor.mjs';
import { configureRemoteFactoryBinding, acceptRemoteFactoryOperation, getRemoteFactoryOperation, requestRemoteFactoryCancellation, signRemoteFactoryReceipt, signRemoteFactoryCandidate } from './remote-factory-operations.mjs';
import { configureRemoteFactorySourceBinding } from './remote-factory-source.mjs';
import { admitRemoteFactoryAttempt, getRemoteFactoryChild, getRemoteFactoryCandidate } from './factory-remote-admission.mjs';
import { getRemoteFactoryEvidence } from './factory-remote-evidence.mjs';

function jsonSourceAllowed(req) {
  if(!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers?.['content-type']||''))) return false;
  const site=String(req.headers?.['sec-fetch-site']||''); if(site&&!['same-origin','none'].includes(site)) return false;
  const origin=String(req.headers?.origin||''); if(!origin) return true;
  try {const url=new URL(origin);return !url.username&&!url.password&&url.origin===origin&&url.protocol===(req.socket?.encrypted?'https:':'http:')&&url.host.toLowerCase()===String(req.headers?.host||'').toLowerCase();} catch{return false;}
}
export async function handleRemoteFactoryRoutes({req,res,pathname,authSession,writeJson}) {
  const config=pathname==='/api/remote-factory/bindings';
  const sourceConfig=pathname==='/api/remote-factory/source-bindings';
  const evidence=/^\/api\/organizations\/([^/]+)\/factory\/work-items\/([^/]+)\/remote-evidence$/.exec(String(pathname||''));
  const operation=/^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)$/.exec(String(pathname||''));
  const candidate=/^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/candidate$/.exec(String(pathname||''));
  const cancel=/^\/api\/remote-factory\/bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/cancel$/.exec(String(pathname||''));
  const knowledge=/^\/api\/remote-factory\/source-bindings\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)\/knowledge\/(n_[A-Za-z0-9_-]{30,100})$/.exec(String(pathname||''));
  if(!config&&!sourceConfig&&!operation&&!candidate&&!cancel&&!evidence&&!knowledge) return false;
  try {
    if(evidence) {if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;} if(authSession?.role!=='owner'||['target_runtime_gateway','run_capability','temporary_device','provisional_device'].includes(authSession?.principalKind)) {writeJson(res,403,{error:'Instance owner required'});return true;} const actor=await resolveResponsibilityActor(req,authSession); if(!actor) {writeJson(res,403,{error:'Verified instance owner required'});return true;} writeJson(res,200,await getRemoteFactoryEvidence({organizationId:decodeURIComponent(evidence[1]),workItemId:decodeURIComponent(evidence[2])},actor));return true;}
    if(config||sourceConfig) {
      if(req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;}
      if(authSession?.role!=='owner'||['target_runtime_gateway','run_capability','temporary_device','provisional_device'].includes(authSession?.principalKind)) {writeJson(res,403,{error:'Instance owner required'});return true;}
      const actor=await resolveResponsibilityActor(req,authSession); if(!actor) {writeJson(res,403,{error:'Verified instance owner required'});return true;}
      if(process.env.AGENTOC_REMOTE_FACTORY_ENABLED!=='1') {writeJson(res,503,{code:'REMOTE_FACTORY_DISABLED',error:'Remote Factory admission is disabled'});return true;}
      if(!jsonSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;}
      const raw=await readBody(req,65536); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
      writeJson(res,200,await (sourceConfig?configureRemoteFactorySourceBinding(body,actor):configureRemoteFactoryBinding(body,actor)));return true;
    }
    if(authSession?.principalKind!=='target_runtime_gateway'||authSession.targetRuntime!==true) {writeJson(res,403,{error:'Verified target-runtime grant required'});return true;}
    if(knowledge) {if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;} const {readLiveRemoteKnowledge}=await import('./factory-remote-knowledge.mjs'); res.setHeader('Cache-Control','no-store'); writeJson(res,200,await readLiveRemoteKnowledge({sourceBindingId:knowledge[1],operationId:knowledge[2],nonce:knowledge[3]},authSession));return true;}
    if(cancel) {if(req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;} if(!jsonSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;} const raw=await readBody(req,16384); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;} const {cancelRemoteFactoryChild}=await import('./factory-remote-admission.mjs'); if(typeof cancelRemoteFactoryChild!=='function') {writeJson(res,503,{code:'REMOTE_CANCEL_UNAVAILABLE',error:'Remote cancellation is unavailable'});return true;} const receipt=await requestRemoteFactoryCancellation({...body,bindingId:cancel[1],operationId:cancel[2]},authSession,{cancel:cancelRemoteFactoryChild}); writeJson(res,200,await signRemoteFactoryReceipt(receipt));return true;}
    if(candidate) {if(req.method!=='GET') {writeJson(res,405,{error:'Method not allowed'});return true;} await getRemoteFactoryOperation(candidate[1],candidate[2],authSession,{candidate:true}); const envelope=await getRemoteFactoryCandidate(candidate[1],candidate[2]); writeJson(res,200,await signRemoteFactoryCandidate(envelope));return true;}
    const bindingId=operation[1],operationId=operation[2];
    if(req.method==='GET') {writeJson(res,200,await signRemoteFactoryReceipt(await getRemoteFactoryOperation(bindingId,operationId,authSession,{queryChild:getRemoteFactoryChild})));return true;}
    if(req.method!=='POST') {writeJson(res,405,{error:'Method not allowed'});return true;}
    if(process.env.AGENTOC_REMOTE_FACTORY_ENABLED!=='1') {writeJson(res,503,{code:'REMOTE_FACTORY_DISABLED',error:'Remote Factory admission is disabled'});return true;}
    if(!jsonSourceAllowed(req)) {writeJson(res,403,{error:'Request source or content type is not allowed'});return true;}
    const raw=await readBody(req,65536); let body; try {body=JSON.parse(raw||'{}');} catch {writeJson(res,400,{error:'Invalid JSON body'});return true;}
    writeJson(res,200,await signRemoteFactoryReceipt(await acceptRemoteFactoryOperation({...body,bindingId,operationId},authSession,{admit:admitRemoteFactoryAttempt})));return true;
  } catch(error) {writeJson(res,error?.code==='BODY_TOO_LARGE'?413:(error?.statusCode||400),{error:error?.message||'Remote Factory request failed',...(error?.code?{code:error.code}:{})});return true;}
}
