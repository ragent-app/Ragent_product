import { createAgentoCHttpClient } from './agentoc-http-client.mjs';
export async function runBlockerProposalCommand(argv=[],io={}) {
 const options={};for(let i=0;i<argv.length;i++){const name=argv[i];if(!['--kind','--reason','--suggestion','--idempotency-key'].includes(name))throw new Error(`Unknown option: ${name}`);options[name]=argv[++i] || '';}
 const sessionId=String(process.env.AGENTOC_SESSION_CONTROL_SESSION_ID || '').trim();
 if(!sessionId || !process.env.AGENTOC_SESSION_CONTROL_TOKEN)throw new Error('A scoped work Run capability is required');
 const body={kind:options['--kind'],reason:options['--reason'],suggestion:options['--suggestion'] || '',idempotencyKey:options['--idempotency-key']};
 if(!body.kind||!body.reason||!body.idempotencyKey)throw new Error('Usage: ragent blocker-proposal --kind <dependency|permission|budget|requirement|other> --reason <text> [--suggestion <text>] --idempotency-key <stable-key>');
 const result=await createAgentoCHttpClient().request(`/api/sessions/${encodeURIComponent(sessionId)}/factory/blocker-proposal`,{method:'POST',body});
 if(!result.response.ok)throw new Error(result.json?.error || result.text || `Proposal failed (${result.response.status})`);
 (io.stdout || process.stdout).write(`${JSON.stringify(result.json)}\n`);return 0;
}
