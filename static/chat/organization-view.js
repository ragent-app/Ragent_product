/**
 * organization-view.js — Ragent Organization View v1 (AI Organization Radar)
 *
 * Implements the mobile & desktop real-time AI Organization Radar UI:
 * - Direct projection of Backend Organization Projection v2
 * - Pure radial fan (Root -> Leads) & focus-tree layout with clusters
 * - Canvas edges & high-fidelity quadratic bezier particle animations
 * - Breathing, sweep, and alert ring animations matching Android
 * - Interactive Bottom Sheet, Detail Screen, Top Bar, and Activity Feed
 * - Parity with Android feature/organization implementation
 */

"use strict";

(function attachOrganizationView(root) {
  // Localization helper
  function tr(key, params) {
    if (typeof root.RagentI18n?.t === "function") {
      return root.RagentI18n.t(key, params);
    }
    return key;
  }

  function isZhLocale() {
    const lang = String(
      root.RagentI18n?.getActiveUiLanguage?.() ||
      root.document?.documentElement?.lang ||
      ""
    ).toLowerCase();
    return lang.startsWith("zh");
  }

  function trText(key, enFallback, zhFallback = enFallback, params = null) {
    const resolved = tr(key, params);
    if (resolved && resolved !== key) return resolved;
    let template = isZhLocale() ? zhFallback : enFallback;
    if (params && typeof params === "object") {
      for (const [k, v] of Object.entries(params)) {
        template = template.replaceAll(`{${k}}`, String(v ?? ""));
      }
    }
    return template;
  }

  function unifiedUiId(canonicalId) {
    const id = String(canonicalId || "");
    return `member:${id.length}:${id}`;
  }

  function nativeNodeId(runId, delegationId) {
    const r = String(runId || "");
    const d = String(delegationId || "");
    return `native:${r.length}:${r}${d}`;
  }

  function normalizeCoverage(rawScope, rawCoverage, isReadOnlyNative = false, availability = "") {
    const scope = String(rawScope || "").trim().toLowerCase();
    const cov = String(rawCoverage || "").trim().toLowerCase();
    const avail = String(availability || "").trim().toLowerCase();
    if (scope === "unavailable") return "unavailable";
    if (scope === "activity_only") return "activity_only";
    if (cov === "partial" || scope === "captured_only") return "partial";
    if (avail === "unavailable" && scope !== "full") return "unavailable";
    if (scope === "full") {
      if (cov === "full") return "full";
      if (avail === "partial" || isReadOnlyNative) return "partial";
      return "full";
    }
    return "unavailable";
  }

  function coverageLabel(coverage) {
    switch (coverage) {
      case "full":
        return trText("organization.coverage.full", "Full", "完整");
      case "partial":
        return trText("organization.coverage.partial", "Partial (captured)", "部分（已捕获）");
      case "activity_only":
        return trText("organization.coverage.activityOnly", "Activity only", "仅活动状态");
      default:
        return trText("organization.coverage.unavailable", "Unavailable", "不可用");
    }
  }

  function coverageDescription(coverage, isReadOnlyNative) {
    switch (coverage) {
      case "partial":
        return trText(
          "organization.coverage.partialDesc",
          "Only content captured by the parent run is shown; this is not a full private transcript.",
          "仅显示父运行中捕获的内容，并非完整私有会话。"
        );
      case "activity_only":
        return trText(
          "organization.coverage.activityOnlyDesc",
          "Available activity and results only; no child transcript was captured.",
          "仅显示可用的活动和结果，未捕获子会话正文。"
        );
      case "full":
        return isReadOnlyNative
          ? trText(
              "organization.coverage.partialDesc",
              "Only content captured by the parent run is shown; this is not a full private transcript.",
              "仅显示父运行中捕获的内容，并非完整私有会话。"
            )
          : trText(
              "organization.coverage.fullDesc",
              "Full managed session transcript (read-only view).",
              "受控子会话完整记录（只读视图）。"
            );
      default:
        return trText(
          "organization.coverage.unavailableDesc",
          "This member's conversation is unavailable.",
          "此成员的会话暂不可用。"
        );
    }
  }

  function mapMemberRuntimeState(rawState, delegationState = "") {
    const primary = String(delegationState || rawState || "").trim().toLowerCase();
    const secondary = String(rawState || "").trim().toLowerCase();
    const s = primary || secondary;
    if (s === "spawned" || s === "running" || s === "working") return NodeRuntimeState.WORKING;
    if (s === "waiting") return NodeRuntimeState.WAITING;
    if (s === "completed" || s === "done" || s === "succeeded") return NodeRuntimeState.DONE;
    if (s === "failed" || s === "lost" || s === "error") return NodeRuntimeState.FAILED;
    if (s === "cancelled" || s === "canceled" || s === "interrupted" || s === "paused") return NodeRuntimeState.PAUSED;
    if (s === "blocked") return NodeRuntimeState.BLOCKED;
    if (s === "reviewing" || s === "waiting_review") return NodeRuntimeState.REVIEWING;
    return NodeRuntimeState.IDLE;
  }

  function formatRuntimeStatusText(node) {
    if (!node) return "";
    if (node.stateUnknown) {
      return trText("organization.stateUnknown", "Unknown", "状态未知");
    }
    const rawNative = String(node.rawNativeState || "").toLowerCase();
    if (rawNative === "lost") return trText("organization.stateLost", "Lost", "已失联");
    if (rawNative === "cancelled" || rawNative === "canceled") return trText("organization.stateCancelled", "Cancelled", "已取消");
    if (rawNative === "interrupted") return trText("organization.stateInterrupted", "Interrupted", "已中断");
    const runtimeState = node.runtimeState || NodeRuntimeState.fromString(node.status, node.currentActivity, Boolean(node.blocker));
    const stateName = String(runtimeState).toLowerCase();
    if (stateName === "paused") return trText("organization.paused", "Paused", "已暂停");
    return tr(`organization.${stateName === "failed" ? "failedStatus" : stateName}`) || runtimeState;
  }

  function readableToolField(value, depth = 0) {
    if (value == null) return "";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (depth === 0 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
        try {
          return readableToolField(JSON.parse(trimmed), depth + 1);
        } catch {
          return value;
        }
      }
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (depth >= 3) return typeof value === "object" ? "[…]" : String(value);
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => readableToolField(item, depth + 1)).filter(Boolean).join("\n");
    }
    if (typeof value === "object") {
      return Object.entries(value)
        .slice(0, 20)
        .map(([k, v]) => {
          const formatted = readableToolField(v, depth + 1);
          return formatted ? `${k}: ${formatted}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  // --- 1. Domain Types & Enums ---

  const NodeRole = Object.freeze({
    EXECUTIVE: "EXECUTIVE",
    MANAGER: "MANAGER",
    PHASE_LEAD: "PHASE_LEAD",
    WORKER: "WORKER",
    WRITER: "WRITER",
    REVIEWER: "REVIEWER",
    EXPERT: "EXPERT",
    UNKNOWN: "UNKNOWN",

    fromString(role) {
      const r = String(role || "").toLowerCase();
      if (r === "root" || r === "executive" || r === "lead") return NodeRole.EXECUTIVE;
      if (r === "manager" || r === "lead_worker") return NodeRole.MANAGER;
      if (r === "phase_lead") return NodeRole.PHASE_LEAD;
      if (r === "worker") return NodeRole.WORKER;
      if (r === "writer") return NodeRole.WRITER;
      if (r === "reviewer") return NodeRole.REVIEWER;
      if (r === "expert" || r === "consultant" || r === "specialist") return NodeRole.EXPERT;
      return NodeRole.UNKNOWN;
    },
  });

  const AgentDomain = Object.freeze({
    BACKEND: "BACKEND",
    MOBILE: "MOBILE",
    WEB: "WEB",
    RUNTIME: "RUNTIME",
    SECURITY: "SECURITY",
    TESTING: "TESTING",
    ARCHITECTURE: "ARCHITECTURE",
    DATABASE: "DATABASE",
    RESEARCH: "RESEARCH",
    DATA: "DATA", AI: "AI", CLOUD: "CLOUD", NETWORK: "NETWORK", HARDWARE: "HARDWARE",
    DESIGN: "DESIGN", PRODUCT: "PRODUCT", WRITING: "WRITING", TRANSLATION: "TRANSLATION",
    EDUCATION: "EDUCATION", BUSINESS: "BUSINESS", FINANCE: "FINANCE", LEGAL: "LEGAL",
    HEALTH: "HEALTH", MARKETING: "MARKETING", SALES: "SALES", PEOPLE: "PEOPLE",
    OPERATIONS: "OPERATIONS", LOGISTICS: "LOGISTICS", MEDIA: "MEDIA", ENVIRONMENT: "ENVIRONMENT",
    ENGINEERING: "ENGINEERING",
    GENERAL: "GENERAL",

    fromExplicit(domain, iconKey) {
      const raw = iconKey == null ? domain : iconKey;
      let key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (iconKey != null && (key === "ANDROID" || key === "IOS")) key = "MOBILE";
      return Object.hasOwn(AgentDomain, key) && typeof AgentDomain[key] === "string" ? AgentDomain[key] : null;
    },
  });

  function escapeDisplayText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function formatBoardBodySafeHtml(rawText) {
    const escaped = escapeDisplayText(rawText);
    return escaped
      .replace(/(^|[\s([{"'])@(#?[A-Za-z0-9][A-Za-z0-9._-]{0,63}|all)(?=$|[\s.,:;!?)\]}"']|&)/g, '$1<span class="org-board-mention">@$2</span>')
      .replace(/(^|[\s([{"'])#(\d{1,7})\b/g, '$1<span class="org-board-seqref">#$2</span>')
      .replace(/\[\s*(done|stall)\s*\]/gi, (_, tag) => {
        const lower = tag.toLowerCase();
        return `<span class="org-board-inline-tag org-board-inline-tag--${lower}">[${lower}]</span>`;
      });
  }

  function normalizeSwarmChannelKey(value, allowEmpty = false) {
    const cleaned = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
    if (!cleaned) return allowEmpty ? "" : "main";
    return cleaned.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || (allowEmpty ? "" : "main");
  }

  const NodeRuntimeState = Object.freeze({
    PROVISIONING: "PROVISIONING",
    IDLE: "IDLE",
    WORKING: "WORKING",
    WAITING: "WAITING",
    BLOCKED: "BLOCKED",
    REVIEWING: "REVIEWING",
    DONE: "DONE",
    FAILED: "FAILED",
    PAUSED: "PAUSED",

    fromString(status, currentActivity, hasBlocker) {
      if (hasBlocker) return NodeRuntimeState.BLOCKED;
      const s = String(status || "").toLowerCase();
      if (s === "provisioning" || s === "unbound") return NodeRuntimeState.PROVISIONING;
      if (s === "working" || s === "running") return NodeRuntimeState.WORKING;
      if (s === "waiting" || s === "waiting_children" || s === "waiting_approval") return NodeRuntimeState.WAITING;
      if (s === "reviewing" || s === "waiting_review") return NodeRuntimeState.REVIEWING;
      if (s === "done" || s === "completed" || s === "succeeded") return NodeRuntimeState.DONE;
      if (s === "failed") return NodeRuntimeState.FAILED;
      if (s === "paused" || s === "cancelled") return NodeRuntimeState.PAUSED;
      if (s === "idle" || s === "ready") {
        return currentActivity === "running" ? NodeRuntimeState.WORKING : NodeRuntimeState.IDLE;
      }
      return NodeRuntimeState.IDLE;
    },
  });

  const CommunicationType = Object.freeze({
    TASK_ASSIGNED: "TASK_ASSIGNED",
    RESULT_AVAILABLE: "RESULT_AVAILABLE",
    REVIEW_REQUESTED: "REVIEW_REQUESTED",
    REVIEW_COMPLETED: "REVIEW_COMPLETED",
    BLOCKER_ESCALATED: "BLOCKER_ESCALATED",
    HANDOFF_AVAILABLE: "HANDOFF_AVAILABLE",

    fromString(type) {
      const t = String(type || "").toUpperCase();
      if (t === "RESULT_AVAILABLE" || t === "RESULT" || t === "PACKET") return CommunicationType.RESULT_AVAILABLE;
      if (t === "REVIEW_REQUESTED" || t === "REVIEW_REQ") return CommunicationType.REVIEW_REQUESTED;
      if (t === "REVIEW_COMPLETED" || t === "REVIEW_DONE") return CommunicationType.REVIEW_COMPLETED;
      if (t === "BLOCKER_ESCALATED" || t === "BLOCKER" || t === "BLOCKER_REPORTED") return CommunicationType.BLOCKER_ESCALATED;
      if (t === "HANDOFF_AVAILABLE" || t === "HANDOFF") return CommunicationType.HANDOFF_AVAILABLE;
      return CommunicationType.TASK_ASSIGNED;
    },
  });

  // --- 2. Minimal Monochrome Domain Glyphs ---

  const domainIcons = Object.freeze({
    BACKEND:'dns', MOBILE:'smartphone', WEB:'web', RUNTIME:'terminal', ARCHITECTURE:'schema', DATABASE:'database',
    DATA:'analytics', AI:'auto_awesome', CLOUD:'cloud', NETWORK:'hub', HARDWARE:'memory', SECURITY:'shield',
    TESTING:'bug_report', DESIGN:'palette', PRODUCT:'category', RESEARCH:'science', WRITING:'edit_note',
    TRANSLATION:'translate', EDUCATION:'school', BUSINESS:'work', FINANCE:'account_balance', LEGAL:'balance',
    HEALTH:'medical_services', MARKETING:'campaign', SALES:'storefront', PEOPLE:'groups', OPERATIONS:'settings_suggest',
    LOGISTICS:'local_shipping', MEDIA:'movie', ENVIRONMENT:'eco', ENGINEERING:'precision_manufacturing', GENERAL:'person',
  });
  const roleIcons = Object.freeze({ executive:'explore', manager:'route', phase_lead:'flag', reviewer:'find_in_page',
    expert:'psychology', specialist:'psychology', worker:'construction', writer:'edit_note' });
  function renderDomainGlyph(role, domain) {
    const priority = role.toLowerCase();
    const roleIcon = Object.hasOwn(roleIcons, priority) ? roleIcons[priority] : null;
    const roleFirst = ['executive', 'manager', 'phase_lead', 'reviewer'].includes(priority);
    const icon = (roleFirst && roleIcon) || domainIcons[domain] || roleIcon || domainIcons.GENERAL;
    // The filename is selected exclusively from the fixed maps above; the mask follows currentColor.
    return `<span aria-hidden="true" style="display:block;width:100%;height:100%;background:currentColor;mask:url('/chat/role-icons/${icon}.svg') center / contain no-repeat;-webkit-mask:url('/chat/role-icons/${icon}.svg') center / contain no-repeat"></span>`;
  }

  // --- 3. Layout Algorithms (Radial Fan + Focus Tree + Edge Routing) ---

  const RadialLayout = {
    calculateFanPositions(centerX, centerY, radius, count, arcDegrees = 140, centerAngleDegrees = 90) {
      if (count <= 0) return [];
      if (count === 1) {
        const rad = (centerAngleDegrees * Math.PI) / 180;
        return [{ x: centerX + radius * Math.cos(rad), y: centerY + radius * Math.sin(rad) }];
      }
      const startAngle = centerAngleDegrees - arcDegrees / 2;
      const step = arcDegrees / (count - 1);
      const points = [];
      for (let i = 0; i < count; i++) {
        const angleDeg = startAngle + i * step;
        const rad = (angleDeg * Math.PI) / 180;
        points.push({
          x: centerX + radius * Math.cos(rad),
          y: centerY + radius * Math.sin(rad),
        });
      }
      return points;
    },
  };

  const FocusTreeLayout = {
    layoutChildren(parentPoint, children, verticalSpacing = 110, horizontalSpacing = 90) {
      if (!children || children.length === 0) return {};
      const count = children.length;
      const result = {};

      if (count <= 4) {
        const totalWidth = (count - 1) * horizontalSpacing;
        const startX = parentPoint.x - totalWidth / 2;
        children.forEach((child, i) => {
          result[child.id] = {
            x: startX + i * horizontalSpacing,
            y: parentPoint.y + verticalSpacing,
          };
        });
      } else {
        const row1Count = Math.ceil(count / 2);
        const row2Count = count - row1Count;

        const row1Width = (row1Count - 1) * horizontalSpacing;
        const row1StartX = parentPoint.x - row1Width / 2;
        for (let i = 0; i < row1Count; i++) {
          result[children[i].id] = {
            x: row1StartX + i * horizontalSpacing,
            y: parentPoint.y + verticalSpacing,
          };
        }

        const row2Width = (row2Count - 1) * horizontalSpacing;
        const row2StartX = parentPoint.x - row2Width / 2;
        for (let i = 0; i < row2Count; i++) {
          result[children[row1Count + i].id] = {
            x: row2StartX + i * horizontalSpacing,
            y: parentPoint.y + verticalSpacing * 1.8,
          };
        }
      }
      return result;
    },
  };

  const EdgeRouter = {
    routeEdge(edgeId, fromNodeId, toNodeId, from, to, alpha = 0.85) {
      const dy = to.y - from.y;
      const c1 = { x: from.x, y: from.y + dy * 0.45 };
      const c2 = { x: to.x, y: to.y - dy * 0.45 };
      return {
        id: edgeId,
        fromNodeId,
        toNodeId,
        start: from,
        end: to,
        control1: c1,
        control2: c2,
        isCurved: true,
        alpha,
      };
    },
  };

  const OrganizationLayoutEngine = {
    calculateLayout({
      nodes = {},
      edges = [],
      viewportWidth = 390,
      viewportHeight = 700,
      focusNodeId = null,
      previousPositions = {},
      clusterThreshold = 5,
      collapsedClusterIds = new Set(),
    }) {
      const nodeList = Object.values(nodes);
      if (nodeList.length === 0) {
        return {
          nodePositions: {},
          edges: [],
          bounds: { minX: 0, minY: 0, maxX: viewportWidth, maxY: viewportHeight },
          rootId: null,
        };
      }

      const rootNode = nodeList.find((n) => n.isRootLeader)
        || nodeList.find((n) => n.role === NodeRole.EXECUTIVE)
        || nodeList.find((n) => !n.parentId && !n.parentUnknown)
        || nodeList.find((n) => !n.parentId)
        || nodeList[0];

      const rootId = rootNode.id;
      const centerX = viewportWidth / 2;
      const rootY = Math.max(120, viewportHeight * 0.18);

      const childrenByParent = {};
      nodeList.forEach((n) => {
        const p = n.parentId && nodes[n.parentId] && n.parentId !== n.id ? n.parentId : "";
        if (!childrenByParent[p]) childrenByParent[p] = [];
        childrenByParent[p].push(n);
      });

      const calculatedPositions = {};
      const clusterNodes = {};
      const visited = new Set([rootId]);
      const hiddenInClusterIds = new Set();

      const collectDescendants = (startNodes, targetSet) => {
        const queue = [...startNodes];
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item || targetSet.has(item.id)) continue;
          targetSet.add(item.id);
          visited.add(item.id);
          for (const child of childrenByParent[item.id] || []) {
            if (!targetSet.has(child.id)) queue.push(child);
          }
        }
      };

      const placeSubtree = (parentNode) => {
        const parentPos = calculatedPositions[parentNode.id];
        if (!parentPos) return;
        const children = (childrenByParent[parentNode.id] || []).filter((c) => !visited.has(c.id));
        if (children.length === 0) return;

        const isFocused = focusNodeId === parentNode.id;
        const shouldCluster = children.length > clusterThreshold && !isFocused && !collapsedClusterIds.has(parentNode.id);

        if (shouldCluster) {
          const clusterId = `cluster_${parentNode.id}`;
          const clusterPos = { x: parentPos.x, y: parentPos.y + 110 };
          calculatedPositions[clusterId] = clusterPos;
          const hiddenIds = new Set();
          collectDescendants(children, hiddenIds);
          hiddenIds.forEach((hid) => hiddenInClusterIds.add(hid));
          clusterNodes[clusterId] = {
            id: clusterId,
            x: clusterPos.x,
            y: clusterPos.y,
            radius: 20,
            isVisible: true,
            isCluster: true,
            clusterCount: children.length,
            clusterChildIds: Array.from(hiddenIds),
            alpha: focusNodeId && focusNodeId !== parentNode.id && focusNodeId !== rootId ? 0.45 : 1.0,
          };
          return;
        }

        const childPositions = FocusTreeLayout.layoutChildren(parentPos, children, 110, 90);
        for (const child of children) {
          visited.add(child.id);
          calculatedPositions[child.id] = previousPositions[child.id] || childPositions[child.id] || { x: parentPos.x, y: parentPos.y + 110 };
          placeSubtree(child);
        }
      };

      // 1. Root Executive Position
      const rootPos = previousPositions[rootId] || { x: centerX, y: rootY };
      calculatedPositions[rootId] = rootPos;

      // 2. Direct leads of Root (Level 1)
      const level1Nodes = (childrenByParent[rootId] || []).filter((n) => !visited.has(n.id));
      const level1Count = level1Nodes.length;

      if (level1Count > 0) {
        const fanRadius = Math.max(180, 60 + level1Count * 30);
        const arcDegrees = Math.min(170, Math.max(90, level1Count * 35));
        const idealPoints = RadialLayout.calculateFanPositions(
          rootPos.x,
          rootPos.y,
          fanRadius,
          level1Count,
          arcDegrees,
          90
        );

        level1Nodes.forEach((node, index) => {
          visited.add(node.id);
          calculatedPositions[node.id] = previousPositions[node.id] || idealPoints[index];
        });
      }

      // 3. Level 2+ Workers / Subtrees (recursively)
      for (const lead of level1Nodes) {
        placeSubtree(lead);
      }

      // 4. Independent / detached components (e.g., unknown parent or cyclic subgraphs)
      const detachedRoots = nodeList.filter((n) => !visited.has(n.id) && (!n.parentId || !nodes[n.parentId]));
      const remainingRoots = nodeList.filter((n) => !visited.has(n.id));
      const componentRoots = [...detachedRoots];
      for (const candidate of remainingRoots) {
        if (!componentRoots.includes(candidate)) componentRoots.push(candidate);
      }

      let maxPlacedX = rootPos.x;
      Object.entries(calculatedPositions).forEach(([, pt]) => {
        if (pt && Number.isFinite(pt.x)) maxPlacedX = Math.max(maxPlacedX, pt.x);
      });
      let detachedCursorX = Math.max(centerX + 160, maxPlacedX + 130);
      const detachedBaseY = rootPos.y + 120;

      for (const compRoot of componentRoots) {
        if (visited.has(compRoot.id)) continue;
        visited.add(compRoot.id);
        const childrenCount = (childrenByParent[compRoot.id] || []).length;
        const halfSpan = Math.max(55, (Math.min(childrenCount, 4) * 90) / 2);
        const defaultPos = { x: detachedCursorX + halfSpan, y: detachedBaseY };
        calculatedPositions[compRoot.id] = previousPositions[compRoot.id] || defaultPos;
        placeSubtree(compRoot);
        detachedCursorX += halfSpan * 2 + 40;
      }

      // Build NodePosition objects
      const nodePositions = {};
      nodeList.forEach((node) => {
        const pt = calculatedPositions[node.id];
        if (!pt) return;
        const isFocused = node.id === focusNodeId;
        const isDimmed = focusNodeId && focusNodeId !== rootId && node.id !== focusNodeId && node.parentId !== focusNodeId;

        let radius = 16;
        if (node.role === NodeRole.EXECUTIVE) radius = 24;
        else if (node.role === NodeRole.MANAGER || node.role === NodeRole.PHASE_LEAD) radius = 20;
        else if (node.role === NodeRole.EXPERT) radius = 18;

        if (!hiddenInClusterIds.has(node.id)) {
          nodePositions[node.id] = {
            id: node.id,
            x: pt.x,
            y: pt.y,
            radius,
            isVisible: true,
            isCluster: false,
            clusterCount: 0,
            alpha: isDimmed ? 0.4 : 1.0,
            scale: isFocused ? 1.08 : 1.0,
            isFocused,
          };
        }
      });

      Object.assign(nodePositions, clusterNodes);

      // 5. Edge routing
      const edgePaths = [];
      const clusterValues = Object.values(clusterNodes);
      edges.forEach((edge) => {
        if (hiddenInClusterIds.has(edge.fromNodeId)) return;
        const fromPos = calculatedPositions[edge.fromNodeId];
        let toPos = calculatedPositions[edge.toNodeId];
        let targetId = edge.toNodeId;

        const containingCluster = clusterValues.find((cl) => cl.clusterChildIds.includes(edge.toNodeId));
        if (containingCluster) {
          toPos = { x: containingCluster.x, y: containingCluster.y };
          targetId = containingCluster.id;
        }

        if (fromPos && toPos) {
          const alpha = focusNodeId && edge.fromNodeId !== focusNodeId && edge.toNodeId !== focusNodeId ? 0.3 : 0.85;
          const routed = EdgeRouter.routeEdge(
            edge.id || `${edge.fromNodeId}-${targetId}`,
            edge.fromNodeId,
            targetId,
            fromPos,
            toPos,
            alpha
          );
          routed.isReview = String(edge.type || "").toUpperCase() === "REVIEWS";
          edgePaths.push(routed);
        }
      });

      // Add edges from leads to clusters
      Object.entries(clusterNodes).forEach(([clusterId, clusterNode]) => {
        const leadId = clusterId.replace("cluster_", "");
        const leadPos = calculatedPositions[leadId];
        if (leadPos) {
          const routed = EdgeRouter.routeEdge(
            `edge_${clusterId}`,
            leadId,
            clusterId,
            leadPos,
            { x: clusterNode.x, y: clusterNode.y },
            0.85
          );
          routed.isReview = false;
          edgePaths.push(routed);
        }
      });

      // 6. Bounds
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      Object.values(nodePositions).forEach((pos) => {
        minX = Math.min(minX, pos.x - 48);
        maxX = Math.max(maxX, pos.x + 48);
        minY = Math.min(minY, pos.y - 48);
        maxY = Math.max(maxY, pos.y + 48);
      });

      if (minX === Infinity) {
        minX = 0; maxX = viewportWidth; minY = 0; maxY = viewportHeight;
      }

      return {
        nodePositions,
        edges: edgePaths,
        bounds: { minX, minY, maxX, maxY },
        rootId,
      };
    },
  };

  // --- 4. Communication Visual Scheduler & Particle System ---

  class CommunicationVisualScheduler {
    constructor(maxActiveParticles = 3) {
      this.maxActiveParticles = maxActiveParticles;
      this.activeParticles = [];
      this.queue = [];
    }

    scheduleCommunication(id, type, fromNodeId, toNodeId) {
      let priority = 4;
      let durationMs = 500;
      switch (type) {
        case CommunicationType.BLOCKER_ESCALATED:
          priority = 1;
          durationMs = 450;
          break;
        case CommunicationType.REVIEW_REQUESTED:
        case CommunicationType.REVIEW_COMPLETED:
          priority = 2;
          durationMs = 600;
          break;
        case CommunicationType.RESULT_AVAILABLE:
          priority = 3;
          durationMs = 550;
          break;
        case CommunicationType.HANDOFF_AVAILABLE:
          priority = 5;
          durationMs = 600;
          break;
        default:
          priority = 4;
          durationMs = 500;
          break;
      }

      this.queue.push({
        id,
        type,
        fromNodeId,
        toNodeId,
        priority,
        durationMs,
      });

      this.queue.sort((a, b) => a.priority - b.priority);
    }

    updateTick(nodePositions, now = Date.now()) {
      // 1. Advance existing active particles
      const updated = [];
      for (const p of this.activeParticles) {
        const elapsed = now - p.startedAt;
        const progress = Math.min(1.0, elapsed / p.durationMs);
        if (progress < 1.0) {
          p.progress = progress;
          const t = progress;
          const oneMinusT = 1 - t;
          if (p.controlPoint) {
            p.currentX = oneMinusT * oneMinusT * p.startPoint.x + 2 * oneMinusT * t * p.controlPoint.x + t * t * p.endPoint.x;
            p.currentY = oneMinusT * oneMinusT * p.startPoint.y + 2 * oneMinusT * t * p.controlPoint.y + t * t * p.endPoint.y;
          } else {
            p.currentX = p.startPoint.x + (p.endPoint.x - p.startPoint.x) * t;
            p.currentY = p.startPoint.y + (p.endPoint.y - p.startPoint.y) * t;
          }
          updated.push(p);
        }
      }

      // 2. Replenish up to maxActiveParticles
      const slotsAvailable = this.maxActiveParticles - updated.length;
      if (slotsAvailable > 0 && this.queue.length > 0) {
        for (let i = 0; i < slotsAvailable && this.queue.length > 0; i++) {
          const next = this.queue.shift();
          const fromPos = nodePositions[next.fromNodeId];
          const toPos = nodePositions[next.toNodeId];
          if (fromPos && toPos) {
            const control = {
              x: (fromPos.x + toPos.x) / 2,
              y: Math.min(fromPos.y, toPos.y) + (toPos.y - fromPos.y) * 0.5,
            };
            updated.push({
              id: next.id,
              type: next.type,
              fromNodeId: next.fromNodeId,
              toNodeId: next.toNodeId,
              startPoint: { x: fromPos.x, y: fromPos.y },
              endPoint: { x: toPos.x, y: toPos.y },
              controlPoint: control,
              startedAt: now,
              durationMs: next.durationMs,
              progress: 0,
              currentX: fromPos.x,
              currentY: fromPos.y,
            });
          }
        }
      }

      this.activeParticles = updated;
      return this.activeParticles;
    }
  }

  // --- 5. RagentOrganizationViewManager Main Controller ---

  class RagentOrganizationViewManager {
    constructor() {
      this.sessionId = null;
      this.projection = null;
      this.projectionEtag = null;
      this.rawUnifiedMembers = null;
      this.membersLoadedAt = 0;
      this.delegationRuns = [];
      this.delegationRecords = [];
      this.delegationEvents = [];
      this.delegationCursors = {};
      this.delegationFinished = {};
      this.delegationScannedAt = {};
      this.delegationGap = false;
      this.delegationSourceAvailability = "unknown";
      this.loading = false;
      this.refreshInFlight = null;
      this.lastRefreshAt = 0;
      this.pollTimerId = null;
      this.detailPollTimerId = null;
      this.detailRequestEpoch = 0;
      this.detailConversationState = null;
      this.active = false;
      this.pan = { x: 0, y: 0 };
      this.zoom = 1.0;
      this.viewportWidth = 390;
      this.viewportHeight = 700;
      this.focusNodeId = null;
      this.selectedSheetNodeId = null;
      this.detailNodeId = null;
      this.isActivityFeedExpanded = false;
      this.previousPositions = {};
      this.previousParents = {};
      this.layoutResult = null;
      this.animationFrameId = null;
      this.communicationScheduler = new CommunicationVisualScheduler(3);
      this.activityEvents = [];
      this.nativeBoard = null;
      this.approvalOverlay = null;
      this.hasLoadedEver = false;

      // Pointer tracking
      this.isPanning = false;
      this.pointerStart = { x: 0, y: 0 };
      this.panStart = { x: 0, y: 0 };
      this.lastPinchDist = 0;
      this.touchPointers = new Map();

      this.dom = {};
      this.init();
    }

    init() {
      this.ensureSwarmUiState();
      this.bindDOM();
      this.setupEventListeners();
    }

    ensureSwarmUiState() {
      if (!Object.hasOwn(this, "swarmStatus")) this.swarmStatus = null;
      if (!Object.hasOwn(this, "boardProjection")) this.boardProjection = null;
      if (!Object.hasOwn(this, "selectedBoardChannel")) this.selectedBoardChannel = "all";
      if (!Object.hasOwn(this, "boardReplyToSeq")) this.boardReplyToSeq = null;
      if (!Object.hasOwn(this, "boardComposerDraft")) this.boardComposerDraft = "";
      if (!Object.hasOwn(this, "boardComposerBusy")) this.boardComposerBusy = false;
      if (!Object.hasOwn(this, "boardComposerError")) this.boardComposerError = "";
      if (!Object.hasOwn(this, "boardChannelDraft")) this.boardChannelDraft = "";
      if (!Object.hasOwn(this, "boardChannelBusy")) this.boardChannelBusy = false;
      if (!Object.hasOwn(this, "boardChannelError")) this.boardChannelError = "";
      if (!Object.hasOwn(this, "userCollapsedBoard")) this.userCollapsedBoard = false;
      if (!Object.hasOwn(this, "killConfirmTargetId")) this.killConfirmTargetId = null;
      if (!Object.hasOwn(this, "killConflictInfo")) this.killConflictInfo = null;
      if (!Object.hasOwn(this, "killBusy")) this.killBusy = false;
      if (!Object.hasOwn(this, "killError")) this.killError = "";
      if (!Object.hasOwn(this, "modelSwitchTargetId")) this.modelSwitchTargetId = null;
      if (!Object.hasOwn(this, "modelSwitchOpen")) this.modelSwitchOpen = false;
      if (!Object.hasOwn(this, "modelSwitchBusy")) this.modelSwitchBusy = false;
      if (!Object.hasOwn(this, "modelSwitchError")) this.modelSwitchError = "";
      if (!Object.hasOwn(this, "modelSwitchStatus")) this.modelSwitchStatus = "";
      if (!Object.hasOwn(this, "promoteBusy")) this.promoteBusy = false;
      if (!Object.hasOwn(this, "promoteError")) this.promoteError = "";
      if (!Object.hasOwn(this, "promoteResult")) this.promoteResult = null;
    }

    bindDOM() {
      // Find or dynamically inject the radar surface
      let surface = document.getElementById("organizationRadarSurface");
      if (!surface) {
        surface = document.createElement("div");
        surface.className = "organization-radar-surface";
        surface.id = "organizationRadarSurface";
        surface.hidden = true;

        const main = document.querySelector(".chat-area") || document.body;
        const messages = document.getElementById("messages");
        if (messages && messages.parentNode === main) {
          main.insertBefore(surface, messages.nextSibling);
        } else {
          main.appendChild(surface);
        }
      }

      surface.innerHTML = `
        <div class="org-radar-viewport" id="orgRadarViewport">
          <div class="org-radar-transform-layer" id="orgRadarTransformLayer">
            <canvas class="org-radar-canvas" id="orgRadarCanvas"></canvas>
            <div class="org-radar-nodes-layer" id="orgRadarNodesLayer"></div>
          </div>
        </div>
        <div class="org-radar-top-bar" id="orgRadarTopBar">
          <div class="org-radar-top-info">
            <div class="org-radar-objective" id="orgRadarObjective">Organization Radar</div>
            <div class="org-radar-meta" id="orgRadarMeta">Revision #0 · 0 agents</div>
          </div>
          <div class="org-radar-top-actions">
            <button type="button" class="org-icon-btn" id="orgFactoryWorkBtn" title="Work items" hidden>Tasks</button>
            <button type="button" class="org-icon-btn" id="orgRadarResetBtn" title="${tr("organization.resetView")}" aria-label="${tr("organization.resetView")}">
              ${root.RagentIcons?.render?.("refresh") || "↺"}
            </button>
            <button type="button" class="org-icon-btn" id="orgRadarCloseBtn" title="${tr("organization.timeline")}" aria-label="${tr("organization.timeline")}">
              ${root.RagentIcons?.render?.("close") || "✕"}
            </button>
          </div>
          <div class="org-swarm-overview" id="orgSwarmOverview" hidden></div>
        </div>
        <div class="org-radar-bottom-container" id="orgRadarBottomContainer">
          <div class="org-approval-overlay" id="orgApprovalOverlay" hidden>
            <div class="org-approval-header">
              <span class="org-status-pill-dot" style="background:#ef4444;width:8px;height:8px;"></span>
              <span>${tr("organization.approvalRequired")}</span>
            </div>
            <div class="org-approval-summary" id="orgApprovalSummary"></div>
            <div class="org-approval-actions">
              <button type="button" class="org-btn org-btn--primary" id="orgApproveBtn">${tr("organization.approve")}</button>
              <button type="button" class="org-btn org-btn--secondary" id="orgRejectBtn">${tr("organization.reject")}</button>
            </div>
          </div>
          <div class="org-activity-feed" id="orgActivityFeed">
            <div class="org-activity-feed-header" id="orgActivityFeedHeader">
              <div class="org-activity-feed-title">
                <span class="org-activity-feed-dot"></span>
                <span>${tr("organization.recentActivity")}</span>
                <span class="org-activity-feed-badge" id="orgActivityBadge">+0 ${tr("organization.updates")}</span>
              </div>
              <span class="org-activity-chevron" id="orgActivityChevron">▲</span>
            </div>
            <div class="org-activity-feed-list" id="orgActivityFeedList" hidden></div>
            <div class="org-swarm-board-composer" id="orgSwarmBoardComposer" hidden>
              <div class="org-board-composer-meta">
                <span class="org-board-composer-target" id="orgSwarmBoardTargetChannel">#main</span>
                <span class="org-board-composer-reply" id="orgSwarmBoardReplyBadge" hidden></span>
                <button type="button" class="org-board-reply-clear" id="orgSwarmBoardReplyClearBtn" hidden>✕</button>
              </div>
              <div class="org-board-composer-row">
                <input type="text" class="org-board-composer-input" id="orgSwarmBoardInput" placeholder="${escapeDisplayText(trText("organization.boardComposerPlaceholder", "Post to Swarm Board (@name, #seq)...", "向协作板发帖（可用 @成员名、#序号引用）..."))}" />
                <button type="button" class="org-btn org-btn--primary org-board-send-btn" id="orgSwarmBoardSendBtn">${escapeDisplayText(trText("organization.send", "Send", "发送"))}</button>
              </div>
              <div class="org-board-channel-create-row">
                <input type="text" class="org-board-channel-input" id="orgSwarmChannelInput" placeholder="${escapeDisplayText(trText("organization.newChannelPlaceholder", "New #channel", "新建 #频道"))}" />
                <button type="button" class="org-btn org-btn--secondary org-board-channel-btn" id="orgSwarmChannelCreateBtn">+ ${escapeDisplayText(trText("organization.channel", "Channel", "频道"))}</button>
              </div>
              <div class="org-board-composer-status" id="orgSwarmBoardStatus"></div>
            </div>
          </div>
        </div>
        <div class="org-bottom-sheet-backdrop" id="orgBottomSheetBackdrop" hidden></div>
        <div class="org-bottom-sheet" id="orgBottomSheet" hidden></div>
        <div class="org-detail-screen" id="orgDetailScreen" hidden></div>
      `;

      this.dom = {
        surface,
        viewport: surface.querySelector("#orgRadarViewport"),
        transformLayer: surface.querySelector("#orgRadarTransformLayer"),
        canvas: surface.querySelector("#orgRadarCanvas"),
        nodesLayer: surface.querySelector("#orgRadarNodesLayer"),
        objective: surface.querySelector("#orgRadarObjective"),
        meta: surface.querySelector("#orgRadarMeta"),
        swarmOverview: surface.querySelector("#orgSwarmOverview"),
        resetBtn: surface.querySelector("#orgRadarResetBtn"),
        closeBtn: surface.querySelector("#orgRadarCloseBtn"),
        bottomContainer: surface.querySelector("#orgRadarBottomContainer"),
        approvalOverlay: surface.querySelector("#orgApprovalOverlay"),
        approvalSummary: surface.querySelector("#orgApprovalSummary"),
        approveBtn: surface.querySelector("#orgApproveBtn"),
        rejectBtn: surface.querySelector("#orgRejectBtn"),
        activityFeed: surface.querySelector("#orgActivityFeed"),
        activityFeedHeader: surface.querySelector("#orgActivityFeedHeader"),
        activityBadge: surface.querySelector("#orgActivityBadge"),
        activityFeedList: surface.querySelector("#orgActivityFeedList"),
        activityChevron: surface.querySelector("#orgActivityChevron"),
        swarmBoardComposer: surface.querySelector("#orgSwarmBoardComposer"),
        swarmBoardTargetChannel: surface.querySelector("#orgSwarmBoardTargetChannel"),
        swarmBoardReplyBadge: surface.querySelector("#orgSwarmBoardReplyBadge"),
        swarmBoardReplyClearBtn: surface.querySelector("#orgSwarmBoardReplyClearBtn"),
        swarmBoardInput: surface.querySelector("#orgSwarmBoardInput"),
        swarmBoardSendBtn: surface.querySelector("#orgSwarmBoardSendBtn"),
        swarmChannelInput: surface.querySelector("#orgSwarmChannelInput"),
        swarmChannelCreateBtn: surface.querySelector("#orgSwarmChannelCreateBtn"),
        swarmBoardStatus: surface.querySelector("#orgSwarmBoardStatus"),
        sheetBackdrop: surface.querySelector("#orgBottomSheetBackdrop"),
        sheet: surface.querySelector("#orgBottomSheet"),
        detailScreen: surface.querySelector("#orgDetailScreen"),
        factoryWorkBtn: surface.querySelector("#orgFactoryWorkBtn"),
        radarBtn: document.getElementById("orgRadarBtn"),
        overflowRadarBtn: document.getElementById("headerOverflowOrgRadarBtn"),
      };
    }

    setupEventListeners() {
      // Top bar actions
      this.dom.resetBtn?.addEventListener("click", () => this.resetView());
      this.dom.closeBtn?.addEventListener("click", () => this.toggleOrganizationMode(false));
      this.dom.factoryWorkBtn?.addEventListener("click", () => this.showFactoryWork());

      // Header Radar Buttons
      this.dom.radarBtn?.addEventListener("click", () => this.toggleOrganizationMode());
      this.dom.overflowRadarBtn?.addEventListener("click", () => {
        if (typeof root.setHeaderOverflowOpen === "function") root.setHeaderOverflowOpen(false);
        this.toggleOrganizationMode();
      });

      // Bottom Sheet Backdrop dismiss
      this.dom.sheetBackdrop?.addEventListener("click", () => this.dismissBottomSheet());

      // Activity Feed & Swarm Board Interactions
      this.dom.activityFeedHeader?.addEventListener("click", () => this.toggleActivityFeed());
      this.dom.activityFeedList?.addEventListener("click", (e) => this.handleBoardFeedClick(e));
      this.dom.swarmBoardInput?.addEventListener("input", (e) => {
        this.boardComposerDraft = String(e?.target?.value ?? "");
      });
      this.dom.swarmBoardInput?.addEventListener("keydown", (e) => {
        if (e?.key === "Enter" && !e.shiftKey) {
          e.preventDefault?.();
          void this.submitBoardMessage();
        }
      });
      this.dom.swarmBoardSendBtn?.addEventListener("click", () => {
        void this.submitBoardMessage();
      });
      this.dom.swarmBoardReplyClearBtn?.addEventListener("click", () => {
        this.boardReplyToSeq = null;
        this.renderSwarmBoardComposerState(this.resolveActiveBoardState());
      });
      this.dom.swarmChannelInput?.addEventListener("input", (e) => {
        this.boardChannelDraft = String(e?.target?.value ?? "");
      });
      this.dom.swarmChannelCreateBtn?.addEventListener("click", () => {
        void this.createOrArchiveBoardChannel("create", this.dom.swarmChannelInput?.value ?? this.boardChannelDraft);
      });

      // Viewport Pan & Zoom
      const vp = this.dom.viewport;
      if (vp) {
        vp.addEventListener("pointerdown", (e) => this.onPointerDown(e));
        window.addEventListener("pointermove", (e) => this.onPointerMove(e));
        window.addEventListener("pointerup", (e) => this.onPointerUp(e));
        window.addEventListener("pointercancel", (e) => this.onPointerUp(e));
        vp.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      }

      // Window resize
      window.addEventListener("resize", () => {
        if (this.active) {
          this.updateViewportDimensions();
          this.render();
        }
      });
    }

    updateViewportDimensions() {
      const rect = this.dom.viewport?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        this.viewportWidth = rect.width;
        this.viewportHeight = rect.height;
      }
    }

    nextMemoryIdempotencyKey() {
      if (typeof root.crypto?.randomUUID === "function") return root.crypto.randomUUID();
      return `mem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    renderResponsibilityMemoryPanel(content, {
      responsibilityId,
      context,
      conflicts,
      userMemory,
      episodicMemory,
      auditData,
      responsibilityRequest,
      onBack,
      onReload,
    }) {
      const add = (parent, tag, value, className = '') => {
        const el = document.createElement(tag);
        el.textContent = value;
        if (className) el.className = className;
        parent.appendChild(el);
        return el;
      };
      const button = (parent, label, action) => {
        const el = add(parent, 'button', label, 'org-btn org-btn--secondary');
        el.type = 'button';
        el.addEventListener('click', action);
        return el;
      };
      const appendProvenanceLine = (parent, item) => {
        const row = add(parent, 'div', '', 'org-memory-provenance-row');
        const layer = item.layer || 'project';
        const sourceType = item.sourceType || (item.sourceKind === 'user' ? 'user_rule' : 'model_inferred');
        add(row, 'span', `[layer:${layer}]`, `org-memory-badge org-memory-badge--layer-${layer}`);
        add(row, 'span', `[source:${sourceType}]`, `org-memory-badge org-memory-badge--source-${sourceType}`);
        if (item.confidence !== undefined && item.confidence !== null) {
          add(row, 'span', ` conf=${item.confidence}`, 'org-memory-meta-chip');
        }
        if (item.validUntil) {
          add(row, 'span', ` validUntil=${item.validUntil}`, 'org-memory-meta-chip');
        }
        if (item.sourceRef) {
          add(row, 'span', ` ref=${item.sourceRef}`, 'org-memory-meta-chip');
        }
        if (sourceType === 'external_untrusted') {
          add(row, 'span', ' [UNTRUSTED: isolated from policy & user_rule]', 'org-memory-badge org-memory-badge--warning');
        }
        return row;
      };

      content.replaceChildren();
      if (typeof onBack === 'function') button(content, 'Responsibility', onBack);
      if (typeof onReload === 'function') button(content, 'Refresh memory', onReload);

      const memory = context?.memory || null;
      const revisionEnabled = Boolean(context?.revisionEnabled);
      add(content, 'h3', `Five-Layer Memory & Conflict Governance${memory ? ` · Project v${memory.version}` : ''}`);
      if (!revisionEnabled) {
        add(content, 'p', 'Memory writes are currently disabled (RAGENT_RESPONSIBILITY_MEMORY_WRITES_ENABLED is off); read-only inspection and previews remain available.');
      }
      add(content, 'p', 'Source provenance and validity are shown as recorded; external_untrusted and model_inferred sources are never promoted to user_rule or Responsibility policy.');

      // 1. Five-layer summary & ranked retrieved items
      const layers = context?.layers || null;
      if (layers) {
        const layerSection = add(content, 'section', '', 'org-memory-layers-section');
        add(layerSection, 'h4', 'Five-Layer Assembly');
        for (const layerName of ['user', 'project', 'responsibility', 'episodic', 'working']) {
          const info = layers[layerName];
          if (!info) continue;
          add(layerSection, 'p', `${layerName}: ${info.includedCount ?? (info.items?.length || 0)} included / ${info.totalActive ?? 0} active${info.truncated ? ' (trimmed by budget)' : ''}`);
        }
        const retrieval = context?.retrieval;
        if (retrieval?.budget) {
          add(layerSection, 'p', `Retrieval budget: ${retrieval.budget.usedTokens}/${retrieval.budget.maxTokens} tokens · ${retrieval.budget.usedBytes}/${retrieval.budget.maxBytes} bytes · excluded untrusted=${retrieval.excludedCounts?.untrusted ?? 0}, expired=${retrieval.excludedCounts?.expired ?? 0}, retracted=${retrieval.excludedCounts?.retractedOrInactive ?? 0}`);
        }
        for (const item of (context?.retrievedMemory || []).slice(0, 20)) {
          const card = add(layerSection, 'div', '', 'org-memory-item-card');
          add(card, 'p', `${item.factKey || item.id}: ${item.text}`);
          appendProvenanceLine(card, item);
        }
      }

      // 2. Semantic & Cross-Layer Conflict Candidates (Human Review Only)
      const conflictSection = add(content, 'section', '', 'org-memory-conflicts-section');
      add(conflictSection, 'h4', 'Semantic & Cross-Layer Conflict Candidates');
      add(conflictSection, 'p', '以下仅是确定性规则识别的候选冲突，专供人工审阅裁决；模型不会自动裁决真伪或静默删除历史。');
      const groups = conflicts?.groups || [];
      if (!groups.length) {
        add(conflictSection, 'p', 'No semantic or same-key memory conflicts detected.');
      }
      for (const group of groups) {
        const groupBox = add(conflictSection, 'div', '', 'org-memory-conflict-group');
        const kindLabel = group.kind || 'possible_conflict';
        const layersLabel = Array.isArray(group.layers) ? group.layers.join(' <-> ') : 'project';
        add(
          groupBox,
          'p',
          `[${kindLabel}] ${group.factKey} · ${group.reviewed ? '已审阅当前版本' : '待人工审阅'} · layers=${layersLabel}${group.authorityTension ? ' · CROSS-LAYER USER_RULE TENSION' : ''}${group.truncated ? ' · 部分省略' : ''}`,
        );
        if (group.conflictReason) {
          add(groupBox, 'p', `Reason (${group.reasonCode || 'candidate'}): ${group.conflictReason}`);
        }
        const groupControls = [];
        for (const fact of group.facts || []) {
          const itemBox = add(groupBox, 'div', '', 'org-memory-conflict-fact');
          add(itemBox, 'p', `${fact.factId} (${fact.factKey}): ${fact.factValue} · v${fact.version ?? fact.currentVersion ?? 1} · ${fact.status || fact.state}`);
          appendProvenanceLine(itemBox, fact);
          if (fact.readOnly || fact.layer === 'responsibility_policy') {
            add(itemBox, 'p', 'Read-only Responsibility policy constraint (cannot be mutated via memory resolution).');
            groupControls.push({ fact, readOnly: true });
            continue;
          }
          const controlRow = add(itemBox, 'div', '', 'org-memory-control-row');
          const chosen = document.createElement('input');
          chosen.type = 'checkbox';
          chosen.checked = true;
          const action = document.createElement('select');
          for (const opt of ['keep', 'correct', 'retract', 'supersede', 'set_valid_until']) {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            action.appendChild(o);
          }
          const valueInput = document.createElement('input');
          valueInput.placeholder = 'New/replacement value (correct/supersede)';
          const validUntilInput = document.createElement('input');
          validUntilInput.placeholder = 'validUntil ISO (set_valid_until)';
          controlRow.appendChild(chosen);
          controlRow.appendChild(action);
          controlRow.appendChild(valueInput);
          controlRow.appendChild(validUntilInput);
          groupControls.push({ fact, chosen, action, valueInput, validUntilInput, readOnly: false });
        }
        button(groupBox, 'Preview conflict resolution', async () => {
          try {
            const selected = groupControls.filter(row => row.readOnly || row.chosen.checked);
            const changes = selected.map(row => {
              if (row.readOnly) {
                return { layer: row.fact.layer, factId: row.fact.factId, action: 'keep' };
              }
              const act = row.action.value;
              const entry = {
                layer: row.fact.layer,
                factId: row.fact.factId,
                action: act,
                expectedVersion: row.fact.version ?? row.fact.currentVersion,
              };
              if (act === 'correct' || (act === 'supersede' && row.valueInput.value.trim())) {
                entry.value = row.valueInput.value.trim();
              }
              if (act === 'set_valid_until') {
                entry.validUntil = row.validUntilInput.value.trim();
              }
              return entry;
            });
            if (changes.length < 2) throw new Error('Select at least 2 facts in this conflict group');
            const body = {
              factIds: changes.map(c => c.factId),
              changes,
              expectedVersion: conflicts.projectVersion ?? conflicts.version ?? 0,
              expectedProjectVersion: conflicts.projectVersion ?? conflicts.version ?? 0,
            };
            const preview = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/conflicts/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const review = add(groupBox, 'section', '', 'org-memory-preview-box');
            add(review, 'p', `Preview ready (crossStore=${Boolean(preview.preview.crossStore)}; expires=${preview.preview.expiresAt}).`);
            add(review, 'pre', JSON.stringify({
              changes: preview.preview.changes,
              projectedUserFacts: preview.preview.projectedUserFacts,
              projectedSummary: preview.preview.projectedSummary,
            }, null, 2));
            if (!revisionEnabled) {
              add(review, 'p', 'Memory writes are disabled; commit blocked by default-off gate.');
              return;
            }
            const commit = {
              ...body,
              previewDigest: preview.previewDigest,
              confirmed: true,
              idempotencyKey: this.nextMemoryIdempotencyKey(),
            };
            const submit = async () => {
              try {
                const res = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/conflicts/commit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(commit),
                });
                add(review, 'p', `Resolution committed (journal=${res.journalId || 'ok'}, projectVersion=${res.projectVersion ?? res.version ?? 0}).`);
                if (typeof onReload === 'function') await onReload();
              } catch (err) {
                add(review, 'p', `Resolution not confirmed: ${err.message}`);
                button(review, 'Retry same resolution', submit);
              }
            };
            button(review, 'Confirm conflict resolution', submit);
          } catch (err) {
            add(groupBox, 'p', `Preview unavailable: ${err.message}`);
          }
        });
      }

      if (conflicts?.truncated || memory?.truncated) {
        add(conflictSection, 'p', '列表不完整，未显示的事实不能在此选择。');
      }

      // Free-form multi-fact selection across active facts (preserving legacy workflow)
      const activeProjectFacts = (memory?.currentFacts || []).filter(fact => fact.state === 'active').map(f => ({ ...f, layer: 'project', version: f.factVersion }));
      const activeUserFacts = (userMemory?.facts || []).filter(fact => fact.status === 'active').map(f => ({ ...f, factId: f.id, state: f.status, layer: 'user' }));
      const selectableFacts = [...activeUserFacts, ...activeProjectFacts];
      if (selectableFacts.length >= 2) {
        const selections = selectableFacts.map(fact => {
          const row = add(conflictSection, 'div', '', 'org-memory-manual-row');
          const chosen = document.createElement('input');
          chosen.type = 'checkbox';
          const action = document.createElement('select');
          for (const option of ['keep', 'correct', 'retract', 'supersede', 'set_valid_until']) {
            const el = document.createElement('option');
            el.value = option;
            el.textContent = option;
            action.appendChild(el);
          }
          const value = document.createElement('input');
          value.placeholder = '更正/替代值或 validUntil ISO';
          const textLabel = add(row, 'span', ` [${fact.layer}] ${fact.factId}: ${fact.factValue} `);
          row.insertBefore(chosen, textLabel);
          row.appendChild(action);
          row.appendChild(value);
          return { fact, chosen, action, value };
        });
        button(conflictSection, '预览事实审阅', async () => {
          try {
            const selected = selections.filter(row => row.chosen.checked);
            const changes = selected.map(row => {
              const act = row.action.value;
              const entry = { layer: row.fact.layer, factId: row.fact.factId, action: act, expectedVersion: row.fact.version };
              if (act === 'correct' || (act === 'supersede' && row.value.value.trim())) entry.value = row.value.value.trim();
              if (act === 'set_valid_until') entry.validUntil = row.value.value.trim();
              return entry;
            });
            if (selected.length < 2 || selected.length > 20 || changes.some(change => change.action === 'correct' && !change.value)) {
              throw new Error('请选择 2 至 20 项事实并填写更正值');
            }
            const body = {
              factIds: changes.map(change => change.factId),
              changes,
              expectedVersion: conflicts?.projectVersion ?? conflicts?.version ?? memory?.version ?? 0,
              expectedProjectVersion: conflicts?.projectVersion ?? conflicts?.version ?? memory?.version ?? 0,
            };
            const preview = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/conflicts/preview`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const review = add(conflictSection, 'section', '');
            add(review, 'p', '事实及来源、所选处理和重建结果如下；撤回不等于物理删除。');
            for (const [label, val] of [
              ['事实与来源', preview.preview.facts],
              ['处理', preview.preview.changes],
              ['原摘要', preview.preview.previousSummary],
              ['重建正文', preview.preview.projectedContent],
              ['重建摘要', preview.preview.projectedSummary],
              ['预览到期', preview.preview.expiresAt],
            ]) {
              add(review, 'h4', label);
              add(review, 'pre', typeof val === 'string' ? val : JSON.stringify(val, null, 2));
            }
            if (!revisionEnabled) {
              add(review, 'p', '记忆写入当前关闭，不能提交。');
              return;
            }
            const commit = { ...body, previewDigest: preview.previewDigest, confirmed: true, idempotencyKey: this.nextMemoryIdempotencyKey() };
            const submit = async () => {
              try {
                const result = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/conflicts/commit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(commit),
                });
                add(review, 'p', `已记录版本 ${result.version}；投影 ${result.projectionState}。`);
              } catch (err) {
                add(review, 'p', `未确认：${err.message}`);
                button(review, '使用同一请求重试', submit);
              }
            };
            button(review, '确认事实审阅', submit);
          } catch (err) {
            add(conflictSection, 'p', `预览不可用：${err.message}`);
          }
        });
      }

      // 3. User Memory Section
      const userSection = add(content, 'section', '', 'org-memory-user-section');
      add(userSection, 'h4', 'User Memory (Cross-Project Rules & Preferences)');
      if (revisionEnabled) {
        button(userSection, 'Add User Memory rule/preference', async () => {
          const category = root.prompt?.('Category: user_rule, preference, work_habit, or constraint', 'user_rule') || '';
          if (!['user_rule', 'preference', 'work_habit', 'constraint'].includes(category.trim())) return;
          const factKey = root.prompt?.('Fact key (e.g. user.preferred_language)', '') || '';
          const factValue = root.prompt?.('Fact statement/value', '') || '';
          if (!factValue.trim()) return;
          const scope = root.prompt?.('Scope: global, project, or responsibility', 'global') || 'global';
          const validUntilRaw = root.prompt?.('Optional validUntil ISO timestamp (blank for none)', '') || '';
          const body = {
            category: category.trim(),
            sourceType: category.trim() === 'user_rule' ? 'user_rule' : 'user_rule',
            sourceRef: `owner:ui:${responsibilityId}`,
            factKey: factKey.trim() || undefined,
            factValue: factValue.trim(),
            scope: scope.trim() === 'responsibility'
              ? { type: 'responsibility', responsibilityId }
              : scope.trim() === 'project'
                ? 'project'
                : 'global',
            ...(validUntilRaw.trim() ? { validUntil: validUntilRaw.trim() } : {}),
            idempotencyKey: this.nextMemoryIdempotencyKey(),
          };
          if (!root.confirm?.(`Save ${body.category}: ${body.factValue}?`)) return;
          try {
            await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/user`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (typeof onReload === 'function') await onReload();
          } catch (err) {
            add(userSection, 'p', `Unable to create user memory: ${err.message}`);
          }
        });
      }
      const userFacts = userMemory?.facts || [];
      if (!userFacts.length) add(userSection, 'p', 'No User Memory facts recorded for this scope.');
      for (const u of userFacts) {
        const card = add(userSection, 'div', '', 'org-memory-user-card');
        add(card, 'p', `${u.id} · ${u.category} · ${u.factKey}: ${u.factValue} · status=${u.status} · v${u.version}`);
        appendProvenanceLine(card, { ...u, layer: 'user' });
        button(card, 'History', async () => {
          try {
            const detail = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/user/${encodeURIComponent(u.id)}?includeHistory=1`);
            add(card, 'pre', JSON.stringify(detail.history || [], null, 2));
          } catch (err) {
            add(card, 'p', `History unavailable: ${err.message}`);
          }
        });
        if (revisionEnabled && u.status === 'active') {
          for (const action of ['revise', 'retract', 'supersede', 'valid-until']) {
            button(card, action, async () => {
              const payload = { action: action === 'valid-until' ? 'set_valid_until' : action, expectedVersion: u.version };
              if (action === 'revise' || action === 'supersede') {
                const val = root.prompt?.(`New value for ${action}`, u.factValue || '') || '';
                if (!val.trim()) return;
                payload.factValue = val.trim();
              } else if (action === 'valid-until') {
                const vu = root.prompt?.('validUntil ISO timestamp (blank to clear)', u.validUntil || '') ?? null;
                if (vu === null) return;
                payload.validUntil = vu.trim() || null;
              }
              try {
                const preview = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/user/${encodeURIComponent(u.id)}/preview`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
                });
                const review = add(card, 'div', '');
                add(review, 'pre', JSON.stringify(preview.preview.projectedFact, null, 2));
                const commitBody = {
                  ...payload,
                  previewDigest: preview.previewDigest,
                  confirmed: true,
                  idempotencyKey: this.nextMemoryIdempotencyKey(),
                };
                button(review, `Confirm user ${action}`, async () => {
                  try {
                    await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/user/${encodeURIComponent(u.id)}/${action}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(commitBody),
                    });
                    if (typeof onReload === 'function') await onReload();
                  } catch (err) {
                    add(review, 'p', `User memory ${action} failed: ${err.message}`);
                  }
                });
              } catch (err) {
                add(card, 'p', `Preview unavailable: ${err.message}`);
              }
            });
          }
        }
      }

      // 4. Project Memory Section
      const projectSection = add(content, 'section', '', 'org-memory-project-section');
      if (!memory) {
        add(projectSection, 'h4', 'Project Memory');
        add(projectSection, 'p', 'No committed project memory.');
      } else {
        add(projectSection, 'h4', `Project Memory · version ${memory.version}`);
        for (const fact of memory.currentFacts || []) {
          const card = add(projectSection, 'div', '', 'org-memory-project-card');
          add(card, 'p', `${fact.factId}: ${fact.factValue || '(retracted)'} · ${fact.state}${fact.contestedBy ? ` · contested by ${fact.contestedBy}` : ''}`);
          appendProvenanceLine(card, { ...fact, layer: 'project' });
          for (const source of (memory.facts || []).filter(entry => entry.factId === fact.factId)) {
            add(card, 'p', `Source: session ${source.sessionId || 'unknown'}, run ${source.runId || 'unknown'}, events ${source.sourceEventStart}-${source.sourceEventEnd}`);
          }
          for (const action of revisionEnabled ? ['correct', 'retract', 'supersede', 'valid-until'] : []) {
            button(card, action, async () => {
              const reqBody = {
                action: action === 'valid-until' ? 'set_valid_until' : action,
                expectedVersion: memory.version,
              };
              if (action === 'correct' || action === 'supersede') {
                const value = root.prompt?.(action === 'correct' ? 'Corrected fact' : 'Replacement fact (optional)', fact.factValue || '');
                if (action === 'correct' && !value) return;
                if (value) reqBody.value = value;
              } else if (action === 'valid-until') {
                const validUntil = root.prompt?.('validUntil ISO timestamp', fact.validUntil || '') || '';
                if (!validUntil.trim()) return;
                reqBody.validUntil = validUntil.trim();
              }
              let preview;
              try {
                preview = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/facts/${encodeURIComponent(fact.factId)}/preview`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(reqBody),
                });
              } catch (err) {
                add(card, 'p', `Preview unavailable: ${err.message}`);
                return;
              }
              const review = add(card, 'div', '');
              add(review, 'h4', `Review ${action}: ${fact.factId}`);
              add(review, 'p', 'Current summary is rebuilt from active facts. Unstructured text remains in history; this is not physical deletion.');
              add(review, 'pre', preview.preview.projectedSummary);
              add(review, 'p', `Preview expires ${preview.preview.expiresAt}`);
              const body = {
                ...reqBody,
                previewDigest: preview.previewDigest,
                confirmed: true,
                idempotencyKey: this.nextMemoryIdempotencyKey(),
              };
              const submit = async () => {
                try {
                  const result = await responsibilityRequest(`/${encodeURIComponent(responsibilityId)}/memory/facts/${encodeURIComponent(fact.factId)}/${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  add(review, 'p', `Memory version ${result.version}; projection ${result.projectionState}.`);
                } catch (err) {
                  add(review, 'p', `Request not confirmed: ${err.message}`);
                  button(review, 'Retry same request', submit);
                }
              };
              button(review, `Confirm ${action}`, submit);
            });
          }
        }
        if (memory.truncated) add(projectSection, 'p', 'Some facts or sources are omitted from this view.');
      }

      // 5. Episodic Memory Section
      const episodicSection = add(content, 'section', '', 'org-memory-episodic-section');
      add(episodicSection, 'h4', 'Episodic Memory (Execution Outcomes & Repairs)');
      const episodes = episodicMemory?.episodes || [];
      if (!episodes.length) add(episodicSection, 'p', 'No execution episodes recorded yet.');
      for (const ep of episodes) {
        const card = add(episodicSection, 'div', '', 'org-memory-episodic-card');
        add(card, 'p', `[${ep.outcome}] ${ep.summary}${ep.failureRootCause ? ` · Root cause: ${ep.failureRootCause}` : ''}${ep.repairAttempt ? ` · Repair (${ep.repairStatus}): ${ep.repairAttempt}` : ''}`);
        appendProvenanceLine(card, { ...ep, layer: 'episodic' });
      }

      // 6. Governance Audit Trail
      const auditSection = add(content, 'section', '', 'org-memory-audit-section');
      add(auditSection, 'h4', 'Memory Governance Audit Trail');
      const auditRows = auditData?.audit || [];
      if (!auditRows.length) add(auditSection, 'p', 'No memory governance audit entries recorded.');
      for (const entry of auditRows.slice(0, 20)) {
        add(auditSection, 'p', `${entry.createdAt} · ${entry.operation} · [${entry.layer}] ${entry.factId} · ${entry.action} (v${entry.previousVersion ?? '-'} -> v${entry.newVersion ?? '-'})`);
      }
    }

    async showFactoryWork(initialResponsibilityId = '', openResponsibilities = false) {
      const organizationId = this.projection?.organizationId;
      if (!organizationId || !this.dom.detailScreen) return;
      this.stopDetailPolling();
      this.detailNodeId = null;
      this.detailConversationState = null;
      const screen = this.dom.detailScreen;
      screen.hidden = false;
      screen.replaceChildren();
      const add = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.appendChild(el); return el; };
      const button = (parent, label, action) => { const el = add(parent, 'button', label); el.type = 'button'; el.className = 'org-btn org-btn--secondary'; el.addEventListener('click', action); return el; };
      const base = `/api/organizations/${encodeURIComponent(organizationId)}/factory`;
      const fetcher = root.ragentFetch || fetch;
      const request = async (path, options = {}) => {
        const response = await fetcher(base + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        let body;
        try { body = await response.json(); } catch { body = {}; }
        if (!response.ok) { const error = new Error(`${body.error || `Request failed: ${response.status}`}${body.blockers ? ` · ${JSON.stringify(body.blockers)}` : ''}`); error.status = response.status; throw error; }
        return body;
      };
      const requestWithTimeout = async (path, options) => {
        const controller = new AbortController();
        const timer = root.setTimeout(() => controller.abort(), 20000);
        try { return await request(path, {...options, signal:controller.signal}); }
        finally { root.clearTimeout(timer); }
      };
      const header = add(screen, 'div', '');
      button(header, 'Back', () => { screen.hidden = true; screen.replaceChildren(); });
      add(header, 'h2', 'Work items');
      const content = add(screen, 'div', 'Loading…');
      let responsibilityObserver = null;
      const stopResponsibilityObserver = () => { if (responsibilityObserver) responsibilityObserver.stopped = true; responsibilityObserver = null; };
      const showList = async () => {
        stopResponsibilityObserver();
        content.replaceChildren(); add(content, 'p', 'Loading…');
        try {
          const [list, status] = await Promise.all([request('/work-items'), request('/status')]);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          content.replaceChildren();
          add(content, 'p', `As of ${list.asOf} · Automatic admission ${status.automaticAdmission === true ? 'enabled' : status.automaticAdmission === false ? 'off' : 'status unavailable'} · Execution ${status.executionReadiness}`);
          if (!list.items.length) add(content, 'p', 'No work items.');
          for (const item of list.items) button(content, `${item.contract?.objective || item.id} · ${item.state} · ${item.controlState}`, () => showItem(item.id));
          if (list.nextCursor) add(content, 'p', 'More items exist; this view shows the first page.');
          button(content, 'Factory concurrency', async () => {
            const panel=add(content,'section','');
            try {
              const policy=await request('/policy');
              add(panel,'p',`Current limit: ${policy.factoryMaxConcurrent ?? 'not configured'}; Organization budget limit: ${policy.budgetMaxConcurrent ?? 'not configured'}. This does not enable automatic admission.`);
              if (!Number.isSafeInteger(policy.budgetMaxConcurrent)) { add(panel,'p','A valid organization concurrency budget is required first.'); return; }
              const input=document.createElement('input'); input.type='number'; input.min='1'; input.max=String(policy.budgetMaxConcurrent); input.value=String(policy.factoryMaxConcurrent || 1); panel.appendChild(input);
              const receipt=add(panel,'p','');
              button(panel,'Save concurrency',()=>{
                const value=Number(input.value);
                if (!Number.isSafeInteger(value) || value<1 || value>policy.budgetMaxConcurrent) {receipt.textContent='Enter a whole number within the organization budget.';return;}
                const commandId=root.crypto.randomUUID(),body={commandId,expectedVersion:policy.organizationVersion,factoryMaxConcurrent:value};
                const submit=async()=>{try {const result=await request('/policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});receipt.textContent=`Saved limit ${result.factoryMaxConcurrent}; refresh to see runtime status.`;}catch(error){receipt.textContent=`Not confirmed: ${error.message}`;button(panel,'Retry same request',submit);}};
                submit();
              });
            } catch(error) { add(panel,'p',`Concurrency settings unavailable: ${error.message}`); }
          });
          button(content, 'Team lifecycle', showLifecycle);
          button(content, 'Responsibilities', showResponsibilities);
          button(content, 'Positions and relationships', showTeamConfiguration);
          button(content, 'Integration queue', showIntegrationQueue);
          button(content, 'Refresh', showList);
        } catch (error) { content.replaceChildren(); add(content, 'p', `Unable to load work items: ${error.message}`); button(content, 'Retry', showList); }
      };
      const responsibilityRequest = async (path, options = {}) => {
        const response = await fetcher(`/api/responsibilities${path}`, { credentials: 'same-origin', cache: 'no-store', ...options });
        const body = await response.json();
        if (!response.ok) throw new Error(`${body.error || `Request failed: ${response.status}`}${body.blockers ? ` · ${JSON.stringify(body.blockers)}` : ''}`);
        return body;
      };
      const showResponsibilities = async () => {
        stopResponsibilityObserver();
        content.replaceChildren(); add(content, 'p', 'Loading responsibilities…');
        try {
          const result = await responsibilityRequest(`?organizationId=${encodeURIComponent(organizationId)}`);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          content.replaceChildren(); button(content, 'All work items', showList);
          add(content, 'h3', 'Responsibilities');
          add(content, 'p', 'A draft records an objective; execution requires a separately reviewed policy and an available adapter.');
          try {
            const catalog = await responsibilityRequest(`/capabilities?organizationId=${encodeURIComponent(organizationId)}`);
            for (const provider of catalog.providers || []) add(content, 'p', `${provider.id}@${provider.version}: ${provider.available ? 'adapter present; node checks still required' : 'unavailable'} · ${provider.reason || ''} · scope ${JSON.stringify(provider.requiredScope || {})} · network ${JSON.stringify(provider.networkPolicies || [])}`);
          } catch { add(content, 'p', 'Adapter availability is unavailable; no execution capability is assumed.'); }
          if (!result.responsibilities?.length) add(content, 'p', 'No responsibilities.');
          for (const responsibility of result.responsibilities || []) {
            button(content, `${responsibility.objective} · ${responsibility.lifecycle}`, () => showResponsibility(responsibility.id));
          }
          button(content, '准备项目周报', async () => {
            const panel=add(content,'section',''); panel.className='org-report-candidate';
            try {
              const [sessionResponse,projectsResponse]=await Promise.all([
                fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}?view=summary`,{credentials:'same-origin',cache:'no-store'}),
                fetcher('/api/projects',{credentials:'same-origin',cache:'no-store'}),
              ]);
              if(!sessionResponse.ok||!projectsResponse.ok) throw new Error('无法读取当前项目');
              const sessionData=await sessionResponse.json(), projectsData=await projectsResponse.json();
              const session=sessionData.session, project=(projectsData.projects || []).find(p=>p.id===session?.projectId);
              if(!project || session.id!==this.sessionId) throw new Error('当前会话的项目无法核实');
              add(panel,'p',`项目：${project.name || project.title || project.id}。此草案先手动运行，不会启用周期。后续须明确授权读取整个项目、选择网络边界和节点。`);
              const objective=document.createElement('input'); objective.value='生成项目周报'; objective.setAttribute('aria-label','报告目标'); panel.appendChild(objective);
              const criterion=document.createElement('input'); criterion.placeholder='填写报告的验收标准'; criterion.setAttribute('aria-label','验收标准'); panel.appendChild(criterion);
              const expiry=document.createElement('input'); expiry.type='datetime-local'; expiry.setAttribute('aria-label','授权到期时间'); panel.appendChild(expiry);
              const status=add(panel,'p',''), actions=add(panel,'div',''); status.setAttribute('role','status');actions.className='org-report-actions';
              button(actions,'创建手动周报草案',()=>{
                const validUntil=new Date(expiry.value);if(!objective.value.trim()||!criterion.value.trim()||!expiry.value||!Number.isFinite(validUntil.getTime())||validUntil.getTime()<=Date.now()){status.textContent='请填写目标、验收标准和未来的授权到期时间。';return;}
                const body={organizationId,projectId:project.id,objective:objective.value.trim(),successCriteria:[criterion.value.trim()],policy:{validUntil:validUntil.toISOString()},idempotencyKey:root.crypto.randomUUID()};
                if(!root.confirm(`创建手动报告草案？\n项目：${project.name || project.title || project.id}\n目标：${body.objective}\n标准：${body.successCriteria[0]}\n到期：${validUntil.toLocaleString()}\n此步骤不授予访问权限，也不启动或安排运行。`))return;actions.replaceChildren();
                const submit=async()=>{try{const result=await responsibilityRequest('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!result.responsibility?.id)throw new Error('责任标识不可用');await showResponsibility(result.responsibility.id);}catch(error){status.textContent=`草案未确认：${error.message}`;button(actions,'重试同一请求',submit);}};void submit();
              });
            } catch(error) { add(panel,'p',`无法准备周报：${error.message}`); }
          });
          button(content, 'Create responsibility', () => {
            const projectId = root.prompt('Project ID for this organization'); if (!projectId) return;
            const objective = root.prompt('Responsibility objective'); if (!objective) return;
            const criterion = root.prompt('Success criterion'); if (!criterion) return;
            const interval = root.prompt('Trigger interval in minutes (leave blank for manual only)', '');
            if (interval === null) return;
            const minutes = interval.trim() === '' ? null : Number(interval);
            if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600)) { add(content, 'p', 'Interval must be a whole number from 1 to 525600 minutes.'); return; }
            const validUntil = root.prompt('Policy expiry (ISO date and time, including timezone)');
            if (!validUntil || !Number.isFinite(Date.parse(validUntil))) return;
            const body = { organizationId, projectId, objective, successCriteria: [criterion], policy: { validUntil }, idempotencyKey: root.crypto.randomUUID() };
            if (minutes !== null) body.intervalMs = minutes * 60000;
            if (!root.confirm(`Create draft responsibility?\nProject: ${projectId}\nObjective: ${objective}\nCriterion: ${criterion}\nTrigger: ${minutes === null ? 'manual' : `every ${minutes} minutes`}\nPolicy expiry: ${validUntil}\nThis does not grant tool access or approve a plan.`)) return;
            const submit = async () => { try { await responsibilityRequest('', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); await showResponsibilities(); }
              catch (error) { add(content, 'p', `Request not confirmed: ${error.message}`); button(content, 'Retry same request', submit); } };
            submit();
          });
          button(content, 'Refresh', showResponsibilities);
        } catch (error) { content.replaceChildren(); add(content, 'p', `Responsibilities unavailable: ${error.message}`); button(content, 'All work items', showList); }
      };
      const showResponsibility = async id => {
        stopResponsibilityObserver();
        content.replaceChildren(); add(content, 'p', 'Loading responsibility…');
        try {
          const path = `/${encodeURIComponent(id)}`;
          const [detail, activity] = await Promise.all([responsibilityRequest(path), responsibilityRequest(`${path}/activity`)]);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          const item = detail.responsibility;
          if (item.organizationId !== organizationId) throw new Error('Responsibility belongs to another organization');
          content.replaceChildren(); button(content, 'Responsibilities', showResponsibilities);
          add(content, 'h3', item.objective);
          add(content, 'p', `Responsibility ${item.lifecycle} · version ${item.rowVersion} · policy ${item.policyRevision}`);
          add(content, 'p', 'A paused responsibility stops new admission; existing work may continue.');
          add(content, 'p', 'A stop request is not proof of stopping. Unknown or older active executions must be reconciled; a run that finished first remains pending result review. Archived responsibilities retain their history.');
          const budgetStatus = detail.budgetStatus;
          if (budgetStatus) {
            add(content, 'h4', 'Daily budget & enforcement boundary');
            add(content, 'p', `Enforcement: ${budgetStatus.costEnforcement || 'admission_estimate_only'} (hard cap available: ${budgetStatus.hardCapAvailable === true ? 'yes' : 'no'}). ${budgetStatus.budgetBoundaryNote || 'Admission estimates reserve capacity before dispatch; they do not enforce a provider spending hard cap.'}`);
            if (budgetStatus.timeZone) {
              const cw = budgetStatus.currentWindow;
              add(content, 'p', `Window day: ${budgetStatus.currentDay || 'unknown'} · timezone: ${budgetStatus.timeZone} · ${budgetStatus.rolloverRule || ''}${budgetStatus.rolledOverFromDay ? ` · prior day ${budgetStatus.rolledOverFromDay}` : ''}`);
              add(content, 'p', `Limits: ${JSON.stringify(budgetStatus.limits || {})} · used totals: ${JSON.stringify(cw?.totals || {})} · reserved: ${JSON.stringify(cw?.reserved || {})} · remaining: ${JSON.stringify(cw?.remaining || {})}`);
            } else {
              add(content, 'p', 'Daily budget window: not configured on current policy.');
            }
            if (budgetStatus.unknownUsageReservationCount > 0) {
              add(content, 'p', `Unknown-usage reservations retained (${budgetStatus.unknownUsageReservationCount}): ${JSON.stringify(budgetStatus.unresolvedReservations)}`);
            }
          }
          if (Array.isArray(detail.workSummary) && detail.workSummary.length) {
            add(content, 'h4', 'Linked work items');
            for (const w of detail.workSummary) {
              const stopLabel = w.stopStatus === 'cancel_requested_pending'
                ? 'Cancellation requested (stop NOT yet confirmed)'
                : w.stopStatus === 'completed_pending_review' || w.stopStatus === 'completed_before_stop'
                  ? 'Completed before stop (pending review, NOT cancelled)'
                  : w.stopStatus === 'stopped'
                    ? 'Confirmed stopped'
                    : w.stopStatus;
              const unknownLabel = w.isUnknownOutcome ? ' · UNKNOWN OUTCOME (auto-redispatch disabled; requires reconciliation)' : '';
              add(content, 'p', `${w.workItemId}: state ${w.state} · control ${w.controlState} · status ${stopLabel}${unknownLabel}`);
              button(content, `Inspect work ${w.workItemId}`, () => showItem(w.workItemId));
            }
          }
          const triggerCatalog = await responsibilityRequest(`/capabilities?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(item.projectId)}`).catch(() => null);
          if (triggerCatalog?.features?.timeTriggerBridge === true) {
            add(content, 'h4', 'Scheduled responsibility wake');
            add(content, 'p', 'A trigger records a wake request; it does not prove work started.');
            const bindingsPath = `${path}/trigger-bindings`;
            const submitBinding = (suffix, body) => {
              const submit = async () => { try { const result = await responsibilityRequest(`${bindingsPath}${suffix}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); add(content,'p',`Schedule request recorded: ${JSON.stringify(result.binding || {})}`); button(content,'Refresh schedules',() => showResponsibility(id)); }
                catch(error) { add(content,'p',`Schedule request not confirmed: ${error.message}`); button(content,'Retry same request',submit); } };
              submit();
            };
            try {
              const bindings = await responsibilityRequest(bindingsPath);
              for (const binding of bindings.bindings || []) {
                add(content,'p',`${binding.enabled ? 'enabled' : 'disabled'} · ${binding.state || 'unknown'} · ${JSON.stringify(binding.config || {})} · delivery ${binding.delivery?.status || 'unknown'} · ${binding.lastError || ''}`);
                if (binding.config?.type === 'event') add(content,'p',`来源：组织根会话中保留的执行记录，创建后开始观察。来源状态 ${binding.source?.status || '未知'}；待处理 ${binding.pendingCount ?? '未知'}。发现前已删除或漏索引的记录可能遗漏；发现后才持久化。${binding.source?.lastError || ''}`);
                if (binding.config?.type === 'event' && binding.source?.lastError === 'receipt_capacity') add(content,'p','历史回执已达容量上限；普通恢复无法释放历史。请先核对未收区间，再撤销并重新绑定新的观察起点；可能存在遗漏。');
                if (binding.config?.type === 'event' && binding.source?.lastError === 'pending_capacity') add(content,'p','待处理队列已满，队列排空后会继续观察。');
                if (binding.config?.type === 'event' && ['source_unavailable','retention_gap'].includes(binding.source?.status)) add(content,'p','来源不可用或可能存在未观察区间；请核对来源和历史后再审阅恢复，不能假设没有遗漏。');
                if (binding.delivery?.status === 'failed' && binding.delivery?.lastError === 'Trigger binding is inactive') add(content,'p','暂停期间错过触发，等待恢复确认。请先恢复责任，再审阅恢复该日程。');
                for (const action of ['revoke','recover']) button(content, `${action} schedule`, () => {
                  if (!root.confirm(`${action} this schedule, version ${binding.version}? This does not establish that work has stopped.`)) return;
                  submitBinding(`/${encodeURIComponent(binding.id)}/${action}`, {confirmed:true,expectedVersion:binding.version,idempotencyKey:root.crypto.randomUUID()});
                });
              }
              button(content,'Review new schedule',() => {
                const scheduledAt=root.prompt('Scheduled time (ISO date and time with timezone)'); if (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt))) return;
                const raw=root.prompt('Repeat interval in minutes (blank for one time)',''); if(raw===null) return;
                const minutes=raw.trim()===''?null:Number(raw); if(minutes!==null&&(!Number.isSafeInteger(minutes)||minutes<1||minutes>525600)) {add(content,'p','Interval must be a whole number from 1 to 525600 minutes.');return;}
                const body={type:'at_time',scheduledAt,confirmed:true,expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID()}; if(minutes!==null)body.intervalMs=minutes*60000;
                if(!root.confirm(`Create a schedule for ${scheduledAt}${minutes===null?'':` every ${minutes} minutes`}? A wake is not proof of execution.`))return;
                submitBinding('',body);
              });
              if (triggerCatalog.features.eventTriggerBridge === true) button(content,'审阅根会话执行结果触发',() => {
                if (!root.confirm('从此绑定创建后开始，尽力观察组织根会话中保留的已结束执行记录；发现前已删除或漏索引的记录可能遗漏，发现后才持久化。此触发不授予额外权限，也不保证执行已启动。确认创建？')) return;
                submitBinding('',{type:'event',eventType:'run_terminal',source:{kind:'root_session'},observeFrom:'binding_created',confirmed:true,expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID()});
              });
            } catch(error) { add(content,'p',`Schedules unavailable: ${error.message}`); }
          }
          if ((detail.policy?.providerId || 'github-ci') === 'github-ci' && detail.policy?.repository && detail.policy?.targetBranch) {
            const panel=add(content,'section','');panel.className='org-report-candidate';
            add(panel,'h4','CI 调查与修复');
            add(panel,'p',`已授权仓库：${detail.policy.repository} · 分支：${detail.policy.targetBranch} · 允许路径：${(detail.policy.allowedPaths || []).join(', ') || '未知'} · 候选范围：${detail.policy.candidateScope || '未知'} · 已注册检查：${detail.policy.checkActionId || '未知'}`);
            add(panel,'p','选择一次失败运行后，服务端会向 GitHub 核对运行、分支、HEAD 与最新状态；记录观察可能唤醒此责任并产生授权范围内的工作。候选、检查、独立审查和 Owner 决定各自保留证据，观察或修复请求不代表检查通过或已验收。');
            const run=document.createElement('input');run.inputMode='numeric';run.placeholder='GitHub Actions 失败运行编号';run.setAttribute('aria-label',run.placeholder);panel.appendChild(run);
            const status=add(panel,'p',''),actions=add(panel,'div','');status.setAttribute('role','status');actions.className='org-report-actions';
            button(actions,'核对并调查失败运行',()=>{
              const runId=run.value.trim();if(!/^\d+$/.test(runId)){status.textContent='请输入数字运行编号。';return;}
              if(!root.confirm(`核对 ${detail.policy.repository} 的失败运行 ${runId} 并在核验成功后请求调查？这会访问 GitHub，可能产生授权范围内的执行用量；不会因此证明修复、检查或验收完成。`))return;
              const body={repository:detail.policy.repository,runId};actions.replaceChildren();
              const submit=async()=>{try{const result=await responsibilityRequest(`${path}/github-event`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});status.textContent=`已记录事件 ${result.eventId || '未知'} 和唤醒 ${result.wakeId || '未知'}；实际调查与结果需刷新核实。`;button(actions,'刷新责任',()=>showResponsibility(id));}catch(error){status.textContent=`核对或请求未确认：${error.message}`;button(actions,'重试同一运行',submit);}};void submit();
            });
          }
          if (detail.policy?.providerId === 'project-report') {
            const zh = String(typeof root.ragentGetActiveUiLanguage === 'function' ? root.ragentGetActiveUiLanguage() : root.navigator?.language || '').toLowerCase().startsWith('zh');
            const label=(en,cn)=>zh?cn:en, section=add(content,'section',''); section.className='org-report-candidate';
            add(section,'h4',label('Project weekly report','项目周报'));
            add(section,'p',label('First run manually and formally accept a report for this responsibility. A weekly schedule can then be enabled explicitly.', '先手动运行并正式验收此责任的报告，之后才能明确启用每周计划。'));
            if (item.lifecycle === 'draft' || item.lifecycle === 'paused') button(section,label('Activate responsibility','启用责任'),async()=>{
              if(!root.confirm(label('Activate this responsibility under its current policy? This does not itself prove a report has run.','按当前策略启用此责任？此操作本身不证明报告已经运行。')))return;
              try{await responsibilityRequest(`${path}/resume`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID(),confirmed:true})});await showResponsibility(id);}catch(error){add(section,'p',`${label('Activation not confirmed','启用未确认')}: ${error.message}`);}
            });
            if (item.lifecycle === 'active') button(section,label('Run report manually','手动运行报告'),async()=>{
              if(!root.confirm(label('Request a manual report under the current scope and budget? This may incur usage; a request does not prove execution.', '按当前范围和预算请求手动运行报告？这可能产生用量；请求不代表已执行。')))return;
              const body={expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID(),confirmed:true};
              const submit=async()=>{try{await responsibilityRequest(`${path}/wake`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});add(section,'p',label('Manual request recorded; refresh to see actual work.','手动请求已记录，请刷新查看实际工作。'));button(section,label('Refresh','刷新'),()=>showResponsibility(id));}catch(error){add(section,'p',`${label('Request not confirmed','请求未确认')}: ${error.message}`);button(section,label('Retry same request','重试同一请求'),submit);}};void submit();
            });

            try {
              const weekly=await responsibilityRequest(`${path}/weekly-report`), base=weekly.baseline;
              if(base) {
                add(section,'p',`${label('Latest accepted version','上一已验收版本')}: ${base.candidateDigest || '—'} · ${label('contract','契约')} ${base.contractRevision ?? '—'} · ${label('execution','执行代次')} ${base.executionEpoch ?? '—'} · ${label('accepted','验收时间')} ${base.acceptedAt || '—'}`);
                add(section,'p',`${label('Source','来源')}: ${base.source || '—'} · ${label('Run','运行')} ${base.runId || '—'} · ${label('packet','结果包')} ${base.packetId || '—'} / ${base.packetDigest || '—'}`);
                add(section,'p',`${label('Accepted baseline for comparison','可用于对比的验收基线')}: ${weekly.comparison?.status === 'available' ? label('available; no change comparison established here','可用；此处未核实变化对比') : label('unavailable','不可比')} · ${weekly.comparison?.reason || '—'}`);
                add(section,'p',label('Report content is a model statement; references, period coverage and changes are only established where supported by the underlying report evidence.', '报告内容是模型陈述；覆盖周期、引用和变化仅在底层报告证据支持时成立。'));
                if(base.report?.visibleText) add(section,'pre',base.report.visibleText);
              } else add(section,'p',`${label('No verified accepted baseline','尚无已核实的验收基线')}: ${weekly.reason || label('unavailable','不可用')}`);
              if (!weekly.eligible) add(section,'p',`${label('Weekly schedule is not available','暂不能启用每周计划')}: ${weekly.reason || label('unverified','未核实')}`);
              else {
                add(section,'p',label('The schedule follows local time in the selected time zone. A nonexistent daylight-saving time is skipped that week; a repeated time uses its first occurrence.', '计划按所选时区的当地时间执行；夏令时切换导致该时间不存在时跳过当周，时间重复时使用第一次。'));
                const form=add(section,'div',''), weekday=document.createElement('select'); weekday.setAttribute('aria-label',label('Day of week','星期'));
                const days=zh?['星期日','星期一','星期二','星期三','星期四','星期五','星期六']:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; days.forEach((day,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=day;weekday.appendChild(option);});form.appendChild(weekday);
                const time=document.createElement('input'); time.type='time';time.required=true;time.setAttribute('aria-label',label('Local time','当地时间'));form.appendChild(time);
                const zone=document.createElement('select'); zone.setAttribute('aria-label',label('Time zone','时区'));const localZone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; let zones=[]; try {zones=Intl.supportedValuesOf('timeZone');}catch{} for(const name of [...new Set([localZone,'UTC',...zones])]){const option=document.createElement('option');option.value=name;option.textContent=name;zone.appendChild(option);} zone.value=localZone;form.appendChild(zone);
                const status=add(section,'p',''); status.setAttribute('role','status'); const actions=add(section,'div','');actions.className='org-report-actions';
                button(actions,label('Enable weekly reports','启用每周报告'),()=>{const match=/^(\d{2}):(\d{2})$/.exec(time.value);if(!match){status.textContent=label('Select a local time.','请选择当地时间。');return;} const body={type:'weekly_report',confirmed:true,idempotencyKey:root.crypto.randomUUID(),expectedVersion:item.rowVersion,weekday:Number(weekday.value),hour:Number(match[1]),minute:Number(match[2]),timeZone:zone.value}; if(!root.confirm(`${label('Enable this weekly schedule? Each run remains subject to the current authorization and limits.','启用此每周计划？每次运行仍受当前授权和限制约束。')}\n${days[body.weekday]} ${time.value} · ${body.timeZone}`))return;actions.replaceChildren();const submit=async()=>{try{const result=await responsibilityRequest(`${path}/trigger-bindings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});status.textContent=`${label('Schedule recorded; next scheduled time','计划已记录；下次计划时间')}: ${result.binding?.nextScheduledAt || result.binding?.config?.nextScheduledAt || result.binding?.config?.scheduledAt || label('unavailable','不可用')}`;button(actions,label('Refresh','刷新'),()=>showResponsibility(id));}catch(error){status.textContent=`${label('Schedule not confirmed','计划未确认')}: ${error.message}`;button(actions,label('Retry same request','重试同一请求'),submit);}};void submit();});
              }
            } catch { add(section,'p',label('Weekly report status is unavailable. No accepted baseline or schedule is assumed.','周报状态不可用，不能假定已有验收基线或计划。')); }
          }
          try {
            const notifications = await responsibilityRequest(`${path}/notifications`);
            add(content, 'h4', 'Responsibility notifications');
            add(content, 'p', `通知选择：${notifications.enabled ? '已开启' : '已关闭'} · 责任运行时：${notifications.runtimeEnabled ? '已启用' : '未启用'} · 推送投递开关：${notifications.deliveryEnabled ? '已开启' : '已关闭'}。这些设置不代表消息已送达或已读。`);
            const cloud=notifications.accountCloudPush || {}, web=notifications.channels?.webPush || {};
            add(content,'p',`Accounts 云推送：${cloud.configured ? '配置就绪' : '配置未齐'} · 当前可用：${notifications.accountCloudPushAvailable ? '是' : '否'} · 账号绑定：${cloud.accountBound ? '是' : '否'} · Accounts 服务：${cloud.accountsConfigured ? '已配置' : '未配置'} · 实例身份：${cloud.instanceReady ? '就绪' : '未就绪'}。`);
            add(content,'p',`Web Push：绑定设备 ${web.bindingCount ?? '未知'} · 推送开关 ${web.deliveryEnabled ? '开启' : '关闭'}。Accounts 接收只表示云服务接受事件，不证明 Firebase 投递或用户已读。`);
            if(cloud.outbox) add(content,'p',`云推送队列：待处理 ${cloud.outbox.pending ?? '未知'} · 已接受 ${cloud.outbox.accepted ?? '未知'} · 已拒绝 ${cloud.outbox.rejected ?? '未知'} · 最近尝试 ${cloud.outbox.lastAttemptAt || '未知'} · 最近结果 ${cloud.outbox.lastResult || '未知'}${cloud.outbox.lastLocalError ? ` · 本地错误 ${cloud.outbox.lastLocalError}` : ''}`);
            if (!notifications.registrationSupported) add(content, 'p', notifications.registrationReason || 'Pair and authenticate this owner device before binding a Web Push subscription.');
            else button(content, 'Bind this device’s Web Push subscription', async () => {
              try {
                if (!root.Notification || !navigator.serviceWorker) throw new Error('Web Push is unavailable in this browser');
                const permission = root.Notification.permission === 'granted' ? 'granted' : await root.Notification.requestPermission();
                if (permission !== 'granted') throw new Error('Notification permission was not granted');
                if (typeof root.setupPushNotifications === 'function') await root.setupPushNotifications();
                const registration = await navigator.serviceWorker.getRegistration();
                const subscription = await registration?.pushManager?.getSubscription();
                if (!subscription) throw new Error('Set up an existing Web Push subscription first');
                await responsibilityRequest('/notification-subscriptions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:subscription.toJSON()})});
                await showResponsibility(id);
              } catch (error) { add(content, 'p', `Subscription not bound: ${error.message}`); }
            });
            button(content, notifications.enabled ? 'Disable responsibility notifications' : 'Review enabling responsibility notifications', async () => {
              const enabled = !notifications.enabled;
              if (!root.confirm(`${enabled ? '开启' : '关闭'}此责任的通知选择？实际渠道仍取决于各自配置和投递状态；服务商接受不代表送达或已读。`)) return;
              try { await responsibilityRequest(`${path}/notifications`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,expectedVersion:notifications.version,idempotencyKey:root.crypto.randomUUID(),confirmed:true})}); await showResponsibility(id); }
              catch (error) { add(content,'p',`Notification setting not confirmed: ${error.message}`); }
            });
            for (const binding of notifications.bindings || []) button(content, `Revoke device ${binding.deviceId}`, async () => {
              if (!root.confirm('Revoke this responsibility notification device binding?')) return;
              try { await responsibilityRequest(`/notification-subscriptions/${encodeURIComponent(binding.subscriptionId)}/revoke`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:binding.version,idempotencyKey:root.crypto.randomUUID(),confirmed:true})}); await showResponsibility(id); }
              catch (error) { add(content,'p',`Revocation not confirmed: ${error.message}`); }
            });
            for (const receipt of notifications.receipts || []) add(content,'p',`${receipt.channel || 'unknown'} · ${receipt.type} · ${receipt.state} · ${receipt.updatedAt}（投递状态，不代表已读）`);
          } catch { add(content, 'p', 'Responsibility notification settings unavailable.'); }
          add(content, 'p', `Policy (not a plan approval): ${JSON.stringify(detail.policy || {})}`);
          if (triggerCatalog?.features?.committedGitChangesOnly === true && ['generic-planner','project-report'].includes(detail.policy?.providerId)) {
            const enabled = detail.policy.committedGitChangesOnly === true;
            add(content,'p',`已提交 Git 版本变化条件：${enabled ? '开启' : '关闭'}。仅周期及时间触发比较本地已提交 HEAD 与分支；未提交、未跟踪、忽略文件及网络资料不在范围内，瞬时 A→B→A 可能漏过。手动唤醒和执行结果触发不受此条件限制；游离 HEAD 或无法读取时等待，不视为无变化。`);
            button(content, enabled ? '审阅关闭 Git 变化条件' : '审阅启用 Git 变化条件', () => {
              if (!root.confirm(`${enabled ? '关闭' : '启用'}此条件？这会更新责任政策，不授予额外工具权限。`)) return;
              const {digest, ...policy} = detail.policy;
              submitCommand('', {policy:{...policy,committedGitChangesOnly:!enabled},expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID()}, 'PATCH');
            });
          }
          try {
            const catalog = await responsibilityRequest(`/capabilities?organizationId=${encodeURIComponent(organizationId)}&projectId=${encodeURIComponent(item.projectId)}`);
            const planner = (catalog.providers || []).find(p => p.id === 'generic-planner' && p.version === 1 && p.available === true);
            const plannerTemplate = planner?.templates?.find(t => t.id === 'ragent-responsibility-planner' && t.version === 1);
            const reportDescriptor = (catalog.planCatalogDescriptors || []).find(d => d.capability === 'project-report' && d.available === true);
            if (planner?.digest && plannerTemplate?.digest && reportDescriptor?.templateDigest) button(content, 'Review planner authorization', async () => {
              const includeReport = root.confirm('Include the project-report capability in this planner catalog?');
              let reportNode = '', reportGeneration = 0;
              if (includeReport) { reportNode = root.prompt('Report node ID'); if (!reportNode) return; reportGeneration = Number(root.prompt('Report node binding generation')); if (!Number.isSafeInteger(reportGeneration) || reportGeneration < 1) return; }
              const maxAttempts = Number(root.prompt('Maximum attempts per step (1–10)')); if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) return;
              const maxCost = Number(root.prompt('Maximum cost per step')); if (!Number.isFinite(maxCost) || maxCost <= 0) return;
              const timeZone = root.prompt('Daily budget IANA timezone'); if (!timeZone) return;
              const dailyInput = root.prompt('Maximum daily cost'); if (dailyInput === null || !dailyInput.trim()) return;
              const dailyCost = Number(dailyInput); if (!Number.isFinite(dailyCost) || dailyCost < 0) return;
              const validUntil = root.prompt('Authorization expiry (ISO date and time with timezone)', detail.policy?.validUntil || ''); if (!validUntil || !Number.isFinite(Date.parse(validUntil))) return;
              const networkPolicy = root.prompt('Network policy: deny, or inherit_existing_permissions (no default)'); if (!['deny','inherit_existing_permissions'].includes(networkPolicy)) return;
              const existing = {validUntil, resource:{projectId:item.projectId,readScope:'entire_project',networkPolicy}, nodeBindings:{report:{nodeId:reportNode,bindingGeneration:reportGeneration}}, maxAttempts,maxCost,dailyBudget:{timeZone,maxCost:dailyCost}};
              const nodeId = root.prompt('Planner node ID'); if (!nodeId) return;
              const generation = Number(root.prompt('Planner node binding generation')); if (!Number.isSafeInteger(generation) || generation < 1) return;
              const entry = {capability:'project-report', templateId:reportDescriptor.templateId, templateVersion:reportDescriptor.templateVersion,
                templateDigest:reportDescriptor.templateDigest, resource:existing.resource, nodeBindings:{report:existing.nodeBindings.report}, maxAttempts:existing.maxAttempts, maxCost:existing.maxCost};
              const policy = {validUntil:existing.validUntil, providerId:planner.id, providerVersion:planner.version, providerDigest:planner.digest,
                templateId:plannerTemplate.id, templateVersion:plannerTemplate.version, templateDigest:plannerTemplate.digest,
                resource:existing.resource, nodeBindings:{planning:{nodeId,bindingGeneration:generation}}, maxAttempts:existing.maxAttempts, maxCost:existing.maxCost,
                dailyBudget:existing.dailyBudget, planCatalog:includeReport ? [entry] : [], planExecutionMaxAttempts:existing.maxAttempts, planExecutionMaxCost:existing.maxCost, planApproval:'always'};
              const codeDescriptor = (catalog.planCatalogDescriptors || []).find(d => d.capability === 'project-code' && d.available === true);
              if (codeDescriptor && root.confirm('Also review a separately bounded project-code capability?')) {
                try {
                  const { baseline } = await responsibilityRequest(`${path}/code-baseline`, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
                  const paths = root.prompt(`Clean project baseline ${baseline.head} on ${baseline.branch}. Allowed project-relative paths, comma separated`); if (!paths) return;
                  const allowedPaths = paths.split(',').map(v => v.trim()).filter(Boolean); if (!allowedPaths.length) return;
                  const candidateScope = root.prompt('Candidate path within allowed paths'); if (!candidateScope) return;
                  const checkActionId = root.prompt('Existing registered check action ID'); if (!checkActionId) return;
                  const nodeBindings = {};
                  for (const key of ['implementation','review','integration']) { const nodeId = root.prompt(`${key} node ID`); if (!nodeId) return; const generation = Number(root.prompt(`${key} node binding generation`)); if (!Number.isSafeInteger(generation) || generation < 1) return; nodeBindings[key] = {nodeId,bindingGeneration:generation}; }
                  const code = {capability:'project-code',templateId:codeDescriptor.templateId,templateVersion:codeDescriptor.templateVersion,templateDigest:codeDescriptor.templateDigest,
                    codeBaselineId:baseline.id,repositoryFactId:baseline.repositoryFactId,repository:baseline.repository,targetBranch:baseline.branch,allowedPaths,candidateScope,checkActionId,nodeBindings,maxAttempts:existing.maxAttempts,maxCost:existing.maxCost};
                  if (!root.confirm(`Authorize code scope separately?\n${JSON.stringify(code,null,2)}\nBaseline HEAD: ${baseline.head}. Code changes and results require human review.`)) return;
                  policy.planCatalog.push(code); if (includeReport) { policy.planExecutionMaxAttempts += existing.maxAttempts; policy.planExecutionMaxCost += existing.maxCost; }
                } catch (error) { add(content, 'p', `Code baseline unavailable: ${error.message}`); return; }
              }
              if (!policy.planCatalog.length) { add(content, 'p', 'Select at least one available capability.'); return; }
              if (existing.resource.networkPolicy === 'inherit_existing_permissions') {
                if (!root.confirm('Separately confirm that the selected planner node retains its existing network and tool permissions? Filesystem read-only does not prevent external effects.')) return;
                policy.networkPermissionConfirmed = true;
              }
              if (includeReport && reportDescriptor.autoEligible === true && root.confirm('Optional: allow automatic admission of eligible report-only plans within this exact policy? Cancel keeps approval required for every plan. Code changes and external publishing still require human approval.')) {
                entry.autoApproval = true; entry.requiresHumanApproval = false;
                policy.planApproval = 'within_policy'; policy.planAutoAdmissionConfirmed = true;
              }
              if (!root.confirm(`Authorize planner and catalog exactly as shown?\n${JSON.stringify(policy, null, 2)}\n${policy.planApproval === 'always' ? 'Each plan requires separate approval.' : 'Only eligible report-only plans may be automatically admitted; code and external publication require human approval.'} Report results still require human review.`)) return;
              submitCommand('', {policy, expectedVersion:item.rowVersion, idempotencyKey:root.crypto.randomUUID()}, 'PATCH');
            });
            const ci = (catalog.providers || []).find(p => p.id === 'github-ci' && p.version === 1 && p.available === true);
            const ciTemplate = ci?.templates?.find(t => t.id === 'ragent-reviewed-change' && t.version === 3);
            if (ciTemplate?.digest) button(content, '审阅 GitHub CI 授权', async () => {
              const panel=add(content,'section','');panel.className='org-report-candidate';
              try {
                const available=await request('/available-checks'), checks=available.checks || [], nodes=(this.projection?.nodes || []).filter(node=>node.id && node.currentBinding?.sessionId && Number.isSafeInteger(node.currentBinding?.generation));
                if(!checks.length || !nodes.length){add(panel,'p','没有可用的已注册检查或已绑定节点；请先完成配置。');return;}
                add(panel,'p','独立授权 CI 调查和受限变更。服务端会核验节点能力、只读审查、仓库及基线；此界面不发起 GitHub 写入。');
                const input=(name,type='text')=>{const el=document.createElement('input');el.type=type;el.placeholder=name;el.setAttribute('aria-label',name);panel.appendChild(el);return el;};
                const repository=input('仓库 owner/name'),branch=input('目标分支'),paths=input('允许的项目相对路径，以逗号分隔'),scope=input('候选范围（位于允许路径内）');
                const check=document.createElement('select');check.setAttribute('aria-label','已注册检查');for(const entry of checks){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.id;check.appendChild(option);}panel.appendChild(check);if(available.truncated)add(panel,'p','检查列表已截断，未显示的检查不能在此选择。');
                const selectors={};for(const [key,title] of [['implementation','实现节点'],['review','只读审查节点'],['integration','集成节点']]){const select=document.createElement('select');select.setAttribute('aria-label',title);for(const node of nodes){const option=document.createElement('option');option.value=node.id;option.textContent=`${title}：${node.displayName || node.id} · ${node.role || '角色未知'}`;select.appendChild(option);}panel.appendChild(select);selectors[key]=select;}
                const attempts=input('最大执行次数（1–10）','number'),cost=input('最高费用','number'),daily=input('每日最高费用','number'),expiry=input('授权到期时间','datetime-local');
                const zone=document.createElement('select');zone.setAttribute('aria-label','预算时区');const local=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';let zones=[];try{zones=Intl.supportedValuesOf('timeZone');}catch{}for(const value of [...new Set([local,'UTC',...zones])]){const option=document.createElement('option');option.value=value;option.textContent=value;zone.appendChild(option);}zone.value=local;panel.appendChild(zone);
                const status=add(panel,'p','');status.setAttribute('role','status');
                button(panel,'审阅并保存 CI 授权',()=>{
                  const allowedPaths=paths.value.split(',').map(v=>v.trim()).filter(Boolean),candidateScope=scope.value.trim(),maxAttempts=Number(attempts.value),maxCost=Number(cost.value),dailyCost=Number(daily.value),validUntil=new Date(expiry.value),nodeBindings={};
                  for(const key of ['implementation','review','integration']){const node=nodes.find(n=>n.id===selectors[key].value);if(node)nodeBindings[key]={nodeId:node.id,bindingGeneration:node.currentBinding.generation};}
                  if(!repository.value.trim()||!branch.value.trim()||!allowedPaths.length||!candidateScope||!check.value||Object.keys(nodeBindings).length!==3||nodeBindings.implementation.nodeId===nodeBindings.review.nodeId||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>10||!Number.isFinite(maxCost)||maxCost<=0||!daily.value||!Number.isFinite(dailyCost)||dailyCost<0||!expiry.value||!Number.isFinite(validUntil.getTime())||validUntil.getTime()<=Date.now()){status.textContent='请填写全部范围、不同的实现和审查节点、有效预算及未来到期时间。';return;}
                  const policy={validUntil:validUntil.toISOString(),repository:repository.value.trim(),templateId:ciTemplate.id,templateVersion:ciTemplate.version,templateDigest:ciTemplate.digest,targetBranch:branch.value.trim(),allowedPaths,candidateScope,checkActionId:check.value,nodeBindings,maxAttempts,maxCost,dailyBudget:{timeZone:zone.value,maxCost:dailyCost}};
                  if(!root.confirm(`保存此 CI 授权？\n${JSON.stringify(policy,null,2)}\n候选、检查、独立审查及 Owner 决定均需分别核验。保存本身不会向 GitHub 写入。`))return;
                  submitCommand('',{policy,expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID()},'PATCH');
                });
              } catch(error){add(panel,'p',`无法读取检查目录：${error.message}`);}
            });
            const provider = (catalog.providers || []).find(p => p.id === 'project-report' && p.version === 1 && p.available === true);
            const template = provider?.templates?.find(t => t.id === 'ragent-project-report' && t.version === 1);
            if (provider?.digest && template?.digest) button(content, '审阅项目报告授权', () => {
              const panel=add(content,'section','');panel.className='org-report-candidate';
              add(panel,'p','此报告读取整个项目，项目文件写入受阻。请选择执行节点与网络边界；节点授权和运行时能力由服务端再次核验。继承现有网络与工具权限时，不承诺网络隔离。');
              const nodes=(this.projection?.nodes || []).filter(node=>node.id && node.currentBinding?.sessionId && Number.isSafeInteger(node.currentBinding?.generation));
              if(!nodes.length){add(panel,'p','当前没有可供选择的已绑定节点，无法准备授权。');return;}
              const nodeSelect=document.createElement('select');nodeSelect.setAttribute('aria-label','报告执行节点');for(const node of nodes){const option=document.createElement('option');option.value=node.id;option.textContent=`${node.displayName || node.id} · ${node.role || '角色未知'}`;nodeSelect.appendChild(option);}panel.appendChild(nodeSelect);
              const input=(label,type)=>{const el=document.createElement('input');el.type=type;el.placeholder=label;el.setAttribute('aria-label',label);panel.appendChild(el);return el;};
              const attempts=input('最多执行次数（1–10，含首份）','number');attempts.min='1';attempts.max='10';
              const cost=input('单次责任最高费用','number');cost.min='0';cost.step='any';
              const daily=input('每日最高费用','number');daily.min='0';daily.step='any';
              const expiry=input('授权到期时间','datetime-local');
              const zone=document.createElement('select');zone.setAttribute('aria-label','预算时区');const localZone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';let zones=[];try{zones=Intl.supportedValuesOf('timeZone');}catch{}for(const value of [...new Set([localZone,'UTC',...zones])]){const option=document.createElement('option');option.value=value;option.textContent=value;zone.appendChild(option);}zone.value=localZone;panel.appendChild(zone);
              const network=document.createElement('select');network.setAttribute('aria-label','网络边界');for(const [value,title] of [['deny','拒绝网络（运行时须支持）'],['inherit_existing_permissions','继承现有网络和工具权限']]){const option=document.createElement('option');option.value=value;option.textContent=title;network.appendChild(option);}panel.appendChild(network);
              const status=add(panel,'p','');status.setAttribute('role','status');
              button(panel,'审阅并保存授权',()=>{
                const selected=nodes.find(node=>node.id===nodeSelect.value),maxAttempts=Number(attempts.value),maxCost=Number(cost.value),dailyCost=Number(daily.value),validUntil=new Date(expiry.value);
                if(!selected || !Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>10||!Number.isFinite(maxCost)||maxCost<=0||!daily.value||!Number.isFinite(dailyCost)||dailyCost<0||!expiry.value||!Number.isFinite(validUntil.getTime())||validUntil.getTime()<=Date.now()){status.textContent='请填写节点、有效次数、费用及未来的到期时间。';return;}
                const networkPolicy=network.value;
                const policy={validUntil:validUntil.toISOString(),providerId:provider.id,providerVersion:provider.version,providerDigest:provider.digest,templateId:template.id,templateVersion:template.version,templateDigest:template.digest,resource:{projectId:item.projectId,readScope:'entire_project',networkPolicy},nodeBindings:{report:{nodeId:selected.id,bindingGeneration:selected.currentBinding.generation}},maxAttempts,maxCost,dailyBudget:{timeZone:zone.value,maxCost:dailyCost},...(networkPolicy==='inherit_existing_permissions'?{networkPermissionConfirmed:true}:{})};
                if(!root.confirm(`授权此报告策略？\n项目：${item.projectId}；读取整个项目\n节点：${selected.displayName || selected.id}\n网络：${network.options[network.selectedIndex].textContent}\n最多执行：${maxAttempts}；最高费用：${maxCost}；每日上限：${dailyCost}（${zone.value}）\n到期：${validUntil.toLocaleString()}\n输出仍需正式验收；此授权不等于已运行。`))return;
                submitCommand('',{policy,expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID()},'PATCH');
              });
            });
          } catch { /* unavailable catalog never grants authority */ }
          add(content, 'h4', 'Plans awaiting review');
          try {
            const plans = await responsibilityRequest(`${path}/plans`);
            for (const plan of plans.plans || []) {
              add(content, 'p', `${plan.state} · ${JSON.stringify(plan.summary || {})} · digest ${plan.proposalDigest}`);
              for (const step of plan.proposal?.steps || []) add(content, 'p', `Step ${step.id}: ${step.objective || step.templateId} · depends on ${JSON.stringify(step.dependsOn || [])} · scope and budget ${JSON.stringify(step.scope || step.resource || {})} ${JSON.stringify(step.budget || {})} · approval ${step.requiresHumanApproval ?? 'see policy'}`);
              if (plan.proposal) add(content, 'pre', JSON.stringify(plan.proposal, null, 2));
              if (plan.catalog) add(content, 'pre', `Authorized catalog and bounds:\n${JSON.stringify(plan.catalog, null, 2)}`);
              if (!plan.proposal || !Array.isArray(plan.catalog)) add(content, 'p', 'Full proposal or authorized catalog unavailable; approval is disabled.');
              if (plan.state === 'pending_review' && plan.proposal && Array.isArray(plan.catalog) && plan.proposalDigest) button(content, 'Approve this reviewed plan', async () => {
                if (!root.confirm(`Approve only plan ${plan.id} at digest ${plan.proposalDigest} and responsibility version ${item.rowVersion}?`)) return;
                const body = { expectedVersion:item.rowVersion, proposalDigest:plan.proposalDigest, idempotencyKey:root.crypto.randomUUID(), confirmed:true };
                try { await responsibilityRequest(`${path}/plans/${encodeURIComponent(plan.id)}/approve`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); await showResponsibility(id); }
                catch (error) { add(content, 'p', `Plan approval not confirmed: ${error.message}. Refresh before retrying.`); }
              });
            }
          } catch { add(content, 'p', 'Plan review is unavailable.'); }
          add(content, 'h4', 'Success criteria');
          for (const criterion of item.successCriteria || []) add(content, 'p', criterion);
          add(content, 'h4', 'Activity');
          for (const entry of activity.activity || []) {
            const message = entry.type === 'budget_blocked' ? `预算准入被拒绝；不表示执行失败或已扣费。工作 ${entry.details?.workItemId || '未知'} · 执行代次 ${entry.details?.executionEpoch ?? '未知'} · 绑定 ${entry.details?.bindingId || '未知'}` : entry.type === 'execution_attempt_failed' ? `一次执行尝试已核实失败，不代表整个责任失败。工作 ${entry.details?.workItemId || '未知'} · 执行代次 ${entry.details?.executionEpoch ?? '未知'} · 绑定 ${entry.details?.bindingId || '未知'}` : entry.type === 'committed_git_unchanged' ? '已提交 Git 版本未变化，本次周期规划已跳过。' : entry.type === 'committed_git_changed_before_admission' ? '规划前后 Git 版本发生变化，本次未准入；需要重新观察。' : entry.type === 'decision_waiting' && entry.details?.reason === 'committed_git_observation_unavailable' ? '无法核实已提交 Git 版本，等待处理；不视为无变化。' : `${entry.type} · ${JSON.stringify(entry.details || {})}`;
            add(content, 'p', `${entry.createdAt} · ${message}`);
          }
          if (!activity.activity?.length) add(content, 'p', 'No activity recorded.');
          // Observe only while this owner view is open. The initial drain is a
          // baseline, so historical activity is never replayed as a notification.
          const observer = { stopped:false, cursor:activity.nextCursor || 0 };
          responsibilityObserver = observer;
          const important = new Set(['plan_proposed','planning_needs_input','planning_invalid_output','plan_admission_blocked','planning_evidence_blocked']);
          const observe = async initial => {
            if (observer.stopped || responsibilityObserver !== observer || screen.hidden || this.projection?.organizationId !== organizationId) return;
            let baselineComplete = !initial;
            try {
              let page, pages = 0;
              do {
                page = await responsibilityRequest(`${path}/activity?after=${observer.cursor}&limit=200`);
                if (observer.stopped || responsibilityObserver !== observer || screen.hidden) return;
                for (const entry of page.activity || []) {
                  if (!initial && important.has(entry.type)) root.showSystemToast?.(`Responsibility: ${entry.type.replaceAll('_',' ')}. Open activity for details.`);
                  observer.cursor = Math.max(observer.cursor, Number(entry.sequence) || 0);
                }
                pages++;
              } while ((page.activity || []).length === 200 && pages < 10);
              if ((page.activity || []).length === 200) { observer.stopped = true; add(content, 'p', 'Live activity unavailable: too much history to establish a safe cursor.'); return; }
              baselineComplete = true;
            } catch { /* Retry without advancing past unseen events. */ }
            if (!observer.stopped) root.setTimeout?.(() => observe(!baselineComplete), 20000);
          };
          observe(true);
          const submitCommand = (action, body, method = 'POST') => {
            const path = `/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
            const submit = async () => { try {
              const result = await responsibilityRequest(path, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
              add(content, 'p', action === 'wake' ? 'Wake recorded; execution is not implied.' : `Request recorded. Actual stop is not established. Stop requests: ${JSON.stringify(result.stop || {})}`);
              button(content, 'Refresh', () => showResponsibility(id));
            } catch (error) { add(content, 'p', `Request not confirmed: ${error.message}`); button(content, 'Retry same request', submit); } };
            submit();
          };
          button(content, 'Edit objective', () => {
            const objective = root.prompt('New objective', item.objective); if (!objective || objective === item.objective) return;
            if (!root.confirm(`Change objective for ${item.id}, version ${item.rowVersion}?\n${objective}`)) return;
            submitCommand('', { objective, expectedVersion:item.rowVersion, idempotencyKey:root.crypto.randomUUID() }, 'PATCH');
          });
          for (const action of ['pause', 'resume', 'wake', 'complete', 'cancel', 'archive']) button(content, action, () => {
            if (!root.confirm(action === 'complete' ? `Confirm the objective of responsibility ${item.id} is achieved? Version ${item.rowVersion}. Existing work is not stopped by this command.` : `${action} responsibility ${item.id}, version ${item.rowVersion}? Existing work is not stopped by this command.`)) return;
            submitCommand(action, { expectedVersion:item.rowVersion, idempotencyKey:root.crypto.randomUUID(), confirmed:true });
          });
          for (const action of ['pause', 'cancel']) button(content, `${action} and request stop`, () => {
            if (!root.confirm(`${action} this responsibility and request cancellation of eligible existing work? A request does not establish that execution has stopped.`)) return;
            submitCommand(action, {expectedVersion:item.rowVersion,idempotencyKey:root.crypto.randomUUID(),confirmed:true,stopExisting:true});
          });
          button(content, 'Review command text', async () => {
            const text = root.prompt('Command text for this responsibility'); if (!text) return;
            try {
              const proposal = await responsibilityRequest('/intent', { method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ text, responsibilityId:id }) });
              if (proposal.action === 'query') { await showResponsibility(id); return; }
              if (!['pause', 'resume', 'wake'].includes(proposal.action)) { add(content, 'p', `Text for manual review: ${text}`); return; }
              if (!root.confirm(`Review ${proposal.action} for ${proposal.objective}, version ${proposal.expectedVersion}? Existing work is not stopped.`)) return;
              submitCommand(proposal.action, { expectedVersion:proposal.expectedVersion, idempotencyKey:root.crypto.randomUUID() });
            } catch (error) { add(content, 'p', `Unable to interpret text: ${error.message}`); }
          });
          const openMemoryGovernance = async () => {
            try {
              const encoded = encodeURIComponent(id);
              const [context, conflicts, userMemory, episodicMemory, auditData] = await Promise.all([
                responsibilityRequest(`/${encoded}/memory`),
                responsibilityRequest(`/${encoded}/memory/conflicts`).catch(() => ({ groups: [], semanticCandidates: [], version: 0 })),
                responsibilityRequest(`/${encoded}/memory/user?includeInactive=1&includeExpired=1`).catch(() => ({ facts: [] })),
                responsibilityRequest(`/${encoded}/memory/episodes`).catch(() => ({ episodes: [] })),
                responsibilityRequest(`/${encoded}/memory/audit`).catch(() => ({ audit: [] })),
              ]);
              this.renderResponsibilityMemoryPanel(content, {
                responsibilityId: id,
                context,
                conflicts,
                userMemory,
                episodicMemory,
                auditData,
                responsibilityRequest,
                onBack: () => showResponsibility(id),
                onReload: openMemoryGovernance,
              });
            } catch (error) { add(content, 'p', `Memory unavailable: ${error.message}`); }
          };
          button(content, 'Memory & governance', openMemoryGovernance);
          button(content, 'Refresh', () => showResponsibility(id));
        } catch (error) { content.replaceChildren(); add(content, 'p', `Responsibility unavailable: ${error.message}`); button(content, 'Responsibilities', showResponsibilities); }
      };
      const showItem = async (id, reportCandidateId = '') => {
        content.replaceChildren(); add(content, 'p', 'Loading…');
        try {
          const { item, asOf } = await request(`/work-items/${encodeURIComponent(id)}${reportCandidateId ? `?reportCandidateId=${encodeURIComponent(reportCandidateId)}` : ''}`);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          content.replaceChildren(); button(content, 'All work items', showList);
          add(content, 'h3', item.contract?.objective || item.id);
          add(content, 'p', `State ${item.state}; control ${item.controlState}; priority ${item.priority}; version ${item.rowVersion}; contract ${item.contractRevision}; as of ${asOf}`);
          const recoveryPanel=add(content,'section',''); recoveryPanel.className='org-report-candidate';
          add(recoveryPanel,'h4','工作状态与恢复');
          add(recoveryPanel,'p','此处只读取已记录状态；请求停止、提供商回执和人工核实是不同事实。打开页面不会派发工作。');
          const reconcileStatus=add(recoveryPanel,'p','正在读取执行与停止状态…');reconcileStatus.setAttribute('role','status');
          const budgetStatus=add(recoveryPanel,'p','正在读取用量与预留…');
          const reconcileActions=add(recoveryPanel,'div','');reconcileActions.className='org-report-actions';

          if (item.controlState === 'cancel_requested') add(content, 'p', 'Cancellation requested — stop is NOT confirmed until a Run cancellation or terminal receipt is verified.');
          else if (item.blockedReason?.code === 'completed_pending_review') add(content, 'p', 'Run completed before stop — pending review, NOT cancelled.');
          else if (item.blockedReason?.code === 'stopped' || item.state === 'cancelled') add(content, 'p', 'Execution confirmed stopped / cancelled.');
          {
            const zh = String(typeof root.ragentGetActiveUiLanguage === 'function' ? root.ragentGetActiveUiLanguage() : root.navigator?.language || '').toLowerCase().startsWith('zh');
            const label = (en, cn) => zh ? cn : en;
            const panel = add(content, 'section', ''); panel.className = 'org-report-candidate';
            add(panel, 'h4', label('Execution and independent review', '执行与独立审查'));
            add(panel, 'p', label('Review opinions are not owner acceptance. A recorded receipt alone does not establish that the review context remains current.', '审查意见不等于 Owner 验收。已记录回执本身不能证明审查上下文仍然有效。'));
            const runtimeText = runtime => {
              if (!runtime || runtime.state === 'unavailable') return label('unavailable', '不可核实');
              return `${label('Run', '运行')} ${runtime.runId || '—'} · Harness ${runtime.tool || label('unknown', '未知')} · ${label('provider', '提供方')} ${runtime.provider || label('unknown', '未知')} · ${label('session', '会话')} ${runtime.sessionId || '—'} · ${label('state', '状态')} ${runtime.state || label('unknown', '未知')}`;
            };
            const binding = (item.bindings || []).find(entry => entry.contractRevision === item.contractRevision && entry.executionEpoch === item.executionEpoch && entry.bindingGeneration === item.bindingGeneration);
            add(panel, 'p', `${label('Assigned node', '指派节点')}: ${item.assigneeNodeId || label('unknown', '未知')} · ${label('execution binding', '执行绑定')}: ${binding?.status || label('unavailable', '不可用')} · ${label('Run', '运行')}: ${binding?.runId || label('unknown', '未知')}`);
            add(panel, 'p', `${label('Contract target', '契约目标')}: ${item.contract?.resource?.projectId || item.projectId || label('unknown', '未知')} · ${label('branch', '分支')}: ${item.contract?.targetBranch || label('not specified', '未指定')} · ${label('access', '访问方式')}: ${item.contract?.accessMode || label('unknown', '未知')} · ${label('paths', '路径')}: ${Array.isArray(item.contract?.allowedPaths) ? item.contract.allowedPaths.join(', ') || label('none', '无') : label('unknown', '未知')}`);
            const handoff = item.reviewHandoff;
            if (handoff) {
              add(panel, 'p', `${label('Review handoff', '审查交接')}: ${handoff.state === 'current' ? label('current context verified', '已核实为当前上下文') : label('unavailable or no longer current', '不可核实或已不再为当前')} · ${label('candidate', '候选')} ${handoff.candidate?.workItemId || '—'} / ${handoff.candidate?.digest || '—'} · ${label('contract', '契约')} ${handoff.candidate?.contractRevision ?? '—'} · ${label('execution', '执行代次')} ${handoff.candidate?.executionEpoch ?? '—'}`);
              add(panel, 'p', `${label('Author execution', '原作者执行')}: ${runtimeText(handoff.candidate?.runtime)}`);
              add(panel, 'p', `${label('Reviewer', '审查者')}: ${handoff.reviewer?.nodeId || label('unknown', '未知')} · ${label('access', '访问方式')} ${handoff.reviewer?.accessMode || label('unknown', '未知')} · ${label('binding generation', '绑定代次')} ${handoff.reviewer?.bindingGeneration ?? '—'} · ${runtimeText(handoff.reviewer?.runtime)}`);
              add(panel, 'p', label('A current handoff does not establish that a review ran or that execution moved between devices.', '交接为当前不代表审查已经运行，也不代表执行已在设备间迁移。'));
              if (handoff.candidate?.workItemId && handoff.candidate.workItemId !== item.id) button(panel,label('Open candidate work','打开候选工作'),()=>showItem(handoff.candidate.workItemId));
            }
            const reviewWork = Array.isArray(item.reviewWorkItems) ? item.reviewWorkItems : [];
            for (const review of reviewWork) {
              const match = !!review.candidateDigest && review.candidateDigest === item.candidateDigest;
              add(panel, 'p', `${label('Linked review work', '关联审查工作')}: ${review.workItemId || '—'} · ${label('state', '状态')} ${review.state || '—'} · ${label('control', '控制状态')} ${review.controlState || '—'} · ${label('reviewer node', '审查节点')} ${review.nodeId || '—'} · ${label('candidate binding', '候选绑定')} ${review.candidateDigest || label('not pinned', '未固定')} · ${match ? label('matches current candidate', '与当前候选一致') : label('not established for current candidate', '未确认属于当前候选')}`);
              if (review.workItemId) button(panel, label('Open linked review work', '打开关联审查工作'), () => showItem(review.workItemId));
            }
            if (item.reviewWorkItemsTruncated) add(panel, 'p', label('Additional linked review work exists; this view is limited to 20.', '还有更多关联审查工作；此处最多显示 20 项。'));
            if (!reviewWork.length) {
              add(panel, 'p', label('No linked review work is shown. A reviewed-change responsibility creates a separate workflow; it does not automatically review this existing candidate.', '未显示关联审查工作。reviewed-change 责任会创建独立工作流，不会自动审查此已有候选。'));
              button(panel, label('Find reviewed-change authorization', '查找受控变更授权'), () => item.reportAuthority?.responsibilityId ? showResponsibility(item.reportAuthority.responsibilityId) : showResponsibilities());
              const reviewerNodes = (this.projection?.nodes || []).filter(node => node.id && node.id !== item.assigneeNodeId);
              if (item.kind === 'execution' && item.state === 'review' && item.controlState === 'none' && item.candidateDigest && Array.isArray(item.contract?.allowedPaths) && item.contract.allowedPaths.length && reviewerNodes.length && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner') {
                button(panel, label('Prepare review of this candidate', '准备审查此候选'), () => {
                  const form=add(panel,'section',''); form.className='org-report-candidate';
                  add(form,'p',label('Choose a different node. Eligibility, independent identity, read/run/review grants, no write access and runtime availability cannot be established by this selector; the server rechecks them. Responsibility-owned work may require its existing authorization.', '请选择不同节点。此选择器不能证明独立身份、read/run/review 授权、无写入权限或运行时可用性；服务端会重新核验。责任所属工作可能需要其既有授权。'));
                  const select=document.createElement('select'); select.setAttribute('aria-label',label('Reviewer node','审查节点')); for(const node of reviewerNodes) {const option=document.createElement('option'); option.value=node.id; option.textContent=node.displayName || node.id; select.appendChild(option);} form.appendChild(select);
                  const attempts=document.createElement('input'); attempts.type='number'; attempts.min='1'; attempts.max='10'; attempts.placeholder=label('Maximum attempts (1–10)','最多执行次数（1–10）'); attempts.setAttribute('aria-label',attempts.placeholder); form.appendChild(attempts);
                  const cost=document.createElement('input'); cost.type='number'; cost.min='0'; cost.step='any'; cost.placeholder=label('Maximum cost','最高费用'); cost.setAttribute('aria-label',cost.placeholder); form.appendChild(cost);
                  const status=add(form,'p',''); status.setAttribute('role','status'); const actions=add(form,'div',''); actions.className='org-report-actions';
                  button(actions,label('Review proposal','审阅草案'),()=>{
                    const maxAttempts=Number(attempts.value),maxCost=Number(cost.value); if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>10||!Number.isFinite(maxCost)||maxCost<=0){status.textContent=label('Enter an attempt limit and a positive cost.','请输入执行次数上限和大于零的费用上限。');return;}
                    const contract={objective:item.contract.objective,accessMode:'read',allowedPaths:item.contract.allowedPaths,acceptanceCriteria:[{id:'review-recorded',method:'manual'}],retry:{maxAttempts},budget:{maxCost},budgetReservation:{cost:maxCost/maxAttempts},...(item.contract.targetBranch?{targetBranch:item.contract.targetBranch}:{}),...(item.contract.candidateScope?{candidateScope:item.contract.candidateScope}:{})};
                    if(!root.confirm(`${label('Create a proposed read-only review for this exact candidate? It will not run until separately approved, and eligibility remains subject to server checks.','为此精确候选创建只读审查草案？须另行批准才可运行，资格仍需服务端核验。')}\n${label('Candidate','候选')}: ${item.id} / ${item.candidateDigest}\n${label('Reviewer','审查者')}: ${select.value}\n${JSON.stringify(contract,null,2)}`)) return;
                    const commandId=root.crypto.randomUUID(),body={type:'CreateWorkItem',commandId,idempotencyKey:commandId,payload:{goalId:item.goalId,kind:'review',assigneeNodeId:select.value,contract,dependencies:[{predecessorId:item.id,milestone:'candidate_ready',candidateDigest:item.candidateDigest}]}}; actions.replaceChildren();
                    const submit=async()=>{try{const result=await requestWithTimeout('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!result.item?.id)throw new Error('Work item ID unavailable');await showItem(result.item.id);}catch(error){actions.replaceChildren();status.textContent=`${label('Proposal not confirmed','草案未确认')}: ${error.message}`;if(!error.status||error.status>=500)button(actions,label('Retry same request','重试同一请求'),submit);else button(actions,label('Refresh','刷新'),()=>showItem(item.id));}};void submit();
                  });
                });
              }
            }
            const opinions = Array.isArray(item.reviewOpinions) ? item.reviewOpinions : [];
            if (!opinions.length) add(panel, 'p', label('No recorded independent review opinion is available for this work.', '此工作暂无可用的已记录独立审查意见。'));
            for (const opinion of opinions) {
              const entry=add(panel,'section',''); entry.className='org-report-candidate';
              const candidate=opinion.candidate || {}, reviewer=opinion.reviewer || {};
              add(entry,'p',`${label('Candidate', '候选')}: ${candidate.workItemId || '—'} · ${candidate.digest || '—'} · ${label('contract', '契约')} ${candidate.contractRevision ?? '—'} · ${label('execution', '执行代次')} ${candidate.executionEpoch ?? '—'}`);
              add(entry,'p',`${label('Author execution', '原作者执行')}: ${runtimeText(candidate.runtime)}`);
              add(entry,'p',`${label('Independent reviewer', '独立审查者')}: ${reviewer.nodeId || label('unknown', '未知')} · ${label('work', '工作项')} ${reviewer.workItemId || '—'} · ${runtimeText(reviewer.runtime)}`);
              add(entry,'p',`${label('Opinion', '意见')}: ${opinion.verdict || label('unknown', '未知')} · ${opinion.reason || '—'}`);
              add(entry,'p',`${label('Review receipt', '审查回执')}: ${opinion.verification === 'receipt_recorded' ? label('recorded', '已记录') : label('pending run verification', '等待运行核实')} · ${label('current context', '当前上下文')}: ${opinion.currentContext === 'current' ? label('verified current', '已核实为当前') : label('unavailable or no longer current', '不可核实或已不再为当前')} · ${label('packet', '结果包')}: ${opinion.receipt?.packetId || '—'} · ${opinion.receipt?.packetDigest || '—'}`);
              add(entry,'p',`${label('Allowed paths in candidate contract', '候选契约允许路径')}: ${Array.isArray(candidate.allowedPaths) ? candidate.allowedPaths.join(', ') || label('none', '无') : label('unknown', '未知')}`);
              if (candidate.workItemId && candidate.workItemId !== item.id) button(entry,label('Open candidate work','打开候选工作'),()=>showItem(candidate.workItemId));
              if (reviewer.workItemId && reviewer.workItemId !== item.id) button(entry,label('Open review work','打开审查工作'),()=>showItem(reviewer.workItemId));
            }
            if(item.reviewOpinionsTruncated) add(panel,'p',label('Additional review opinions exist; this view is limited to the latest 20.','还有更多审查意见；此处最多显示最近 20 条。'));
            add(panel,'p',label('Device and target environment are not established by these review records. Check the work contract, device workspace and actual run before relying on capability or availability.', '这些审查记录不证明设备或目标环境。请核对工作契约、设备工作台及实际运行，再判断能力或可用性。'));
            button(panel,label('Open device workspace','打开设备工作台'),()=>root.RagentCrossDevicePanel?.open?.({view:'devices'}));
          }
          const revisionShortcuts = [];
          const reports = (item.candidates || []).filter(candidate => candidate.report);
          if (Array.isArray(item.validationWorkItems) || Array.isArray(item.checks)) {
            const panel=add(content,'section','');panel.className='org-report-candidate'; add(panel,'h4','候选检查');
            add(panel,'p','下列关联来自候选依赖和已记录工作区。工作区记录不代表当前已验签；只有带提供商退出码和工作目录的检查证据才支持检查结论。');
            for(const work of item.validationWorkItems || []) {
              const matches=!!work.candidateDigest && work.candidateDigest===item.candidateDigest;
              add(panel,'p',`验证工作 ${work.workItemId} · 状态 ${work.state || '未知'} / ${work.controlState || '未知'} · 候选 ${work.candidateDigest || '未固定'}（${matches?'匹配当前候选':'未确认匹配当前候选'}） · 运行 ${work.runId || '未知'} · 工作区 ${work.workspace?.id || '不可用'} / ${work.workspace?.state || '未知'} / ${work.workspace?.provenance || '未知'}`);
              button(panel,'打开验证工作',()=>showItem(work.workItemId));
              if(matches && work.state==='running' && work.workspace?.state==='sealed' && work.workspace?.provenance==='candidate_materialized' && item.state==='review' && root.__RAGENT_BOOTSTRAP__?.auth?.role==='owner') for(const criterion of (item.contract?.acceptanceCriteria || []).filter(c=>c.method==='check' && c.actionId)) button(panel,`登记检查 ${criterion.description || criterion.id}`,()=>{
                if(!root.confirm(`为候选 ${item.candidateDigest} 和验证工作 ${work.workItemId} 登记已配置检查 ${criterion.actionId}？登记不启动命令，也不代表检查通过。`))return;
                const body={validationWorkItemId:work.workItemId,candidateDigest:item.candidateDigest,criterionId:criterion.id,actionId:criterion.actionId};const receipt=add(panel,'p','');
                const submit=async()=>{try{const result=await request(`/work-items/${encodeURIComponent(item.id)}/checks/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});receipt.textContent=`检查登记：${result.checkId} · ${result.state}；请刷新后核对提供商回执。`;button(panel,'刷新检查',()=>showItem(item.id));}catch(error){receipt.textContent=`检查登记未确认：${error.message}`;button(panel,'重试登记',submit);}};void submit();
              });
            }
            if(item.validationWorkItemsTruncated) add(panel,'p','还有更多验证工作，此处最多显示 20 项。');
            for(const check of item.checks || []) {
              const current=check.candidateDigest===item.candidateDigest;
              add(panel,'p',`检查 ${check.checkId} · 标准 ${check.criterionId} · 动作 ${check.actionId} · 状态 ${check.state} · 候选 ${check.candidateDigest}（${current?'当前':'历史'}） · 提供商证据 ${check.evidence ? `运行 ${check.evidence.runId || '未知'} / 退出码 ${check.evidence.exitCode ?? '未知'} / 工作区 ${check.evidence.workspaceId || '未知'}` : '未取得'}`);
              button(panel,'核对检查回执',async()=>{const status=add(panel,'p','正在核对…');try{const result=await request(`/checks/${encodeURIComponent(check.checkId)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});status.textContent=`核对状态：${result.state} · ${result.reason || ''}。请刷新查看已记录证据。`;button(panel,'刷新检查',()=>showItem(item.id));}catch(error){status.textContent=`无法核对：${error.message}`;}});
              if(current && check.state==='passed' && check.evidence && item.state==='review' && root.__RAGENT_BOOTSTRAP__?.auth?.role==='owner') button(panel,'记录检查标准通过',()=>{
                if(!root.confirm(`为当前候选记录已核实检查 ${check.checkId} 的标准通过？服务端将再次核验证据。`))return;
                const commandId=root.crypto.randomUUID(),body={checkId:check.checkId,criterionId:check.criterionId,commandId,idempotencyKey:commandId,expectedVersion:item.rowVersion,contractRevision:item.contractRevision,gateGeneration:item.gateGeneration,candidateDigest:item.candidateDigest};const status=add(panel,'p','');
                const submit=async()=>{try{await requestWithTimeout(`/work-items/${encodeURIComponent(item.id)}/checks/accept`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await showItem(item.id);}catch(error){status.textContent=`检查决定未确认：${error.message}`;if(!error.status||error.status>=500)button(panel,'重试同一决定',submit);else button(panel,'刷新',()=>showItem(item.id));}};void submit();
              });
            }
            if(item.checksTruncated) add(panel,'p','还有更多检查，此处最多显示 20 项。');
          }
          if (item.reportComparison) {
            const comparison=item.reportComparison, section=add(content,'section','');section.className='org-report-candidate';
            add(section,'h4','本次执行固定的上一已验收版本');
            if (comparison.status === 'available' && comparison.baseline) {
              const base=comparison.baseline;
              add(section,'p',`候选 ${base.candidateDigest || '未知'} · 契约 ${base.contractRevision ?? '未知'} · 执行代次 ${base.executionEpoch ?? '未知'} · 验收 ${base.acceptedAt || '未知'} · 结果包 ${base.packetId || '未知'} / ${base.packetDigest || '未知'} · 采集时间 ${base.capturedAt || '未知'}`);
              add(section,'p','这是执行前固定的上一份 Owner 正式验收基线。系统未核实逐项变化；覆盖周期、引用和风险仅是报告中的模型陈述，缺少证据时不可确认为事实。');
              if(base.report?.visibleText) add(section,'pre',base.report.visibleText);
              if (base.report?.declaration?.status === 'valid') {
                for (const [field,title] of [['risks','基线模型声明的风险'],['blockers','基线模型声明的阻塞'],['unresolvedItems','基线模型声明的待决定项']]) {
                  const entries=base.report.declaration[field];
                  add(section,'p',title);
                  if (!Array.isArray(entries)) add(section,'p','未知：该字段不可用。');
                  else if (!entries.length) add(section,'p','模型未列出条目；不证明不存在。');
                  else for (const entry of entries) add(section,'p',typeof entry === 'string' ? entry : JSON.stringify(entry));
                }
                add(section,'p','下方当前候选的模型声明可供对照；系统未判定这些条目是否解决或变化。');
              } else add(section,'p','基线的结构化风险、阻塞和待决定项不可用或未核实。');
              if(base.report?.truncated) add(section,'p','基线正文已截断；请打开原工作查看完整报告。');
              if(base.workItemId) button(section,'打开已验收基线工作',()=>showItem(base.workItemId));
            } else add(section,'p',`不可比较：${comparison.reason || '基线不可核实'}。不将最近一次运行当作已验收版本。`);
          }
          const reportHistory = item.contract?.resource?.readScope === 'entire_project' ? (item.candidates || []).filter(candidate => candidate.id && !candidate.report) : [];
          if (reports.length || reportHistory.length) {
            const zh = String(typeof root.ragentGetActiveUiLanguage === 'function' ? root.ragentGetActiveUiLanguage() : root.navigator?.language || '').toLowerCase().startsWith('zh');
            const label = (en, cn) => zh ? cn : en;
            add(content, 'h4', label('Project reports', '项目报告'));
            add(content, 'p', label('A report is a candidate for review. Reading it or approving execution does not accept it.', '报告是待审阅的候选结果。已读或执行审批不等于正式验收。'));
            for (const candidate of reportHistory) {
              button(content, `${label('Load candidate report', '加载候选报告')} · ${candidate.digest || candidate.id} · ${label('contract', '契约')} ${candidate.contractRevision ?? '—'} · ${label('execution', '执行代次')} ${candidate.executionEpoch ?? '—'}`, () => showItem(id, candidate.id));
            }
            for (const candidate of reports) {
              const report = candidate.report;
              const section = add(content, 'section', '');
              section.className = 'org-report-candidate';
              const current = candidate.digest === item.candidateDigest && candidate.contractRevision === item.contractRevision && candidate.executionEpoch === item.executionEpoch;
              add(section, 'h4', current ? label('Current candidate', '当前候选') : label('Earlier candidate', '历史候选'));
              add(section, 'p', `${label('Candidate', '候选')}: ${candidate.digest || label('unavailable', '不可用')} · ${label('Contract version', '契约版本')}: ${candidate.contractRevision ?? '—'} · ${label('Execution', '执行代次')}: ${candidate.executionEpoch ?? '—'}`);
              add(section, 'p', `${label('Source', '来源')}: ${report.source || label('unavailable', '不可用')} · ${label('Packet', '结果包')}: ${report.packetId || '—'} · ${label('Packet digest', '结果包摘要')}: ${report.packetDigest || '—'} · ${label('Packet state', '结果包状态')}: ${report.packetState || label('unverified', '未核实')}`);
              if(report.producer?.sessionId) {
                add(section,'p',`${label('Verified source run','已核实来源运行')}: ${report.producer.runId || '—'} · ${label('captured','采集时间')}: ${report.producer.packetCreatedAt || label('unknown','未知')}`);
                button(section,label('Open source session','打开来源会话'),()=>{const sessionId=report.producer.sessionId; this.toggleOrganizationMode(false); if(typeof root.applyNavigationState==='function') root.applyNavigationState({sessionId,tab:'sessions'}); else root.location.assign(`/?session=${encodeURIComponent(sessionId)}`);});
              } else add(section,'p',label('Source session is unavailable or unverified.','来源会话不可用或未核实。'));

              const selectionSources = [];
              if (report.visibleText) selectionSources.push({element:add(section, 'pre', report.visibleText),section:'visibleText'});
              if (report.declaration?.status === 'valid') {
                add(section, 'p', `${label('Model-declared state', '模型声明状态')}: ${report.declaration.state || '—'}`);
                for (const field of ['summary', 'blockers', 'risks', 'changedFiles', 'unresolvedItems', 'tests', 'acceptanceNotes']) {
                  const value=report.declaration[field]; if(value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
                  add(section,'p',`${label('Model-declared', '模型声明')} ${field}`);
                  const text=typeof value === 'string' ? value : JSON.stringify(value);
                  selectionSources.push({element:add(section,'pre',text),section:'declaration',field});
                }
              } else add(section, 'p', `${label('Model declaration', '模型声明')}: ${report.declaration?.status || label('unavailable', '不可用')}`);
              if (!report.readable) add(section, 'p', label('Readable report unavailable or source unverified.', '报告正文不可用或来源未核实。'));
              const decisions = (item.decisions || []).filter(decision => decision.candidateDigest === candidate.digest && decision.contractRevision === candidate.contractRevision && (decision.evidence || []).some(entry => entry.kind === 'owner_report_review'));
              for (const decision of decisions) {
                const evidence = (decision.evidence || []).find(entry => entry.kind === 'owner_report_review');
                add(section, 'p', `${label('Owner decision', 'Owner 决定')}: ${decision.criterionId} · ${decision.decision} · ${label('gate', '验收代次')} ${decision.gateGeneration}${evidence?.rationale ? ` · ${evidence.rationale}` : ''}`);
                for (const target of evidence?.targets || []) add(section,'p',`${label('Returned passage','退回条目')} ${target.section}${target.field ? ` / ${target.field}` : ''}: ${target.excerpt || ''}${target.rationale ? ` · ${target.rationale}` : ''}`);
              }
              if (!decisions.length) add(section, 'p', label('No owner acceptance decision recorded for this candidate.', '此候选尚无已记录的 Owner 验收决定。'));
              if (current) for (const prior of (item.decisions || []).filter(d=>d.decision==='failed' && d.candidateDigest!==candidate.digest)) {
                const evidence=(prior.evidence || []).find(e=>e.kind==='owner_report_review'); if(!evidence) continue;
                add(section,'p',`${label('Earlier candidate feedback','历史候选意见')} · ${prior.candidateDigest}: ${evidence.rationale || ''}`);
                for(const target of evidence.targets || []) add(section,'p',`${target.field || target.section}: ${target.excerpt || ''} · ${target.rationale || ''}`);
              }

              const criteria = (item.contract?.acceptanceCriteria || []).filter(criterion => criterion.method === 'manual' && !(item.decisions || []).some(decision => decision.criterionId === criterion.id && decision.candidateDigest === candidate.digest && decision.contractRevision === item.contractRevision && decision.gateGeneration === item.gateGeneration));
              const canDecide = current && item.state === 'review' && item.controlState === 'none' && report.readable && report.packetId && report.packetDigest && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner';
              if (canDecide && criteria.length) {
                add(section, 'h4', label('Formal acceptance', '正式验收'));
                add(section, 'p', label('Record a decision for this candidate and criterion. A failed decision records the need for changes; use the work revision controls below to request revisions.', '针对当前候选和标准记录决定。不通过只记录需要修改；请使用下方工作修订功能提出修改。'));
                const targets=[];
                add(section,'p',label('To return specific passages or risks, select text above and use Add selection. Each entry is bound to this report packet.', '如需退回具体段落或风险，请先选中上方文字，再点“添加选中内容”。每条意见绑定此报告结果包。'));
                const targetList=add(section,'div','');
                const targetStatus=add(section,'p',''); targetStatus.setAttribute('role','status');
                const addSelection=button(section,label('Add selection','添加选中内容'),()=>{
                  const selection=root.getSelection?.();if(!selection || selection.rangeCount!==1 || selection.isCollapsed){targetStatus.textContent=label('Select a passage in this report first.','请先选中此报告中的一段文字。');return;}
                  const range=selection.getRangeAt(0), source=selectionSources.find(entry=>entry.element.contains(range.startContainer)&&entry.element.contains(range.endContainer));
                  if(!source || targets.length>=20){targetStatus.textContent=label('Select within one report field; at most 20 entries.','请在同一报告字段内选取，最多 20 条。');return;}
                  const excerpt=range.toString(), before=range.cloneRange();before.selectNodeContents(source.element);before.setEnd(range.startContainer,range.startOffset);
                  if(!excerpt || excerpt.length>1200 || new TextEncoder().encode(excerpt).length>12000){targetStatus.textContent=label('Selection is empty or too long.','选中内容为空或过长。');return;}
                  const entry={section:source.section,...(source.field?{field:source.field}:{}),start:before.toString().length,excerpt}; const row=add(targetList,'div','');add(row,'p',`${entry.field || entry.section}: ${excerpt}`); const note=document.createElement('input');note.maxLength=1200;note.placeholder=label('Reason for this passage','此条目的理由');note.setAttribute('aria-label',note.placeholder);row.appendChild(note);const selected={entry,note};targets.push(selected);button(row,label('Remove','移除'),()=>{targets.splice(targets.indexOf(selected),1);row.remove();});targetStatus.textContent=label('Selection added.','已添加选中内容。');
                });
                addSelection.addEventListener('mousedown',event=>event.preventDefault());
                const criterionSelect = document.createElement('select');
                criterionSelect.setAttribute('aria-label', label('Acceptance criterion', '验收标准'));
                for (const criterion of criteria) { const option = document.createElement('option'); option.value = criterion.id; option.textContent = criterion.description || criterion.id; criterionSelect.appendChild(option); }
                section.appendChild(criterionSelect);
                const rationale = document.createElement('textarea'); rationale.maxLength = 4096; rationale.placeholder = label('Reason for your decision (required)', '填写决定理由（必填）'); rationale.setAttribute('aria-label', rationale.placeholder); section.appendChild(rationale);
                const receipt = add(section, 'p', ''); receipt.setAttribute('role', 'status');
                const actions = add(section, 'div', ''); actions.className = 'org-report-actions';
                const submitDecision = decision => {
                  const reason = rationale.value.trim();
                  if (!reason) { receipt.textContent = label('Enter a reason first.', '请先填写决定理由。'); return; }
                  const commandId = root.crypto.randomUUID();
                  if (decision === 'passed' && targets.length) {receipt.textContent=label('Remove selected return entries before accepting.', '通过前请先移除已选退回条目。');return;}
                  if (decision === 'failed' && targets.some(target=>!target.note.value.trim())) { receipt.textContent=label('Enter a reason for each selected passage.', '请填写每个选中条目的理由。'); return; }
                  if (decision === 'failed' && new TextEncoder().encode(JSON.stringify(targets.map(target=>({...target.entry,rationale:target.note.value.trim()})))).length > 12000) {receipt.textContent=label('Selected entries exceed the 12 KB limit.', '所选条目超过 12 KB 限制。');return;}
                  const body = {criterionId:criterionSelect.value, decision, rationale:reason, commandId, idempotencyKey:commandId, expectedVersion:item.rowVersion, contractRevision:item.contractRevision, gateGeneration:item.gateGeneration, candidateDigest:candidate.digest, packetId:report.packetId, packetDigest:report.packetDigest,...(decision === 'failed' && targets.length ? {targets:targets.map(target=>({...target.entry,rationale:target.note.value.trim()}))} : {})};
                  actions.replaceChildren(); criterionSelect.disabled = true; rationale.disabled = true; addSelection.disabled = true; for (const target of targets) target.note.disabled = true; for (const remove of targetList.querySelectorAll('button')) remove.disabled = true;
                  const submit = async () => {
                    receipt.textContent = label('Recording decision…', '正在记录决定…');
                    try {
                      await requestWithTimeout(`/work-items/${encodeURIComponent(item.id)}/manual-acceptance`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
                      await showItem(item.id);
                    } catch (error) {
                      if (error.status === 409) {
                        receipt.textContent = label('The candidate or work changed, or its evidence could not be verified. Reload before deciding again.', '候选或工作状态已变化，或证据无法核实。请刷新后重新决定。');
                        actions.replaceChildren(); button(actions, label('Reload current work', '刷新当前工作'), () => showItem(item.id));
                      } else {
                        actions.replaceChildren();
                        if (!error.status || error.status >= 500) {
                          const checkReceipt = async () => {
                            try {
                              const recorded = await requestWithTimeout(`/commands/${encodeURIComponent(commandId)}`, {});
                              receipt.textContent = `${label('Decision recorded', '决定已记录')}: ${recorded.operation?.state || label('receipt available', '回执可用')}.`;
                              actions.replaceChildren(); button(actions, label('Refresh work', '刷新工作'), () => showItem(item.id));
                            } catch {
                              receipt.textContent = label('Decision outcome is not yet confirmed. Your reason is preserved here; check the receipt or retry the same request.', '决定结果尚待核实。理由保留在此；可查询回执或重试同一请求。');
                              actions.replaceChildren(); button(actions, label('Check receipt', '查询回执'), checkReceipt); button(actions, label('Retry same decision', '重试同一决定'), submit);
                            }
                          };
                          await checkReceipt();
                        } else {
                          receipt.textContent = `${label('Decision not confirmed', '决定未确认')}: ${error.message}`;
                          button(actions, label('Reload current work', '刷新当前工作'), () => showItem(item.id));
                        }
                      }
                    }
                  };
                  void submit();
                };
                button(actions, label('Accept', '通过验收'), () => submitDecision('passed'));
                button(actions, label('Needs revision', '验收不通过'), () => submitDecision('failed'));
                const revisionShortcut = button(section, label('Review work revision', '审阅工作修改'), () => content.querySelector('[data-report-revision]')?.click());
                revisionShortcut.disabled = true; revisionShortcuts.push(revisionShortcut);
              }
            }
          }
          if ((reports.length || reportHistory.length) && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner') {
            const zh = String(typeof root.ragentGetActiveUiLanguage === 'function' ? root.ragentGetActiveUiLanguage() : root.navigator?.language || '').toLowerCase().startsWith('zh');
            const label = (en, cn) => zh ? cn : en;
            const authority = item.reportAuthority?.kind;
            const attemptsUsed = Array.isArray(item.bindings) ? item.bindings.length : null;
            const maxAttempts = item.contract?.retry?.maxAttempts;
            const attemptsKnown = attemptsUsed !== null && Number.isSafeInteger(maxAttempts) && maxAttempts > 0;
            const attemptsRemain = attemptsKnown && attemptsUsed < maxAttempts;
            const returned = item.state === 'review' && item.controlState === 'none' && (item.decisions || []).some(decision => decision.decision === 'failed' && decision.candidateDigest === item.candidateDigest && decision.contractRevision === item.contractRevision && decision.gateGeneration === item.gateGeneration && (decision.evidence || []).some(entry => entry.kind === 'owner_report_review'));
            const revisionPanel = add(content, 'section', ''); revisionPanel.className = 'org-report-candidate';
            add(revisionPanel, 'h4', label('Report revision', '报告修订'));
            const status = add(revisionPanel, 'p', ''); status.setAttribute('role', 'status');
            const actions = add(revisionPanel, 'div', ''); actions.className = 'org-report-actions';
            if (attemptsKnown) add(revisionPanel, 'p', `${label('Execution attempts used / authorized', '已用 / 已授权执行次数')}: ${attemptsUsed} / ${maxAttempts}`);
            else add(revisionPanel, 'p', label('Execution attempt limit unavailable; refresh or review the contract before requesting revision.', '执行次数上限不可用；请求修订前请刷新或检查契约。'));
            if (returned && attemptsRemain && (authority === 'responsibility' || authority === 'owner')) {
              status.textContent = label('The report was returned. Record all criterion feedback before requesting another execution. The original attempt and budget limits still apply.', '报告已退回。请先记录各项标准的意见，再请求重新执行；原有次数和预算限制仍然适用。');
              button(actions, label('Request report revision', '请求修订报告'), () => {
                if (!root.confirm(label('Request another report execution using the recorded feedback? This may incur additional usage within the existing authorization and limits.', '使用已记录的意见请求再次执行报告？这可能产生额外用量，并受现有授权和限制约束。'))) return;
                const commandId = root.crypto.randomUUID();
                const body = {type:'RetryWork', targetId:item.id, expectedVersion:item.rowVersion, commandId, idempotencyKey:commandId, payload:{}};
                actions.replaceChildren();
                const submit = async () => {
                  status.textContent = label('Recording revision request…', '正在记录修订请求…');
                  try { await requestWithTimeout('/commands', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); await showItem(item.id); }
                  catch (error) {
                    actions.replaceChildren();
                    if (!error.status || error.status >= 500) {
                      const check = async () => { try { const result = await requestWithTimeout(`/commands/${encodeURIComponent(commandId)}`, {}); status.textContent = `${label('Revision request recorded', '修订请求已记录')}: ${result.operation?.state || '—'}.`; actions.replaceChildren(); button(actions, label('Refresh work', '刷新工作'), () => showItem(item.id)); } catch { status.textContent = label('Revision request outcome is not confirmed. Check its receipt or retry the same request.', '修订请求结果尚待核实，可查询回执或重试同一请求。'); actions.replaceChildren(); button(actions,label('Check receipt','查询回执'),check); button(actions,label('Retry same request','重试同一请求'),submit); } };
                      await check();
                    } else { status.textContent = `${label('Revision request not accepted', '修订请求未获受理')}: ${error.message}`; button(actions,label('Refresh work','刷新工作'),() => showItem(item.id)); }
                  }
                };
                void submit();
              });
            } else if (returned && attemptsKnown && !attemptsRemain) {
              status.textContent = label('The authorized attempt limit is exhausted. This work cannot be retried. A new report requires a new work item with its own scope, attempt limit, budget and authorization.', '已达到授权执行次数上限，此工作不能再次执行。新报告需要另建工作项，并单独确认范围、执行次数、预算和授权。');
              if (authority === 'owner' && item.goalId && item.assigneeNodeId && item.projectId && item.contract?.budgetReservation) button(actions, label('Prepare a new report', '准备新报告'), () => {
                const feedback = (item.decisions || []).filter(d => d.decision === 'failed' && d.candidateDigest === item.candidateDigest && d.contractRevision === item.contractRevision && d.gateGeneration === item.gateGeneration).map(d => `${d.criterionId}: ${(d.evidence || []).find(e => e.kind === 'owner_report_review')?.rationale || ''}`).join('\n');
                const objective = root.prompt(label('Review or edit the new report objective and prior feedback. The new report is separate from the old candidate.', '检查或修改新报告目标与之前意见。新报告是独立工作项。'), `${item.contract.objective}\n\n${label('Prior review feedback', '此前审阅意见')}:\n${feedback}`);
                if (!objective?.trim()) return;
                const attempts = Number(root.prompt(label('Maximum total executions for the new report (1–10), including the first execution', '新报告最多执行次数（1–10，含首次执行）')));
                if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) { status.textContent = label('Enter a whole number from 1 to 10.', '请输入 1 至 10 的整数。'); return; }
                const contract = {objective:objective.trim(), accessMode:'read', allowedPaths:[], acceptanceCriteria:item.contract.acceptanceCriteria, resource:{projectId:item.projectId,readScope:'entire_project',networkPolicy:'inherit_existing_permissions'}, budgetReservation:item.contract.budgetReservation, retry:{maxAttempts:attempts}};
                if (!root.confirm(`${label('Create this proposed report? No execution is authorized yet. Review the exact scope, budget, attempts and feedback:', '创建此报告草案？此步骤尚不授权执行。请核对范围、预算、次数及意见：')}\n${JSON.stringify(contract, null, 2)}`)) return;
                const commandId=root.crypto.randomUUID(), body={type:'CreateWorkItem',commandId,idempotencyKey:commandId,payload:{goalId:item.goalId,kind:'review',assigneeNodeId:item.assigneeNodeId,contract}};
                actions.replaceChildren();
                const submit = async () => { status.textContent=label('Creating report proposal…','正在创建报告草案…'); try { const result=await requestWithTimeout('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if (!result.item?.id) throw new Error('Work item ID unavailable'); await showItem(result.item.id); } catch(error) { actions.replaceChildren(); if (!error.status || error.status>=500) { status.textContent=label('Creation outcome is not confirmed. Retry the same request to reconcile it.','创建结果尚待核实，请重试同一请求以核对。'); button(actions,label('Retry same request','重试同一请求'),submit); } else { status.textContent=`${label('Report not created','报告未创建')}: ${error.message}`; button(actions,label('Refresh work','刷新工作'),()=>showItem(item.id)); } } };
                void submit();
              });
              else if (authority === 'responsibility' && item.reportAuthority.responsibilityId) button(actions, label('Open responsibility', '打开责任'), () => showResponsibility(item.reportAuthority.responsibilityId));
              else if (authority === 'responsibility') button(actions, label('Open responsibilities', '打开责任列表'), showResponsibilities);

            } else if (authority === 'owner' && item.state === 'ready' && !item.candidateDigest && (item.decisions || []).some(decision => decision.decision === 'failed' && (decision.evidence || []).some(entry => entry.kind === 'owner_report_review'))) {
              const authorized = item.reportAuthority?.nextExecutionAuthorized === true;
              status.textContent = authorized ? label('Authorization is recorded. Execution is subject to scheduling and remaining limits.', '授权已记录；实际执行仍取决于调度与剩余限制。') : label('Revision is prepared. A separate authorization is needed for the next read-only report execution.', '修订已准备。下一次只读报告执行需要单独授权。');
              if (!authorized) button(actions, label('Authorize revised report execution', '授权执行修订报告'), () => {
                if (!root.confirm(label('Authorize the next read-only report execution within the existing scope, budget and attempt limits? This may incur additional usage.', '授权在现有范围、预算和次数限制内再次执行只读报告？这可能产生额外用量。'))) return;
                const commandId = root.crypto.randomUUID(), body = {commandId,idempotencyKey:commandId,expectedVersion:item.rowVersion}; actions.replaceChildren();
                const submit = async () => { status.textContent = label('Recording authorization…', '正在记录授权…'); try { await requestWithTimeout(`/work-items/${encodeURIComponent(item.id)}/owner-report-authorization`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); status.textContent = label('Authorization recorded. Execution is subject to scheduling and remaining limits.', '授权已记录；实际执行仍取决于调度与剩余限制。'); button(actions,label('Refresh work','刷新工作'),() => showItem(item.id)); } catch(error) { actions.replaceChildren(); if (!error.status || error.status >= 500) {status.textContent = label('Authorization outcome is not confirmed. Retry the same request to reconcile it.', '授权结果尚待核实，请重试同一请求以核对。'); button(actions,label('Retry same authorization','重试同一授权'),submit);} else {status.textContent = `${label('Authorization not accepted','授权未获受理')}: ${error.message}`; button(actions,label('Refresh work','刷新工作'),() => showItem(item.id));} } };
                void submit();
              });
            } else if (returned) status.textContent = label('Report authority is unavailable; revision cannot be requested here.', '报告授权归属不可用，暂无法在此请求修订。');
            else status.textContent = label('See the work state and recorded decisions for the current revision status.', '请查看工作状态与已记录决定，确认当前修订状态。');
          }
          if (item.kind === 'review' && item.state === 'proposed' && item.reviewHandoff?.state === 'current' && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner') {
            const panel=add(content,'section',''); panel.className='org-report-candidate';
            add(panel,'p','审查交接已核实为当前；批准后仍需通过调度、预算和只读运行时检查。审查意见不等于正式验收。');
            const status=add(panel,'p',''), actions=add(panel,'div',''); status.setAttribute('role','status');
            button(actions,'批准此审查契约',()=>{if(!root.confirm(`批准针对候选 ${item.reviewHandoff.candidate?.digest || '未知'} 的只读审查？执行可能产生预算内用量。`))return; const commandId=root.crypto.randomUUID(),body={type:'ApproveContract',targetId:item.id,expectedVersion:item.rowVersion,commandId,idempotencyKey:commandId,payload:{}}; actions.replaceChildren(); const submit=async()=>{try{await requestWithTimeout('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await showItem(item.id);}catch(error){actions.replaceChildren();status.textContent=`批准未确认：${error.message}`;if(!error.status||error.status>=500)button(actions,'重试同一批准',submit);else button(actions,'刷新',()=>showItem(item.id));}};void submit();});
          }
          const proposedReport = item.state === 'proposed' && item.contract?.accessMode === 'read' && item.contract?.resource?.readScope === 'entire_project' && item.contract?.resource?.projectId === item.projectId && (item.contract?.acceptanceCriteria || []).length && item.contract.acceptanceCriteria.every(c => c.method === 'manual');
          if (proposedReport && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner') {
            const zh = String(typeof root.ragentGetActiveUiLanguage === 'function' ? root.ragentGetActiveUiLanguage() : root.navigator?.language || '').toLowerCase().startsWith('zh');
            const label=(en,cn)=>zh?cn:en, panel=add(content,'section',''); panel.className='org-report-candidate';
            add(panel,'h4',label('Proposed report','报告草案')); add(panel,'p',label('Review the scope and limits. Authorization and approval are separate; scheduling and budget checks still apply.','请核对范围与限制。授权和批准是两个独立步骤；仍需通过调度和预算检查。')); add(panel,'pre',JSON.stringify(item.contract,null,2));
            const status=add(panel,'p',''), actions=add(panel,'div',''); status.setAttribute('role','status'); actions.className='org-report-actions';
            if (item.reportAuthority?.kind !== 'responsibility' && item.reportAuthority?.nextExecutionAuthorized !== true) button(actions,label('Authorize report scope','授权报告范围'),()=>{
              if (!root.confirm(label('Authorize this report’s read-only scope and next execution within the displayed limits? This may incur usage after approval.','授权此报告在所示限制内的只读范围和下一次执行？批准后可能产生用量。'))) return;
              const commandId=root.crypto.randomUUID(), body={commandId,idempotencyKey:commandId,expectedVersion:item.rowVersion}; actions.replaceChildren();
              const submit=async()=>{try {await requestWithTimeout(`/work-items/${encodeURIComponent(item.id)}/owner-report-authorization`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); status.textContent=label('Authorization recorded. Review the contract before approving.','授权已记录，请审阅契约后批准。'); actions.replaceChildren(); button(actions,label('Refresh','刷新'),()=>showItem(item.id));} catch(error){actions.replaceChildren();status.textContent=`${label('Authorization not confirmed','授权未确认')}: ${error.message}`; if(!error.status||error.status>=500) button(actions,label('Retry same authorization','重试同一授权'),submit); else button(actions,label('Refresh','刷新'),()=>showItem(item.id));}}; void submit();
            });
            if (item.reportAuthority?.kind === 'owner' && item.reportAuthority?.nextExecutionAuthorized === true) button(actions,label('Approve report contract','批准报告契约'),()=>{
              if(!root.confirm(label('Approve this report contract for scheduling? Execution may incur usage within the displayed limits.','批准此报告契约进入调度？执行可能在所示限制内产生用量。'))) return;
              const commandId=root.crypto.randomUUID(), body={type:'ApproveContract',targetId:item.id,expectedVersion:item.rowVersion,commandId,idempotencyKey:commandId,payload:{}}; actions.replaceChildren();
              const submit=async()=>{try {await requestWithTimeout('/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); await showItem(item.id);} catch(error){actions.replaceChildren();status.textContent=`${label('Approval not confirmed','批准未确认')}: ${error.message}`;if(!error.status||error.status>=500)button(actions,label('Retry same approval','重试同一批准'),submit);else button(actions,label('Refresh','刷新'),()=>showItem(item.id));}};void submit();
            });
          }
          const technical = add(content, 'details', '');
          add(technical, 'summary', 'Technical work details');
          for (const [name, value] of [['Dependencies', item.dependencies], ['Contract', item.contract], ['Executions', item.bindings], ['Candidates', (item.candidates || []).map(({report, ...candidate}) => candidate)], ['Decisions', item.decisions]]) {
            add(technical, 'h4', name); add(technical, 'pre', JSON.stringify(value || [], null, 2));
          }
          if (item.state === 'review' && item.controlState === 'none' && item.candidateDigest && !reports.length && item.contract?.resource?.readScope !== 'entire_project' && root.__RAGENT_BOOTSTRAP__?.auth?.role === 'owner') {
            const criteria=(item.contract?.acceptanceCriteria || []).filter(c=>c.method==='manual' && !(item.decisions || []).some(d=>d.criterionId===c.id && d.candidateDigest===item.candidateDigest && d.contractRevision===item.contractRevision && d.gateGeneration===item.gateGeneration));
            if(criteria.length){
              const panel=add(content,'section','');panel.className='org-report-candidate'; add(panel,'h4','当前候选的 Owner 决定');
              add(panel,'p','请选择人工标准并填写理由。服务端会重新核验当前候选、运行和证据；审查意见或请求检查本身不等于验收。');
              const select=document.createElement('select');select.setAttribute('aria-label','人工验收标准');for(const c of criteria){const option=document.createElement('option');option.value=c.id;option.textContent=c.description || c.id;select.appendChild(option);}panel.appendChild(select);
              const rationale=document.createElement('textarea');rationale.maxLength=4096;rationale.placeholder='决定理由（必填）';rationale.setAttribute('aria-label',rationale.placeholder);panel.appendChild(rationale); const status=add(panel,'p',''),actions=add(panel,'div','');status.setAttribute('role','status');actions.className='org-report-actions';
              const decide=decision=>{const reason=rationale.value.trim();if(!reason){status.textContent='请填写决定理由。';return;}const commandId=root.crypto.randomUUID(),body={criterionId:select.value,decision,rationale:reason,commandId,idempotencyKey:commandId,expectedVersion:item.rowVersion,contractRevision:item.contractRevision,gateGeneration:item.gateGeneration,candidateDigest:item.candidateDigest};select.disabled=true;rationale.disabled=true;actions.replaceChildren();
                const submit=async()=>{try{await requestWithTimeout(`/work-items/${encodeURIComponent(item.id)}/manual-acceptance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});await showItem(item.id);}catch(error){actions.replaceChildren();if(!error.status||error.status>=500){const check=async()=>{try{await requestWithTimeout(`/commands/${encodeURIComponent(commandId)}`,{});status.textContent='决定已记录；请刷新查看当前工作。';actions.replaceChildren();button(actions,'刷新',()=>showItem(item.id));}catch{status.textContent='决定结果待核实；理由保留，可查询回执或重试同一请求。';actions.replaceChildren();button(actions,'查询回执',check);button(actions,'重试同一请求',submit);}};await check();}else{status.textContent=`决定未确认：${error.message}`;button(actions,'刷新',()=>showItem(item.id));}}};void submit();};
              button(actions,'通过此标准',()=>decide('passed'));button(actions,'不通过此标准',()=>decide('failed'));
            }
          }
          add(content, 'h4', 'Delivery evidence');
          for (const candidate of item.candidates || []) add(content, 'p', `Candidate ${candidate.digest || 'unverified'} · contract ${candidate.contractRevision} · execution ${candidate.executionEpoch}`);
          if (!item.candidates?.length) add(content, 'p', 'Candidate: unverified');
          for (const decision of item.decisions || []) add(content, 'p', `Acceptance ${decision.criterionId}: ${decision.decision} · candidate ${decision.candidateDigest}. Evidence: ${JSON.stringify(decision.evidence || [])}`);
          if (!item.decisions?.length) add(content, 'p', 'Acceptance and checks: unverified');
          for (const milestone of item.milestones || []) add(content, 'p', `${milestone.milestone} · candidate ${milestone.candidateDigest} · commit ${milestone.evidence?.commit || 'unverified'} · target ${milestone.target || 'unknown'}`);
          if (!item.milestones?.some(m => m.milestone === 'integrated')) add(content, 'p', 'Integrated commit: unverified');
          add(content, 'p', 'Package availability and publication: unverified unless supported by a recorded delivery operation.');
          add(content, 'h4', 'Read-only consultation');
          add(content, 'p', 'A consultation requests an expert opinion, subject to read-only runtime and budget checks. It is not an acceptance decision.');
          const consultationBase=`/work-items/${encodeURIComponent(item.id)}/consultations`;
          const consultationStatus=add(content,'p','');
          const expert=document.createElement('select');
          for(const node of this.projection?.nodes || []) { const option=document.createElement('option');option.value=node.id;option.textContent=node.displayName || node.id;expert.appendChild(option); }
          content.appendChild(expert);
          const consultationField=(placeholder,type='text')=>{const field=document.createElement('input');field.placeholder=placeholder;field.type=type;content.appendChild(field);return field;};
          const question=consultationField('Question for the expert'), deadline=consultationField('Deadline','datetime-local');
          const maxCost=consultationField('Maximum cost','number'), maxTokens=consultationField('Maximum tokens','number');
          let consultationId='';
          const showConsultation=async action=>{if(!consultationId){consultationStatus.textContent='No consultation selected.';return;}try {const result=await request(`${consultationBase}/${encodeURIComponent(consultationId)}${action?`/${action}`:''}`,action?{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}:{});consultationStatus.textContent=`Consultation ${result.consultationId}: ${result.state}; ${result.reconciliation || result.reason || result.recovery || 'no new observation'}. ${result.opinion?.opinion ? `Opinion: ${result.opinion.opinion}${result.opinion.truncated ? ' (truncated)' : ''}` : 'Opinion unavailable or unverified.'} Opinion is not acceptance; budget usage may remain pending.`;}catch(error){consultationStatus.textContent=`Consultation unavailable: ${error.message}`;}};
          button(content,'Start consultation',()=>{
            const end=new Date(deadline.value),cost=Number(maxCost.value),tokens=Number(maxTokens.value);
            if(!expert.value || !question.value.trim() || !Number.isFinite(end.getTime()) || !Number.isFinite(cost) || cost<=0 || !Number.isSafeInteger(tokens) || tokens<=0) {consultationStatus.textContent='Select an expert and enter a question, deadline and positive cost and token limits.';return;}
            const commandId=root.crypto.randomUUID(),body={expertNodeId:expert.value,expectedVersion:item.rowVersion,question:question.value.trim(),deadline:end.toISOString(),budget:{maxCost:cost,maxTokens:tokens},commandId,idempotencyKey:commandId};
            const submit=async()=>{try{const result=await request(consultationBase,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});consultationId=result.consultationId;consultationStatus.textContent=`Consultation ${consultationId}: ${result.state}${result.reason ? ` · ${result.reason}` : ''}. A recorded request is not an answer.`;}catch(error){consultationStatus.textContent=`Consultation not confirmed: ${error.message}`;button(content,'Retry same consultation',submit);}};
            submit();
          });
          try {
            const prior=await request(consultationBase);
            if(!prior.items?.length) add(content,'p','No consultations recorded.');
            for(const entry of prior.items || []) button(content,`${entry.createdAt} · ${entry.state}`,()=>{consultationId=entry.consultationId;showConsultation('');});
            if(prior.truncated) add(content,'p','Only the most recent consultations are shown.');
          } catch(error) { add(content,'p',`Consultation history unavailable: ${error.message}`); }
          button(content,'Refresh consultation',()=>showConsultation(''));
          button(content,'Reconcile consultation',()=>showConsultation('reconcile'));
          button(content,'Resume unstarted consultation',()=>showConsultation('resume'));
          add(content, 'h4', 'Worker blocker proposals');
          try {
            const proposals = await request(`/work-items/${encodeURIComponent(item.id)}/blocker-proposals`);
            if (!proposals.items?.length) add(content, 'p', 'No recorded blocker proposals.');
            for (const proposal of proposals.items || []) {
              add(content, 'p', `${proposal.kind}: ${proposal.reason} · ${proposal.state} · execution ${proposal.executionEpoch}${proposal.suggestion ? ` · Suggestion: ${proposal.suggestion}` : ''}`);
              if (proposal.state !== 'pending') continue;
              const disposition = action => {
                if (!root.confirm(action === 'pause' ? 'Request a pause for this work? The proposal itself does not stop the Run.' : 'Dismiss this proposal without changing the work?')) return;
                const token=root.crypto.randomUUID();
                const body={action,expectedProposalVersion:proposal.version,expectedWorkVersion:item.rowVersion,commandId:token,idempotencyKey:token};
                const submit=async()=>{try {const result=await request(`/work-items/${encodeURIComponent(item.id)}/blocker-proposals/${encodeURIComponent(proposal.id)}/dispose`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});add(content,'p',`Disposition ${result.state}; refresh for current work and stop facts.`);}catch(error){add(content,'p',`Disposition not confirmed: ${error.message}`);button(content,'Retry same disposition',submit);}};
                submit();
              };
              button(content,'Dismiss proposal',()=>disposition('dismiss'));
              button(content,'Request pause',()=>disposition('pause'));
            }
          } catch(error) { add(content,'p',`Blocker proposals unavailable: ${error.message}`); }
          try {
            const state = await request(`/work-items/${encodeURIComponent(item.id)}/reconcile`);
            const observation = state.acceptedRunObservation;
            const outcomes=state.externalOutcomes;
            if(outcomes?.state==='observed') {
              if(!(outcomes.entries || []).length) add(recoveryPanel,'p','此运行没有可归属的外部动作回执记录；不据此推断其他动作未发生。');
              for(const outcome of outcomes.entries || []) {
                add(recoveryPanel,'p',`外部目标 ${outcome.targetId || '未知'} · 状态 ${outcome.state || '未知'} · 可安全重试 ${outcome.safeToRetry === true ? '是' : outcome.safeToRetry === false ? '否' : '未知'} · 调用时间 ${outcome.providerInvokedAt || '未知'} · 投递时间 ${outcome.deliveredAt || '未知'}`);
                add(recoveryPanel,'p',outcome.providerReceipt ? `提供商回执：${outcome.providerReceipt.provider || '未知'} · 状态码 ${outcome.providerReceipt.statusCode ?? '未知'} · 响应 ${outcome.providerReceipt.responseId || '未知'}` : '提供商回执不可用；不得据此视为已投递。');
                for(const review of outcome.manualReviews || []) add(recoveryPanel,'p',`人工核实：${review.observation || '未知'} · ${review.actorId || '未知'} · ${review.reviewedAt || '未知'} · 证据 ${typeof review.evidence === 'string' ? review.evidence : JSON.stringify(review.evidence || {})}。人工记录不等于提供商回执，也不自动解除未知结果。`);
              }
              if(outcomes.truncated)add(recoveryPanel,'p','外部动作记录已截断。');
            } else add(recoveryPanel,'p','外部动作结果不可核实；不能判断动作未发生或可以安全重试。');

            const stopText = state.stopStatus === 'cancel_requested_pending'
              ? '已请求取消（尚未确认停止）'
              : state.stopStatus === 'completed_before_stop' || state.stopStatus === 'completed_pending_review'
                ? 'Run 已在停止前完成（待审阅，不标记为已取消）'
                : state.stopStatus === 'stopped'
                  ? '已确认停止'
                  : (state.stopStatus || 'none');
            const unknownText = state.unknownOutcome?.isUnknown ? ` · 存在未知结果（${state.unknownOutcome.reason || 'unknown_outcome'}，禁止自动重派）` : '';
            reconcileStatus.textContent = `${observation?.state === 'found' ? '发现执行记录，等待系统核实关联' : observation?.state === 'bound_run_observed' ? '已关联执行记录' : '暂未核实是否已执行'}。${observation?.expectedRunId ? `执行记录：${observation.expectedRunId}；Run 状态：${observation.runState || '未知'}。` : ''} 对账状态：${state.state || '未知'} · 停止状态：${stopText}${unknownText}。`;
            if (state.unknownOutcome?.canVerifyAcceptedRun && observation?.expectedRunId) {
              button(reconcileActions, 'Verify accepted Run receipt', async () => {
                if (!root.confirm(`Verify and link accepted Run ${observation.expectedRunId} for work item ${item.id}?`)) return;
                try {
                  const res = await request(`/work-items/${encodeURIComponent(item.id)}/reconcile/verify-accepted`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expectedVersion: state.rowVersion, executionEpoch: state.executionEpoch, leaseGeneration: state.schedulerLease?.generation, expectedRunId: observation.expectedRunId }),
                  });
                  reconcileStatus.textContent = `Accepted Run verification result: ${res.state}${res.runId ? ` (${res.runId})` : ''}${res.reason ? ` · ${res.reason}` : ''}.`;
                } catch (error) { reconcileStatus.textContent = `Verify failed: ${error.message}`; }
              });
            }
            if (state.state === 'dead_letter') {
              button(reconcileActions, 'Resume dead-letter reconciliation', async () => {
                if (!root.confirm(`Resume dead-letter reconciliation for ${item.id} epoch ${state.executionEpoch}?`)) return;
                const body = { commandId: root.crypto.randomUUID(), expectedVersion: state.rowVersion, executionEpoch: state.executionEpoch };
                try {
                  await request(`/work-items/${encodeURIComponent(item.id)}/reconcile/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                  await showItem(item.id);
                } catch (error) { reconcileStatus.textContent = `Resume failed: ${error.message}`; }
              });
            }
            if (state.unknownOutcome?.canResolveExplicitly) {
              const runState = observation?.runState;
              const options = runState === 'completed'
                ? [['adopt_run_outcome', 'Confirm completed pending review (not cancelled)']]
                : runState === 'cancelled'
                  ? [['adopt_run_outcome', 'Confirm stopped / cancelled from Run receipt']]
                  : runState === 'failed'
                    ? [['adopt_run_outcome', 'Confirm failed from Run receipt']]
                    : [
                        ...(state.controlState === 'cancel_requested' || state.controlState === 'pause_requested' ? [['confirm_stopped', 'Confirm stopped after owner verification']] : []),
                        ['confirm_failed', 'Confirm failed (unknown outcome; retains unverified budget reservation)'],
                      ];
              for (const [resolution, label] of options) {
                button(reconcileActions, label, () => {
                  const rationale = root.prompt(`Owner rationale for ${resolution} on ${item.id}`);
                  if (!rationale || !rationale.trim()) return;
                  if (!root.confirm(`Explicitly resolve ${item.id} (epoch ${state.executionEpoch}) as ${resolution}? Audit history and unknown-usage reservations remain preserved.`)) return;
                  const body = {
                    commandId: root.crypto.randomUUID(), idempotencyKey: root.crypto.randomUUID(),
                    expectedVersion: state.rowVersion, executionEpoch: state.executionEpoch,
                    resolution, rationale: rationale.trim(), confirmed: true,
                  };
                  const submit = async () => {
                    try {
                      const res = await request(`/work-items/${encodeURIComponent(item.id)}/reconcile/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                      reconcileStatus.textContent = `Explicit resolution recorded: ${res.resolution} -> state ${res.item?.state}, binding ${res.binding?.status}, budgetRetained=${res.budgetRetained}.`;
                    } catch (error) {
                      reconcileStatus.textContent = `Resolution not confirmed: ${error.message}`;
                      button(reconcileActions, `Retry ${resolution}`, submit);
                    }
                  };
                  submit();
                });
              }
            }
            if (state.unknownOutcome?.isUnknown) add(recoveryPanel,'p','下一步：先核对已发现的运行或回执；无法核实时保留未知，不要据此重派。');
            else if (state.stopStatus === 'cancel_requested_pending') add(recoveryPanel,'p','下一步：等待或核对终态回执；停止请求本身不证明执行已停止。');
          } catch (error) { reconcileStatus.textContent = `执行与停止状态不可用：${error.message}。无法据此判断是否运行或停止。`; }
          try { const budget = await request(`/work-items/${encodeURIComponent(item.id)}/budget`); const reservation = budget.reservation || {}; const wd = budget.windowDetail;
            const windowSummary = wd ? `${wd.windowDay || 'unknown'} (${wd.timeZone || 'unknown'}${wd.rolledOver ? `, rolled over to ${wd.currentDay}` : ''}; totals ${JSON.stringify(wd.totals)}; reserved ${JSON.stringify(wd.reserved)}; limits ${JSON.stringify(wd.limits)})` : (reservation.window ? JSON.stringify(reservation.window) : 'none');
            budgetStatus.textContent = `用量状态：${budget.usageState || '未知'} · 实际用量：${budget.usageState === 'actual' && reservation.actualUsage != null ? JSON.stringify(reservation.actualUsage) : '未知，不能当作零'} · 预留：${reservation.reserved == null ? '未知' : JSON.stringify(reservation.reserved)} · 预留状态：${reservation.state || '不可用'}${budget.reservationRetained ? '（保留至权威用量或已核实未启动回执）' : ''} · 日预算窗口：${windowSummary} · 执行边界：${budget.costEnforcement || 'admission_estimate_only'}；提供商硬上限${budget.hardCapAvailable === true ? '可用' : '未确认'}。${budget.budgetBoundary?.note || '准入估算不保证提供商费用硬上限；事实不可用不证明工作没有运行。'}`;
          } catch (error) { budgetStatus.textContent = `Budget facts unavailable: ${error.message}. This does not prove work did not run.`; }
          const reportRevisionButton = button(content, '审阅局部目标修改', async () => {
            try {
              let cursor = '', goal = null;
              for (let page = 0; page < 10 && !goal; page++) {
                const goals = await request(`/goals?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                goal = (goals.items || []).find(entry => entry.id === item.goalId);
                if (!goals.nextCursor || goal) break; cursor = goals.nextCursor;
              }
              if (!goal || !Number.isSafeInteger(goal.rowVersion)) throw new Error('无法读取当前目标版本');
              const objective = root.prompt('新的此项工作目标', item.contract?.objective || ''); if (!objective) return;
              const criterion = root.prompt('可选：追加一项人工验收标准 ID。固定责任工作流不支持追加；原标准与检查保留。', ''); if (criterion === null) return;
              const additionalManualCriteria = criterion.trim() ? [{id:criterion.trim(),method:'manual'}] : undefined;
              const base = `/goals/${encodeURIComponent(item.goalId)}/scoped-revision`;
              const preview = await request(`${base}/preview`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:goal.rowVersion,rootWorkItemId:item.id,objective,additionalManualCriteria})});
              if (preview.goalVersion !== goal.rowVersion || preview.rootWorkItemId !== item.id || preview.objective !== objective || JSON.stringify(preview.additionalManualCriteria) !== JSON.stringify(additionalManualCriteria) || !preview.impactDigest) throw new Error('预览与请求不一致，请刷新');
              const summary = (preview.items || []).map(entry => `${entry.id} · ${entry.state} · ${entry.controlState} · 活动执行 ${entry.activeBindings?.length ?? '未知'}`).join('\n');
              if (!root.confirm(`修改目标：${preview.objective}；追加人工验收标准：${JSON.stringify(preview.additionalManualCriteria || [])}。保留原权限、标准和检查。\n目标版本：${preview.goalVersion}\n受影响工作：\n${summary}\n活动下游仅请求取消，不代表已停止；不受影响历史保留。确认提交？`)) return;
              const commandId = root.crypto.randomUUID();
              const body = {expectedVersion:preview.goalVersion,rootWorkItemId:preview.rootWorkItemId,objective:preview.objective,...(preview.additionalManualCriteria?{additionalManualCriteria:preview.additionalManualCriteria}:{}),impactDigest:preview.impactDigest,commandId,idempotencyKey:commandId};
              const submit = async () => { try { const result = await request(`${base}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); add(content,'p',`修改已记录：${result.operation?.state || '未知'}。请刷新查看实际停止和工作状态。`); }
                catch(error) { add(content,'p',`修改未确认：${error.message}`); button(content,'使用同一请求重试',submit); } };
              await submit();
            } catch (error) { add(content, 'p', `无法审阅局部修改：${error.message}`); }
          });
          reportRevisionButton.dataset.reportRevision = 'true';
          for (const shortcut of revisionShortcuts) shortcut.disabled = false;
          button(content, '审阅多个工作目标修改', async () => {
            const panel = add(content, 'section', '');
            try {
              const rows = await request('/work-items');
              const candidates = (rows.items || []).filter(row => row.goalId === item.goalId);
              if (rows.nextCursor) add(panel, 'p', '仅显示当前页；未显示的工作不能在此选择。');
              const fields = candidates.map(row => {
                const label = document.createElement('label'), selected = document.createElement('input'), objective = document.createElement('input'), criterion = document.createElement('input');
                selected.type = 'checkbox'; objective.placeholder = '新的工作目标';
                criterion.placeholder='可选人工验收标准 ID（固定责任合同不支持）';label.append(selected, document.createTextNode(` ${row.contract?.objective || row.id} · ${row.state} `), objective, criterion); panel.appendChild(label);
                return {row, selected, objective, criterion};
              });
              button(panel, '预览合并影响', async () => {
                try {
                  const revisions = fields.filter(field => field.selected.checked).map(field => ({rootWorkItemId:field.row.id,objective:field.objective.value.trim(),...(field.criterion.value.trim()?{additionalManualCriteria:[{id:field.criterion.value.trim(),method:'manual'}]}:{})}));
                  if (revisions.length < 2 || revisions.length > 32 || revisions.some(entry => !entry.objective)) throw new Error('请选择 2 至 32 项工作并填写每项新目标');
                  let cursor = '', goal = null;
                  for (let page = 0; page < 10 && !goal; page++) { const result = await request(`/goals?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); goal = (result.items || []).find(entry => entry.id === item.goalId); if (!result.nextCursor || goal) break; cursor = result.nextCursor; }
                  if (!Number.isSafeInteger(goal?.rowVersion)) throw new Error('无法读取当前目标版本');
                  const base = `/goals/${encodeURIComponent(item.goalId)}/scoped-revision`;
                  const preview = await request(`${base}/preview`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:goal.rowVersion,revisions})});
                  const normalized = list => JSON.stringify([...list].sort((a,b) => a.rootWorkItemId.localeCompare(b.rootWorkItemId)));
                  if (preview.goalVersion !== goal.rowVersion || !Array.isArray(preview.revisions) || normalized(preview.revisions) !== normalized(revisions) || !preview.impactDigest) throw new Error('预览与请求不一致，请刷新');
                  const summary = (preview.items || []).map(entry => `${entry.id} · ${entry.state} · ${entry.controlState} · 活动执行 ${entry.activeBindings?.length ?? '未知'}`).join('\n');
                  if (!root.confirm(`修改目标：\n${preview.revisions.map(entry => `${entry.rootWorkItemId}: ${entry.objective}；追加人工标准 ${JSON.stringify(entry.additionalManualCriteria || [])}`).join('\n')}\n受影响工作：\n${summary}\n活动下游仅请求取消，不代表已停止；原权限、标准及检查保留。确认提交？`)) return;
                  const commandId = root.crypto.randomUUID(), body = {expectedVersion:preview.goalVersion,revisions:preview.revisions,impactDigest:preview.impactDigest,commandId,idempotencyKey:commandId};
                  const submit = async () => { try { await request(`${base}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); add(panel,'p','修改已记录；请刷新查看实际工作状态。'); } catch(error) { add(panel,'p',`修改未确认：${error.message}`); button(panel,'使用同一请求重试',submit); } };
                  await submit();
                } catch(error) { add(panel,'p',`无法审阅修改：${error.message}`); }
              });
            } catch(error) { add(panel,'p',`无法读取工作：${error.message}`); }
          });
          const receipt = add(content, 'p', '');
          button(content, 'Request reconciliation', () => {
            const body = { commandId:root.crypto.randomUUID(), expectedVersion:item.rowVersion, executionEpoch:item.executionEpoch };
            const submit = async () => { try { const result=await request(`/work-items/${encodeURIComponent(item.id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const budget=result.unstartedBudget; const budgetNote=!budget ? '' : budget.state==='released' ? ' The verified unstarted reservation was released.' : budget.state==='unavailable' ? ' No verified unstarted-release receipt is available.' : ' Reservation release remains pending reconciliation.'; receipt.textContent=`Reconciliation request ${result.requested ? 'recorded' : 'not confirmed'}; refresh for observed facts.${budgetNote}`; } catch(error) { receipt.textContent=`Reconciliation not confirmed: ${error.message}`; button(content,'Retry same reconciliation request',submit); } }; submit();
          });
          const send = (type, payload = {}) => {
            const token = root.crypto.randomUUID();
            const command = { commandId: token, idempotencyKey: token, type, targetId: item.id, expectedVersion: item.rowVersion, payload };
            const submit = async () => {
              receipt.textContent = 'Submitting request…';
              try {
                const result = await request('/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
                receipt.textContent = `Receipt ${result.operation?.commandId || token}: ${result.operation?.state || 'unknown'}; task control ${result.item?.controlState || 'unknown'}. Refresh for current facts.`;
              } catch (error) { receipt.textContent = `Request not confirmed: ${error.message}. Retry uses the same command ID.`; button(content, 'Retry same request', submit); }
            };
            submit();
          };
          button(content, 'Increase priority', () => send('ChangePriority', { priority: item.priority + 1 }));
          button(content, 'Request pause', () => send('RequestPause'));
          if (item.controlState === 'paused') {
            button(content, 'Release pause', () => send('ResumeWork'));
            add(content, 'p', 'Releasing a pause does not start work. A stopped task may also need an authorized retry.');
          }
          button(content, 'Request cancel', () => send('RequestCancel'));
          if (item.state === 'running' && item.controlState === 'none') {
            add(content, 'p', 'Direct steering targets the current supported execution only. Other runtimes return next-turn guidance without scheduling a message.');
            const steeringText = document.createElement('textarea'); steeringText.maxLength = 4000; steeringText.setAttribute('aria-label', 'Steering instruction'); content.appendChild(steeringText);
            button(content, 'Send steering instruction', () => {
              const body={commandId:root.crypto.randomUUID(),expectedVersion:item.rowVersion,executionEpoch:item.executionEpoch,bindingGeneration:item.bindingGeneration,text:steeringText.value};
              const show = result => { receipt.textContent=`Steering ${result.commandId}: ${result.state}. ${result.state==='unsupported'?'Not sent or scheduled; use the next turn.':result.state==='accepted'?'Provider acknowledged the request; task outcome is not yet known.':''}`; };
              const submit = async () => { try { show(await request(`/work-items/${encodeURIComponent(item.id)}/steer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})); button(content,'Refresh steering receipt',async()=>{try {show(await request(`/steer-commands/${encodeURIComponent(body.commandId)}`));} catch(error) {receipt.textContent=`Receipt unavailable: ${error.message}`;}}); } catch(error) {receipt.textContent=`Steering not confirmed: ${error.message}`; button(content,'Retry same steering request',submit);} };
              submit();
            });
          }
          let handoffPending = null, handoffBusy = false;
          const handoffStatus = add(content,'p','');
          add(content,'p','未确认请求的同键重试仅在此页面打开期间可用；离开或重载后不会自动重试，需先核查交接记录。');
          const showHandoff = result => {
            const label = result.assessment === 'current' ? '快照核对为当前' : result.assessment === 'stale' ? '快照已过期' : '快照无法完整核实';
            handoffStatus.textContent = `${label} · ${result.asOf || '时间未知'} · 原因 ${JSON.stringify(result.staleReasons || [])}。快照核对不证明旧执行已停止或可以继续、重派。`;
            add(content,'pre',JSON.stringify(result.facts || {},null,2));
            button(content,'重新核对该快照',async()=>{try {showHandoff(await request(`/handoffs/${encodeURIComponent(result.id)}`));}catch(error){handoffStatus.textContent=`无法核对快照：${error.message}`;}});
          };
          const submitHandoff = async () => {
            if (!handoffPending || handoffBusy) return;
            handoffBusy = true;
            try { const result=await request(`/work-items/${encodeURIComponent(item.id)}/handoffs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(handoffPending)});handoffPending=null;showHandoff(result); }
            catch(error) {handoffStatus.textContent=`请求结果未确认：${error.message}。请使用相同请求重试。`;} finally {handoffBusy=false;}
          };
          button(content, '生成或刷新交接快照', async () => {
            if (handoffBusy || handoffPending) {handoffStatus.textContent='先等待或使用相同请求重试未确认的交接。';return;}
            if (!root.confirm('重新读取当前工作并生成交接快照？这不会停止旧执行或自动重派。')) return;
            handoffBusy = true;
            try {const latest=await request(`/work-items/${encodeURIComponent(item.id)}`);const version=latest.item?.rowVersion;if(!Number.isSafeInteger(version)) throw new Error('无法读取当前工作版本');handoffPending={commandId:root.crypto.randomUUID(),expectedVersion:version};}
            catch(error) {handoffStatus.textContent=`无法读取当前工作：${error.message}`;} finally {handoffBusy=false;}
            await submitHandoff();
          });
          button(content,'使用相同交接请求重试',submitHandoff);
        } catch (error) { content.replaceChildren(); add(content, 'p', `Unable to load work item: ${error.message}`); button(content, 'All work items', showList); }
      };
      const showLifecycle = async () => {
        content.replaceChildren(); add(content, 'p', 'Loading team state…');
        try {
          const info = await request('/lifecycle');
          content.replaceChildren(); button(content, 'All work items', showList);
          add(content, 'h3', 'Team lifecycle');
          add(content, 'p', `State ${info.state}; revision ${info.revision}; root ${info.rootSessionId}; version ${info.version}`);
          const receipt = add(content, 'p', info.pending ? `Pending ${info.pending.kind}: ${info.pending.commandId}` : 'No lifecycle operation pending.');
          const post = async (path, body, retry) => {
            try { const result = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); receipt.textContent = `Operation ${result.commandId}: ${result.state}.`; button(content, 'Refresh state', showLifecycle); }
            catch (error) { receipt.textContent = `Not completed: ${error.message}`; if (retry) button(content, 'Retry same request', retry); }
          };
          if (info.pending) {
            const id = encodeURIComponent(info.pending.commandId);
            button(content, 'Finalize when clear', () => post(`/lifecycle/${id}/finalize`, {}));
            button(content, 'Cancel transition', () => post(`/lifecycle/${id}/cancel`, {}));
          } else if (info.state !== 'archived') {
            const begin = (kind, targetRootSessionId = '') => {
              const body = { commandId: root.crypto.randomUUID(), kind, expectedVersion: info.version, targetRootSessionId };
              const submit = () => post('/lifecycle', body, submit); submit();
            };
            button(content, 'Request team archive', () => begin('archive'));
            const target = document.createElement('input'); target.placeholder = 'Existing root session ID'; content.appendChild(target);
            button(content, 'Request root rebind', () => { if (target.value.trim()) begin('rebind_root', target.value.trim()); });
            add(content, 'p', 'These requests pause new admissions. Finalize after active work and pending operations are resolved. Node session replacement is a separate operation.');
            for (const node of info.nodes || []) {
              const existing = (info.pendingNodeRebinds || []).find(op => op.nodeId === node.nodeId);
              const command = existing ? { commandId: existing.commandId, expectedGeneration: existing.expectedGeneration } : { commandId: root.crypto.randomUUID(), expectedGeneration: node.bindingGeneration };
              const path = `/nodes/${encodeURIComponent(node.nodeId)}/rebind`;
              const submit = () => post(path, command, submit);
              button(content, `${existing ? 'Resume' : 'Replace'} ${node.stableKey} session (generation ${command.expectedGeneration})`, submit);
              if (existing) button(content, `Cancel ${node.stableKey} replacement`, () => post(`${path}/${encodeURIComponent(command.commandId)}/cancel`, {}));
            }
          }
        } catch (error) { content.replaceChildren(); add(content, 'p', `Unable to load team lifecycle: ${error.message}`); button(content, 'All work items', showList); }
      };
      const showIntegrationQueue = async () => {
        content.replaceChildren(); button(content,'All work items',showList); add(content,'h3','Integration queue');
        const output=add(content,'pre','Loading…');
        const field=(placeholder)=>{ const el=document.createElement('input'); el.placeholder=placeholder; content.appendChild(el); return el; };
        const queue=field('Queue ID'), work=field('Validation work item ID'), version=field('Validation work item version'), action=field('Configured check action ID'), check=field('Check ID'), head=field('Expected base HEAD');
        const candidates=field('Ordered candidates JSON: [{"workItemId":"…","candidateDigest":"…"}]'), key=field('Stable enqueue idempotency key');
        const run=async(path,body)=>{ try { const result=await request(path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : undefined); output.textContent=JSON.stringify(result,null,2); } catch(error) { output.textContent=`Not confirmed: ${error.message}`; } };
        button(content,'Refresh queue',()=>run('/integration-queue'));
        button(content,'Enqueue accepted candidates',()=>{ try { run('/integration-queue/enqueue',{candidates:JSON.parse(candidates.value),idempotencyKey:key.value.trim()}); } catch(error) { output.textContent=`Invalid candidate list: ${error.message}`; } });
        button(content,'Inspect queue item',()=>run(`/integration-queue/${encodeURIComponent(queue.value.trim())}`));
        button(content,'Materialize combination',()=>run('/integration-queue/materialize',{queueId:queue.value.trim()}));
        button(content,'Attach validation work',()=>run('/integration-queue/attach-validation',{queueId:queue.value.trim(),validationWorkItemId:work.value.trim(),expectedVersion:Number(version.value)}));
        button(content,'Register configured check',()=>run('/integration-queue/register-check',{queueId:queue.value.trim(),actionId:action.value.trim()}));
        button(content,'Reconcile check evidence',()=>run('/integration-queue/reconcile-check',{checkId:check.value.trim()}));
        const operation=field('Stable integration operation ID');
        button(content,'Commit verified combination',()=>run('/integration-queue/commit',{queueId:queue.value.trim(),expectedHead:head.value.trim(),operationId:operation.value.trim()}));
        add(content,'p','Each step requires current server authorization and evidence. A recorded commit can still have members awaiting acceptance; missing verification is not success.');
        await run('/integration-queue');
      };
      const showTeamConfiguration = async () => {
        content.replaceChildren(); add(content,'p','Loading team configuration…');
        try {
          const data=await request('/team'); content.replaceChildren(); button(content,'All work items',showList);
          add(content,'h3',`Positions and relationships · organization revision ${data.organizationRevision}`);
          add(content,'pre',JSON.stringify(data,null,2));
          const field=(placeholder) => { const el=document.createElement('input'); el.placeholder=placeholder; content.appendChild(el); return el; };
          const node=field('Node ID'), responsibility=field('Responsibility'), capabilities=field('Required capabilities, comma separated'), runtime=field('Preferred runtime'), alternatives=field('Alternative runtimes, comma separated'), capacity=field('Capacity');
          const output=add(content,'p','Capability requirements (run, write, review, delegate) are checked against current grants at admission and during reconciliation; unknown requirements block admission. Each node remains limited to one active task. Runtime preferences are advisory and do not change grants or switch an active runtime.');
          const submit=(path,payload) => { const run=async () => { try { const result=await request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); output.textContent=JSON.stringify(result); } catch(error) { output.textContent=`Not confirmed: ${error.message}`; button(content,'Retry same request',run); } }; run(); };
          button(content,'Save position profile',() => { const id=node.value.trim(); const current=data.profiles.find(p=>p.nodeId===id); submit('/team/profiles',{commandId:root.crypto.randomUUID(),nodeId:id,expectedOrganizationRevision:data.organizationRevision,expectedProfileVersion:current?.version || 0,profile:{responsibility:responsibility.value,capabilityRequirements:capabilities.value.split(',').map(x=>x.trim()).filter(Boolean),runtimePreference:runtime.value,alternativeRuntimes:alternatives.value.split(',').map(x=>x.trim()).filter(Boolean),capacity:Number(capacity.value)}}); });
          const from=field('From node ID'),to=field('To node ID');
          const type=document.createElement('select'); for(const value of ['REVIEWS','CONSULTS']) { const option=document.createElement('option'); option.value=value; option.textContent=value; type.appendChild(option); } content.appendChild(type);
          const required=document.createElement('input'); required.type='checkbox'; content.appendChild(required); add(content,'span','Propose required review');
          button(content,'Add relationship',() => submit('/team/relations',{commandId:root.crypto.randomUUID(),fromNodeId:from.value.trim(),toNodeId:to.value.trim(),edgeType:type.value,requiredReview:required.checked,expectedOrganizationRevision:data.organizationRevision}));
          const retiredRelation=field('Relationship ID to retire');
          button(content,'Retire relationship',()=>submit('/team/retire-relation',{commandId:root.crypto.randomUUID(),relationId:retiredRelation.value.trim(),expectedOrganizationRevision:data.organizationRevision,expectedRelationVersion:data.currentRelationVersion}));
          add(content,'p','Required review remains a proposal; the impact report identifies contracts that need amendment.');
        } catch(error) { content.replaceChildren(); add(content,'p',`Unable to load team configuration: ${error.message}`); button(content,'All work items',showList); }
      };
      if (initialResponsibilityId) await showResponsibility(initialResponsibilityId); else if (openResponsibilities) await showResponsibilities(); else await showList();
    }

    // --- Pointer & Gesture Handling (Pan / Pinch / Wheel Zoom) ---

    onPointerDown(e) {
      if (e.target.closest(".org-node") || e.target.closest(".org-radar-top-bar") || e.target.closest(".org-radar-bottom-container")) {
        return;
      }
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchPointers.size === 1) {
        this.isPanning = true;
        this.pointerStart = { x: e.clientX, y: e.clientY };
        this.panStart = { x: this.pan.x, y: this.pan.y };
      } else if (this.touchPointers.size === 2) {
        this.isPanning = false;
        const pts = Array.from(this.touchPointers.values());
        this.lastPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
    }

    onPointerMove(e) {
      if (!this.touchPointers.has(e.pointerId)) return;
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.touchPointers.size === 1 && this.isPanning) {
        const dx = e.clientX - this.pointerStart.x;
        const dy = e.clientY - this.pointerStart.y;
        this.pan.x = this.panStart.x + dx;
        this.pan.y = this.panStart.y + dy;
        this.applyTransform();
      } else if (this.touchPointers.size === 2) {
        const pts = Array.from(this.touchPointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.lastPinchDist > 0) {
          const factor = dist / this.lastPinchDist;
          const midX = (pts[0].x + pts[1].x) / 2;
          const midY = (pts[0].y + pts[1].y) / 2;
          this.zoomAt(factor, midX, midY);
        }
        this.lastPinchDist = dist;
      }
    }

    onPointerUp(e) {
      this.touchPointers.delete(e.pointerId);
      if (this.touchPointers.size === 0) {
        this.isPanning = false;
        this.lastPinchDist = 0;
      } else if (this.touchPointers.size === 1) {
        const remaining = Array.from(this.touchPointers.values())[0];
        this.isPanning = true;
        this.pointerStart = { x: remaining.x, y: remaining.y };
        this.panStart = { x: this.pan.x, y: this.pan.y };
      }
    }

    onWheel(e) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      this.zoomAt(factor, e.clientX, e.clientY);
    }

    zoomAt(factor, clientX, clientY) {
      const oldZoom = this.zoom;
      const newZoom = Math.min(2.25, Math.max(0.75, oldZoom * factor));
      if (Math.abs(newZoom - oldZoom) < 0.001) return;

      const vpRect = this.dom.viewport.getBoundingClientRect();
      const originX = clientX - vpRect.left;
      const originY = clientY - vpRect.top;

      // Adjust pan to zoom towards pointer
      this.pan.x = originX - (originX - this.pan.x) * (newZoom / oldZoom);
      this.pan.y = originY - (originY - this.pan.y) * (newZoom / oldZoom);
      this.zoom = newZoom;
      this.applyTransform();
    }

    applyTransform() {
      if (this.dom.transformLayer) {
        this.dom.transformLayer.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      }
    }

    resetView() {
      if (!this.layoutResult || !this.layoutResult.bounds) {
        this.pan = { x: 0, y: 0 };
        this.zoom = 1.0;
        this.applyTransform();
        return;
      }
      const b = this.layoutResult.bounds;
      const graphW = Math.max(100, b.maxX - b.minX);
      const graphH = Math.max(100, b.maxY - b.minY);

      this.updateViewportDimensions();
      const fitZoom = Math.min(1.2, Math.max(0.75, Math.min((this.viewportWidth * 0.85) / graphW, (this.viewportHeight * 0.7) / graphH)));
      const graphCenterX = (b.minX + b.maxX) / 2;
      const graphCenterY = (b.minY + b.maxY) / 2;

      this.zoom = fitZoom;
      this.pan.x = this.viewportWidth / 2 - graphCenterX * fitZoom;
      this.pan.y = Math.max(20, this.viewportHeight * 0.35 - graphCenterY * fitZoom);
      this.applyTransform();
    }

    // --- Session & Realtime Hooks ---

    getFetcher() {
      if (typeof root.ragentFetch === "function") return root.ragentFetch;
      if (typeof root.fetch === "function") return root.fetch;
      if (typeof fetch === "function") return fetch;
      return null;
    }

    stopPolling() {
      if (this.pollTimerId) {
        clearInterval(this.pollTimerId);
        this.pollTimerId = null;
      }
    }

    startPolling() {
      this.stopPolling();
      if (!this.active || !this.sessionId) return;
      this.pollTimerId = setInterval(() => {
        if (!this.active || !this.sessionId) {
          this.stopPolling();
          return;
        }
        void this.refreshOrganizationData({ force: false });
      }, 3000);
    }

    stopDetailPolling() {
      this.detailRequestEpoch += 1;
      if (this.detailPollTimerId) {
        clearInterval(this.detailPollTimerId);
        this.detailPollTimerId = null;
      }
    }

    onSessionChanged(sessionId) {
      const normalized = sessionId || null;
      if (this.sessionId === normalized) {
        if (normalized && !this.refreshInFlight && Date.now() - this.lastRefreshAt > 1500) {
          void this.refreshOrganizationData({ force: false });
        }
        return;
      }

      this.sessionId = normalized;
      this.projection = null;
      this.projectionEtag = null;
      this.rawUnifiedMembers = null;
      this.membersLoadedAt = 0;
      this.delegationRuns = [];
      this.delegationRecords = [];
      this.delegationEvents = [];
      this.delegationCursors = {};
      this.delegationFinished = {};
      this.delegationScannedAt = {};
      this.delegationGap = false;
      this.delegationSourceAvailability = "unknown";
      this.lastRefreshAt = 0;
      this.focusNodeId = null;
      this.selectedSheetNodeId = null;
      this.detailNodeId = null;
      this.previousPositions = {};
      this.previousParents = {};
      this.activityEvents = [];
      this.nativeBoard = null;
      this.swarmStatus = null;
      this.boardProjection = null;
      this.selectedBoardChannel = "all";
      this.boardReplyToSeq = null;
      this.boardComposerDraft = "";
      this.boardComposerBusy = false;
      this.boardComposerError = "";
      this.boardChannelDraft = "";
      this.boardChannelBusy = false;
      this.boardChannelError = "";
      this.userCollapsedBoard = false;
      this.killConfirmTargetId = null;
      this.killConflictInfo = null;
      this.killBusy = false;
      this.killError = "";
      this.stopPolling();
      this.dismissBottomSheet();
      this.closeDetailScreen();

      if (!normalized) {
        this.setRadarButtonVisibility(false);
        if (this.active) this.toggleOrganizationMode(false);
        return;
      }

      void this.refreshOrganizationData({ force: true, checkUrlParams: true });
    }

    hasCollaborators() {
      const hasFormalNodes = Boolean(this.projection && Array.isArray(this.projection.nodes) && this.projection.nodes.length > 0);
      if (hasFormalNodes) return true;
      if (Array.isArray(this.swarmStatus?.members) && this.swarmStatus.members.length > 0) return true;
      if (this.boardProjection?.mode === "ragent_swarm") return true;
      if (Array.isArray(this.boardProjection?.board?.messages) && this.boardProjection.board.messages.length > 0) return true;
      const membersPage = this.rawUnifiedMembers || (Array.isArray(this.projection?.members) ? this.projection : null);
      const hasUnifiedSubagents = Boolean(
        membersPage &&
        Array.isArray(membersPage.members) &&
        membersPage.members.some((m) => m && m.canonicalId && m.canonicalId !== membersPage.rootCanonicalId)
      );
      if (hasUnifiedSubagents) return true;
      return Array.isArray(this.delegationRecords) && this.delegationRecords.length > 0;
    }

    async refreshOrganizationData({ force = false, checkUrlParams = false } = {}) {
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return null;
      if (this.refreshInFlight && !force) return this.refreshInFlight;

      const projectionPromise = this.fetchProjection(force);
      const membersPromise = this.fetchUnifiedMembers(force);
      const delegationsPromise = this.fetchDelegationRuns(force);
      const swarmStatusPromise = this.fetchSwarmStatus(force);
      const boardPromise = this.fetchBoardProjection(force);

      const run = Promise.all([projectionPromise, membersPromise, delegationsPromise, swarmStatusPromise, boardPromise])
        .then(([proj]) => {
          if (this.sessionId !== targetSessionId) return null;
          this.lastRefreshAt = Date.now();
          this.processProjectionEvents(this.projection || proj);
          const hasOrgOrMembers = this.hasCollaborators();
          this.setRadarButtonVisibility(hasOrgOrMembers);

          if (this.active) {
            if (hasOrgOrMembers) {
              this.render();
            } else if (!this.loading) {
              this.toggleOrganizationMode(false);
            }
          }

          if (checkUrlParams && root.location?.href) {
            try {
              const url = new URL(root.location.href);
              const responsibilityId = url.searchParams.get("responsibility");
              if (responsibilityId && url.searchParams.get("session") === targetSessionId) {
                url.searchParams.delete("responsibility");
                root.history?.replaceState?.(root.history.state, "", url);
                void this.openResponsibilityLink(targetSessionId, responsibilityId);
              } else if (url.searchParams.get("organization") === "responsibilities" && url.searchParams.get("session") === targetSessionId && (this.projection || proj)?.organizationId) {
                url.searchParams.delete("organization");
                root.history?.replaceState?.(root.history.state, "", url);
                this.toggleOrganizationMode(true);
                void this.showFactoryWork("", true);
              }
            } catch {
              /* ignore invalid URL in partial environments */
            }
          }
          return proj;
        })
        .finally(() => {
          if (this.refreshInFlight === run) {
            this.refreshInFlight = null;
          }
        });

      this.refreshInFlight = run;
      return run;
    }

    async openResponsibilityLink(sessionId, responsibilityId) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(String(responsibilityId || "")) || this.sessionId !== sessionId) return;
      const projection = await this.fetchProjection(true);
      if (!projection?.organizationId || this.sessionId !== sessionId) return;
      this.toggleOrganizationMode(true);
      await this.showFactoryWork(responsibilityId);
    }

    setRadarButtonVisibility(visible) {
      if (this.dom.radarBtn) {
        this.dom.radarBtn.hidden = !visible;
      }
      if (this.dom.overflowRadarBtn) {
        this.dom.overflowRadarBtn.hidden = !visible;
      }
      if (typeof root.syncHeaderOverflowMenu === "function") {
        root.syncHeaderOverflowMenu();
      }
    }

    async fetchProjection(force = false) {
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return null;
      if (this.loading && !force) return this.projection;
      const fetcher = this.getFetcher();
      if (!fetcher) return this.projection;
      this.loading = true;

      try {
        const headers = { Accept: "application/json" };
        if (this.projectionEtag && !force) {
          headers["If-None-Match"] = this.projectionEtag;
        }
        const res = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/organization/projection?version=2`, {
          credentials: "same-origin",
          cache: "no-store",
          headers,
        });
        if (this.sessionId !== targetSessionId) return null;

        if (res.status === 304) {
          return this.projection;
        }

        if (!res.ok) {
          if (res.status === 404 || res.status === 401 || res.status === 403) {
            this.projection = null;
            this.projectionEtag = null;
            return null;
          }
          throw new Error(`Failed to load organization projection: ${res.status}`);
        }

        this.projectionEtag = res.headers?.get?.("ETag") || this.projectionEtag;
        const payload = await res.json();
        if (this.sessionId !== targetSessionId) return null;
        const proj = payload?.projection || payload;
        this.projection = proj;
        this.hasLoadedEver = true;

        this.processProjectionEvents(proj);
        return proj;
      } catch (err) {
        console.warn("[organization-view] Failed to fetch projection:", err);
        return null;
      } finally {
        this.loading = false;
      }
    }

    async fetchSwarmStatus(_force = false) {
      this.ensureSwarmUiState();
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/organization/swarm/status`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (this.sessionId !== targetSessionId) return null;
        if (!res.ok) {
          if (res.status === 404 || res.status === 401 || res.status === 403) {
            this.swarmStatus = null;
          }
          return null;
        }
        const data = await res.json();
        if (this.sessionId !== targetSessionId) return null;
        this.swarmStatus = data && typeof data === "object" ? data : null;
        return this.swarmStatus;
      } catch (err) {
        console.warn("[organization-view] Failed to fetch swarm status:", err);
        return null;
      }
    }

    async fetchBoardProjection(_force = false) {
      this.ensureSwarmUiState();
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      try {
        const params = new URLSearchParams({ limit: "100" });
        const selected = typeof this.selectedBoardChannel === "string" ? this.selectedBoardChannel.trim() : "";
        if (selected && selected !== "all") {
          params.set("channel", selected);
        }
        const res = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/organization/board?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (this.sessionId !== targetSessionId) return null;
        if (!res.ok) {
          if (res.status === 404 || res.status === 401 || res.status === 403) {
            this.boardProjection = null;
          }
          return null;
        }
        const data = await res.json();
        if (this.sessionId !== targetSessionId) return null;
        this.boardProjection = data && typeof data === "object" ? data : null;
        return this.boardProjection;
      } catch (err) {
        console.warn("[organization-view] Failed to fetch board projection:", err);
        return null;
      }
    }

    async fetchUnifiedMembers(_force = false) {
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;

      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/organization/members`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (this.sessionId !== targetSessionId) return null;
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            this.rawUnifiedMembers = null;
          }
          return null;
        }
        const page = await res.json();
        if (this.sessionId !== targetSessionId) return null;
        if (!page || page.rootSessionId !== targetSessionId || !Array.isArray(page.members)) {
          return null;
        }
        const canonicalIds = page.members.map((m) => m?.canonicalId).filter(Boolean);
        if (new Set(canonicalIds).size !== page.members.length) {
          return null;
        }

        const previous =
          this.rawUnifiedMembers &&
          this.rawUnifiedMembers.rootSessionId === page.rootSessionId &&
          this.rawUnifiedMembers.rootCanonicalId === page.rootCanonicalId
            ? this.rawUnifiedMembers
            : null;
        const trustedComplete = Boolean(page.membersComplete) && page.sourceCoverage?.gap === false;

        if (trustedComplete || !previous) {
          this.rawUnifiedMembers = page;
        } else {
          const merged = new Map();
          for (const prev of previous.members || []) {
            if (!prev?.canonicalId) continue;
            merged.set(prev.canonicalId, { ...prev, activity: null });
          }
          for (const member of page.members) {
            const old = merged.get(member.canonicalId);
            if (!old) {
              merged.set(member.canonicalId, member);
            } else {
              const aliasMap = new Map();
              for (const alias of [...(old.aliases || []), ...(member.aliases || [])]) {
                if (!alias) continue;
                aliasMap.set(`${alias.kind || ""}\0${alias.runId || ""}\0${alias.id || ""}`, alias);
              }
              merged.set(member.canonicalId, {
                ...member,
                sourceTag: member.sourceTag || old.sourceTag || null,
                executionHarnessId: member.executionHarnessId || old.executionHarnessId || null,
                aliases: Array.from(aliasMap.values()),
                parentCanonicalId: member.relationKnown ? member.parentCanonicalId : old.parentCanonicalId,
                relationKnown: Boolean(member.relationKnown || old.relationKnown),
                birth: member.birth || old.birth || null,
                conversation: member.conversation || old.conversation || null,
              });
            }
          }
          this.rawUnifiedMembers = {
            ...page,
            members: Array.from(merged.values()),
          };
        }

        this.membersLoadedAt = Date.now();
        return this.rawUnifiedMembers;
      } catch (err) {
        console.warn("[organization-view] Failed to fetch organization members:", err);
        return null;
      }
    }

    async fetchDelegationRuns(_force = false) {
      const targetSessionId = this.sessionId;
      if (!targetSessionId) return [];
      const fetcher = this.getFetcher();
      if (!fetcher) return [];

      try {
        const runsRes = await fetcher(`/api/sessions/${encodeURIComponent(targetSessionId)}/delegation-runs`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (this.sessionId !== targetSessionId) return [];
        if (!runsRes.ok) {
          if (runsRes.status === 401 || runsRes.status === 403) {
            this.delegationRuns = [];
            this.delegationRecords = [];
            this.delegationEvents = [];
            this.delegationCursors = {};
            this.delegationFinished = {};
          }
          return [];
        }

        const runsPayload = await runsRes.json();
        if (this.sessionId !== targetSessionId) return [];
        const runs = Array.isArray(runsPayload?.runs) ? runsPayload.runs : [];
        this.delegationRuns = runs;
        if (runs.length === 0) {
          this.delegationRecords = [];
          this.delegationEvents = [];
          this.delegationGap = false;
          this.delegationSourceAvailability = "empty";
          return [];
        }

        let nextRecords = [...this.delegationRecords];
        let nextEvents = [...this.delegationEvents];
        let anyGap = false;
        let lastAvailability = "verified";
        const nowMs = Date.now();
        const terminalStates = new Set(["completed", "failed", "cancelled", "interrupted"]);

        for (const run of runs.slice(-16)) {
          if (!run?.id) continue;
          const version = `${run.state || ""}:${run.updatedAt || ""}`;
          const lastScan = this.delegationScannedAt[run.id] || 0;
          if (this.delegationFinished[run.id] === version && (run.updatedAt || nowMs - lastScan < 60000)) {
            continue;
          }

          let cursor = this.delegationCursors[run.id] || 0;
          let more = true;
          let reachedTail = false;
          for (let pageIndex = 0; pageIndex < 10 && more; pageIndex += 1) {
            const evRes = await fetcher(
              `/api/sessions/${encodeURIComponent(targetSessionId)}/delegation-runs/${encodeURIComponent(run.id)}/events?afterLines=${cursor}`,
              { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } }
            );
            if (this.sessionId !== targetSessionId) return [];
            if (!evRes.ok) {
              if (evRes.status === 401 || evRes.status === 403) {
                this.delegationRecords = [];
                this.delegationEvents = [];
                return [];
              }
              anyGap = true;
              break;
            }
            const page = await evRes.json();
            if (this.sessionId !== targetSessionId) return [];
            if (page?.sourceAvailability) lastAvailability = page.sourceAvailability;
            if (page?.gap || page?.sourceAvailability !== "verified") anyGap = true;

            if (Array.isArray(page?.delegations)) {
              if (!page.gap) {
                nextRecords = nextRecords.filter((rec) => rec.runId !== run.id).concat(page.delegations);
              } else {
                const byKey = new Map(nextRecords.map((rec) => [`${rec.runId}\0${rec.delegationId}`, rec]));
                for (const rec of page.delegations) {
                  if (rec?.runId && rec?.delegationId) {
                    byKey.set(`${rec.runId}\0${rec.delegationId}`, rec);
                  }
                }
                nextRecords = Array.from(byKey.values());
              }
            }

            if (Array.isArray(page?.events) && page.events.length > 0) {
              const evByKey = new Map(nextEvents.map((ev) => [`${ev.runId}\0${ev.id}`, ev]));
              for (const ev of page.events) {
                if (ev?.id) {
                  evByKey.set(`${ev.runId || run.id}\0${ev.id}`, { ...ev, runId: ev.runId || run.id });
                }
              }
              nextEvents = Array.from(evByKey.values()).slice(-500);
            }

            const nextCursor = Math.max(cursor, Number(page?.nextAfterLines || 0));
            this.delegationCursors[run.id] = nextCursor;
            more = page?.hasMore === true && nextCursor > cursor;
            if (page?.hasMore === true && !more) anyGap = true;
            cursor = nextCursor;
            reachedTail = !page?.hasMore && !page?.gap;
          }

          if (reachedTail && terminalStates.has(String(run.state || "").toLowerCase())) {
            this.delegationFinished[run.id] = version;
            this.delegationScannedAt[run.id] = Date.now();
          } else {
            delete this.delegationFinished[run.id];
          }
        }

        this.delegationRecords = nextRecords;
        this.delegationEvents = nextEvents;
        this.delegationGap = anyGap;
        this.delegationSourceAvailability = lastAvailability;
        return nextRecords;
      } catch (err) {
        console.warn("[organization-view] Failed to fetch delegation runs:", err);
        return [];
      }
    }

    handleInvalidation(msg = {}) {
      if (!this.sessionId) return;
      if (msg.organizationId && this.projection?.organizationId && msg.organizationId !== this.projection.organizationId) {
        return;
      }
      const nextRev = Number(msg.revision || 0);
      const rawCurrRev = typeof this.projection?.revision === "object"
        ? this.projection?.revision?.number
        : this.projection?.revision;
      const currRev = Number(rawCurrRev || this.projection?.asOf?.revision || 0);
      if (nextRev && currRev && nextRev < currRev) return;

      this.refreshOrganizationData({ force: true }).then(() => {
        if (this.active) {
          this.render();
        }
      });
    }

    processProjectionEvents(proj) {
      const activeProj = proj || this.projection;
      const model = this.buildUnifiedGraphModel(activeProj);

      // A blocker is not an approval request; the old buttons had no command.
      this.approvalOverlay = null;

      // Schedule particles for active formal/unified nodes & edges
      const nodesList = Object.values(model.nodesMap);
      const edgesList = model.edgesList;
      nodesList.forEach((node) => {
        if (node.isRootLeader) return;
        if (node.runtimeState === NodeRuntimeState.WORKING) {
          const parentEdge = edgesList.find((e) => e.toNodeId === node.id);
          if (parentEdge) {
            this.communicationScheduler.scheduleCommunication(
              `comm_${node.id}_${Date.now()}`,
              CommunicationType.TASK_ASSIGNED,
              parentEdge.fromNodeId,
              node.id
            );
          }
        } else if (node.runtimeState === NodeRuntimeState.REVIEWING) {
          const reviewerEdge = edgesList.find((e) => String(e.type || "").toUpperCase() === "REVIEWS" && (e.fromNodeId === node.id || e.toNodeId === node.id));
          if (reviewerEdge) {
            this.communicationScheduler.scheduleCommunication(
              `comm_rev_${node.id}_${Date.now()}`,
              CommunicationType.REVIEW_REQUESTED,
              node.id,
              reviewerEdge.fromNodeId === node.id ? reviewerEdge.toNodeId : reviewerEdge.fromNodeId
            );
          }
        }
      });

      // Update Activity Feed across formal + unified/native members
      const activities = [];
      nodesList.forEach((node) => {
        if (node.currentActivity) {
          activities.push({
            id: `act_${node.id}`,
            dotClass:
              node.runtimeState === NodeRuntimeState.BLOCKED || node.runtimeState === NodeRuntimeState.FAILED
                ? "error"
                : node.runtimeState === NodeRuntimeState.WORKING
                  ? "running"
                  : node.runtimeState === NodeRuntimeState.DONE
                    ? "success"
                    : "waiting",
            message: `${node.displayName}: ${node.currentActivity}`,
            time: "now",
          });
        }
      });
      for (const ev of (this.delegationEvents || []).slice(-10).reverse()) {
        if (!ev?.kind) continue;
        const source = ev.details ? `${ev.kind} (${ev.details})` : ev.kind;
        activities.push({
          id: `delg_ev_${ev.runId}_${ev.id}`,
          dotClass: ev.state === "failed" || ev.state === "lost" ? "error" : ev.state === "completed" ? "success" : ev.state === "running" || ev.state === "spawned" ? "running" : "waiting",
          message: `${ev.delegationId || "subagent"}: ${source}`,
          time: "now",
        });
      }
      this.activityEvents = activities.slice(0, 20);
    }

    // --- Mode Switching (Timeline <-> Organization Radar) ---

    toggleOrganizationMode(targetActive) {
      const nextActive = typeof targetActive === "boolean" ? targetActive : !this.active;
      if (this.active === nextActive) return;
      this.active = nextActive;

      const surface = this.dom.surface;
      const messages = document.getElementById("messages");
      const homeWs = document.getElementById("homeWorkspace");

      if (this.active) {
        if (messages) messages.hidden = true;
        if (homeWs) homeWs.hidden = true;
        if (surface) surface.hidden = false;

        if (this.dom.radarBtn) {
          this.dom.radarBtn.classList.add("is-active");
          this.dom.radarBtn.setAttribute("aria-expanded", "true");
        }
        if (this.dom.overflowRadarBtn) {
          this.dom.overflowRadarBtn.classList.add("is-active");
        }

        this.updateViewportDimensions();
        this.render();
        this.resetView();
        this.startAnimationLoop();
        if (this.sessionId) {
          void this.refreshOrganizationData({ force: true });
          this.startPolling();
        }
      } else {
        this.stopPolling();
        if (surface) surface.hidden = true;
        if (messages) messages.hidden = false;
        if (this.dom.radarBtn) {
          this.dom.radarBtn.classList.remove("is-active");
          this.dom.radarBtn.setAttribute("aria-expanded", "false");
        }
        if (this.dom.overflowRadarBtn) {
          this.dom.overflowRadarBtn.classList.remove("is-active");
        }
        this.dismissBottomSheet();
        this.closeDetailScreen();
        this.stopAnimationLoop();
      }
    }

    // --- Animation Clock & Canvas Rendering ---

    startAnimationLoop() {
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
      const loop = () => {
        if (!this.active) return;
        this.renderCanvasFrame();
        this.animationFrameId = requestAnimationFrame(loop);
      };
      this.animationFrameId = requestAnimationFrame(loop);
    }

    stopAnimationLoop() {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }

    renderCanvasFrame() {
      const canvas = this.dom.canvas;
      if (!canvas || !this.layoutResult) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const b = this.layoutResult.bounds;
      const width = Math.max(this.viewportWidth * 2, (b.maxX - b.minX) + 600);
      const height = Math.max(this.viewportHeight * 2, (b.maxY - b.minY) + 600);

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // 1. Draw Edges
      const edges = this.layoutResult.edges || [];
      edges.forEach((edge) => {
        ctx.save();
        ctx.beginPath();
        if (edge.isReview && typeof ctx.setLineDash === "function") {
          ctx.setLineDash([5, 5]);
        }
        ctx.moveTo(edge.start.x, edge.start.y);
        ctx.bezierCurveTo(edge.control1.x, edge.control1.y, edge.control2.x, edge.control2.y, edge.end.x, edge.end.y);
        ctx.strokeStyle = `rgba(148, 163, 184, ${edge.alpha || 0.6})`;
        ctx.lineWidth = 1.75;
        ctx.stroke();
        ctx.restore();
      });

      // 2. Update & Draw Active Particles
      const now = Date.now();
      const nodePos = this.layoutResult.nodePositions;
      const particles = this.communicationScheduler.updateTick(nodePos, now);

      particles.forEach((p) => {
        ctx.save();
        ctx.translate(p.currentX, p.currentY);

        let color = "#3b82f6"; // Blue (Task assigned)
        let isDiamond = false;
        if (p.type === CommunicationType.RESULT_AVAILABLE) {
          color = "#10b981"; // Emerald
          isDiamond = true;
        } else if (p.type === CommunicationType.REVIEW_REQUESTED || p.type === CommunicationType.REVIEW_COMPLETED) {
          color = "#f59e0b"; // Amber
          isDiamond = true;
        } else if (p.type === CommunicationType.BLOCKER_ESCALATED) {
          color = "#ef4444"; // Red
        } else if (p.type === CommunicationType.HANDOFF_AVAILABLE) {
          color = "#8b5cf6"; // Purple
        }

        // Particle Outer Glow
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, 2 * Math.PI);
        ctx.fillStyle = `${color}33`;
        ctx.fill();

        if (isDiamond) {
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = color;
          ctx.fillRect(-3.5, -3.5, 7, 7);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, 4, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.restore();
      });

      ctx.restore();
    }

    // --- Unified Member & Formal Organization Graph Model ---

    buildUnifiedGraphModel(explicitProj = null) {
      const proj = explicitProj || this.projection || {};
      const rawNodes = Array.isArray(proj.nodes) ? proj.nodes : [];
      const rawEdges = Array.isArray(proj.edges) ? proj.edges : [];
      const hasFormalOrg = rawNodes.length > 0;

      const nodesMap = {};
      rawNodes.forEach((n) => {
        const id = n.id || n.stableKey;
        if (!id) return;
        const role = NodeRole.fromString(n.nodeRole || n.role || n.sessionClass);
        const domain = typeof n.domain === "string" ? n.domain : null;
        const iconDomain = AgentDomain.fromExplicit(n.domain, n.iconKey);
        const hasBlocker = Boolean(n.blocker || n.status === "blocked");
        const runtimeState = NodeRuntimeState.fromString(n.status, n.currentActivity, hasBlocker);
        const memberDesc = n.member || null;
        const boundSessionId = n.currentBinding?.sessionId || n.currentSessionId || n.sessionId || null;
        const coverage = normalizeCoverage(
          memberDesc?.conversation?.scope || (boundSessionId ? "full" : "unavailable"),
          memberDesc?.conversation?.coverage || "",
          false,
          memberDesc?.conversation?.availability || ""
        );
        const resultPacketId = n.attempt?.resultPacketId || n.resultPacketId || null;

        nodesMap[id] = {
          id,
          parentId: n.parentNodeId || n.parentId || null,
          role,
          domain,
          iconDomain,
          displayName: n.displayName || n.stableKey || id,
          phaseId: n.phaseId || null,
          runtimeState,
          sessionId: boundSessionId,
          providerRef: null,
          currentActivity: n.activity?.kind || n.currentActivity || null,
          currentTaskSummary:
            n.currentTask?.objective ||
            n.task?.objective ||
            n.currentTaskSummary ||
            (n.progress && Number.isFinite(n.progress.total) && n.progress.total > 0
              ? `${tr("organization.working")} (${n.progress.completed}/${n.progress.total})`
              : null),
          currentTaskDetail: n.task?.detail || n.currentTaskDetail || n.responsibility || null,
          progressCompleted: n.progress?.completed || 0,
          progressTotal: n.progress?.total || 0,
          blockerText: n.blocker?.reason || n.blocker?.reasonCode || (hasBlocker ? tr("organization.blocked") : null),
          testsPassed: n.testsPassed || 0,
          testsTotal: n.testsTotal || 0,
          changedFiles: n.changedFiles || [],
          resultPacketSummary: resultPacketId ? `${tr("organization.resultPacket")}: ${resultPacketId}` : null,
          isRootLeader: role === NodeRole.EXECUTIVE,
          memberKind: "formal",
          isNativeMember: false,
          isReadOnlyNative: false,
          canOpenInbox: Boolean(proj.organizationId),
          canonicalId: memberDesc?.canonicalId || null,
          sourceTag: memberDesc?.sourceTag || "ragent",
          executionHarnessId: n.executionHarnessId || memberDesc?.executionHarnessId || n.runtime?.tool || n.runtime?.provider || null,
          conversationDescriptor: memberDesc?.conversation || null,
          coverage,
          sourceGap: false,
          relationKnown: true,
          parentUnknown: false,
          activity: n.activity || null,
          stateUnknown: false,
          rawNativeState: null,
        };
      });

      const membersPage =
        this.rawUnifiedMembers ||
        (Array.isArray(proj.members) && proj.members.length > 0
          ? {
              rootSessionId: proj.rootSessionId || this.sessionId || "",
              rootCanonicalId: proj.rootCanonicalId || "",
              members: proj.members,
              membersComplete: Boolean(proj.membersComplete),
              sourceCoverage: proj.sourceCoverage || null,
              board: proj.board || null,
            }
          : null);
      this.nativeBoard = membersPage?.board || proj.board || null;

      const delegationByKey = new Map();
      const sortedRecords = [...(this.delegationRecords || [])]
        .filter((rec) => rec && rec.runId && rec.delegationId)
        .sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || String(a.runId).localeCompare(String(b.runId)) || String(a.delegationId).localeCompare(String(b.delegationId)));
      for (const rec of sortedRecords) {
        const key = `${rec.runId}\0${rec.delegationId}`;
        const prev = delegationByKey.get(key);
        const prevTime = prev ? (prev.updatedAt ?? prev.startedAt ?? 0) : -1;
        const nextTime = rec.updatedAt ?? rec.startedAt ?? 0;
        if (!prev || nextTime >= prevTime) {
          delegationByKey.set(key, rec);
        }
      }

      const confirmedRootChildren = new Set();
      for (const ev of this.delegationEvents || []) {
        if (
          ev &&
          ev.kind === "spawned" &&
          !ev.parentDelegationId &&
          ev.birthActor === "root_session" &&
          ev.runId &&
          ev.delegationId &&
          (!this.sessionId || !ev.parentSessionId || ev.parentSessionId === this.sessionId)
        ) {
          confirmedRootChildren.add(`${ev.runId}\0${ev.delegationId}`);
        }
      }

      // Determine root node ID
      let rootId = null;
      const formalValues = Object.values(nodesMap);
      if (formalValues.length > 0) {
        const sessionId = proj.rootSessionId || this.sessionId;
        const sessionMatches = sessionId ? formalValues.filter((n) => n.sessionId === sessionId) : [];
        if (sessionMatches.length === 1) {
          rootId = sessionMatches[0].id;
        } else if (sessionMatches.length === 0) {
          const noParent = formalValues.filter((n) => !n.parentId);
          rootId = noParent.length === 1
            ? noParent[0].id
            : (formalValues.find((n) => n.role === NodeRole.EXECUTIVE)?.id || formalValues[0].id);
        } else {
          rootId = formalValues.find((n) => n.role === NodeRole.EXECUTIVE)?.id || sessionMatches[0].id;
        }
      } else if ((membersPage?.members?.length || 0) > 0 || delegationByKey.size > 0) {
        rootId = membersPage?.rootCanonicalId || `native-root:${this.sessionId || "session"}`;
        nodesMap[rootId] = {
          id: rootId,
          parentId: null,
          role: NodeRole.EXECUTIVE,
          domain: null,
          iconDomain: AgentDomain.GENERAL,
          displayName: trText("organization.nativeRoot", "Root session", "根会话"),
          phaseId: null,
          runtimeState: NodeRuntimeState.IDLE,
          sessionId: this.sessionId || null,
          providerRef: null,
          currentActivity: null,
          currentTaskSummary: null,
          currentTaskDetail: null,
          progressCompleted: 0,
          progressTotal: 0,
          blockerText: null,
          testsPassed: 0,
          testsTotal: 0,
          changedFiles: [],
          resultPacketSummary: null,
          isRootLeader: true,
          isSyntheticRoot: true,
          memberKind: "root_session",
          isNativeMember: false,
          isReadOnlyNative: false,
          canOpenInbox: false,
          canonicalId: rootId,
          sourceTag: "ragent",
          executionHarnessId: null,
          conversationDescriptor: null,
          coverage: "unavailable",
          sourceGap: false,
          relationKnown: true,
          parentUnknown: false,
          activity: null,
          stateUnknown: false,
          rawNativeState: null,
        };
      }

      // Deduplicate formal members by verified canonical IDs and formal aliases
      const formalByCanonical = new Map();
      for (const node of formalValues) {
        if (node.canonicalId) formalByCanonical.set(node.canonicalId, node.id);
      }
      const memberList = Array.isArray(membersPage?.members) ? membersPage.members : [];
      for (const member of memberList) {
        if (!member?.canonicalId) continue;
        const formalMatches = Array.from(
          new Set(
            (member.aliases || [])
              .filter((a) => a?.kind === "formal" && a.id && nodesMap[a.id])
              .map((a) => a.id)
          )
        );
        if (formalMatches.length === 1 && !formalByCanonical.has(member.canonicalId)) {
          formalByCanonical.set(member.canonicalId, formalMatches[0]);
        }
        // Enrich matched formal or root node with non-empty provenance/activity
        const matchedNodeId =
          member.canonicalId === membersPage?.rootCanonicalId
            ? rootId
            : formalByCanonical.get(member.canonicalId);
        if (matchedNodeId && nodesMap[matchedNodeId]) {
          const target = nodesMap[matchedNodeId];
          if (!target.executionHarnessId && member.executionHarnessId) {
            target.executionHarnessId = member.executionHarnessId;
          }
          if (!target.sourceTag && member.sourceTag) {
            target.sourceTag = member.sourceTag;
          }
          if (!target.conversationDescriptor && member.conversation) {
            target.conversationDescriptor = member.conversation;
            target.coverage = normalizeCoverage(
              member.conversation.scope || "unavailable",
              member.conversation.coverage || "",
              target.isReadOnlyNative,
              member.conversation.availability || ""
            );
          }
        }
      }

      const knownCanonical = new Set(memberList.map((m) => m?.canonicalId).filter(Boolean));
      const resolveDisplayId = (canonicalId) => {
        if (!canonicalId) return null;
        if (membersPage?.rootCanonicalId && canonicalId === membersPage.rootCanonicalId) return rootId;
        if (formalByCanonical.has(canonicalId)) return formalByCanonical.get(canonicalId);
        if (knownCanonical.has(canonicalId)) return unifiedUiId(canonicalId);
        return null;
      };

      const legacyAliasToDisplay = new Map();
      const ambiguousLegacyKeys = new Set();
      for (const member of memberList) {
        if (!member?.canonicalId) continue;
        const targetId = resolveDisplayId(member.canonicalId);
        if (!targetId) continue;
        for (const alias of member.aliases || []) {
          if (alias?.kind === "legacy_delegation" && alias.runId && alias.id) {
            const key = `${alias.runId}\0${alias.id}`;
            if (legacyAliasToDisplay.has(key) && legacyAliasToDisplay.get(key) !== targetId) {
              ambiguousLegacyKeys.add(key);
              legacyAliasToDisplay.delete(key);
            } else if (!ambiguousLegacyKeys.has(key)) {
              legacyAliasToDisplay.set(key, targetId);
            }
          }
        }
      }

      const memberLabel = trText("organization.nativeMember", "Member", "成员");
      const additionalMembers = memberList.filter(
        (m) => m?.canonicalId && !formalByCanonical.has(m.canonicalId) && m.canonicalId !== membersPage?.rootCanonicalId
      );

      additionalMembers.forEach((member, index) => {
        const uiId = unifiedUiId(member.canonicalId);
        // Match against delegation records via verified legacy_delegation aliases
        let matchingDelegation = null;
        for (const alias of member.aliases || []) {
          if (alias?.kind === "legacy_delegation" && alias.runId && alias.id) {
            const candidate = delegationByKey.get(`${alias.runId}\0${alias.id}`);
            if (candidate) {
              const candTime = candidate.updatedAt ?? candidate.startedAt ?? 0;
              const prevTime = matchingDelegation ? (matchingDelegation.updatedAt ?? matchingDelegation.startedAt ?? 0) : -1;
              if (!matchingDelegation || candTime >= prevTime) matchingDelegation = candidate;
            }
          }
        }

        // Strict parent honesty: unknown parent stays detached (null), NEVER fabricated
        const resolvedParentId =
          member.relationKnown && member.parentCanonicalId
            ? resolveDisplayId(member.parentCanonicalId)
            : null;
        const relationKnown = Boolean(member.relationKnown && resolvedParentId);
        const parentUnknown = !relationKnown;

        const activityState = member.activity?.state || matchingDelegation?.activity?.state || "unknown";
        const delegationState = matchingDelegation?.state || "";
        const runtimeState = mapMemberRuntimeState(activityState, delegationState);
        const stateUnknown = !delegationState && (!activityState || activityState === "unknown");
        const scope = member.conversation?.scope || "unavailable";
        const coverage = normalizeCoverage(
          scope,
          member.conversation?.coverage || "",
          true,
          member.conversation?.availability || ""
        );
        const activityText =
          matchingDelegation?.currentAction ||
          member.activity?.kind ||
          (activityState && activityState !== "unknown" ? activityState : null);

        const rawName = typeof member.displayName === "string" && member.displayName.trim()
          ? member.displayName.trim()
          : (typeof member.name === "string" && member.name.trim() ? member.name.trim() : "");
        const memberRole = member.role ? NodeRole.fromString(member.role) : NodeRole.WORKER;
        const memberModel = typeof member.model === "string" && member.model.trim() ? member.model.trim() : null;

        nodesMap[uiId] = {
          id: uiId,
          parentId: resolvedParentId,
          role: memberRole,
          domain: null,
          iconDomain: AgentDomain.GENERAL,
          displayName: rawName || `${memberLabel} ${index + 1}`,
          phaseId: null,
          runtimeState,
          sessionId: null,
          providerRef: matchingDelegation?.childSessionId || null,
          model: memberModel,
          controlCapabilities: member.controlCapabilities || { readOnly: true, canControlMember: false, canMessageMember: false },
          currentActivity: activityText,
          currentTaskSummary: null,
          currentTaskDetail: null,
          progressCompleted: 0,
          progressTotal: 0,
          blockerText: delegationState === "lost" ? trText("organization.delegationLost", "Subagent connection lost", "子代理连接已丢失") : null,
          testsPassed: 0,
          testsTotal: 0,
          changedFiles: [],
          resultPacketSummary: null,
          isRootLeader: false,
          memberKind: "unified_member",
          isNativeMember: true,
          isReadOnlyNative: true,
          canOpenInbox: false,
          canonicalId: member.canonicalId,
          sourceTag: member.sourceTag || matchingDelegation?.provider || null,
          executionHarnessId: member.executionHarnessId || matchingDelegation?.provider || null,
          conversationDescriptor: member.conversation || null,
          coverage,
          sourceGap: Boolean(membersPage?.sourceCoverage?.gap),
          relationKnown,
          parentUnknown,
          activity: member.activity || matchingDelegation?.activity || null,
          birth: member.birth || null,
          runId: member.activity?.runId || matchingDelegation?.runId || null,
          stateUnknown,
          rawNativeState: delegationState || activityState || "unknown",
        };
      });

      // Fallback: fold any unmatched delegation-run records that do not yet have a unified member entry
      let fallbackIndex = additionalMembers.length;
      for (const [key, rec] of delegationByKey.entries()) {
        if (legacyAliasToDisplay.has(key) || ambiguousLegacyKeys.has(key)) continue;
        fallbackIndex += 1;
        const uiId = nativeNodeId(rec.runId, rec.delegationId);
        let parentId = null;
        if (rec.parentDelegationId) {
          const parentKey = `${rec.runId}\0${rec.parentDelegationId}`;
          parentId = legacyAliasToDisplay.get(parentKey) || (delegationByKey.has(parentKey) ? nativeNodeId(rec.runId, rec.parentDelegationId) : null);
        } else if (confirmedRootChildren.has(key)) {
          parentId = rootId;
        }
        const relationKnown = Boolean(parentId && nodesMap[parentId]);
        if (!relationKnown) parentId = null;

        const activityState = rec.activity?.state || "unknown";
        const runtimeState = mapMemberRuntimeState(activityState, rec.state);
        const hasActivity = Boolean(rec.currentAction || (rec.activity?.state && rec.activity.state !== "unknown"));

        nodesMap[uiId] = {
          id: uiId,
          parentId,
          role: NodeRole.WORKER,
          domain: null,
          iconDomain: AgentDomain.GENERAL,
          displayName: `${memberLabel} ${fallbackIndex}`,
          phaseId: null,
          runtimeState,
          sessionId: null,
          providerRef: rec.childSessionId || null,
          currentActivity: rec.currentAction || (activityState !== "unknown" ? activityState : null),
          currentTaskSummary: null,
          currentTaskDetail: null,
          progressCompleted: 0,
          progressTotal: 0,
          blockerText: rec.state === "lost" ? trText("organization.delegationLost", "Subagent connection lost", "子代理连接已丢失") : null,
          testsPassed: 0,
          testsTotal: 0,
          changedFiles: [],
          resultPacketSummary: null,
          isRootLeader: false,
          memberKind: "native_delegation",
          isNativeMember: true,
          isReadOnlyNative: true,
          canOpenInbox: false,
          canonicalId: null,
          sourceTag: rec.provider || null,
          executionHarnessId: rec.provider || null,
          conversationDescriptor: null,
          coverage: hasActivity ? "activity_only" : "unavailable",
          sourceGap: this.delegationGap,
          relationKnown,
          parentUnknown: !relationKnown,
          activity: rec.activity || null,
          runId: rec.runId,
          stateUnknown: !rec.state && activityState === "unknown",
          rawNativeState: rec.state || activityState || "unknown",
        };
      }

      // Build edges: formal edges + verified member edges (no edges for detached unknown-parent nodes)
      const edgesList = rawEdges.map((e, idx) => ({
        id: e.id || `edge-${idx}`,
        fromNodeId: e.parentNodeId || e.fromNodeId || e.parentId,
        toNodeId: e.childNodeId || e.toNodeId || e.childId,
        type: e.edgeType || e.type || "MANAGES",
      }));
      const formalChildIds = new Set(edgesList.map((e) => e.toNodeId));
      Object.values(nodesMap).forEach((node) => {
        if (node.parentId && nodesMap[node.parentId] && !formalChildIds.has(node.id)) {
          edgesList.push({
            id: `member-edge:${node.id}`,
            fromNodeId: node.parentId,
            toNodeId: node.id,
            type: "MANAGES",
          });
        }
      });

      const rawRev = typeof proj.revision === "object" ? proj.revision?.number : proj.revision;
      const revisionNumber = rawRev ?? proj.asOf?.revision ?? 0;

      return {
        hasFormalOrg,
        objective: proj.objective || proj.proposal?.objective || (hasFormalOrg ? tr("organization.radar") : trText("organization.nativeWorkspace", "Session Agents", "会话协作成员")),
        revisionNumber,
        rootId,
        nodesMap,
        edgesList,
        sourceCoverage: membersPage?.sourceCoverage || null,
      };
    }

    // --- DOM Graph Rendering ---

    render() {
      if (!this.active || !this.dom.surface) return;
      this.updateViewportDimensions();

      const model = this.buildUnifiedGraphModel();
      const { hasFormalOrg, objective, revisionNumber, nodesMap, edgesList } = model;

      // Toggle Factory Work button strictly for formal organizations
      if (this.dom.factoryWorkBtn) {
        this.dom.factoryWorkBtn.hidden = !Boolean(this.projection?.organizationId);
      }

      // Top Bar Text
      if (this.dom.objective) {
        this.dom.objective.textContent = objective;
      }
      if (this.dom.meta) {
        const count = Object.keys(nodesMap).length;
        const parts = [];
        if (hasFormalOrg) {
          parts.push(tr("organization.revisionNumber", { revision: revisionNumber }));
        }
        parts.push(`${count} ${tr("organization.agents")}`);
        if (model.sourceCoverage?.gap || this.delegationGap) {
          parts.push(trText("organization.coverageGapShort", "partial coverage", "部分覆盖"));
        }
        this.dom.meta.textContent = parts.join(" · ");
      }
      this.renderSwarmOverview(model);

      // Prune cached positions when parent topology changes (e.g. detached -> linked)
      Object.entries(nodesMap).forEach(([id, node]) => {
        if (Object.hasOwn(this.previousParents, id) && this.previousParents[id] !== node.parentId) {
          delete this.previousPositions[id];
        }
        this.previousParents[id] = node.parentId;
      });

      // Compute Layout
      this.layoutResult = OrganizationLayoutEngine.calculateLayout({
        nodes: nodesMap,
        edges: edgesList,
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        focusNodeId: this.focusNodeId,
        previousPositions: this.previousPositions,
      });

      // Cache positions
      Object.entries(this.layoutResult.nodePositions).forEach(([id, p]) => {
        this.previousPositions[id] = { x: p.x, y: p.y };
      });

      // Render Nodes Layer
      const nodesLayer = this.dom.nodesLayer;
      if (nodesLayer) {
        nodesLayer.innerHTML = "";
        const nodePositions = this.layoutResult.nodePositions;

        Object.entries(nodePositions).forEach(([id, pos]) => {
          if (!pos.isVisible) return;
          const nodeModel = nodesMap[id];
          const nodeEl = document.createElement("div");

          if (pos.isCluster) {
            nodeEl.className = "org-node org-node--cluster";
            nodeEl.style.left = `${pos.x}px`;
            nodeEl.style.top = `${pos.y}px`;
            nodeEl.style.opacity = pos.alpha;
            nodeEl.innerHTML = `
              <div class="org-node-circle" style="width:${pos.radius * 2}px;height:${pos.radius * 2}px;">
                <span class="org-cluster-count">+${escapeDisplayText(pos.clusterCount)}</span>
              </div>
            `;
            nodeEl.addEventListener("click", (e) => {
              e.stopPropagation();
              const leadId = id.replace("cluster_", "");
              this.focusNodeId = this.focusNodeId === leadId ? null : leadId;
              this.render();
            });
          } else if (nodeModel) {
            const roleClass = `org-node--${nodeModel.role.toLowerCase()}`;
            const stateClass = `is-${nodeModel.runtimeState.toLowerCase()}`;
            const nativeClass = nodeModel.isNativeMember ? "org-node--native" : "";
            const detachedClass = nodeModel.parentUnknown ? "org-node--detached" : "";
            const focusedClass = pos.isFocused ? "is-focused" : "";
            const dimmedClass = pos.alpha < 1.0 ? "is-dimmed" : "";

            nodeEl.className = `org-node ${roleClass} ${stateClass} ${nativeClass} ${detachedClass} ${focusedClass} ${dimmedClass}`.trim();
            nodeEl.style.left = `${pos.x}px`;
            nodeEl.style.top = `${pos.y}px`;
            nodeEl.style.opacity = pos.alpha;

            const subTags = [];
            if (nodeModel.isNativeMember && nodeModel.sourceTag) subTags.push(nodeModel.sourceTag);
            if (nodeModel.parentUnknown) subTags.push(trText("organization.detachedShort", "detached", "独立"));
            const subBadgeHtml = subTags.length > 0
              ? `<span class="org-node-subbadge">${escapeDisplayText(subTags.join(" · "))}</span>`
              : "";

            nodeEl.innerHTML = `
              <div class="org-node-circle" style="width:${pos.radius * 2}px;height:${pos.radius * 2}px;">
                ${nodeModel.role === NodeRole.EXECUTIVE ? '<div class="org-node-inner-ring"></div>' : ""}
                ${nodeModel.role === NodeRole.REVIEWER && nodeModel.runtimeState === NodeRuntimeState.REVIEWING ? '<div class="org-reviewer-sweep"></div>' : ""}
                <div class="org-domain-glyph">
                  ${renderDomainGlyph(nodeModel.role, nodeModel.iconDomain)}
                </div>
              </div>
              <div class="org-node-label">${escapeDisplayText(nodeModel.displayName)}${subBadgeHtml}</div>
            `;

            // Single click opens Bottom Sheet
            nodeEl.addEventListener("click", (e) => {
              e.stopPropagation();
              this.openBottomSheet(nodeModel);
            });

            // Double click focuses subtree
            nodeEl.addEventListener("dblclick", (e) => {
              e.stopPropagation();
              this.focusNodeId = this.focusNodeId === nodeModel.id ? null : nodeModel.id;
              this.render();
            });
          }

          nodesLayer.appendChild(nodeEl);
        });
      }

      // Render Approval Banner if active
      if (this.approvalOverlay && this.dom.approvalOverlay) {
        this.dom.approvalOverlay.hidden = false;
        if (this.dom.approvalSummary) {
          this.dom.approvalSummary.textContent = this.approvalOverlay.actionSummary;
        }
        if (this.dom.approveBtn) {
          this.dom.approveBtn.onclick = () => {
            this.approvalOverlay = null;
            this.dom.approvalOverlay.hidden = true;
          };
        }
        if (this.dom.rejectBtn) {
          this.dom.rejectBtn.onclick = () => {
            this.approvalOverlay = null;
            this.dom.approvalOverlay.hidden = true;
          };
        }
      } else if (this.dom.approvalOverlay) {
        this.dom.approvalOverlay.hidden = true;
      }

      // Render Activity Feed & Swarm Board
      this.renderActivityFeed();
    }

    resolveActiveBoardState() {
      this.ensureSwarmUiState();
      const bp = this.boardProjection;
      if (bp && bp.mode === "ragent_swarm" && bp.readOnly === false && bp.board && typeof bp.board === "object") {
        const channels = Array.isArray(bp.channels)
          ? bp.channels
          : Array.isArray(bp.board.channels)
            ? bp.board.channels
            : [];
        return {
          mode: "ragent_swarm",
          readOnly: false,
          isWritable: true,
          board: { ...bp.board, mode: "ragent_swarm", readOnly: false, channels },
          channels,
          nativeBoard: bp.nativeBoard || this.nativeBoard || null,
        };
      }
      const nativeRaw =
        (bp?.board && bp.mode === "provider_native" ? bp.board : null) ||
        bp?.nativeBoard ||
        this.nativeBoard ||
        null;
      if (nativeRaw && typeof nativeRaw === "object") {
        const channels = Array.isArray(nativeRaw.channels)
          ? nativeRaw.channels
          : Array.isArray(bp?.channels)
            ? bp.channels
            : [];
        return {
          mode: "provider_native",
          readOnly: true,
          isWritable: false,
          board: { ...nativeRaw, mode: "provider_native", readOnly: true, channels },
          channels,
          nativeBoard: null,
        };
      }
      return {
        mode: null,
        readOnly: true,
        isWritable: false,
        board: null,
        channels: [],
        nativeBoard: null,
      };
    }

    matchSwarmMemberForNode(node) {
      const members = Array.isArray(this.swarmStatus?.members) ? this.swarmStatus.members : [];
      if (!node || members.length === 0) return null;
      return (
        members.find((m) => m && (m.nodeId === node.id || (node.stableKey && m.stableKey === node.stableKey) || m.stableKey === node.id)) ||
        null
      );
    }

    formatBudgetSummaryParts(budget) {
      if (!budget || typeof budget !== "object") return [];
      const totals = budget.totals && typeof budget.totals === "object" ? budget.totals : {};
      const limits = budget.limits && typeof budget.limits === "object" ? budget.limits : {};
      const reserved = budget.reserved && typeof budget.reserved === "object" ? budget.reserved : {};
      const parts = [];
      if (Number.isFinite(Number(totals.runs)) || Number.isFinite(Number(limits.maxTotalRuns))) {
        const runs = Number.isFinite(Number(totals.runs)) ? Number(totals.runs) : 0;
        const cap = Number.isFinite(Number(limits.maxTotalRuns)) ? `/${Number(limits.maxTotalRuns)}` : "";
        parts.push(`${trText("organization.budgetRuns", "runs", "运行次数")}: ${runs}${cap}`);
      }
      if (Number.isFinite(Number(totals.tokens)) && Number(totals.tokens) > 0) {
        parts.push(`${trText("organization.budgetTokens", "tokens", "Tokens")}: ${Number(totals.tokens)}`);
      }
      if (Number.isFinite(Number(totals.costUsd)) && Number(totals.costUsd) > 0) {
        parts.push(`$${Number(totals.costUsd).toFixed(4)}`);
      }
      if (Number.isFinite(Number(reserved.runs)) && Number(reserved.runs) > 0) {
        parts.push(`${trText("organization.budgetReserved", "reserved", "预留")}: ${Number(reserved.runs)}`);
      }
      return parts;
    }

    renderSwarmOverview(model = null) {
      const container = this.dom.swarmOverview;
      if (!container) return;
      this.ensureSwarmUiState();
      const status = this.swarmStatus;
      const boardState = this.resolveActiveBoardState();

      if (status && typeof status === "object" && status.counts) {
        const counts = status.counts;
        const members = Array.isArray(status.members) ? status.members : [];
        const stalls = Array.isArray(status.activeStalls) && status.activeStalls.length > 0
          ? status.activeStalls
          : Array.isArray(boardState.board?.activeStalls)
            ? boardState.board.activeStalls
            : [];
        const pills = [];

        pills.push(`<span class="org-overview-pill org-overview-pill--working">${escapeDisplayText(trText("organization.swarmWorking", "working", "工作中"))}: ${escapeDisplayText(Number(counts.working || 0))}</span>`);
        pills.push(`<span class="org-overview-pill org-overview-pill--waiting">${escapeDisplayText(trText("organization.swarmWaiting", "waiting", "休眠等待"))}: ${escapeDisplayText(Number(counts.waiting || 0))}</span>`);
        pills.push(`<span class="org-overview-pill org-overview-pill--stopped">${escapeDisplayText(trText("organization.swarmStopped", "stopped", "已停止"))}: ${escapeDisplayText(Number(counts.stopped || 0))}</span>`);
        pills.push(`<span class="org-overview-pill org-overview-pill--killed">${escapeDisplayText(trText("organization.swarmKilled", "killed", "已终止"))}: ${escapeDisplayText(Number(counts.killed || 0))}</span>`);

        if (status.isDone || boardState.board?.isDone) {
          pills.push(`<span class="org-overview-pill org-overview-pill--done">[done]</span>`);
        }

        const harnessCounts = new Map();
        const branchSeen = new Set();
        const worktreePills = [];
        for (const m of members) {
          if (!m || m.swarmState === "killed") continue;
          const harness = String(m.harness || m.provider || "").trim().toLowerCase();
          if (harness) {
            harnessCounts.set(harness, (harnessCounts.get(harness) || 0) + 1);
          }
          const mode = String(m.workspaceMode || "inherit").toLowerCase();
          if (mode === "worktree" || mode === "staging" || m.workspaceBranch) {
            const label = m.workspaceBranch
              ? `${mode === "staging" ? "staging" : "branch"}: ${m.workspaceBranch}`
              : `${mode}: ${m.name || m.stableKey || "member"}`;
            if (!branchSeen.has(label)) {
              branchSeen.add(label);
              worktreePills.push(`<span class="org-overview-pill org-overview-pill--worktree">${escapeDisplayText(label)}</span>`);
            }
          }
        }
        for (const [harness, count] of harnessCounts.entries()) {
          pills.push(`<span class="org-overview-pill org-overview-pill--harness">${escapeDisplayText(harness)} ×${escapeDisplayText(count)}</span>`);
        }
        pills.push(...worktreePills);

        const budgetParts = this.formatBudgetSummaryParts(status.budget);
        if (budgetParts.length > 0) {
          pills.push(`<span class="org-overview-pill org-overview-pill--budget">${escapeDisplayText(budgetParts.join(" · "))}</span>`);
        }

        if (Array.isArray(status.usageByModel) && status.usageByModel.length > 0) {
          for (const bucket of status.usageByModel) {
            if (!bucket) continue;
            const tok = Number(bucket.totalTokens || 0);
            const cost = Number(bucket.costUsd || 0);
            const label = `${bucket.modelKey || `${bucket.tool || "runtime"}:${bucket.model || bucket.provider || "default"}`}${tok > 0 || cost > 0 ? ` (${tok} tok${cost > 0 ? `, $${cost.toFixed(4)}` : ""})` : ""}`;
            pills.push(`<span class="org-overview-pill org-overview-pill--model">${escapeDisplayText(label)}</span>`);
          }
        }

        const stallHtml = stalls.map((s) => {
          const detailLabel = s.details?.reason || s.conditionKind || "stall";
          const targetLabel = s.targetNodeId || s.targetRole || "";
          const alertText = `[stall] ${detailLabel}${targetLabel ? ` (${targetLabel})` : ""}${Number(s.alertCount) > 1 ? ` ×${s.alertCount}` : ""}`;
          return `<span class="org-overview-pill org-overview-pill--stall">${escapeDisplayText(alertText)}</span>`;
        }).join("");

        container.hidden = false;
        container.innerHTML = `<div class="org-overview-row">${pills.join("")}${stallHtml}</div>`;
        return;
      }

      // Honest read-only observation fallback for AgY / provider-native Swarm (never fabricating swarm counts or budget)
      const rawMembers = Array.isArray(this.rawUnifiedMembers?.members) ? this.rawUnifiedMembers.members : [];
      const nativeMembers = rawMembers.filter((m) => m && m.canonicalId !== this.rawUnifiedMembers?.rootCanonicalId);
      if (boardState.mode === "provider_native" || nativeMembers.length > 0) {
        const harnessCounts = new Map();
        let activeObserved = 0;
        let idleObserved = 0;
        for (const m of nativeMembers) {
          const h = String(m.executionHarnessId || m.sourceTag || "").trim().toLowerCase();
          if (h) harnessCounts.set(h, (harnessCounts.get(h) || 0) + 1);
          const actState = String(m.activity?.state || "").toLowerCase();
          if (["working", "running", "in_progress"].includes(actState)) activeObserved += 1;
          else idleObserved += 1;
        }
        const pills = [
          `<span class="org-overview-pill org-overview-pill--readonly">${escapeDisplayText(trText("organization.nativeReadOnlyPill", "Provider Native · Read-Only", "原生协作 · 只读"))}</span>`,
        ];
        if (nativeMembers.length > 0) {
          pills.push(`<span class="org-overview-pill org-overview-pill--working">${escapeDisplayText(trText("organization.observedWorking", "working", "运行中"))}: ${escapeDisplayText(activeObserved)}</span>`);
          pills.push(`<span class="org-overview-pill org-overview-pill--waiting">${escapeDisplayText(trText("organization.observedIdle", "idle", "空闲"))}: ${escapeDisplayText(idleObserved)}</span>`);
        }
        for (const [h, count] of harnessCounts.entries()) {
          pills.push(`<span class="org-overview-pill org-overview-pill--harness">${escapeDisplayText(h)} ×${escapeDisplayText(count)}</span>`);
        }
        container.hidden = false;
        container.innerHTML = `<div class="org-overview-row">${pills.join("")}</div>`;
        return;
      }

      container.hidden = true;
      container.innerHTML = "";
    }

    selectBoardChannel(channelName = "all") {
      this.ensureSwarmUiState();
      const raw = String(channelName ?? "all").trim();
      this.selectedBoardChannel = !raw || raw === "all" ? "all" : normalizeSwarmChannelKey(raw);
      if (this.sessionId && this.boardProjection?.mode === "ragent_swarm") {
        void this.fetchBoardProjection(true).then(() => {
          if (this.active) this.renderActivityFeed();
        });
      }
      this.renderActivityFeed();
    }

    handleBoardFeedClick(e) {
      const target = e?.target;
      const chanEl = target?.closest?.("[data-board-channel]") || (target?.dataset?.boardChannel ? target : null);
      if (chanEl) {
        const ch = chanEl.dataset?.boardChannel || chanEl.getAttribute?.("data-board-channel");
        if (ch) {
          e.stopPropagation?.();
          this.selectBoardChannel(ch);
          return;
        }
      }
      const archiveEl = target?.closest?.("[data-board-archive]") || (target?.dataset?.boardArchive ? target : null);
      if (archiveEl) {
        const ch = archiveEl.dataset?.boardArchive || archiveEl.getAttribute?.("data-board-archive");
        if (ch) {
          e.stopPropagation?.();
          void this.createOrArchiveBoardChannel("archive", ch);
          return;
        }
      }
      const replyEl = target?.closest?.("[data-board-reply-seq]") || (target?.dataset?.boardReplySeq ? target : null);
      if (replyEl) {
        const seq = Number(replyEl.dataset?.boardReplySeq || replyEl.getAttribute?.("data-board-reply-seq"));
        if (Number.isInteger(seq) && seq > 0) {
          e.stopPropagation?.();
          this.boardReplyToSeq = seq;
          this.renderSwarmBoardComposerState(this.resolveActiveBoardState());
          this.dom.swarmBoardInput?.focus?.();
        }
      }
    }

    async submitBoardMessage(explicitText = null) {
      this.ensureSwarmUiState();
      const boardState = this.resolveActiveBoardState();
      if (!boardState.isWritable || !this.sessionId || this.boardComposerBusy) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      const rawText = String(explicitText !== null ? explicitText : (this.dom.swarmBoardInput?.value ?? this.boardComposerDraft ?? "")).trim();
      if (!rawText) {
        this.boardComposerError = trText("organization.boardMessageEmpty", "Message cannot be empty.", "消息内容不能为空。");
        this.renderSwarmBoardComposerState(boardState);
        return null;
      }
      const targetChannel = this.selectedBoardChannel && this.selectedBoardChannel !== "all" ? this.selectedBoardChannel : "main";
      const replyToSeq = Number.isInteger(this.boardReplyToSeq) && this.boardReplyToSeq > 0 ? this.boardReplyToSeq : null;
      this.boardComposerBusy = true;
      this.boardComposerError = "";
      this.renderSwarmBoardComposerState(boardState);
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/board/messages`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            channel: targetChannel,
            bodyMarkdown: rawText,
            ...(replyToSeq ? { replyToSeq } : {}),
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          this.boardComposerError = payload?.error || `HTTP ${res.status}`;
          return null;
        }
        this.boardComposerDraft = "";
        this.boardReplyToSeq = null;
        if (this.dom.swarmBoardInput) this.dom.swarmBoardInput.value = "";
        await Promise.all([this.fetchBoardProjection(true), this.fetchSwarmStatus(true)]);
        if (this.active) this.render();
        return payload;
      } catch (err) {
        this.boardComposerError = err?.message || "Failed to post message";
        return null;
      } finally {
        this.boardComposerBusy = false;
        this.renderSwarmBoardComposerState(this.resolveActiveBoardState());
      }
    }

    async createOrArchiveBoardChannel(action, rawName, topic = "") {
      this.ensureSwarmUiState();
      const boardState = this.resolveActiveBoardState();
      if (!boardState.isWritable || !this.sessionId || this.boardChannelBusy) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      const name = normalizeSwarmChannelKey(rawName, true);
      if (!name) {
        this.boardChannelError = trText("organization.boardInvalidChannel", "Channel name is required.", "请输入有效频道名称。");
        this.renderSwarmBoardComposerState(boardState);
        return null;
      }
      this.boardChannelBusy = true;
      this.boardChannelError = "";
      this.renderSwarmBoardComposerState(boardState);
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/swarm/channels`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ action: action === "archive" ? "archive" : "create", name, ...(topic ? { topic } : {}) }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          this.boardChannelError = payload?.error || `HTTP ${res.status}`;
          return null;
        }
        if (action === "create") {
          this.boardChannelDraft = "";
          if (this.dom.swarmChannelInput) this.dom.swarmChannelInput.value = "";
          this.selectedBoardChannel = payload?.channel?.name || name;
        } else if (this.selectedBoardChannel === name) {
          this.selectedBoardChannel = "all";
        }
        await Promise.all([this.fetchBoardProjection(true), this.fetchSwarmStatus(true)]);
        if (this.active) this.render();
        return payload;
      } catch (err) {
        this.boardChannelError = err?.message || "Channel request failed";
        return null;
      } finally {
        this.boardChannelBusy = false;
        this.renderSwarmBoardComposerState(this.resolveActiveBoardState());
      }
    }

    async killSwarmMemberRequest(targetNodeId, { forceDiscard = false } = {}) {
      this.ensureSwarmUiState();
      if (!this.sessionId || !targetNodeId || this.killBusy) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      this.killBusy = true;
      this.killError = "";
      this.killConfirmTargetId = targetNodeId;
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/swarm/kill`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ targetNodeId, forceDiscard: forceDiscard === true }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 409 && payload?.code === "SWARM_WORKSPACE_UNMERGED_CHANGES") {
            this.killConflictInfo = payload;
          } else {
            this.killConflictInfo = null;
            this.killError = payload?.error || `HTTP ${res.status}`;
          }
          const matchedNode = this.selectedSheetNodeId
            ? this.buildUnifiedGraphModel().nodesMap?.[this.selectedSheetNodeId]
            : null;
          if (matchedNode && this.dom.sheet && !this.dom.sheet.hidden) {
            this.openBottomSheet(matchedNode);
          }
          return payload;
        }
        this.killConflictInfo = null;
        this.killConfirmTargetId = null;
        this.dismissBottomSheet();
        await this.refreshOrganizationData({ force: true });
        if (this.active) this.render();
        return payload;
      } catch (err) {
        this.killError = err?.message || "Kill request failed";
        return null;
      } finally {
        this.killBusy = false;
      }
    }

    async switchSwarmMemberModelRequest(targetNodeId, { harness = "", provider = "", model = "", effort = "", reason = "" } = {}) {
      this.ensureSwarmUiState();
      if (!this.sessionId || !targetNodeId || this.modelSwitchBusy) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      this.modelSwitchBusy = true;
      this.modelSwitchError = "";
      this.modelSwitchStatus = "";
      this.modelSwitchTargetId = targetNodeId;
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/swarm/model`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            targetNodeId,
            ...(harness ? { harness } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(reason ? { reason } : {}),
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          this.modelSwitchError = payload?.code
            ? `${payload.code}: ${payload.error || `HTTP ${res.status}`}`
            : (payload?.error || `HTTP ${res.status}`);
        } else {
          this.modelSwitchOpen = false;
          this.modelSwitchStatus = trText(
            "organization.modelSwitched",
            `Switched to gen ${payload.bindingGeneration} (${payload.handoff?.resolvedConfig?.model || payload.handoff?.resolvedConfig?.tool || "updated"})`,
            `已切换至第 ${payload.bindingGeneration} 代绑定`,
          );
          await this.refreshOrganizationData({ force: true });
          if (this.active) this.render();
        }
        const matchedNode = this.selectedSheetNodeId
          ? this.buildUnifiedGraphModel().nodesMap?.[this.selectedSheetNodeId]
          : null;
        if (matchedNode && this.dom.sheet && !this.dom.sheet.hidden) {
          this.openBottomSheet(matchedNode);
        }
        return payload;
      } catch (err) {
        this.modelSwitchError = err?.message || "Model switch request failed";
        return null;
      } finally {
        this.modelSwitchBusy = false;
      }
    }

    async promoteSwarmCandidateRequest(targetNodeId, { summary = "" } = {}) {
      this.ensureSwarmUiState();
      if (!this.sessionId || !targetNodeId || this.promoteBusy) return null;
      const fetcher = this.getFetcher();
      if (!fetcher) return null;
      this.promoteBusy = true;
      this.promoteError = "";
      this.promoteResult = null;
      try {
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/swarm/promote-candidate`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ targetNodeId, ...(summary ? { summary } : {}) }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          this.promoteError = payload?.code
            ? `${payload.code}: ${payload.error || `HTTP ${res.status}`}`
            : (payload?.error || `HTTP ${res.status}`);
        } else {
          this.promoteResult = payload;
          await this.refreshOrganizationData({ force: true });
          if (this.active) this.render();
        }
        const matchedNode = this.selectedSheetNodeId
          ? this.buildUnifiedGraphModel().nodesMap?.[this.selectedSheetNodeId]
          : null;
        if (matchedNode && this.dom.sheet && !this.dom.sheet.hidden) {
          this.openBottomSheet(matchedNode);
        }
        return payload;
      } catch (err) {
        this.promoteError = err?.message || "Promote candidate failed";
        return null;
      } finally {
        this.promoteBusy = false;
      }
    }

    renderModelEpochHistoryHtml(swarmMember) {
      const history = Array.isArray(swarmMember?.modelHistory) ? swarmMember.modelHistory : [];
      if (history.length === 0) return "";
      const rows = history.map((epoch) => {
        const req = epoch?.requestedConfig || {};
        const res = epoch?.resolvedConfig || {};
        const act = epoch?.actualReportedConfig || null;
        const u = epoch?.usage || {};
        const fmtCfg = (c) => [c?.tool, c?.provider, c?.model, c?.effort].filter(Boolean).join("/") || "unrecorded";
        const tokens = Number(u.totalTokens || (Number(u.inputTokens || 0) + Number(u.outputTokens || 0)) || 0);
        const cost = Number(u.costUsd || 0);
        const stateTag = epoch?.endedAt ? "closed" : "active";
        return `<div class="org-epoch-item">
          <div><strong>#${escapeDisplayText(epoch.epochIndex)}</strong> (gen ${escapeDisplayText(epoch.bindingGeneration)}, ${escapeDisplayText(stateTag)})</div>
          <div>requested: ${escapeDisplayText(fmtCfg(req))} · resolved: ${escapeDisplayText(fmtCfg(res))}${act ? ` · actual: ${escapeDisplayText(fmtCfg(act))}` : ""}</div>
          <div>usage: ${escapeDisplayText(tokens)} tok · $${escapeDisplayText(cost.toFixed(4))} · ${escapeDisplayText(Number(u.runCount || 0))} run(s)</div>
        </div>`;
      }).join("");
      return `<div class="org-info-card" id="orgSwarmModelHistoryCard">
        <div class="org-info-card-label">${escapeDisplayText(trText("organization.modelHistory", "Model & Usage Epochs", "模型与用量世代"))}</div>
        <div class="org-epoch-list">${rows}</div>
      </div>`;
    }

    resolveBoardMessageHarnessAndRole(msg) {
      const explicitHarness = String(msg?.senderHarness || "").trim();
      const explicitRole = String(msg?.senderRole || "").trim();
      if (explicitHarness || explicitRole) {
        return { harness: explicitHarness, role: explicitRole };
      }
      const swarmMembers = Array.isArray(this.swarmStatus?.members) ? this.swarmStatus.members : [];
      const senderNodeId = String(msg?.senderNodeId || "").trim();
      const senderName = String(msg?.sender || msg?.senderName || "").trim().toLowerCase();
      const matchedSwarm = swarmMembers.find((m) =>
        (senderNodeId && m?.nodeId === senderNodeId) ||
        (senderName && (String(m?.name || "").toLowerCase() === senderName || String(m?.stableKey || "").toLowerCase() === senderName))
      );
      if (matchedSwarm) {
        return { harness: matchedSwarm.harness || matchedSwarm.provider || "", role: matchedSwarm.role || matchedSwarm.contractRole || "" };
      }
      const unifiedMembers = Array.isArray(this.rawUnifiedMembers?.members) ? this.rawUnifiedMembers.members : [];
      const matchedUnified = unifiedMembers.find((m) =>
        senderName && String(m?.displayName || "").trim().toLowerCase() === senderName
      );
      if (matchedUnified) {
        return { harness: matchedUnified.executionHarnessId || matchedUnified.sourceTag || "", role: matchedUnified.role || "" };
      }
      if (msg?.senderKind === "owner") return { harness: "", role: "owner" };
      if (msg?.senderKind === "system") return { harness: "", role: "system" };
      return { harness: "", role: "" };
    }

    renderSwarmBoardComposerState(boardState) {
      const composer = this.dom.swarmBoardComposer;
      if (!composer) return;
      const showComposer = Boolean(boardState?.isWritable);
      composer.hidden = !showComposer || !this.isActivityFeedExpanded;
      composer.setAttribute("data-writable", showComposer ? "true" : "false");
      if (!showComposer) {
        if (this.dom.swarmBoardStatus) this.dom.swarmBoardStatus.textContent = "";
        return;
      }
      const targetChannel = this.selectedBoardChannel && this.selectedBoardChannel !== "all" ? this.selectedBoardChannel : "main";
      if (this.dom.swarmBoardTargetChannel) {
        this.dom.swarmBoardTargetChannel.textContent = `#${targetChannel}`;
      }
      if (this.dom.swarmBoardReplyBadge && this.dom.swarmBoardReplyClearBtn) {
        if (Number.isInteger(this.boardReplyToSeq) && this.boardReplyToSeq > 0) {
          this.dom.swarmBoardReplyBadge.hidden = false;
          this.dom.swarmBoardReplyBadge.textContent = `↳ #${this.boardReplyToSeq}`;
          this.dom.swarmBoardReplyClearBtn.hidden = false;
        } else {
          this.dom.swarmBoardReplyBadge.hidden = true;
          this.dom.swarmBoardReplyBadge.textContent = "";
          this.dom.swarmBoardReplyClearBtn.hidden = true;
        }
      }
      if (this.dom.swarmBoardInput && this.dom.swarmBoardInput.value !== this.boardComposerDraft) {
        this.dom.swarmBoardInput.value = this.boardComposerDraft;
      }
      if (this.dom.swarmBoardInput) this.dom.swarmBoardInput.disabled = this.boardComposerBusy;
      if (this.dom.swarmBoardSendBtn) this.dom.swarmBoardSendBtn.disabled = this.boardComposerBusy;
      if (this.dom.swarmChannelInput && this.dom.swarmChannelInput.value !== this.boardChannelDraft) {
        this.dom.swarmChannelInput.value = this.boardChannelDraft;
      }
      if (this.dom.swarmChannelInput) this.dom.swarmChannelInput.disabled = this.boardChannelBusy;
      if (this.dom.swarmChannelCreateBtn) this.dom.swarmChannelCreateBtn.disabled = this.boardChannelBusy;
      if (this.dom.swarmBoardStatus) {
        this.dom.swarmBoardStatus.textContent = this.boardComposerError || this.boardChannelError || "";
      }
    }

    renderActivityFeed() {
      this.ensureSwarmUiState();
      if (!this.dom.activityFeedList || !this.dom.activityBadge) return;
      const events = this.activityEvents;
      const boardState = this.resolveActiveBoardState();
      const board = boardState.board;
      const boardMessages = Array.isArray(board?.messages) ? board.messages : [];
      const boardChannels = Array.isArray(boardState.channels) ? boardState.channels : [];
      const totalUpdates = events.length + boardMessages.length;
      this.dom.activityBadge.textContent = `+${totalUpdates} ${tr("organization.updates")}`;

      if (boardState.isWritable && !this.userCollapsedBoard && !this.isActivityFeedExpanded) {
        this.isActivityFeedExpanded = true;
        this.dom.activityFeedList.hidden = false;
        if (this.dom.activityChevron) this.dom.activityChevron.textContent = "▼";
      }

      if (totalUpdates === 0 && !board) {
        this.dom.activityFeedList.innerHTML = `<div class="org-activity-row" style="color:var(--text-secondary);font-size:12px;">${escapeDisplayText(tr("organization.noActivity"))}</div>`;
        this.renderSwarmBoardComposerState(boardState);
        return;
      }

      const allowedDotClasses = new Set(["running", "success", "waiting", "error"]);
      const rows = events
        .map((e) => {
          const dotClass = allowedDotClasses.has(e.dotClass) ? e.dotClass : "waiting";
          return `
        <div class="org-activity-row">
          <span class="org-activity-row-dot org-activity-row-dot--${dotClass}"></span>
          <span class="org-activity-row-msg">${escapeDisplayText(e.message)}</span>
          <span class="org-activity-row-time">${escapeDisplayText(e.time)}</span>
        </div>`;
        });

      if (board) {
        const channelSummary = boardChannels
          .map((ch) => `#${ch.name} (${ch.messageCount ?? 0})`)
          .join(" · ");
        const headerBase = boardState.isWritable
          ? trText("organization.swarmBoardTitle", "Swarm Board", "协作留言板")
          : trText("organization.swarmBoardReadOnly", "Swarm Board (Read-Only)", "协作留言板（只读）");
        const boardHeader = board.title ? `${headerBase}: ${board.title}` : headerBase;

        rows.push(
          `<div class="org-board-section-header">` +
            `<div class="org-activity-row org-board-header">` +
              `<span class="org-board-mode-badge ${boardState.isWritable ? "org-board-mode-badge--writable" : "org-board-mode-badge--readonly"}">${escapeDisplayText(boardHeader)}</span>` +
              `${board.headSeq ? `<span class="org-board-seq-head">#${escapeDisplayText(board.headSeq)}</span>` : ""}` +
              `${board.isDone ? `<span class="org-board-signal org-board-signal--done">[done]</span>` : ""}` +
              `${channelSummary ? `<span class="org-board-channel-summary">${escapeDisplayText(channelSummary)}</span>` : ""}` +
            `</div>` +
            `${!boardState.isWritable
              ? `<div class="org-board-readonly-banner">${escapeDisplayText(trText("organization.swarmBoardReadOnlyBanner", "Provider-native Swarm observation only. Owner posting and channel controls are disabled.", "仅用于观测 Provider 原生协作：禁止发帖或修改频道。"))}</div>`
              : ""}` +
          `</div>`
        );

        if (boardChannels.length > 0) {
          const activeSel = this.selectedBoardChannel || "all";
          const allTab = `<button type="button" class="org-board-channel-tab ${activeSel === "all" ? "is-active" : ""}" data-board-channel="all">${escapeDisplayText(trText("organization.allChannels", "All", "全部"))}</button>`;
          const chanTabs = boardChannels.map((ch) => {
            const name = String(ch?.name || "main");
            const isActive = activeSel === name;
            const unread = Number(ch?.unreadCount || 0);
            const unreadHtml = unread > 0 ? `<span class="org-board-channel-unread">${escapeDisplayText(unread)}</span>` : "";
            const archiveHtml = boardState.isWritable && name !== "main"
              ? `<span class="org-board-channel-archive" role="button" data-board-archive="${escapeDisplayText(name)}" title="Archive #${escapeDisplayText(name)}">×</span>`
              : "";
            return `<button type="button" class="org-board-channel-tab ${isActive ? "is-active" : ""}" data-board-channel="${escapeDisplayText(name)}">#${escapeDisplayText(name)}<span class="org-board-channel-count">(${escapeDisplayText(ch?.messageCount ?? 0)})</span>${unreadHtml}${archiveHtml}</button>`;
          });
          rows.push(`<div class="org-board-channels" id="orgSwarmBoardChannels">${allTab}${chanTabs.join("")}</div>`);
        }

        const activeChannelFilter = this.selectedBoardChannel && this.selectedBoardChannel !== "all"
          ? normalizeSwarmChannelKey(this.selectedBoardChannel)
          : "";
        const filteredMessages = [...boardMessages]
          .filter((msg) => !activeChannelFilter || normalizeSwarmChannelKey(msg?.channel || "main") === activeChannelFilter)
          .sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));

        if (filteredMessages.length === 0) {
          rows.push(`<div class="org-activity-row org-board-empty">${escapeDisplayText(trText("organization.noBoardMessages", "No board messages in this channel yet.", "当前频道暂无留言。"))}</div>`);
        } else {
          for (const msg of filteredMessages.slice(-40)) {
            const seq = Number(msg?.seq || 0);
            const seqTag = seq > 0 ? `#${seq}` : "";
            const chName = msg?.channel || "main";
            const { harness, role } = this.resolveBoardMessageHarnessAndRole(msg);
            const isStall = Boolean(msg?.isStallAlert || msg?.kind === "stall" || /\[\s*stall\s*\]/i.test(String(msg?.text || msg?.bodyMarkdown || "")));
            const isDone = Boolean(msg?.isDoneSignal || msg?.kind === "done" || /\[\s*done\s*\]/i.test(String(msg?.text || msg?.bodyMarkdown || "")));
            const replyTag = Number.isInteger(msg?.replyToSeq) && msg.replyToSeq > 0
              ? `<span class="org-board-reply-ref">↳ #${escapeDisplayText(msg.replyToSeq)}</span>`
              : "";
            const harnessBadge = harness ? `<span class="org-board-sender-badge org-board-sender-badge--harness">${escapeDisplayText(harness)}</span>` : "";
            const roleBadge = role ? `<span class="org-board-sender-badge org-board-sender-badge--role">${escapeDisplayText(role)}</span>` : "";
            const signalBadges = `${isDone ? `<span class="org-board-signal org-board-signal--done">[done]</span>` : ""}${isStall ? `<span class="org-board-signal org-board-signal--stall">[stall]</span>` : ""}`;
            const rawBody = msg?.text ?? msg?.bodyMarkdown ?? "";
            const bodySafeHtml = formatBoardBodySafeHtml(rawBody);
            const artifactHtml = Array.isArray(msg?.artifactRefs) && msg.artifactRefs.length > 0
              ? `<div class="org-board-artifacts">${msg.artifactRefs.map((ref) => `<span class="org-board-artifact-pill">${escapeDisplayText(ref?.title || ref?.id || ref?.packetId || "artifact")}</span>`).join("")}</div>`
              : "";
            const replyBtnHtml = boardState.isWritable && seq > 0
              ? `<button type="button" class="org-board-reply-btn" data-board-reply-seq="${escapeDisplayText(seq)}" title="Reply to #${escapeDisplayText(seq)}">↳</button>`
              : "";
            const rowClasses = [
              "org-board-message-row",
              isStall ? "org-board-message-row--stall" : "",
              isDone ? "org-board-message-row--done" : "",
              msg?.senderKind === "owner" ? "org-board-message-row--owner" : "",
            ].filter(Boolean).join(" ");

            rows.push(
              `<div class="${rowClasses}">` +
                `<div class="org-board-message-meta">` +
                  `${seqTag ? `<span class="org-board-seq">${escapeDisplayText(seqTag)}</span>` : ""}` +
                  `<span class="org-board-channel-pill">#${escapeDisplayText(chName)}</span>` +
                  `<span class="org-board-sender">${escapeDisplayText(msg?.sender || msg?.senderName || "member")}</span>` +
                  `${harnessBadge}${roleBadge}${replyTag}${signalBadges}` +
                  `${replyBtnHtml}` +
                `</div>` +
                `<div class="org-board-message-body">${bodySafeHtml}</div>` +
                `${artifactHtml}` +
              `</div>`
            );
          }
        }
      }
      this.dom.activityFeedList.innerHTML = rows.join("");
      this.renderSwarmBoardComposerState(boardState);
    }

    toggleActivityFeed() {
      this.ensureSwarmUiState();
      this.isActivityFeedExpanded = !this.isActivityFeedExpanded;
      this.userCollapsedBoard = !this.isActivityFeedExpanded;
      if (this.dom.activityFeedList) {
        this.dom.activityFeedList.hidden = !this.isActivityFeedExpanded;
      }
      if (this.dom.activityChevron) {
        this.dom.activityChevron.textContent = this.isActivityFeedExpanded ? "▼" : "▲";
      }
      this.renderSwarmBoardComposerState(this.resolveActiveBoardState());
    }

    // --- Member Metadata & Provenance Normalization ---

    normalizeNodeForView(node) {
      if (!node) return null;
      const role = node.role || NodeRole.fromString(node.nodeRole || node.role || node.sessionClass);
      const domain = typeof node.domain === "string" ? node.domain : null;
      const hasBlocker = Boolean(node.blocker || node.status === "blocked" || node.blockerText);
      const runtimeState = node.runtimeState || NodeRuntimeState.fromString(node.status, node.currentActivity, hasBlocker);
      const isReadOnlyNative = Boolean(node.isReadOnlyNative || node.isNativeMember);
      const memberKind = node.memberKind || (isReadOnlyNative ? "unified_member" : node.isSyntheticRoot ? "root_session" : "formal");
      const memberDesc = node.member || null;
      const conversationDescriptor = node.conversationDescriptor || memberDesc?.conversation || null;
      const sessionId = isReadOnlyNative ? null : (node.currentSessionId || node.sessionId || null);
      const coverage = node.coverage || normalizeCoverage(
        conversationDescriptor?.scope || (sessionId && !node.isSyntheticRoot ? "full" : "unavailable"),
        conversationDescriptor?.coverage || "",
        isReadOnlyNative,
        conversationDescriptor?.availability || ""
      );
      const sourceTag = node.sourceTag ?? memberDesc?.sourceTag ?? (memberKind === "formal" || memberKind === "root_session" ? "ragent" : null);
      const matchedSwarm = !isReadOnlyNative ? this.matchSwarmMemberForNode(node) : null;
      const executionHarnessId = node.executionHarnessId ?? memberDesc?.executionHarnessId ?? (matchedSwarm?.harness || matchedSwarm?.provider || null);
      const isRootLeader = Boolean(node.isRootLeader ?? (role === NodeRole.EXECUTIVE));
      const canOpenInbox = Boolean(
        node.canOpenInbox ?? (memberKind === "formal" && Boolean(this.projection?.organizationId) && !isReadOnlyNative)
      );

      return {
        ...node,
        id: node.id || node.stableKey,
        role,
        domain,
        runtimeState,
        displayName: node.displayName || node.stableKey || node.id,
        sessionId,
        isRootLeader,
        memberKind,
        isReadOnlyNative,
        canOpenInbox,
        sourceTag,
        executionHarnessId,
        swarmState: node.swarmState || matchedSwarm?.swarmState || null,
        workspaceMode: node.workspaceMode || matchedSwarm?.workspaceMode || null,
        workspaceBranch: node.workspaceBranch || matchedSwarm?.workspaceBranch || null,
        swarmMemberId: matchedSwarm?.nodeId || null,
        swarmChannels: Array.isArray(matchedSwarm?.channels) ? matchedSwarm.channels : null,
        conversationDescriptor,
        coverage,
        parentUnknown: Boolean(node.parentUnknown),
        sourceGap: Boolean(node.sourceGap),
        progressCompleted: node.progressCompleted ?? node.progress?.completed ?? 0,
        progressTotal: node.progressTotal ?? node.progress?.total ?? 0,
        currentTaskSummary: node.currentTaskSummary || node.currentTask?.objective || node.task?.objective || null,
        currentTaskDetail: node.currentTaskDetail || node.task?.detail || null,
        blockerText: node.blockerText || node.blocker?.reason || node.blocker?.reasonCode || null,
        changedFiles: Array.isArray(node.changedFiles) ? node.changedFiles : [],
      };
    }

    renderMetaPillsHtml(node, overrideCoverage = null, overrideGap = null) {
      const effectiveCoverage = overrideCoverage || node.coverage || "unavailable";
      const hasGap = overrideGap !== null ? Boolean(overrideGap) : Boolean(node.sourceGap);
      const sourceText = node.sourceTag || trText("organization.unknown", "unknown", "未知");
      const harnessText = node.executionHarnessId || trText("organization.unknown", "unknown", "未知");
      const pills = [
        `<span class="org-meta-pill org-meta-pill--source">${escapeDisplayText(trText("organization.sourceTag", "Source", "来源"))}: ${escapeDisplayText(sourceText)}</span>`,
        `<span class="org-meta-pill org-meta-pill--harness">${escapeDisplayText(trText("organization.executionHarness", "Harness", "执行环境"))}: ${escapeDisplayText(harnessText)}</span>`,
        `<span class="org-meta-pill org-meta-pill--coverage-${escapeDisplayText(effectiveCoverage)}">${escapeDisplayText(trText("organization.coverageLabel", "Coverage", "覆盖"))}: ${escapeDisplayText(coverageLabel(effectiveCoverage))}</span>`,
      ];
      if (node.model) {
        pills.push(`<span class="org-meta-pill">${escapeDisplayText(node.model)}</span>`);
      }
      if (node.swarmState) {
        pills.push(`<span class="org-meta-pill org-meta-pill--swarm-${escapeDisplayText(node.swarmState)}">${escapeDisplayText(trText("organization.swarmStateLabel", "Swarm", "集群"))}: ${escapeDisplayText(node.swarmState)}</span>`);
      }
      if (node.workspaceBranch || (node.workspaceMode && node.workspaceMode !== "inherit")) {
        const wsLabel = node.workspaceBranch
          ? `${node.workspaceMode || "worktree"}: ${node.workspaceBranch}`
          : String(node.workspaceMode);
        pills.push(`<span class="org-meta-pill org-meta-pill--worktree">${escapeDisplayText(wsLabel)}</span>`);
      }
      if (node.isReadOnlyNative) {
        pills.push(`<span class="org-meta-pill org-meta-pill--readonly">${escapeDisplayText(trText("organization.readOnly", "Read-only", "只读"))}</span>`);
      }
      if (node.parentUnknown) {
        pills.push(`<span class="org-meta-pill org-meta-pill--warning">${escapeDisplayText(trText("organization.parentUnknown", "Parent unknown (detached)", "父级未知（独立节点）"))}</span>`);
      }
      if (hasGap) {
        pills.push(`<span class="org-meta-pill org-meta-pill--warning">${escapeDisplayText(trText("organization.coverageGapBadge", "Partial / gap", "存在缺口"))}</span>`);
      }
      return pills.join("");
    }

    // --- Organization Bottom Sheet ---

    buildHonestyBannerText(node, overrideCoverage = null, overrideGap = null) {
      if (!node) return "";
      const effectiveCoverage = overrideCoverage || node.coverage || "unavailable";
      const hasGap = overrideGap !== null ? Boolean(overrideGap) : Boolean(node.sourceGap);
      if (node.isSyntheticRoot && !node.conversationDescriptor?.ref) {
        return trText(
          "organization.syntheticRootTranscriptNotice",
          "Root session conversation is available in the main chat timeline.",
          "根会话的对话内容请返回主聊天时间线查看。"
        );
      }
      const lines = [coverageDescription(effectiveCoverage, node.isReadOnlyNative)];
      if (hasGap) {
        lines.push(
          trText(
            "organization.coverageGapDesc",
            "Some activity may be unavailable due to a source gap.",
            "部分活动或历史可能因来源缺口而不可用。"
          )
        );
      }
      if (node.isReadOnlyNative) {
        lines.push(
          trText(
            "organization.readOnlyCapabilityNotice",
            "Read-only observation: single-member control and messaging are unavailable.",
            "只读观测视图：不支持单成员控制或发消息。"
          )
        );
      }
      return lines.join(" ");
    }

    openBottomSheet(rawNode) {
      this.ensureSwarmUiState();
      const node = this.normalizeNodeForView(rawNode);
      if (!node) return;
      const swarmMember = !node.isReadOnlyNative ? this.matchSwarmMemberForNode(node) : null;
      const killTargetId = swarmMember?.nodeId || node.swarmMemberId || node.id;
      if (this.killConfirmTargetId && this.killConfirmTargetId !== killTargetId) {
        this.killConflictInfo = null;
        this.killError = "";
        this.killConfirmTargetId = null;
      }
      if (this.modelSwitchTargetId && this.modelSwitchTargetId !== killTargetId) {
        this.modelSwitchOpen = false;
        this.modelSwitchError = "";
        this.modelSwitchStatus = "";
        this.promoteError = "";
        this.promoteResult = null;
        this.modelSwitchTargetId = null;
      }
      this.selectedSheetNodeId = node.id;
      const sheet = this.dom.sheet;
      const backdrop = this.dom.sheetBackdrop;
      if (!sheet || !backdrop) return;

      const stateName = String(node.runtimeState).toLowerCase();
      const statusText = formatRuntimeStatusText(node);
      const subtitleParts = [
        node.isReadOnlyNative
          ? trText("organization.nativeSubagent", "Native subagent", "原生子代理")
          : node.isSyntheticRoot
            ? trText("organization.nativeRoot", "Root session", "根会话")
            : node.role,
      ];
      if (node.domain) subtitleParts.push(node.domain);
      if (node.sourceTag) subtitleParts.push(node.sourceTag);

      const hasConversationRef = Boolean(node.conversationDescriptor?.ref);
      const detailsBtnLabel = hasConversationRef && node.isReadOnlyNative
        ? trText("organization.viewConversation", "View Conversation", "查看会话")
        : tr("organization.viewDetails");

      sheet.innerHTML = `
        <div class="org-sheet-header">
          <div>
            <div class="org-sheet-name">${escapeDisplayText(node.displayName)}</div>
            <div class="org-sheet-subtitle">${escapeDisplayText(subtitleParts.join(" · "))}</div>
          </div>
          <div class="org-status-pill org-status-pill--${escapeDisplayText(stateName)}">
            <span class="org-status-pill-dot"></span>
            <span>${escapeDisplayText(statusText)}</span>
          </div>
        </div>

        <div class="org-meta-pills">${this.renderMetaPillsHtml(node)}</div>

        <div class="org-honesty-banner ${node.sourceGap || node.parentUnknown ? "org-honesty-banner--warning" : ""}">
          ${escapeDisplayText(this.buildHonestyBannerText(node))}
        </div>

        ${
          !node.isReadOnlyNative
            ? `<div class="org-info-card">
                <div class="org-info-card-label">${escapeDisplayText(tr("organization.currentTask"))}</div>
                <div class="org-info-card-value">${escapeDisplayText(node.currentTaskSummary || tr("organization.noTaskAssigned"))}</div>
              </div>`
            : ""
        }

        ${
          node.currentActivity
            ? `<div class="org-info-card">
                <div class="org-info-card-label">${escapeDisplayText(tr("organization.currentActivity"))}</div>
                <div class="org-info-card-value" style="font-family:monospace;font-size:12px;">${escapeDisplayText(node.currentActivity)}</div>
              </div>`
            : ""
        }

        ${
          !node.isReadOnlyNative && node.memberKind === "formal"
            ? `<div class="org-info-row">
                <div class="org-info-card">
                  <div class="org-info-card-label">${escapeDisplayText(tr("organization.acceptance"))}</div>
                  <div class="org-info-card-value">${escapeDisplayText(node.progressCompleted)} / ${escapeDisplayText(node.progressTotal)} ${escapeDisplayText(tr("organization.items"))}</div>
                </div>
              </div>`
            : ""
        }

        ${
          node.blockerText
            ? `<div class="org-blocker-card">
                ${escapeDisplayText(tr("organization.activeBlocker"))}: ${escapeDisplayText(node.blockerText)}
              </div>`
            : ""
        }

        ${
          this.killConflictInfo && this.killConfirmTargetId === killTargetId
            ? `<div class="org-blocker-card org-kill-conflict-card" id="orgSwarmKillConflictCard">
                <div><strong>${escapeDisplayText(trText("organization.unmergedWorkspaceChanges", "Unmerged workspace changes detected", "检测到未合并的工作区改动"))}</strong></div>
                <div>${escapeDisplayText(this.killConflictInfo.error || "")}</div>
                ${this.killConflictInfo.workspaceBranch ? `<div>${escapeDisplayText(`branch: ${this.killConflictInfo.workspaceBranch}`)}</div>` : ""}
                ${Array.isArray(this.killConflictInfo.dirtyFiles) && this.killConflictInfo.dirtyFiles.length > 0
                  ? `<div class="org-kill-dirty-files">${escapeDisplayText(this.killConflictInfo.dirtyFiles.join(", "))}</div>`
                  : ""}
                <div class="org-sheet-actions" style="margin-top:8px;">
                  <button type="button" class="org-btn org-btn--danger" id="orgSwarmForceKillBtn">${escapeDisplayText(trText("organization.forceDiscardKill", "Force Discard & Kill", "强制丢弃并终止"))}</button>
                  <button type="button" class="org-btn org-btn--secondary" id="orgSwarmKillCancelBtn">${escapeDisplayText(trText("organization.cancel", "Cancel", "取消"))}</button>
                </div>
              </div>`
            : ""
        }

        ${
          this.killError && this.killConfirmTargetId === killTargetId
            ? `<div class="org-blocker-card">${escapeDisplayText(this.killError)}</div>`
            : ""
        }

        ${
          !node.isReadOnlyNative && swarmMember
            ? this.renderModelEpochHistoryHtml(swarmMember)
            : ""
        }

        ${
          !node.isReadOnlyNative && swarmMember && this.modelSwitchOpen && this.modelSwitchTargetId === killTargetId
            ? `<div class="org-model-switch-card" id="orgSwarmModelForm">
                <div class="org-info-card-label">${escapeDisplayText(trText("organization.switchModel", "Controlled Model Switch", "受控切换模型"))}</div>
                <div class="org-model-switch-grid">
                  <input type="text" class="org-model-switch-input" id="orgSwarmModelHarness" placeholder="harness (codex/claude/agy)" value="${escapeDisplayText(swarmMember.harness || "")}" />
                  <input type="text" class="org-model-switch-input" id="orgSwarmModelProvider" placeholder="provider" value="${escapeDisplayText(swarmMember.provider || "")}" />
                  <input type="text" class="org-model-switch-input" id="orgSwarmModelName" placeholder="model" value="${escapeDisplayText(swarmMember.model || "")}" />
                  <input type="text" class="org-model-switch-input" id="orgSwarmModelEffort" placeholder="effort" value="${escapeDisplayText(swarmMember.effort || "")}" />
                </div>
                <input type="text" class="org-model-switch-input" id="orgSwarmModelReason" style="margin-top:6px;" placeholder="reason (optional)" value="" />
                <div class="org-sheet-actions" style="margin-top:8px;">
                  <button type="button" class="org-btn org-btn--primary" id="orgSwarmModelSubmitBtn"${this.modelSwitchBusy ? " disabled" : ""}>${escapeDisplayText(trText("organization.confirmSwitch", "Confirm Switch", "确认切换"))}</button>
                  <button type="button" class="org-btn org-btn--secondary" id="orgSwarmModelCancelBtn">${escapeDisplayText(trText("organization.cancel", "Cancel", "取消"))}</button>
                </div>
              </div>`
            : ""
        }

        ${
          this.modelSwitchError
            ? `<div class="org-blocker-card" id="orgSwarmModelError">${escapeDisplayText(this.modelSwitchError)}</div>`
            : ""
        }

        ${
          this.modelSwitchStatus
            ? `<div class="org-info-card org-info-card--success" id="orgSwarmModelStatus">${escapeDisplayText(this.modelSwitchStatus)}</div>`
            : ""
        }

        ${
          this.promoteError
            ? `<div class="org-blocker-card" id="orgSwarmPromoteError">${escapeDisplayText(this.promoteError)}</div>`
            : ""
        }

        ${
          this.promoteResult?.candidate
            ? `<div class="org-info-card org-info-card--success" id="orgSwarmPromoteResult">${escapeDisplayText(`Candidate ${this.promoteResult.candidate.candidateId} (Work Item ${this.promoteResult.workItem?.id || ""}) ready for acceptance`)}</div>`
            : ""
        }

        <div class="org-sheet-actions">
          ${
            node.isRootLeader
              ? `<button type="button" class="org-btn org-btn--primary" id="orgSendInstructionBtn">${escapeDisplayText(tr("organization.sendInstruction"))}</button>`
              : ""
          }
          <button type="button" class="org-btn ${node.isRootLeader ? "org-btn--secondary" : "org-btn--primary"}" id="orgViewDetailsBtn">${escapeDisplayText(detailsBtnLabel)}</button>
          ${
            !node.isReadOnlyNative && swarmMember && swarmMember.swarmState !== "killed" && this.sessionId
              ? `<button type="button" class="org-btn org-btn--secondary" id="orgSwarmModelBtn"${swarmMember.swarmState === "working" ? " disabled" : ""}>${escapeDisplayText(swarmMember.swarmState === "working" ? trText("organization.switchWaitRequired", "Switch Model (Waiting Required)", "切换模型（需先休眠）") : trText("organization.switchModelBtn", "Switch Model", "切换模型"))}</button>`
              : ""
          }
          ${
            !node.isReadOnlyNative && swarmMember && ["worktree", "staging"].includes(swarmMember.workspaceMode) && swarmMember.swarmState !== "killed" && this.sessionId
              ? `<button type="button" class="org-btn org-btn--secondary" id="orgSwarmPromoteBtn"${swarmMember.swarmState === "working" || this.promoteBusy ? " disabled" : ""}>${escapeDisplayText(trText("organization.promoteCandidate", "Promote Candidate", "晋升候选产物"))}</button>`
              : ""
          }
          ${
            swarmMember && !node.isRootLeader && swarmMember.role !== "coordinator" && swarmMember.contractRole !== "root_leadership" && swarmMember.swarmState !== "killed" && this.sessionId
              ? `<button type="button" class="org-btn org-btn--danger" id="orgSwarmKillBtn">${escapeDisplayText(trText("organization.killSwarmMember", "Kill Member", "终止成员"))}</button>`
              : ""
          }
        </div>
      `;

      // Wire sheet buttons
      const sendBtn = sheet.querySelector("#orgSendInstructionBtn");
      if (sendBtn) {
        sendBtn.addEventListener("click", () => {
          this.dismissBottomSheet();
          this.toggleOrganizationMode(false);
          const msgInput = document.getElementById("msgInput");
          if (msgInput) {
            msgInput.focus();
          } else if (typeof root.focusComposer === "function") {
            root.focusComposer({ force: true, preventScroll: true });
          }
        });
      }

      const detailBtn = sheet.querySelector("#orgViewDetailsBtn");
      if (detailBtn) {
        detailBtn.addEventListener("click", () => {
          this.dismissBottomSheet();
          this.openDetailScreen(node);
        });
      }

      const killBtn = sheet.querySelector("#orgSwarmKillBtn");
      if (killBtn && swarmMember) {
        killBtn.addEventListener("click", () => {
          void this.killSwarmMemberRequest(killTargetId, { forceDiscard: false });
        });
      }

      const forceKillBtn = sheet.querySelector("#orgSwarmForceKillBtn");
      if (forceKillBtn && swarmMember) {
        forceKillBtn.addEventListener("click", () => {
          void this.killSwarmMemberRequest(killTargetId, { forceDiscard: true });
        });
      }

      const cancelKillBtn = sheet.querySelector("#orgSwarmKillCancelBtn");
      if (cancelKillBtn) {
        cancelKillBtn.addEventListener("click", () => {
          this.killConflictInfo = null;
          this.killError = "";
          this.killConfirmTargetId = null;
          this.openBottomSheet(rawNode);
        });
      }

      const modelBtn = sheet.querySelector("#orgSwarmModelBtn");
      if (modelBtn && swarmMember) {
        modelBtn.addEventListener("click", () => {
          this.modelSwitchTargetId = killTargetId;
          this.modelSwitchOpen = !this.modelSwitchOpen;
          this.modelSwitchError = "";
          this.openBottomSheet(rawNode);
        });
      }

      const modelCancelBtn = sheet.querySelector("#orgSwarmModelCancelBtn");
      if (modelCancelBtn) {
        modelCancelBtn.addEventListener("click", () => {
          this.modelSwitchOpen = false;
          this.modelSwitchError = "";
          this.openBottomSheet(rawNode);
        });
      }

      const modelSubmitBtn = sheet.querySelector("#orgSwarmModelSubmitBtn");
      if (modelSubmitBtn && swarmMember) {
        modelSubmitBtn.addEventListener("click", () => {
          const harness = sheet.querySelector("#orgSwarmModelHarness")?.value?.trim() || "";
          const provider = sheet.querySelector("#orgSwarmModelProvider")?.value?.trim() || "";
          const modelName = sheet.querySelector("#orgSwarmModelName")?.value?.trim() || "";
          const effort = sheet.querySelector("#orgSwarmModelEffort")?.value?.trim() || "";
          const reason = sheet.querySelector("#orgSwarmModelReason")?.value?.trim() || "";
          void this.switchSwarmMemberModelRequest(killTargetId, {
            harness,
            provider,
            model: modelName,
            effort,
            reason,
          });
        });
      }

      const promoteBtn = sheet.querySelector("#orgSwarmPromoteBtn");
      if (promoteBtn && swarmMember) {
        promoteBtn.addEventListener("click", () => {
          this.modelSwitchTargetId = killTargetId;
          void this.promoteSwarmCandidateRequest(killTargetId);
        });
      }

      backdrop.hidden = false;
      sheet.hidden = false;
      // Animate slide up
      requestAnimationFrame(() => {
        sheet.classList.add("is-open");
      });
    }

    dismissBottomSheet() {
      this.selectedSheetNodeId = null;
      const sheet = this.dom.sheet;
      const backdrop = this.dom.sheetBackdrop;
      if (!sheet) return;
      sheet.classList.remove("is-open");
      setTimeout(() => {
        sheet.hidden = true;
        if (backdrop) backdrop.hidden = true;
      }, 200);
    }

    // --- Agent Detail Screen & Read-Only Conversation Loader ---

    openDetailScreen(rawNode) {
      const node = this.normalizeNodeForView(rawNode);
      if (!node) return;
      this.stopDetailPolling();
      this.detailNodeId = node.id;
      this.detailConversationState = null;
      const screen = this.dom.detailScreen;
      if (!screen) return;

      const stateName = String(node.runtimeState).toLowerCase();
      const statusText = formatRuntimeStatusText(node);
      const changedFiles = node.changedFiles || [];
      const subtitleText = node.isReadOnlyNative
        ? trText("organization.nativeSubagent", "Native subagent", "原生子代理")
        : node.isSyntheticRoot
          ? trText("organization.nativeRoot", "Root session", "根会话")
          : `${node.role}${node.domain ? ` · ${node.domain}` : ""}`;

      screen.innerHTML = `
        <div class="org-detail-top-bar">
          <button type="button" class="org-icon-btn" id="orgDetailBackBtn" aria-label="${escapeDisplayText(tr("organization.backToRadar"))}">
            ${root.RagentIcons?.render?.("chevron-left") || "←"}
          </button>
          <div class="org-detail-title">${escapeDisplayText(node.displayName)}</div>
        </div>

        <div class="org-detail-content">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div>
              <div style="font-size:12px;color:var(--text-secondary);">${escapeDisplayText(subtitleText)}</div>
              ${node.sessionId ? `<div style="font-size:11px;font-family:monospace;color:var(--text-tertiary);">Session: ${escapeDisplayText(node.sessionId)}</div>` : ""}
              ${node.providerRef ? `<div style="font-size:11px;font-family:monospace;color:var(--text-tertiary);">${escapeDisplayText(trText("organization.externalRef", "External provider ref", "外部运行时引用"))}: ${escapeDisplayText(node.providerRef)}</div>` : ""}
            </div>
            <div class="org-status-pill org-status-pill--${escapeDisplayText(stateName)}">
              <span class="org-status-pill-dot"></span>
              <span>${escapeDisplayText(statusText)}</span>
            </div>
          </div>

          <div class="org-meta-pills" id="orgDetailMetaPills">${this.renderMetaPillsHtml(node)}</div>

          <div class="org-honesty-banner ${node.sourceGap || node.parentUnknown ? "org-honesty-banner--warning" : ""}" id="orgDetailCoverageBanner">
            ${escapeDisplayText(this.buildHonestyBannerText(node))}
          </div>

          <div class="org-conv-section" id="orgDetailConversationSection">
            <div class="org-conv-header">
              <div class="org-info-card-label">${escapeDisplayText(trText("organization.memberConversation", "Read-only conversation", "只读会话视图"))}</div>
              <div class="org-conv-actions">
                <button type="button" class="org-btn org-btn--secondary" id="orgConvOlderBtn" hidden>${escapeDisplayText(trText("organization.loadEarlier", "Load earlier", "加载更早消息"))}</button>
                <button type="button" class="org-btn org-btn--secondary" id="orgConvRefreshBtn">${escapeDisplayText(trText("organization.refresh", "Refresh", "刷新"))}</button>
              </div>
            </div>
            <div class="org-conv-empty" id="orgConvStatus"></div>
            <div class="org-conv-list" id="orgConvList"></div>
          </div>

          ${
            !node.isReadOnlyNative
              ? `<div class="org-info-card">
                  <div class="org-info-card-label">${escapeDisplayText(tr("organization.currentTask"))}</div>
                  <div class="org-info-card-value" style="font-weight:600;">${escapeDisplayText(node.currentTaskSummary || tr("organization.noActiveTask"))}</div>
                  ${node.currentTaskDetail ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${escapeDisplayText(node.currentTaskDetail)}</div>` : ""}
                </div>`
              : ""
          }

          ${
            node.currentActivity || !node.isReadOnlyNative
              ? `<div class="org-info-card">
                  <div class="org-info-card-label">${escapeDisplayText(tr("organization.currentActivity"))}</div>
                  <div class="org-info-card-value" style="font-family:monospace;font-size:12px;">${escapeDisplayText(node.currentActivity || tr("organization.idle"))}</div>
                </div>`
              : ""
          }

          ${
            !node.isReadOnlyNative && node.memberKind === "formal"
              ? `<div class="org-info-card">
                  <div class="org-info-card-label">${escapeDisplayText(tr("organization.changedFiles"))} (${escapeDisplayText(changedFiles.length)})</div>
                  <div class="org-file-list">
                    ${
                      changedFiles.length > 0
                        ? changedFiles
                            .map(
                              (f) => `
                          <div class="org-file-item">
                            ${root.RagentIcons?.render?.("file") || "📄"}
                            <span>${escapeDisplayText(f)}</span>
                          </div>`
                            )
                            .join("")
                        : `<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;">${escapeDisplayText(trText("organization.noChangedFiles", "No changed files", "暂无变更文件"))}</div>`
                    }
                  </div>
                </div>`
              : ""
          }

          ${
            node.canOpenInbox
              ? `<div class="org-info-card"><button type="button" class="org-btn org-btn--secondary" id="orgNodeInboxBtn">${escapeDisplayText(trText("organization.messagesButton", "Messages", "成员消息"))}</button></div>`
              : ""
          }

          ${
            node.resultPacketSummary
              ? `<div class="org-info-card">
                  <div class="org-info-card-label">${escapeDisplayText(tr("organization.resultPacket"))}</div>
                  <div class="org-info-card-value">${escapeDisplayText(node.resultPacketSummary)}</div>
                </div>`
              : ""
          }

          ${
            node.blockerText
              ? `<div class="org-blocker-card">
                  <div style="font-weight:600;">${escapeDisplayText(tr("organization.activeBlocker"))}</div>
                  <div style="margin-top:4px;">${escapeDisplayText(node.blockerText)}</div>
                </div>`
              : ""
          }
        </div>
      `;

      const backBtn = screen.querySelector("#orgDetailBackBtn");
      if (backBtn) {
        backBtn.addEventListener("click", () => this.closeDetailScreen());
      }
      if (node.canOpenInbox) {
        screen.querySelector("#orgNodeInboxBtn")?.addEventListener("click", () => this.showNodeInbox(node));
      }

      const refreshBtn = screen.querySelector("#orgConvRefreshBtn");
      const olderBtn = screen.querySelector("#orgConvOlderBtn");
      if (node.conversationDescriptor?.ref && this.sessionId) {
        if (refreshBtn) {
          refreshBtn.addEventListener("click", () => {
            void this.loadMemberConversation(node, { mode: "refresh" });
          });
        }
        if (olderBtn) {
          olderBtn.addEventListener("click", () => {
            void this.loadMemberConversation(node, { mode: "older" });
          });
        }
        void this.loadMemberConversation(node, { mode: "initial" });
        this.detailPollTimerId = setInterval(() => {
          if (!this.active || this.detailNodeId !== node.id || this.dom.detailScreen?.hidden) {
            this.stopDetailPolling();
            return;
          }
          if (this.detailConversationState && !this.detailConversationState.denied && !this.detailConversationState.loading) {
            void this.loadMemberConversation(node, { mode: "delta" });
          }
        }, 3000);
      } else {
        if (refreshBtn) refreshBtn.hidden = true;
        const convStatus = screen.querySelector("#orgConvStatus");
        if (convStatus) {
          if (node.isSyntheticRoot) {
            convStatus.textContent = trText(
              "organization.syntheticRootTranscriptNotice",
              "Root session conversation is available in the main chat timeline.",
              "根会话的对话内容请返回主聊天时间线查看。"
            );
          } else {
            convStatus.textContent = node.coverage === "activity_only"
              ? trText("organization.coverage.activityOnlyDesc", "Available activity and results only; no child transcript was captured.", "仅显示可用的活动和结果，未捕获子会话正文。")
              : trText("organization.coverage.unavailableDesc", "This member's conversation is unavailable.", "此成员的会话暂不可用。");
          }
        }
      }

      screen.hidden = false;
    }

    async loadMemberConversation(node, { mode = "initial" } = {}) {
      const screen = this.dom.detailScreen;
      const memberRef = node?.conversationDescriptor?.ref;
      const targetSessionId = this.sessionId;
      if (!screen || !memberRef || !targetSessionId) return;

      const epoch = this.detailRequestEpoch;
      const fetcher = this.getFetcher();
      const statusEl = screen.querySelector("#orgConvStatus");
      const listEl = screen.querySelector("#orgConvList");
      const olderBtn = screen.querySelector("#orgConvOlderBtn");
      const pillsEl = screen.querySelector("#orgDetailMetaPills");
      const bannerEl = screen.querySelector("#orgDetailCoverageBanner");
      if (!fetcher) {
        if (statusEl) statusEl.textContent = trText("organization.conversationUnavailable", "Conversation unavailable.", "会话暂不可用。");
        return;
      }

      const prevState = this.detailConversationState || {
        generation: null,
        scope: null,
        revision: null,
        entries: [],
        nextBeforeSeq: null,
        latestSeq: 0,
        hasMoreBefore: false,
        denied: false,
        loading: false,
      };
      if (prevState.loading && mode === "delta") return;
      prevState.loading = true;
      this.detailConversationState = prevState;

      if (mode === "initial" && statusEl) {
        statusEl.textContent = trText("organization.loadingConversation", "Loading conversation…", "正在加载会话…");
      }

      const basePath = `/api/sessions/${encodeURIComponent(targetSessionId)}/organization/members/${encodeURIComponent(memberRef)}/conversation`;
      let url = `${basePath}?limit=50`;
      if (mode === "older" && prevState.nextBeforeSeq != null) {
        url = `${basePath}?beforeSeq=${encodeURIComponent(prevState.nextBeforeSeq)}&limit=50`;
      } else if (mode === "delta" && prevState.latestSeq > 0) {
        url = `${basePath}?afterSeq=${encodeURIComponent(prevState.latestSeq)}&limit=200`;
      }

      try {
        const res = await fetcher(url, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (this.detailRequestEpoch !== epoch || this.detailNodeId !== node.id || this.sessionId !== targetSessionId) return;

        if (res.status === 401 || res.status === 403) {
          prevState.denied = true;
          prevState.entries = [];
          if (listEl) listEl.replaceChildren();
          if (olderBtn) olderBtn.hidden = true;
          if (statusEl) statusEl.textContent = trText("organization.conversationDenied", "This conversation is not available.", "无法查看此会话。");
          return;
        }
        if (res.status === 404) {
          prevState.entries = [];
          if (listEl) listEl.replaceChildren();
          if (olderBtn) olderBtn.hidden = true;
          if (statusEl) statusEl.textContent = trText("organization.coverage.unavailableDesc", "This member's conversation is unavailable.", "此成员的会话暂不可用。");
          return;
        }
        if (res.status === 409) {
          prevState.entries = [];
          prevState.generation = null;
          prevState.latestSeq = 0;
          prevState.nextBeforeSeq = null;
          if (listEl) listEl.replaceChildren();
          if (olderBtn) olderBtn.hidden = true;
          if (statusEl) statusEl.textContent = trText("organization.bindingChanged", "Member binding changed; refreshing…", "成员绑定已变更，正在刷新…");
          void this.refreshOrganizationData({ force: true });
          return;
        }
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const page = await res.json();
        if (this.detailRequestEpoch !== epoch || this.detailNodeId !== node.id || this.sessionId !== targetSessionId) return;

        const validScopes = new Set(["full", "captured_only", "activity_only", "unavailable"]);
        if (page?.reset || !Number.isSafeInteger(page?.generation) || page.generation < 0 || !validScopes.has(page?.scope)) {
          prevState.entries = [];
          prevState.generation = null;
          prevState.latestSeq = 0;
          if (listEl) listEl.replaceChildren();
          if (statusEl) statusEl.textContent = trText("organization.conversationReset", "Conversation reset; click Refresh to reload.", "会话已重置，请点击刷新重新加载。");
          return;
        }

        if (mode === "delta" || mode === "older") {
          if (prevState.generation !== null && (page.generation !== prevState.generation || page.scope !== prevState.scope)) {
            this.detailConversationState = null;
            void this.loadMemberConversation(node, { mode: "refresh" });
            return;
          }
          if (prevState.revision != null && page.revision != null && page.revision < prevState.revision) {
            this.detailConversationState = null;
            void this.loadMemberConversation(node, { mode: "refresh" });
            return;
          }
        }

        const effectiveCoverage = normalizeCoverage(page.scope, page.coverage, node.isReadOnlyNative, page.availability);
        const hasGap = Boolean(page.gap || node.sourceGap);
        if (pillsEl) {
          pillsEl.innerHTML = this.renderMetaPillsHtml(node, effectiveCoverage, hasGap);
        }
        if (bannerEl) {
          bannerEl.className = `org-honesty-banner ${hasGap || node.parentUnknown ? "org-honesty-banner--warning" : ""}`;
          bannerEl.textContent = this.buildHonestyBannerText(node, effectiveCoverage, hasGap);
        }

        const incoming = Array.isArray(page.entries) ? page.entries : [];
        let combined;
        if (mode === "older") {
          combined = [...incoming, ...prevState.entries];
        } else if (mode === "delta") {
          combined = [...prevState.entries, ...incoming];
        } else {
          combined = incoming;
        }

        // Deduplicate deterministically by eventId / id / seq and sort chronologically by seq
        const seen = new Map();
        for (const entry of combined) {
          if (!entry || typeof entry !== "object") continue;
          const seq = Number.isInteger(entry.seq) && entry.seq > 0 ? entry.seq : 0;
          const key = entry.eventId || entry.id || `${entry.type || "event"}:${seq}:${entry.timelineEntityId || ""}`;
          seen.set(key, entry);
        }
        const orderedEntries = Array.from(seen.values())
          .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
          .slice(-1000);

        prevState.generation = page.generation;
        prevState.scope = page.scope;
        prevState.revision = page.revision ?? prevState.revision;
        prevState.entries = orderedEntries;
        if (mode !== "delta") {
          prevState.nextBeforeSeq = page.nextBeforeSeq ?? null;
          prevState.hasMoreBefore = Boolean(page.hasMoreBefore && page.nextBeforeSeq != null);
        }
        const maxIncomingSeq = orderedEntries.reduce((acc, ev) => Math.max(acc, Number(ev.seq) || 0), 0);
        prevState.latestSeq = Math.max(prevState.latestSeq || 0, Number(page.nextAfterSeq) || 0, maxIncomingSeq);

        if (olderBtn) {
          olderBtn.hidden = !prevState.hasMoreBefore;
        }
        if (listEl) {
          this.renderConversationEntries(listEl, orderedEntries);
        }
        if (statusEl) {
          if (orderedEntries.length > 0) {
            statusEl.textContent = "";
          } else if (effectiveCoverage === "activity_only") {
            const actState = page.activity?.state || node.rawNativeState || "unknown";
            statusEl.textContent = `${trText("organization.coverage.activityOnlyDesc", "Available activity and results only; no child transcript was captured.", "仅显示可用的活动和结果，未捕获子会话正文。")} (${actState})`;
          } else if (effectiveCoverage === "unavailable") {
            statusEl.textContent = trText("organization.coverage.unavailableDesc", "This member's conversation is unavailable.", "此成员的会话暂不可用。");
          } else {
            statusEl.textContent = trText("organization.noMessages", "No messages yet.", "暂无消息。");
          }
        }
      } catch (err) {
        if (this.detailRequestEpoch !== epoch || this.detailNodeId !== node.id) return;
        if (statusEl) {
          statusEl.textContent = prevState.entries.length > 0
            ? trText("organization.conversationRefreshFailedRetained", "Couldn't refresh · showing previously verified entries.", "刷新失败，保留显示已加载内容。")
            : trText("organization.conversationUnavailable", "Conversation unavailable.", "会话暂不可用。");
        }
      } finally {
        prevState.loading = false;
      }
    }

    renderConversationEntries(container, entries) {
      if (!container) return;
      container.replaceChildren();
      for (const entry of entries) {
        const type = String(entry?.type || "notice").toLowerCase();
        if (type === "usage" || type === "approval_request" || type === "run_terminal" || type === "run_regenerate") {
          continue;
        }
        const card = document.createElement("div");
        const role = String(entry?.role || "").toLowerCase();
        let variant = "notice";
        let metaTitle = type;
        let bodyText = "";

        if (type === "message") {
          variant = role === "user" ? "user" : role === "system" ? "system" : "assistant";
          metaTitle = role === "user"
            ? trText("organization.roleUser", "User", "用户")
            : role === "system"
              ? trText("organization.roleSystem", "System", "系统")
              : trText("organization.roleAssistant", "Assistant", "助手");
          bodyText = typeof entry.content === "string"
            ? entry.content
            : (typeof entry.text === "string" ? entry.text : "");
          if (!bodyText && Array.isArray(entry.attachments) && entry.attachments.length > 0) {
            bodyText = entry.attachments.map((a) => a?.name || a?.filename || "attachment").join(", ");
          }
        } else if (type === "thinking_block" || type === "reasoning") {
          variant = "thinking";
          metaTitle = trText("organization.thinkingLabel", "Reasoning", "思考过程");
          bodyText = typeof entry.content === "string"
            ? entry.content
            : (typeof entry.text === "string" ? entry.text : "");
        } else if (type === "operation" || type === "tool_use" || type === "tool_result") {
          variant = "operation";
          metaTitle = entry.title || entry.toolName || trText("organization.operationLabel", "Tool call", "工具调用");
          const parts = [];
          if (entry.state) parts.push(`[${entry.state}]`);
          if (entry.detail && entry.detail !== metaTitle) parts.push(entry.detail);
          if (entry.summary && entry.summary !== metaTitle && entry.summary !== entry.detail) parts.push(entry.summary);
          if (entry.command && entry.command !== entry.detail) parts.push(entry.command);
          const inputText = readableToolField(entry.input ?? entry.toolInput);
          if (inputText && inputText !== entry.detail && inputText !== entry.command) parts.push(`Input:\n${inputText}`);
          const outputText = readableToolField(entry.outputPreview ?? entry.output);
          if (outputText && outputText !== entry.detail) parts.push(`Output:\n${outputText}`);
          if (entry.exitCode != null) parts.push(`Exit code: ${entry.exitCode}`);
          bodyText = parts.join("\n");
        } else if (type === "plan") {
          variant = "plan";
          metaTitle = entry.title || trText("organization.planLabel", "Plan", "计划");
          const itemLines = Array.isArray(entry.items)
            ? entry.items.map((it) => `- ${typeof it === "string" ? it : (it?.text || it?.step || it?.title || "")}`).filter(Boolean)
            : [];
          bodyText = [entry.bodyMarkdown || "", ...itemLines].filter(Boolean).join("\n");
        } else {
          bodyText = entry.content || entry.text || entry.detail || "";
        }

        if (!bodyText.trim()) continue;
        card.className = `org-conv-item org-conv-item--${variant}`;

        const meta = document.createElement("div");
        meta.className = "org-conv-item-meta";
        const labelSpan = document.createElement("span");
        labelSpan.textContent = metaTitle;
        meta.appendChild(labelSpan);
        if (Number.isInteger(entry.seq) && entry.seq > 0) {
          const seqSpan = document.createElement("span");
          seqSpan.textContent = `#${entry.seq}`;
          meta.appendChild(seqSpan);
        }

        const body = document.createElement("div");
        body.className = "org-conv-item-body";
        body.textContent = bodyText;

        card.appendChild(meta);
        card.appendChild(body);
        container.appendChild(card);
      }
    }

    async showNodeInbox(rawNode) {
      const node = this.normalizeNodeForView(rawNode);
      const organizationId = this.projection?.organizationId;
      const screen = this.dom.detailScreen;
      if (!node || !organizationId || !screen || node.memberKind !== "formal" || node.isReadOnlyNative) return;
      this.stopDetailPolling();
      screen.replaceChildren();
      const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; screen.appendChild(el); return el; };
      const button = (label, action) => { const el = add('button', label); el.type = 'button'; el.className = 'org-btn org-btn--secondary'; el.addEventListener('click', action); return el; };
      button('Back', () => this.openDetailScreen(node));
      add('h2', `Messages to ${node.displayName || node.id}`);
      const list = add('div', 'Loading…');
      const field = document.createElement('textarea'); field.maxLength = 4000; field.placeholder = 'Informational message'; screen.appendChild(field);
      const deadline = document.createElement('input'); deadline.type = 'datetime-local'; deadline.setAttribute('aria-label', 'Reply deadline (optional)'); screen.appendChild(deadline);
      const task = document.createElement('input'); task.placeholder = 'Work item ID (optional)'; task.setAttribute('aria-label', 'Work item ID'); screen.appendChild(task);
      const receipt = add('p', 'Messages are queued for the node; delivery does not mean a reply.');
      const path = `/api/organizations/${encodeURIComponent(organizationId)}/factory/nodes/${encodeURIComponent(node.id)}/messages`;
      const fetcher = this.getFetcher();
      const request = async (options, target = path) => { if (!fetcher) throw new Error('Fetch unavailable'); const res = await fetcher(target, { credentials: 'same-origin', cache: 'no-store', ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data; };
      const refresh = async () => {
        try { const data = await request(); list.replaceChildren(); for (const message of data.messages) { const p = document.createElement('p'); p.textContent = `${message.createdAt} · ${message.deliveryState === 'delivered' ? 'Delivered to Run' : message.deliveryState} · ${message.requestState || 'information'} · ${message.body}${message.reply ? ` · Reply: ${message.reply.body}` : ''}${message.escalation ? ` · Escalation: ${message.escalation.deliveryState}` : ''}`; list.appendChild(p);
          if(message.requestState==='overdue' && !message.escalation) { const action=document.createElement('button'); action.type='button'; action.className='org-btn org-btn--secondary'; action.textContent='Escalate to manager'; list.appendChild(action); let key=null; action.addEventListener('click',async()=>{ key ||= root.crypto.randomUUID(); action.disabled=true; try { const result=await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:key})},`${path}/${encodeURIComponent(message.messageId)}/escalate`); receipt.textContent=`Escalation ${result.message.messageId}: ${result.message.deliveryState}; original request remains unanswered.`; await refresh(); } catch(error) { receipt.textContent=`Escalation not confirmed: ${error.message}. Retry uses the same request.`; action.disabled=false; } }); }
        } if (!data.messages.length) list.textContent = 'No messages.'; }
        catch (error) { list.textContent = `Unable to load messages: ${error.message}`; }
      };
      const send = requestType => {
        const body = field.value.trim(); if (!body) return;
        const command = { body, requestType, idempotencyKey: root.crypto.randomUUID() };
        if(task.value.trim()) command.workItemId=task.value.trim();
        if(requestType==='required_response' && deadline.value) { const date=new Date(deadline.value); if(!Number.isFinite(date.getTime())) {receipt.textContent='Reply deadline is invalid.';return;} command.respondBy=date.toISOString(); }
        const submit = async () => { try { const data = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }); receipt.textContent = `Message ${data.message.messageId}: ${data.message.deliveryState}`; field.value = ''; await refresh(); }
          catch (error) { receipt.textContent = `Not confirmed: ${error.message}. Retry uses the same message ID.`; button('Retry same message', submit); } };
        submit();
      };
      button('Send information', () => send('information'));
      button('Request a reply', () => send('required_response'));
      button('Refresh', refresh); await refresh();
    }

    closeDetailScreen() {
      this.stopDetailPolling();
      this.detailNodeId = null;
      this.detailConversationState = null;
      if (this.dom.detailScreen) {
        this.dom.detailScreen.hidden = true;
      }
    }
  }

  // --- 6. Global Export & Auto Initialization ---

  const manager = new RagentOrganizationViewManager();
  root.RagentOrganizationView = manager;

  // Intercept WebSocket organization_invalidated if handler already attached
  const existingInvalidationHandler = root.handleOrganizationInvalidation;
  root.handleOrganizationInvalidation = function (msg) {
    if (typeof existingInvalidationHandler === "function") {
      try {
        existingInvalidationHandler(msg);
      } catch (e) {
        console.warn("[organization-view] Previous invalidation handler error:", e);
      }
    }
    manager.handleInvalidation(msg);
  };
})(window);
