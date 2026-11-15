package com.andysagent.ragent.feature.organization.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.andysagent.ragent.feature.organization.data.OrganizationApi
import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationCommunicationDto
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationEventDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationPhaseDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.OrganizationRepository
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository

class OrganizationViewModelFactory(
    private val api: OrganizationApi? = null,
    private val sessionId: String? = null,
    private val organizationId: String? = null,
) : ViewModelProvider.Factory {

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        val effectiveApi = api ?: object : OrganizationApi {
            override suspend fun getProjection(
                organizationId: String,
                version: Int,
                sinceEventId: Long,
            ): Result<OrganizationProjectionDto> = Result.success(sampleOrganizationProjection(organizationId, sessionId))

            override suspend fun getSessionOrganization(
                sessionId: String,
            ): Result<OrganizationProjectionDto?> = Result.success(sampleOrganizationProjection(organizationId ?: "org_default", sessionId))
        }

        val repository = RealOrganizationRepository(effectiveApi)
        val viewModel = OrganizationViewModel(repository)
        repository.applyProjection(sampleOrganizationProjection(organizationId ?: "org_default", sessionId))
        return viewModel as T
    }

    companion object {
        fun sampleOrganizationProjection(orgId: String = "org_1", sessId: String? = null): OrganizationProjectionDto {
            return OrganizationProjectionDto(
                organizationId = orgId,
                rootSessionId = sessId,
                objective = "Mobile Multi-Agent Organization Radar",
                state = "active",
                nodes = listOf(
                    OrganizationNodeDto(
                        id = "executive",
                        role = "executive",
                        domain = "architecture",
                        displayName = "Root Leader",
                        status = "working",
                        currentActivity = "Orchestrating system phases",
                    ),
                    OrganizationNodeDto(
                        id = "backend_lead",
                        parentId = "executive",
                        role = "manager",
                        domain = "backend",
                        displayName = "Backend Lead",
                        status = "working",
                        currentActivity = "Refining service APIs",
                    ),
                    OrganizationNodeDto(
                        id = "android_lead",
                        parentId = "executive",
                        role = "manager",
                        domain = "android",
                        displayName = "Android Lead",
                        status = "working",
                        currentActivity = "Rendering canvas hierarchy",
                    ),
                    OrganizationNodeDto(
                        id = "runtime_worker",
                        parentId = "backend_lead",
                        role = "worker",
                        domain = "runtime",
                        displayName = "Runtime Engineer",
                        status = "working",
                        currentActivity = "Executing streaming test suite",
                    ),
                    OrganizationNodeDto(
                        id = "security_reviewer",
                        parentId = "backend_lead",
                        role = "reviewer",
                        domain = "security",
                        displayName = "Security Reviewer",
                        status = "reviewing",
                        currentActivity = "Auditing IPC capability permissions",
                    ),
                    OrganizationNodeDto(
                        id = "testing_worker",
                        parentId = "android_lead",
                        role = "worker",
                        domain = "testing",
                        displayName = "Test Lead",
                        status = "completed",
                        currentActivity = "100% assertions verified",
                    ),
                ),
                edges = listOf(
                    OrganizationEdgeDto(id = "e1", parentId = "executive", childId = "backend_lead", type = "MANAGES"),
                    OrganizationEdgeDto(id = "e2", parentId = "executive", childId = "android_lead", type = "MANAGES"),
                    OrganizationEdgeDto(id = "e3", parentId = "backend_lead", childId = "runtime_worker", type = "MANAGES"),
                    OrganizationEdgeDto(id = "e4", parentId = "backend_lead", childId = "security_reviewer", type = "REVIEWS"),
                    OrganizationEdgeDto(id = "e5", parentId = "android_lead", childId = "testing_worker", type = "MANAGES"),
                ),
                activeCommunications = listOf(
                    OrganizationCommunicationDto(
                        id = "c1",
                        type = "TASK_ASSIGNED",
                        fromNodeId = "backend_lead",
                        toNodeId = "runtime_worker",
                        subject = "Execute streaming cancellation suite",
                    ),
                    OrganizationCommunicationDto(
                        id = "c2",
                        type = "RESULT_AVAILABLE",
                        fromNodeId = "runtime_worker",
                        toNodeId = "backend_lead",
                        subject = "Streaming verification passed",
                    ),
                ),
                phases = listOf(
                    OrganizationPhaseDto(
                        phaseId = "p1",
                        objective = "Architecture & State Models",
                        state = "completed",
                    ),
                    OrganizationPhaseDto(
                        phaseId = "p2",
                        objective = "Layout Engine & Particle Animation",
                        state = "active",
                    ),
                ),
                recentEvents = listOf(
                    OrganizationEventDto(id = 1, type = "node.created", nodeId = "executive"),
                    OrganizationEventDto(id = 2, type = "node.created", nodeId = "backend_lead"),
                    OrganizationEventDto(id = 3, type = "node.created", nodeId = "android_lead"),
                    OrganizationEventDto(id = 4, type = "task.started", nodeId = "runtime_worker"),
                ),
            )
        }
    }
}
