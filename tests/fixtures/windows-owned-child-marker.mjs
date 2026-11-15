// No product API, Provider, network or real identity. Uses the actual ownership
// marker producer and the same inherited per-child correlation token.
import {writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {acquireInstanceOwnership} from '../../lib/instance-ownership.mjs';
import {deriveWindowsEndpointName} from '../../lib/windows-runtime-paths.mjs';
const root=process.env.RAGENT_INSTANCE_ROOT,instanceId='inst_'+'1'.repeat(32);
const filePath=join(root,'runtime','instance-ownership.json');
await acquireInstanceOwnership({filePath,instanceId,endpointName:deriveWindowsEndpointName({instanceRoot:root,instanceId,allowProgramData:false}),token:process.env.RAGENT_SERVICE_OWNERSHIP_TOKEN});
await writeFile(join(root,'generation-'+process.pid+'-'+process.env.RAGENT_SERVICE_OWNERSHIP_TOKEN+'.ready'),'ready');
process.stdin.setEncoding('utf8');
let ending=false;
async function release(){if(ending)return;ending=true;const {readInstanceOwnership}=await import('../../lib/instance-ownership.mjs');const owner=await readInstanceOwnership(filePath);if(owner?.pid===process.pid){const {unlink}=await import('node:fs/promises');await unlink(filePath);}process.exit(0);}
process.stdin.on('data',s=>{if(s.includes('release'))void release();});
setInterval(async()=>{try{await access(process.env.RAGENT_WINDOWS_SERVICE_STOP_FILE||join(root,'never-stop'));await release();}catch{}},30);
