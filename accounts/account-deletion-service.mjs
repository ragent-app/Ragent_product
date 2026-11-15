import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createGoogleIdTokenVerifier, GOOGLE_JWKS_URL } from '../lib/google-id-token.mjs';
import { createAccountDeletionRepository } from './store/account-deletions.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT=/^[A-Za-z0-9_-]{1,160}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===64&&b.length===64
  &&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const stamp=value=>new Date(value).getTime();
function fail(code,statusCode=400){throw Object.assign(new Error(code),{code,statusCode});}
function shape(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('account_deletion_invalid');}
function id(value){if(typeof value!=='string'||!UUID.test(value))fail('account_deletion_id_invalid');return value;}
function secret(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)||Buffer.from(value,'base64url').toString('base64url')!==value)fail('account_deletion_secret_invalid');return hash(value);}

// Never send an ID token upstream: only Google's fixed public JWKS URL is used
// by the existing verifier. Bound both response bytes and its complete lifetime.
function boundedJwksFetch(fetchImpl){return async(url,options)=>{
  if(url!==GOOGLE_JWKS_URL)throw Error('Unexpected JWKS destination');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);timer.unref?.();
  try{
    const response=await fetchImpl(url,{...options,redirect:'error',signal:controller.signal});
    if(!response.ok){await response.body?.cancel?.();return{ok:false};}
    const reader=response.body?.getReader?.();if(!reader)throw Error('JWKS response is not a byte stream');
    let size=0;const chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>128*1024){await reader.cancel();throw Error('JWKS response too large');}chunks.push(Buffer.from(value));}
    const document=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return{ok:true,json:async()=>document};
  }finally{clearTimeout(timer);}
};}

export function createAccountDeletionService({pool,schema='public',googleWebClientId='',nativeGoogleClientIds=[],
  fetchImpl=globalThis.fetch,clock=Date.now,maxConfirmations=1024,workerIntervalMs=1000,audit=()=>{}}={}){
  if(!pool?.connect||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw TypeError('Deletion requires the store’s exact PostgreSQL context');
  if(!Number.isInteger(maxConfirmations)||maxConfirmations<1||maxConfirmations>10_000)throw TypeError('Invalid confirmation capacity');
  if(!Number.isInteger(workerIntervalMs)||workerIntervalMs<10||workerIntervalMs>60_000)throw TypeError('Invalid worker interval');
  const audiences={web:googleWebClientId?[googleWebClientId]:[],native:Array.isArray(nativeGoogleClientIds)?nativeGoogleClientIds.filter(x=>typeof x==='string'&&x):[]};
  if(!audiences.web.length&&!audiences.native.length)throw TypeError('Deletion requires configured Google audiences');
  let observed=0;
  function now(){const value=clock();if(!Number.isSafeInteger(value)||value<observed||value<0||value>8640000000000000-300_000)fail('account_deletion_clock_invalid',503);return value;}
  const verifiers=Object.fromEntries(Object.entries(audiences).map(([channel,clientIds])=>[channel,createGoogleIdTokenVerifier({clientIds,fetchImpl:boundedJwksFetch(fetchImpl),clock:now,requireNonce:true})]));
  async function transaction(run,{readOnly=false,lock='ragent_accounts_store_v1'}={}){
    const client=await pool.connect();
    try{
      await client.query(readOnly?'begin isolation level repeatable read read only':'begin');
      await client.query('select set_config($1,$2,true)',['search_path',schema]);
      await client.query('select set_config($1,$2,true)',['lock_timeout','5000ms']);
      await client.query('select set_config($1,$2,true)',['statement_timeout','15000ms']);
      if(!readOnly)await client.query('select pg_advisory_xact_lock(hashtext($1))',[lock]);
      const result=await run(client);await client.query('commit');return result;
    }catch(error){
      await client.query('rollback').catch(()=>{});
      if(typeof error?.code==='string'&&error.code.startsWith('account_deletion_'))throw error;
      if(['42P01','42703'].includes(error?.code))fail('account_deletion_migration_required',503);
      if(['55P03','57014','40P01'].includes(error?.code))fail('account_deletion_store_busy',503);
      fail('account_deletion_unavailable',503);
    }finally{client.release();}
  }
  async function authNow(client){
    const row=(await client.query('select last_observed_at from account_deletion_confirmation_clock where singleton=true for update')).rows[0];
    const at=now(),previous=Number(row?.last_observed_at);
    if(!row||!Number.isSafeInteger(previous)||at<previous)fail('account_deletion_clock_invalid',503);
    observed=at;await client.query('update account_deletion_confirmation_clock set last_observed_at=$1 where singleton=true',[at]);return at;
  }
  function check(row,{confirmationId,confirmationHash,requestId,receiptHash},at){
    if(!row||row.confirmation_id!==confirmationId||row.request_id!==requestId||!same(row.confirmation_secret_hash,confirmationHash)
      ||(receiptHash&&!same(row.receipt_secret_hash,receiptHash)))fail('account_deletion_confirmation_invalid',401);
    if(stamp(row.expires_at)<=at)fail('account_deletion_confirmation_expired',410);
    if(stamp(row.created_at)>at)fail('account_deletion_clock_invalid',503);
  }
  const core=createAccountDeletionRepository({pool,schema,clock:now,verifyDeletionConfirmation:async({proof,requestId,receiptSecretHash})=>{
    let body;try{body=JSON.parse(proof);}catch{fail('account_deletion_confirmation_invalid',401);}
    shape(body,['confirmationId','confirmationSecret']);id(body.confirmationId);const confirmationHash=secret(body.confirmationSecret);
    return transaction(async client=>{
      const at=await authNow(client);
      const row=(await client.query(`select c.*,a.provider,a.provider_subject,a.deletion_requested_at
        from account_deletion_confirmations c join accounts a on a.account_id=c.account_id
        where c.request_id=$1 for share of c`,[requestId])).rows[0];
      check(row,{confirmationId:body.confirmationId,confirmationHash,requestId,receiptHash:receiptSecretHash},at);
      if(!row.verified_at||row.provider!=='google'||!same(row.verified_subject_hash,hash(row.provider_subject)))fail('account_deletion_confirmation_invalid',401);
      if(row.deletion_requested_at)fail('account_deletion_pending',410);
      return{accountId:row.account_id,providerSubject:row.provider_subject,confirmationId:row.confirmation_id,requestId,
        receiptSecretHash:row.receipt_secret_hash,issuedAt:stamp(row.verified_at),expiresAt:stamp(row.expires_at),
        purpose:'delete-account-and-associated-data',audience:'ragent-account-deletion'};
    });
  }});
  async function lookup(input){shape(input,['requestId','receiptSecret']);id(input.requestId);secret(input.receiptSecret);return core.getReceipt(input);}
  async function existing(input){try{return await lookup({requestId:input.requestId,receiptSecret:input.receiptSecret});}catch(e){if(e.code!=='account_deletion_receipt_not_found')throw e;return null;}}

  async function createChallenge(input){
    shape(input,['requestId','receiptSecret','confirmationSecret','channel','expectedAccountId']);
    const requestId=id(input.requestId),receiptHash=secret(input.receiptSecret),confirmationHash=secret(input.confirmationSecret);
    if(!['web','native'].includes(input.channel))fail('account_deletion_channel_invalid');
    const expected=input.expectedAccountId==null?null:input.expectedAccountId;
    if(expected!==null&&(typeof expected!=='string'||!ACCOUNT.test(expected)))fail('account_deletion_account_hint_invalid');
    const recovered=await existing(input);if(recovered)return{schemaVersion:1,phase:'receipt',receipt:recovered,recovered:true};
    if(!audiences[input.channel].length)fail('account_deletion_google_not_configured',409);
    return transaction(async client=>{
      const at=await authNow(client),when=new Date(at).toISOString();
      await client.query(`delete from account_deletion_confirmations where request_id in
        (select request_id from account_deletion_confirmations where expires_at<=$1 and request_id<>$2 limit 128)`,[when,requestId]);
      let row=(await client.query('select * from account_deletion_confirmations where request_id=$1 for update',[requestId])).rows[0];
      const hint=expected===null?null:hash(expected);
      if(row&&(row.receipt_secret_hash!==receiptHash||row.channel!==input.channel||row.expected_account_hash!==hint))fail('account_deletion_request_conflict',409);
      if(row&&stamp(row.expires_at)>at&&row.confirmation_secret_hash!==confirmationHash)fail('account_deletion_request_conflict',409);
      if(!row){const count=Number((await client.query('select count(*) as n from account_deletion_confirmations')).rows[0].n);if(count>=maxConfirmations)fail('account_deletion_confirmation_capacity',429);}
      if(!row||stamp(row.expires_at)<=at){
        const values=[requestId,randomUUID(),receiptHash,confirmationHash,randomBytes(32).toString('base64url'),input.channel,hint,when,new Date(at+300_000).toISOString()];
        if(row)row=(await client.query(`update account_deletion_confirmations set confirmation_id=$2,confirmation_secret_hash=$3,
          nonce=$4,created_at=$5,expires_at=$6,verified_at=null,account_id=null,verified_subject_hash=null where request_id=$1 returning *`,
          [values[0],values[1],values[3],values[4],values[7],values[8]])).rows[0];
        else row=(await client.query(`insert into account_deletion_confirmations
          (request_id,confirmation_id,receipt_secret_hash,confirmation_secret_hash,nonce,channel,expected_account_hash,created_at,expires_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,values)).rows[0];
      }
      return{schemaVersion:1,phase:'challenge',requestId,confirmationId:row.confirmation_id,nonce:row.nonce,
        expiresAt:new Date(row.expires_at).toISOString(),channel:row.channel,googleClientId:audiences[row.channel][0],
        purpose:'delete-account-and-associated-data'};
    },{lock:'ragent_account_deletion_confirmations_v1'});
  }

  async function verifyGoogle(input){
    shape(input,['requestId','confirmationId','confirmationSecret','idToken']);
    const requestId=id(input.requestId),confirmationId=id(input.confirmationId),confirmationHash=secret(input.confirmationSecret);
    if(typeof input.idToken!=='string'||!input.idToken||Buffer.byteLength(input.idToken)>16_384)fail('account_deletion_google_invalid',401);
    const before=await transaction(async client=>(await client.query('select * from account_deletion_confirmations where request_id=$1',[requestId])).rows[0],{readOnly:true});
    check(before,{confirmationId,confirmationHash,requestId},now());
    let identity,claims;
    try{
      identity=await verifiers[before.channel]({idToken:input.idToken,nonce:before.nonce});
      claims=JSON.parse(Buffer.from(input.idToken.split('.')[1],'base64url'));
      if(typeof claims.aud!=='string'||!audiences[before.channel].includes(claims.aud)||!Number.isInteger(claims.iat)
        ||claims.iat*1000<stamp(before.created_at)-30_000||claims.iat*1000>now()+30_000
        ||typeof claims.sub!=='string'||claims.sub!==identity.sub
        ||!/^[\x21-\x7e]{1,255}$/.test(identity.sub))fail('account_deletion_google_invalid',401);
    }catch(e){fail(e?.statusCode===502?'account_deletion_google_unavailable':'account_deletion_google_invalid',e?.statusCode===502?503:401);}
    return transaction(async client=>{
      const at=await authNow(client),row=(await client.query('select * from account_deletion_confirmations where request_id=$1 for update',[requestId])).rows[0];
      check(row,{confirmationId,confirmationHash,requestId},at);
      const account=(await client.query("select * from accounts where provider='google' and provider_subject=$1 for update",[identity.sub])).rows[0];
      if(!account)fail('account_deletion_account_unavailable',404);
      if(row.expected_account_hash&&!same(row.expected_account_hash,hash(account.account_id)))fail('account_deletion_different_account',409);
      if(account.deletion_requested_at)fail('account_deletion_pending',410);
      if(row.verified_at&&(row.account_id!==account.account_id||!same(row.verified_subject_hash,hash(identity.sub))))fail('account_deletion_confirmation_conflict',409);
      const updated=row.verified_at?row:(await client.query(`update account_deletion_confirmations set verified_at=$2,account_id=$3,
        verified_subject_hash=$4 where request_id=$1 returning *`,[requestId,new Date(at).toISOString(),account.account_id,hash(identity.sub)])).rows[0];
      return{schemaVersion:1,phase:'confirmed',requestId,confirmationId,expiresAt:new Date(updated.expires_at).toISOString(),
        account:{accountId:account.account_id,email:String(identity.email||'').slice(0,320),displayName:String(identity.name||'').slice(0,128)}};
    });
  }

  async function submit(input){
    shape(input,['requestId','receiptSecret','confirmationId','confirmationSecret','confirmation']);
    id(input.requestId);id(input.confirmationId);secret(input.receiptSecret);secret(input.confirmationSecret);
    if(input.confirmation!=='delete-account-and-associated-data')fail('account_deletion_explicit_confirmation_required');
    const recovered=await existing(input);if(recovered)return{schemaVersion:1,phase:'receipt',receipt:recovered,recovered:true};
    let receipt;
    try{receipt=await core.accept({requestId:input.requestId,receiptSecret:input.receiptSecret,
      proof:JSON.stringify({confirmationId:input.confirmationId,confirmationSecret:input.confirmationSecret})});}
    catch(error){const recovered=await existing(input);if(recovered)return{schemaVersion:1,phase:'receipt',receipt:recovered,recovered:true};throw error;}
    try{await transaction(client=>client.query('delete from account_deletion_confirmations where request_id=$1 and confirmation_id=$2',[input.requestId,input.confirmationId]));}
    catch{emitAudit({event:'account_deletion.confirmation_cleanup_pending',code:'account_deletion_cleanup_pending'});}
    return{schemaVersion:1,phase:'receipt',receipt,recovered:false};
  }

  async function checkReady(){return transaction(async client=>{
    await client.query('select job_id,plan_version from account_deletion_jobs limit 0');
    await client.query('select account_id from account_deletion_fences limit 0');
    await client.query('select job_id,instance_id from account_deletion_targets limit 0');
    await client.query('select confirmation_id,verified_subject_hash from account_deletion_confirmations limit 0');
    const row=(await client.query('select last_observed_at from account_deletion_confirmation_clock where singleton=true')).rows[0];
    if(!row)fail('account_deletion_migration_required',503);return true;
  },{readOnly:true});}
  let stopped=true,timer=null,active=null,lastFailure=null,failures=0;
  async function runWorkerBatch(){
    await transaction(async client=>{const at=await authNow(client);return client.query(`delete from account_deletion_confirmations where request_id in
      (select request_id from account_deletion_confirmations where expires_at<=$1 limit 128)`,[new Date(at).toISOString()]);},{lock:'ragent_account_deletion_confirmations_v1'});
    const jobs=await transaction(async client=>(await client.query(`select job_id from account_deletion_jobs
      where cloud_erased_at is null order by requested_at,job_id limit 8`)).rows,{readOnly:true});
    let failure;
    for(const job of jobs){try{await core.cleanBatch({jobId:job.job_id});}catch(error){failure=error;}}
    if(failure)throw failure;
    return jobs.length;
  }
  function schedule(delay){if(!stopped){timer=setTimeout(tick,delay);timer.unref?.();}}
  async function tick(){
    active=runWorkerBatch();
    try{await active;lastFailure=null;failures=0;}
    catch(e){lastFailure=typeof e?.code==='string'&&e.code.startsWith('account_deletion_')?e.code:'account_deletion_unavailable';failures++;emitAudit({event:'account_deletion.worker_failed',code:lastFailure});}
    finally{active=null;schedule(Math.min(60_000,workerIntervalMs*2**Math.min(failures,6)));}
  }
  function emitAudit(fields){try{audit(fields);}catch{/* An audit sink cannot reverse committed revocation. */}}
  return Object.freeze({createChallenge,verifyGoogle,submit,getReceipt:lookup,checkReady,runWorkerBatch,
    acknowledgeTarget:core.acknowledgeTarget,
    startWorker(){if(stopped){stopped=false;schedule(0);}},
    async close(){stopped=true;clearTimeout(timer);if(active)await active.catch(()=>{});},
    workerStatus(){return{running:!stopped,lastFailure};}});
}
