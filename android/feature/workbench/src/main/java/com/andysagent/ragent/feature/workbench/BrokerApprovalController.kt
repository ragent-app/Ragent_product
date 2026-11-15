package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.auth.BrokerEnrollmentMaterial
import com.andysagent.ragent.core.auth.BrokerPendingEnrollment
import kotlinx.coroutines.flow.Flow

/** Supplies Broker challenges to the app's existing attention and approval surfaces. */
interface BrokerApprovalController {
    fun observePendingApprovals(): Flow<List<Approval>>
    suspend fun resolve(approval: Approval, approve: Boolean)
}

/** The original signed decision may have reached the Broker and must not be posted again. */
class BrokerApprovalOutcomeUnknownException(message: String, cause: Throwable? = null) : IllegalStateException(message, cause)

/** One-time local administrator enrollment; request decisions still use the shared Attention surface. */
interface BrokerEnrollmentController {
    fun enrollmentMaterial(): BrokerEnrollmentMaterial
    suspend fun enrollmentChallenge(targetInstanceId: String): BrokerPendingEnrollment
    suspend fun completeEnrollment(targetInstanceId: String, enrollmentId: String, confirmedCode: String): String
}
