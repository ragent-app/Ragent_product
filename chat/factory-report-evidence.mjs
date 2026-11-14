import { computeResultPacketDigest } from './result-packets.mjs';
import { verifyFactoryResponsibilityFence } from './factory-responsibility-admission.mjs';

// Packet storage is immutable but separate from the Collaboration database.
// The current binding, authority and attempt are checked in the transition.
export function verifyFactoryReportEvidence(db,item,binding,packet) {
  try {
    if(item.contract?.accessMode!=='read' || item.contract?.resource?.readScope!=='entire_project'
        || packet?.kind!=='execution' || packet.state!=='succeeded' || !packet.summary?.trim()
        || packet.digest!==computeResultPacketDigest(packet) || !/^sha256:[a-f0-9]{64}$/.test(packet.digest)
        || packet.producer?.projectId!==item.projectId || packet.producer?.runId!==binding.runId
        || packet.producer?.taskId!==binding.taskId || packet.producer?.attemptId!==binding.attemptId) return null;
    const attempt=db.prepare('SELECT state,result_packet_id,run_id,session_id FROM collaboration_attempts WHERE id=? AND task_id=?').get(binding.attemptId,binding.taskId);
    if(attempt?.state!=='succeeded' || attempt.result_packet_id!==packet.packetId || attempt.run_id!==binding.runId || attempt.session_id!==packet.producer.sessionId) return null;
    const raw=db.prepare('SELECT * FROM factory_work_items WHERE id=? AND organization_id=?').get(item.id,item.organizationId);
    if(!raw || !['project-report','generic-planner'].includes(verifyFactoryResponsibilityFence(db,raw)?.providerId)) return null;
    return {digest:packet.digest.slice(7),packetId:packet.packetId,packetDigest:packet.digest,terminalEvidenceRef:`run:${binding.runId}`};
  } catch { return null; }
}
