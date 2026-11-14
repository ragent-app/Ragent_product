// GitHub is an explicitly configured provider. No credentials or output are persisted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { factoryError } from './work-graph-store.mjs';
const exec=promisify(execFile);
const fail=(message,code='FACTORY_RELEASE_UNAVAILABLE')=>{throw factoryError(code,message,409);};
const sha=value=>createHash('sha256').update(value).digest('hex');
async function gh(args,{allowMissing=false}={}) {
 try {const {stdout}=await exec('gh',args,{timeout:60000,maxBuffer:8*1024*1024,windowsHide:true,env:{...process.env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1'}});return stdout;}
 catch(error){if(allowMissing && /HTTP 404\b/.test(String(error.stderr||'')))return null;fail('GitHub request could not be verified');}
}
async function api(path,{allowMissing=false}={}){const value=await gh(['api',path],{allowMissing});if(value===null)return null;try{return JSON.parse(value);}catch{fail('GitHub returned an invalid response');}}
export function githubReleaseConfig(policy,tag,artifactPath){
 const config=policy?.factoryGithubRelease,repo=config?.repository,workflow=config?.signerWorkflow,signerDigest=config?.signerDigest;
 if(process.env.AGENTOC_FACTORY_GITHUB_RELEASE_ENABLED!=='1'||typeof repo!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repo)||typeof workflow!=='string'||!workflow.startsWith(`${repo}/.github/workflows/`)||!/^[-A-Za-z0-9_./]+\.ya?ml$/.test(workflow)||workflow.includes('..')||!/^[a-f0-9]{40}$/.test(signerDigest||''))fail('GitHub release repository and pinned signer are not configured');
 if(typeof tag!=='string'||!/^[-A-Za-z0-9_./]{1,128}$/.test(tag)||tag.startsWith('-')||tag.includes('..')||tag.endsWith('/')||tag.includes('//'))fail('Invalid release tag','FACTORY_INVALID');
 const asset=basename(artifactPath);if(!asset||asset.includes('#')||asset.startsWith('-'))fail('Invalid asset name','FACTORY_INVALID');
 return {repository:repo,signerWorkflow:workflow,signerDigest,tag,asset};
}
export async function verifyGithubBuild({repository,signerWorkflow,signerDigest,artifactPath,artifactDigest,sourceCommit}){
 if(!/^[a-f0-9]{40}$/.test(sourceCommit||'')||!/^[a-f0-9]{64}$/.test(artifactDigest||''))fail('Build source or artifact digest unavailable');
 const raw=await gh(['attestation','verify',artifactPath,'--repo',repository,'--signer-workflow',signerWorkflow,'--signer-digest',signerDigest,'--source-digest',sourceCommit,'--format','json']);let results;try{results=JSON.parse(raw);}catch{fail('Build attestation response unavailable');}
 const matches=Array.isArray(results)?results.filter(x=>x?.verificationResult?.signature?.certificate?.sourceRepositoryDigest===sourceCommit&&String(x?.verificationResult?.signature?.certificate?.sourceRepositoryURI||'').toLowerCase()===`https://github.com/${repository}`.toLowerCase()&&x?.verificationResult?.statement?.predicateType==='https://slsa.dev/provenance/v1'&&Array.isArray(x.verificationResult.statement.subject)&&x.verificationResult.statement.subject.some(y=>y?.digest?.sha256===artifactDigest)):[];
 if(!matches.length)fail('No verified build attestation matches the artifact');return {kind:'github_attestation',repository,signerWorkflow,signerDigest,sourceCommit,artifactDigest,verifier:'gh attestation verify',verifiedCount:matches.length,verificationDigest:sha(JSON.stringify(matches.map(x=>x.verificationResult.statement)))};
}
export async function githubTagCommit({repository,tag}) {let object=(await api(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`))?.object;for(let i=0;i<8&&object?.type==='tag';i++)object=(await api(`repos/${repository}/git/tags/${object.sha}`))?.object;if(object?.type!=='commit'||!/^[a-f0-9]{40}$/.test(object.sha||''))fail('Remote tag does not resolve to a commit');return object.sha;}
// The by-tag endpoint returns published releases only; an incomplete draft listing is not absence.
export async function getGithubReleaseByTag({repository,tag}){
 const found=[];for(let page=1;page<=10;page++){const rows=await api(`repos/${repository}/releases?per_page=100&page=${page}`);if(!Array.isArray(rows))fail('Release listing unavailable');found.push(...rows.filter(row=>row?.tag_name===tag));if(found.length>1)fail('Multiple releases share the tag');if(rows.length<100)return found[0]||null;}fail('Release listing exceeds observation bound');
}
export async function publishGithubRelease({repository,tag,artifactPath,operationId}) {await gh(['release','create',tag,artifactPath,'--repo',repository,'--verify-tag','--draft','--notes',`Factory release operation ${operationId}`]);}
export async function finalizeGithubRelease({repository,tag}) {await gh(['release','edit',tag,'--repo',repository,'--draft=false']);}
export async function observeGithubRelease({repository,tag,asset,artifactDigest,sourceCommit,operationId}){
 const commit=await githubTagCommit({repository,tag});if(commit!==sourceCommit)fail('Remote tag changed');const release=await getGithubReleaseByTag({repository,tag});if(!release)return {state:'unknown',reason:'release_not_found'};
 if(release.tag_name!==tag||typeof release.draft!=='boolean'||(!release.draft&&!release.published_at)||release.body!==`Factory release operation ${operationId}`||!Number.isSafeInteger(release.id))return {state:'unknown',reason:'release_identity_mismatch'};
 const assets=await api(`repos/${repository}/releases/${release.id}/assets?per_page=100`);if(Array.isArray(assets)&&assets.length===0&&release.draft)return {state:'draft_empty',repository,tag,releaseId:String(release.id),commit};if(!Array.isArray(assets)||assets.length!==1)return {state:'unknown',reason:'asset_set_unverified'};
 const matched=assets.filter(a=>a.name===asset);if(matched.length!==1||matched[0].state!=='uploaded'||!Number.isSafeInteger(matched[0].id)||matched[0].digest!==`sha256:${artifactDigest}`)return {state:'unknown',reason:'asset_identity_unverified'};
 return {state:release.draft?'draft_verified':'published',repository,tag,commit,releaseId:String(release.id),assetId:String(matched[0].id),asset,artifactDigest,publishedAt:release.published_at||null};
}
