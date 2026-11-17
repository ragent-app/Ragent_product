package com.andysagent.ragent.feature.organization.ui

import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.UnifiedMembersPageDto

internal fun unifiedUiId(canonicalId: String) = "member:${canonicalId.length}:$canonicalId"

internal fun unifiedDisplayId(page: UnifiedMembersPageDto, canonicalId: String, rootId: String,
    formal: List<OrganizationNodeDto>): String? {
    if (canonicalId == page.rootCanonicalId) return rootId
    val member = page.members.singleOrNull { it.canonicalId == canonicalId }
    val matches = formal.filter { node -> node.member?.canonicalId == canonicalId ||
        member?.aliases?.any { it.kind == "formal" && it.id == node.id } == true }
    if (matches.size == 1) return matches.single().id
    return if (member != null && matches.isEmpty()) unifiedUiId(canonicalId) else null
}

internal fun memberIdForLegacy(page: UnifiedMembersPageDto?, runId: String, delegationId: String,
    formal: List<OrganizationNodeDto> = emptyList()): String {
    val member = page?.members?.singleOrNull { candidate -> candidate.aliases.any { it.kind == "legacy_delegation" && it.runId == runId && it.id == delegationId } }
        ?: return nativeNodeId(runId, delegationId)
    val matches = formal.filter { node -> node.member?.canonicalId == member.canonicalId ||
        member.aliases.any { it.kind == "formal" && it.id == node.id } }
    return matches.singleOrNull()?.id ?: unifiedUiId(member.canonicalId)
}

/** Identities are joined only on server-provided canonical IDs or aliases. */
internal fun unifiedMemberNodes(page: UnifiedMembersPageDto, rootId: String,
    formal: List<OrganizationNodeDto>, memberName: String): List<OrganizationNodeDto> {
    val directFormal = formal.mapNotNull { node -> node.member?.canonicalId?.let { it to node.id } }.toMap()
    val formalIds = formal.map { it.id }.toSet()
    val formalByCanonical = directFormal + page.members.mapNotNull { member ->
        val matches = member.aliases.filter { it.kind == "formal" && it.id in formalIds }.map { it.id }.distinct()
        if (matches.size == 1) member.canonicalId to matches.single() else null
    }.toMap()
    val knownCanonical = page.members.map { it.canonicalId }.toSet()
    fun displayId(id: String): String? = when {
        id == page.rootCanonicalId -> rootId
        id in formalByCanonical -> formalByCanonical[id]
        id in knownCanonical -> unifiedUiId(id)
        else -> null
    }
    val additional = page.members.filter { it.canonicalId !in formalByCanonical && it.canonicalId != page.rootCanonicalId }.mapIndexed { index, member ->
        OrganizationNodeDto(id = unifiedUiId(member.canonicalId), member = member,
            parentId = member.parentCanonicalId?.takeIf { member.relationKnown }?.let(::displayId),
            displayName = "$memberName ${index + 1}", status = member.activity?.state ?: "unknown", activity = member.activity)
    }
    return formal + additional
}

internal fun unifiedMemberEdges(nodes: List<OrganizationNodeDto>, formal: List<OrganizationEdgeDto>): List<OrganizationEdgeDto> {
    val formalIds = formal.map { it.childId }.toSet()
    return formal + nodes.mapNotNull { node -> node.parentId?.takeIf { node.id !in formalIds }?.let { parent ->
        OrganizationEdgeDto(id = "member-edge:${node.id}", parentId = parent, childId = node.id)
    } }
}
