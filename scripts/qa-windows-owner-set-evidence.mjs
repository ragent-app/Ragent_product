// Independently compare ordinary Owner HTTP/native proofs with protected service
// exports for the actual paired controller. Does not create services or elevate.
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {ownerSetScenarios,ownerSetPurposes} from '../tests/fixtures/windows-service-owner-set-probe.mjs';
export async function verifyOwnerSet({manifest,summary,bundle,protectedRoot,sids,pids}){
  const before=JSON.parse(await readFile(join(bundle,'production-before.json'),'utf8')),after=JSON.parse(await readFile(join(bundle,'production-after.json'),'utf8'));assert.deepEqual(after,before);
  const client=JSON.parse(await readFile(join(bundle,'owner-set-client.json'),'utf8'));assert.equal(client.caseId,manifest.caseId);assert.equal(client.pass,true);assert.equal(client.launchExitCode,0);assert.equal(client.cases.length,12);
  for(const key of ['productionChanged','phoneTouched','providerUsed','actualPhoneOrTurn'])assert.equal(client[key],false);
  const identities=new Set(),requests=new Set(),pipes=new Set();
  function remember(facts,sid,session,query=false){assert.equal(facts.sid,sid);assert.equal(facts.sessionId,session);assert.equal(facts.integrityRid,8192);assert.equal(facts.elevated,false);assert.equal(facts.enabledAdministrators,false);
    assert.ok(Number.isSafeInteger(facts.pid)&&facts.pid>0);assert.match(facts.createdTicks,/^\d{10,20}$/);if(query)assert.equal(facts.queryOnlyAuthorityVerified,true);
    const key=facts.pid+'/'+facts.createdTicks;assert.equal(identities.has(key),false);identities.add(key);pids.add(facts.pid);}
  function descriptor(value,purpose,deadline){const {policy,peer}=value.descriptor;assert.deepEqual(value.peer,peer);assert.equal(policy.protocolVersion,2);assert.equal(policy.purpose,purpose);
    assert.equal(policy.instanceId,manifest.ownerInstanceId);assert.equal(policy.controlSid,sids.control);assert.equal(policy.ownerSid,manifest.requestorSid);assert.equal(policy.ownerSessionId,manifest.ownerSessionId);
    assert.equal(policy.expiresAtUnixMs,deadline);assert.match(policy.pipeName,/^ragent-owner-bootstrap-[a-f0-9]{32}$/);assert.match(policy.requestId,/^[a-f0-9]{32}$/);
    assert.equal(pipes.has(policy.pipeName),false);pipes.add(policy.pipeName);assert.equal(requests.has(policy.requestId),false);requests.add(policy.requestId);
    for(const key of ['launchNonce','bootstrapTicket','sessionToken'])assert.equal(JSON.stringify(value).includes(key),false);
    remember(peer,sids.control,0);
  }
  for(const round of summary.rounds){const control=round.controlNode.ownerBootstrap,executor=round.executorNode.ownerBootstrap;
    for(const [role,value]of [['control',control],['executor',executor]]){
      assert.equal(value.pass,true);assert.equal(value.role,role);assert.equal(value.round,round.round);assert.equal(value.protocolVersion,2);assert.equal(value.pairedController,true);assert.equal(value.productionCredentialsRead,false);
      assert.deepEqual(value.cases.map(x=>x.scenario),ownerSetScenarios);
    }
    for(const key of ['signingKeyNeverInEndpointEnvironment','syntheticOwnerSessionsRevoked','signingFileRemoved'])assert.equal(control[key],true);
    for(const [i,scenario]of ownerSetScenarios.entries()){
      const proof=client.cases.find(x=>x.round===round.round&&x.scenario===scenario),value=control.cases[i],received=scenario!=='close-both',refresh=scenario.endsWith('-refresh');assert.ok(proof);
      assert.deepEqual(proof.initial,value.initial);assert.deepEqual(proof.final,value.final);assert.deepEqual(proof.retired,value.retired);assert.deepEqual(proof.peers,value.peers);assert.deepEqual(proof.outcomes,value.outcomes);
      const deadline=value.initial.cli.descriptor.policy.expiresAtUnixMs;assert.ok(Number.isSafeInteger(deadline));
      for(const p of ownerSetPurposes)descriptor(value.initial[p],p,deadline);
      if(refresh){const p=value.retired.purpose,other=p==='cli'?'browser':'cli';assert.equal(p,scenario.startsWith('cli-')?'cli':'browser');
        assert.deepEqual({descriptor:value.retired.descriptor,peer:value.retired.peer},value.initial[p]);assert.equal(value.retired.completion.issued,false);
        assert.deepEqual(value.final[other],value.initial[other]);assert.notEqual(value.final[p].descriptor.policy.requestId,value.initial[p].descriptor.policy.requestId);descriptor(value.final[p],p,deadline);
      }else assert.deepEqual(value.final,value.initial);
      for(const item of [proof,value]){
        for(const key of ['pass','publicationWithdrawn','originalDeadlinePreserved','syntheticSessionsRevoked'])assert.equal(item[key],true,scenario+':'+key);
        for(const key of ['cliIssues','ticketIssues','cookieIssues'])assert.equal(item[key],received?1:0,scenario+':'+key);
        assert.equal(item.revocations,received?2:0);assert.equal(item.confirmations,received&&scenario!=='browser-failure'?1:0);assert.equal(item.executorDenials,refresh?3:2);
        assert.equal(item.otherPreserved,refresh||['browser-failure','browser-completes-first'].includes(scenario));
        assert.equal(item.browserWithdrawn,['browser-failure','browser-completes-first'].includes(scenario));assert.equal(item.allWithdrawn,['simultaneous','close-both'].includes(scenario));
      }
      assert.equal(executor.cases[i].pass,true);assert.equal(executor.cases[i].executorDenials,refresh?3:2);assert.equal(value.publicationVerified,true);
      for(const key of ['pairedPublished','anonymousHttpDenied'])assert.equal(proof[key],true);
      for(const key of ['ticketNotCookie','nonceDenied','replayDenied','authenticatedBoth','revokedBoth'])assert.equal(proof[key],received);
      assert.equal(proof.retiredRefusals,refresh?1:0);assert.equal(proof.closeRefusals,received?0:2);assert.equal(proof.browserFailureCookieRevoked,scenario==='browser-failure');
      assert.equal(Object.keys(value.peers).length,received?2:0);if(received)assert.ok(value.validHttp>=2);
      for(const p of ownerSetPurposes){const outcome=value.outcomes[p],success=received&&!(p==='browser'&&scenario==='browser-failure');assert.equal(outcome.issued,success);
        if(received)remember(value.peers[p],manifest.requestorSid,manifest.ownerSessionId,true);
        if(success)assert.deepEqual(outcome.peer,value.peers[p]);else if(scenario==='browser-failure')assert.equal(outcome.code,'OBC_DELIVERY_UNCONFIRMED');else assert.match(outcome.code,/^OBC_[A-Z_]+$/);
      }
      for(const [location,kinds]of [['handoff/control',['ready','after-step','done']],['handoff/executor',['denied','denied-fresh']],['control/inbox',['step','ack','finish']]])for(const kind of kinds)for(const suffix of ['.json','.json.tmp'])
        await assert.rejects(lstat(join(protectedRoot,location,`r${round.round}-owner-${scenario}-${kind}${suffix}`)),{code:'ENOENT'});
    }
    const config=join(protectedRoot,'state/control',`owner-auth-r${round.round}/config`);
    for(const name of ['owner-bootstrap-cli-live.json','owner-bootstrap-browser-live.json','owner-bootstrap-publisher.json'])for(const suffix of ['','.publisher-lock'])await assert.rejects(lstat(join(config,name+suffix)),{code:'ENOENT'});
    await assert.rejects(lstat(join(config,'auth-session-secret')),{code:'ENOENT'});
  }
  assert.equal(identities.size,48);assert.equal(requests.size,28);assert.equal(pipes.size,28);
  assert.equal(summary.ownerPublicationRemoved,true);assert.equal(summary.ownerHandoffRemoved,true);assert.equal(client.productionObservationUnchanged,true);
  return {before,after,unchangedAtObservationPoints:true};
}
