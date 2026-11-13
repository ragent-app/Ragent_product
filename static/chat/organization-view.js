/**
 * organization-view.js — AgentoC Organization View v1 (AI Organization Radar)
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
    if (typeof root.AgentoCI18n?.t === "function") {
      return root.AgentoCI18n.t(key, params);
    }
    return key;
  }

  // --- 1. Domain Types & Enums ---

  const NodeRole = Object.freeze({
    EXECUTIVE: "EXECUTIVE",
    MANAGER: "MANAGER",
    WORKER: "WORKER",
    REVIEWER: "REVIEWER",
    EXPERT: "EXPERT",

    fromString(role) {
      const r = String(role || "").toLowerCase();
      if (r === "root" || r === "executive" || r === "lead") return NodeRole.EXECUTIVE;
      if (r === "manager" || r === "lead_worker") return NodeRole.MANAGER;
      if (r === "reviewer") return NodeRole.REVIEWER;
      if (r === "expert" || r === "consultant") return NodeRole.EXPERT;
      return NodeRole.WORKER;
    },
  });

  const AgentDomain = Object.freeze({
    BACKEND: "BACKEND",
    ANDROID: "ANDROID",
    RUNTIME: "RUNTIME",
    SECURITY: "SECURITY",
    TESTING: "TESTING",
    ARCHITECTURE: "ARCHITECTURE",
    DATABASE: "DATABASE",
    RESEARCH: "RESEARCH",
    GENERAL: "GENERAL",

    infer(displayName, domainHint) {
      const text = `${domainHint || ""} ${displayName || ""}`.toLowerCase();
      if (text.includes("android") || text.includes("ui") || text.includes("frontend")) return AgentDomain.ANDROID;
      if (text.includes("runtime") || text.includes("protocol") || text.includes("stream")) return AgentDomain.RUNTIME;
      if (text.includes("security") || text.includes("permission") || text.includes("auth")) return AgentDomain.SECURITY;
      if (text.includes("test") || text.includes("qa") || text.includes("benchmark")) return AgentDomain.TESTING;
      if (text.includes("arch")) return AgentDomain.ARCHITECTURE;
      if (text.includes("db") || text.includes("database") || text.includes("sqlite") || text.includes("room")) return AgentDomain.DATABASE;
      if (text.includes("research") || text.includes("doc")) return AgentDomain.RESEARCH;
      if (text.includes("backend") || text.includes("server") || text.includes("api")) return AgentDomain.BACKEND;
      return AgentDomain.GENERAL;
    },
  });

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

  function renderDomainGlyph(role, domain) {
    if (role === NodeRole.REVIEWER) {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m5 13 4 4L19 7"/>
      </svg>`;
    }

    switch (domain) {
      case AgentDomain.BACKEND:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>`;

      case AgentDomain.ANDROID:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
          <circle cx="12" cy="18" r="1" fill="currentColor"/>
        </svg>`;

      case AgentDomain.RUNTIME:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>`;

      case AgentDomain.SECURITY:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>`;

      case AgentDomain.TESTING:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 2v7.31L4.89 18.5a2 2 0 0 0 1.73 3h10.76a2 2 0 0 0 1.73-3L14 9.31V2"/>
          <line x1="8.5" y1="2" x2="15.5" y2="2"/>
          <line x1="7" y1="14" x2="17" y2="14"/>
        </svg>`;

      case AgentDomain.DATABASE:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>`;

      case AgentDomain.ARCHITECTURE:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/>
          <rect x="14" y="3" width="7" height="7"/>
          <rect x="14" y="14" width="7" height="7"/>
          <rect x="3" y="14" width="7" height="7"/>
        </svg>`;

      case AgentDomain.RESEARCH:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>`;

      default:
        return `<svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="3.5"/>
        </svg>`;
    }
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

      const rootNode = nodeList.find((n) => n.role === NodeRole.EXECUTIVE)
        || nodeList.find((n) => !n.parentId)
        || nodeList[0];

      const rootId = rootNode.id;
      const centerX = viewportWidth / 2;
      const rootY = Math.max(120, viewportHeight * 0.18);

      const childrenByParent = {};
      nodeList.forEach((n) => {
        const p = n.parentId || "";
        if (!childrenByParent[p]) childrenByParent[p] = [];
        childrenByParent[p].push(n);
      });

      const calculatedPositions = {};
      const clusterNodes = {};

      // 1. Root Executive Position
      const rootPos = previousPositions[rootId] || { x: centerX, y: rootY };
      calculatedPositions[rootId] = rootPos;

      // 2. Direct leads of Root (Level 1)
      const level1Nodes = childrenByParent[rootId] || [];
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
          calculatedPositions[node.id] = previousPositions[node.id] || idealPoints[index];
        });
      }

      // 3. Level 2+ Workers / Subtrees
      for (const lead of level1Nodes) {
        const leadPos = calculatedPositions[lead.id];
        if (!leadPos) continue;
        const children = childrenByParent[lead.id] || [];
        if (children.length === 0) continue;

        const isFocused = focusNodeId === lead.id;
        const shouldCluster = children.length > clusterThreshold && !isFocused && !collapsedClusterIds.has(lead.id);

        if (shouldCluster) {
          const clusterId = `cluster_${lead.id}`;
          const clusterPos = { x: leadPos.x, y: leadPos.y + 110 };
          calculatedPositions[clusterId] = clusterPos;
          clusterNodes[clusterId] = {
            id: clusterId,
            x: clusterPos.x,
            y: clusterPos.y,
            radius: 20,
            isVisible: true,
            isCluster: true,
            clusterCount: children.length,
            clusterChildIds: children.map((c) => c.id),
            alpha: focusNodeId && focusNodeId !== lead.id && focusNodeId !== rootId ? 0.45 : 1.0,
          };
        } else {
          const childPositions = FocusTreeLayout.layoutChildren(leadPos, children, 110, 90);
          for (const [childId, pt] of Object.entries(childPositions)) {
            calculatedPositions[childId] = previousPositions[childId] || pt;
          }
        }
      }

      // Position any remaining unassigned nodes
      nodeList.forEach((node) => {
        if (!calculatedPositions[node.id]) {
          const parentPt = node.parentId ? calculatedPositions[node.parentId] : rootPos;
          const offset = ((node.id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 60) - 30;
          calculatedPositions[node.id] = { x: (parentPt ? parentPt.x : centerX) + offset, y: (parentPt ? parentPt.y : rootY) + 100 };
        }
      });

      // Build NodePosition objects
      const nodePositions = {};
      nodeList.forEach((node) => {
        const pt = calculatedPositions[node.id];
        if (!pt) return;
        const isFocused = node.id === focusNodeId;
        const isDimmed = focusNodeId && focusNodeId !== rootId && node.id !== focusNodeId && node.parentId !== focusNodeId;

        let radius = 16;
        if (node.role === NodeRole.EXECUTIVE) radius = 24;
        else if (node.role === NodeRole.MANAGER) radius = 20;
        else if (node.role === NodeRole.EXPERT) radius = 18;

        const isHiddenInCluster = Object.values(clusterNodes).some((cl) => cl.clusterChildIds.includes(node.id));
        if (!isHiddenInCluster) {
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

      // 4. Edge routing
      const edgePaths = [];
      edges.forEach((edge) => {
        const fromPos = calculatedPositions[edge.fromNodeId];
        let toPos = calculatedPositions[edge.toNodeId];
        let targetId = edge.toNodeId;

        const containingCluster = Object.values(clusterNodes).find((cl) => cl.clusterChildIds.includes(edge.toNodeId));
        if (containingCluster) {
          toPos = { x: containingCluster.x, y: containingCluster.y };
          targetId = containingCluster.id;
        }

        if (fromPos && toPos) {
          const alpha = focusNodeId && edge.fromNodeId !== focusNodeId && edge.toNodeId !== focusNodeId ? 0.3 : 0.85;
          edgePaths.push(
            EdgeRouter.routeEdge(
              edge.id || `${edge.fromNodeId}-${targetId}`,
              edge.fromNodeId,
              targetId,
              fromPos,
              toPos,
              alpha
            )
          );
        }
      });

      // Add edges from leads to clusters
      Object.entries(clusterNodes).forEach(([clusterId, clusterNode]) => {
        const leadId = clusterId.replace("cluster_", "");
        const leadPos = calculatedPositions[leadId];
        if (leadPos) {
          edgePaths.push(
            EdgeRouter.routeEdge(`edge_${clusterId}`, leadId, clusterId, leadPos, { x: clusterNode.x, y: clusterNode.y }, 0.85)
          );
        }
      });

      // 5. Bounds
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

  // --- 5. AgentoCOrganizationViewManager Main Controller ---

  class AgentoCOrganizationViewManager {
    constructor() {
      this.sessionId = null;
      this.projection = null;
      this.projectionEtag = null;
      this.loading = false;
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
      this.layoutResult = null;
      this.animationFrameId = null;
      this.communicationScheduler = new CommunicationVisualScheduler(3);
      this.activityEvents = [];
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
      this.bindDOM();
      this.setupEventListeners();
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
            <button type="button" class="org-icon-btn" id="orgFactoryWorkBtn" title="Work items">Tasks</button>
            <button type="button" class="org-icon-btn" id="orgRadarResetBtn" title="${tr("organization.resetView")}" aria-label="${tr("organization.resetView")}">
              ${root.AgentoCIcons?.render?.("refresh") || "↺"}
            </button>
            <button type="button" class="org-icon-btn" id="orgRadarCloseBtn" title="${tr("organization.timeline")}" aria-label="${tr("organization.timeline")}">
              ${root.AgentoCIcons?.render?.("close") || "✕"}
            </button>
          </div>
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

      // Activity Feed Toggle
      this.dom.activityFeedHeader?.addEventListener("click", () => this.toggleActivityFeed());

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

    async showFactoryWork() {
      const organizationId = this.projection?.organizationId;
      if (!organizationId || !this.dom.detailScreen) return;
      const screen = this.dom.detailScreen;
      screen.hidden = false;
      screen.replaceChildren();
      const add = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.appendChild(el); return el; };
      const button = (parent, label, action) => { const el = add(parent, 'button', label); el.type = 'button'; el.className = 'org-btn org-btn--secondary'; el.addEventListener('click', action); return el; };
      const base = `/api/organizations/${encodeURIComponent(organizationId)}/factory`;
      const fetcher = root.agentocFetch || fetch;
      const request = async (path, options = {}) => {
        const response = await fetcher(base + path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
        return body;
      };
      const header = add(screen, 'div', '');
      button(header, 'Back', () => { screen.hidden = true; screen.replaceChildren(); });
      add(header, 'h2', 'Work items');
      const content = add(screen, 'div', 'Loading…');
      const showList = async () => {
        content.replaceChildren(); add(content, 'p', 'Loading…');
        try {
          const [list, status] = await Promise.all([request('/work-items'), request('/status')]);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          content.replaceChildren();
          add(content, 'p', `As of ${list.asOf} · Automatic admission ${status.automaticAdmission === true ? 'enabled' : status.automaticAdmission === false ? 'off' : 'status unavailable'} · Execution ${status.executionReadiness}`);
          if (!list.items.length) add(content, 'p', 'No work items.');
          for (const item of list.items) button(content, `${item.contract?.objective || item.id} · ${item.state} · ${item.controlState}`, () => showItem(item.id));
          if (list.nextCursor) add(content, 'p', 'More items exist; this view shows the first page.');
          button(content, 'Team lifecycle', showLifecycle);
          button(content, 'Positions and relationships', showTeamConfiguration);
          button(content, 'Integration queue', showIntegrationQueue);
          button(content, 'Refresh', showList);
        } catch (error) { content.replaceChildren(); add(content, 'p', `Unable to load work items: ${error.message}`); button(content, 'Retry', showList); }
      };
      const showItem = async id => {
        content.replaceChildren(); add(content, 'p', 'Loading…');
        try {
          const { item, asOf } = await request(`/work-items/${encodeURIComponent(id)}`);
          if (this.projection?.organizationId !== organizationId || screen.hidden) return;
          content.replaceChildren(); button(content, 'All work items', showList);
          add(content, 'h3', item.contract?.objective || item.id);
          add(content, 'p', `State ${item.state}; control ${item.controlState}; priority ${item.priority}; version ${item.rowVersion}; contract ${item.contractRevision}; as of ${asOf}`);
          for (const [label, value] of [['Dependencies', item.dependencies], ['Contract', item.contract], ['Executions', item.bindings], ['Candidates', item.candidates], ['Decisions', item.decisions]]) {
            add(content, 'h4', label); add(content, 'pre', JSON.stringify(value || [], null, 2));
          }
          add(content, 'h4', 'Delivery evidence');
          for (const candidate of item.candidates || []) add(content, 'p', `Candidate ${candidate.digest || 'unverified'} · contract ${candidate.contractRevision} · execution ${candidate.executionEpoch}`);
          if (!item.candidates?.length) add(content, 'p', 'Candidate: unverified');
          for (const decision of item.decisions || []) add(content, 'p', `Acceptance ${decision.criterionId}: ${decision.decision} · candidate ${decision.candidateDigest}. Evidence: ${JSON.stringify(decision.evidence || [])}`);
          if (!item.decisions?.length) add(content, 'p', 'Acceptance and checks: unverified');
          for (const milestone of item.milestones || []) add(content, 'p', `${milestone.milestone} · candidate ${milestone.candidateDigest} · commit ${milestone.evidence?.commit || 'unverified'} · target ${milestone.target || 'unknown'}`);
          if (!item.milestones?.some(m => m.milestone === 'integrated')) add(content, 'p', 'Integrated commit: unverified');
          add(content, 'p', 'Package availability and publication: unverified unless supported by a recorded delivery operation.');
          const reconcileStatus = add(content, 'p', 'Loading reconciliation state…');
          try { const state = await request(`/work-items/${encodeURIComponent(item.id)}/reconcile`); reconcileStatus.textContent = `Reconciliation: ${state.state || 'unknown'}; observation continues: ${state.observationContinues ?? 'unknown'}; ${state.errorCode || ''}`; }
          catch (error) { reconcileStatus.textContent = `Reconciliation state unavailable: ${error.message}`; }
          const receipt = add(content, 'p', '');
          button(content, 'Request reconciliation', () => {
            const body = { commandId:root.crypto.randomUUID(), expectedVersion:item.rowVersion, executionEpoch:item.executionEpoch };
            const submit = async () => { try { const result=await request(`/work-items/${encodeURIComponent(item.id)}/reconcile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); receipt.textContent=`Reconciliation request ${result.requested ? 'recorded' : 'not confirmed'}; refresh for observed facts.`; } catch(error) { receipt.textContent=`Reconciliation not confirmed: ${error.message}`; button(content,'Retry same reconciliation request',submit); } }; submit();
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
          button(content, 'Create task handoff', () => {
            const payload={commandId:root.crypto.randomUUID(),expectedVersion:item.rowVersion};
            const submit=async () => { try { const result=await request(`/work-items/${encodeURIComponent(item.id)}/handoffs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); receipt.textContent=`Handoff ${result.id} as of ${result.asOf}; stale: ${result.stale}.`; add(content,'pre',JSON.stringify(result.facts,null,2)); } catch(error) { receipt.textContent=`Handoff not confirmed: ${error.message}`; button(content,'Retry same handoff',submit); } }; submit();
          });
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
      await showList();
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

    onSessionChanged(sessionId) {
      if (this.sessionId === sessionId) return;
      this.sessionId = sessionId;
      this.projection = null;
      this.projectionEtag = null;
      this.focusNodeId = null;
      this.selectedSheetNodeId = null;
      this.detailNodeId = null;
      this.dismissBottomSheet();
      this.closeDetailScreen();

      if (!sessionId) {
        this.setRadarButtonVisibility(false);
        if (this.active) this.toggleOrganizationMode(false);
        return;
      }

      this.fetchProjection().then((proj) => {
        const hasOrg = Boolean(proj && proj.nodes && proj.nodes.length > 0);
        this.setRadarButtonVisibility(hasOrg);
        if (this.active && hasOrg) {
          this.render();
        } else if (this.active && !hasOrg) {
          this.toggleOrganizationMode(false);
        }
      });
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
      if (!this.sessionId) return null;
      if (this.loading && !force) return this.projection;
      this.loading = true;

      try {
        const headers = { Accept: "application/json" };
        if (this.projectionEtag && !force) {
          headers["If-None-Match"] = this.projectionEtag;
        }
        const fetcher = root.agentocFetch || fetch;
        const res = await fetcher(`/api/sessions/${encodeURIComponent(this.sessionId)}/organization/projection?version=2`, {
          credentials: "same-origin",
          cache: "no-store",
          headers,
        });

        if (res.status === 304) {
          return this.projection;
        }

        if (!res.ok) {
          if (res.status === 404) {
            this.projection = null;
            return null;
          }
          throw new Error(`Failed to load organization projection: ${res.status}`);
        }

        this.projectionEtag = res.headers.get("ETag") || this.projectionEtag;
        const payload = await res.json();
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

    handleInvalidation(msg = {}) {
      if (!this.sessionId) return;
      if (msg.organizationId && this.projection?.organizationId && msg.organizationId !== this.projection.organizationId) {
        return;
      }
      const nextRev = Number(msg.revision || 0);
      const currRev = Number(this.projection?.revision || this.projection?.asOf?.revision || 0);
      if (nextRev && currRev && nextRev < currRev) return;

      this.fetchProjection(true).then((proj) => {
        const hasOrg = Boolean(proj && proj.nodes && proj.nodes.length > 0);
        this.setRadarButtonVisibility(hasOrg);
        if (this.active) {
          this.render();
        }
      });
    }

    processProjectionEvents(proj) {
      if (!proj) return;
      // Synthesize communication and activity events
      const nodes = proj.nodes || [];
      const edges = proj.edges || [];

      // A blocker is not an approval request; the old buttons had no command.
      this.approvalOverlay = null;

      // Schedule particles for active nodes/edges
      nodes.forEach((node) => {
        if (node.status === "running" || node.status === "working") {
          const parentEdge = edges.find((e) => e.childNodeId === node.id || e.toNodeId === node.id);
          if (parentEdge) {
            this.communicationScheduler.scheduleCommunication(
              `comm_${node.id}_${Date.now()}`,
              CommunicationType.TASK_ASSIGNED,
              parentEdge.parentNodeId || parentEdge.fromNodeId,
              node.id
            );
          }
        } else if (node.status === "waiting_review") {
          const reviewerEdge = edges.find((e) => (e.edgeType === "REVIEWS" || e.type === "REVIEWS") && (e.fromNodeId === node.id || e.childNodeId === node.id));
          if (reviewerEdge) {
            this.communicationScheduler.scheduleCommunication(
              `comm_rev_${node.id}_${Date.now()}`,
              CommunicationType.REVIEW_REQUESTED,
              node.id,
              reviewerEdge.toNodeId || reviewerEdge.parentNodeId
            );
          }
        }
      });

      // Update Activity Feed
      const activities = [];
      nodes.forEach((node) => {
        if (node.currentActivity) {
          activities.push({
            id: `act_${node.id}`,
            dotClass: node.status === "blocked" ? "error" : node.status === "running" ? "running" : "waiting",
            message: `${node.stableKey || node.id}: ${node.currentActivity}`,
            time: "now",
          });
        }
      });
      this.activityEvents = activities;
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
      } else {
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
        ctx.beginPath();
        ctx.moveTo(edge.start.x, edge.start.y);
        ctx.bezierCurveTo(edge.control1.x, edge.control1.y, edge.control2.x, edge.control2.y, edge.end.x, edge.end.y);
        ctx.strokeStyle = `rgba(148, 163, 184, ${edge.alpha || 0.6})`;
        ctx.lineWidth = 1.75;
        ctx.stroke();
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

    // --- DOM Graph Rendering ---

    render() {
      if (!this.active || !this.dom.surface) return;
      this.updateViewportDimensions();

      const proj = this.projection || {};
      const rawNodes = proj.nodes || [];
      const rawEdges = proj.edges || [];

      // Map raw nodes to models
      const nodesMap = {};
      rawNodes.forEach((n) => {
        const id = n.id || n.stableKey;
        const role = NodeRole.fromString(n.nodeRole || n.role || n.sessionClass);
        const domain = AgentDomain.infer(n.displayName || n.stableKey || id, n.domainHint);
        const hasBlocker = Boolean(n.blocker || n.status === "blocked");
        const runtimeState = NodeRuntimeState.fromString(n.status, n.currentActivity, hasBlocker);

        nodesMap[id] = {
          id,
          parentId: n.parentNodeId || n.parentId || null,
          role,
          domain,
          displayName: n.displayName || n.stableKey || id,
          phaseId: n.phaseId || null,
          runtimeState,
          sessionId: n.currentSessionId || n.sessionId || null,
          currentActivity: n.currentActivity || null,
          currentTaskSummary: n.task?.objective || n.currentTaskSummary || (n.progress ? `${tr("organization.working")} (${n.progress.completed}/${n.progress.total})` : null),
          currentTaskDetail: n.task?.detail || n.currentTaskDetail || null,
          progressCompleted: n.progress?.completed || 0,
          progressTotal: n.progress?.total || 0,
          blockerText: n.blocker?.reason || n.blocker?.reasonCode || (hasBlocker ? tr("organization.blocked") : null),
          testsPassed: n.testsPassed || 0,
          testsTotal: n.testsTotal || 0,
          changedFiles: n.changedFiles || [],
          resultPacketSummary: n.resultPacketId ? `${tr("organization.resultPacket")}: ${n.resultPacketId}` : null,
          isRootLeader: role === NodeRole.EXECUTIVE,
        };
      });

      // Map raw edges
      const edgesList = rawEdges.map((e, idx) => ({
        id: e.id || `edge-${idx}`,
        fromNodeId: e.parentNodeId || e.fromNodeId,
        toNodeId: e.childNodeId || e.toNodeId,
        type: e.edgeType || e.type || "MANAGES",
      }));

      // Top Bar Text
      if (this.dom.objective) {
        this.dom.objective.textContent = proj.objective || proj.proposal?.objective || tr("organization.radar");
      }
      if (this.dom.meta) {
        const rev = proj.revision || proj.asOf?.revision || 0;
        const count = Object.keys(nodesMap).length;
        this.dom.meta.textContent = `${tr("organization.revisionNumber", { revision: rev })} · ${count} ${tr("organization.agents")}`;
      }

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
                <span class="org-cluster-count">+${pos.clusterCount}</span>
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
            const focusedClass = pos.isFocused ? "is-focused" : "";
            const dimmedClass = pos.alpha < 1.0 ? "is-dimmed" : "";

            nodeEl.className = `org-node ${roleClass} ${stateClass} ${focusedClass} ${dimmedClass}`.trim();
            nodeEl.style.left = `${pos.x}px`;
            nodeEl.style.top = `${pos.y}px`;
            nodeEl.style.opacity = pos.alpha;

            let innerHtml = `
              <div class="org-node-circle" style="width:${pos.radius * 2}px;height:${pos.radius * 2}px;">
                ${nodeModel.role === NodeRole.EXECUTIVE ? '<div class="org-node-inner-ring"></div>' : ""}
                ${nodeModel.role === NodeRole.REVIEWER && nodeModel.runtimeState === NodeRuntimeState.REVIEWING ? '<div class="org-reviewer-sweep"></div>' : ""}
                <div class="org-domain-glyph">
                  ${renderDomainGlyph(nodeModel.role, nodeModel.domain)}
                </div>
              </div>
              <div class="org-node-label">${nodeModel.displayName}</div>
            `;

            nodeEl.innerHTML = innerHtml;

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

      // Render Activity Feed
      this.renderActivityFeed();
    }

    renderActivityFeed() {
      if (!this.dom.activityFeedList || !this.dom.activityBadge) return;
      const events = this.activityEvents;
      this.dom.activityBadge.textContent = `+${events.length} ${tr("organization.updates")}`;

      if (events.length === 0) {
        this.dom.activityFeedList.innerHTML = `<div class="org-activity-row" style="color:var(--text-secondary);font-size:12px;">${tr("organization.noActivity")}</div>`;
        return;
      }

      this.dom.activityFeedList.innerHTML = events
        .map(
          (e) => `
        <div class="org-activity-row">
          <span class="org-activity-row-dot org-activity-row-dot--${e.dotClass}"></span>
          <span class="org-activity-row-msg">${e.message}</span>
          <span class="org-activity-row-time">${e.time}</span>
        </div>`
        )
        .join("");
    }

    toggleActivityFeed() {
      this.isActivityFeedExpanded = !this.isActivityFeedExpanded;
      if (this.dom.activityFeedList) {
        this.dom.activityFeedList.hidden = !this.isActivityFeedExpanded;
      }
      if (this.dom.activityChevron) {
        this.dom.activityChevron.textContent = this.isActivityFeedExpanded ? "▼" : "▲";
      }
    }

    // --- Organization Bottom Sheet ---

    openBottomSheet(node) {
      if (!node) return;
      this.selectedSheetNodeId = node.id;
      const sheet = this.dom.sheet;
      const backdrop = this.dom.sheetBackdrop;
      if (!sheet || !backdrop) return;

      const role = node.role || NodeRole.fromString(node.nodeRole || node.sessionClass);
      const domain = node.domain || AgentDomain.infer(node.displayName, node.domainHint);
      const runtimeState = node.runtimeState || NodeRuntimeState.fromString(node.status, node.currentActivity, Boolean(node.blocker));
      const stateName = String(runtimeState).toLowerCase();
      const statusText = tr(`organization.${stateName === "failed" ? "failedStatus" : stateName}`) || runtimeState;
      const isRootLeader = Boolean(node.isRootLeader ?? (role === NodeRole.EXECUTIVE));
      const displayName = node.displayName || node.stableKey || node.id;

      sheet.innerHTML = `
        <div class="org-sheet-header">
          <div>
            <div class="org-sheet-name">${displayName}</div>
            <div class="org-sheet-subtitle">${role} · ${domain}</div>
          </div>
          <div class="org-status-pill org-status-pill--${stateName}">
            <span class="org-status-pill-dot"></span>
            <span>${statusText}</span>
          </div>
        </div>

        <div class="org-info-card">
          <div class="org-info-card-label">${tr("organization.currentTask")}</div>
          <div class="org-info-card-value">${node.currentTaskSummary || tr("organization.noTaskAssigned")}</div>
        </div>

        ${
          node.currentActivity
            ? `
          <div class="org-info-card">
            <div class="org-info-card-label">${tr("organization.currentActivity")}</div>
            <div class="org-info-card-value" style="font-family:monospace;font-size:12px;">${node.currentActivity}</div>
          </div>`
            : ""
        }

        <div class="org-info-row">
          <div class="org-info-card">
            <div class="org-info-card-label">${tr("organization.acceptance")}</div>
            <div class="org-info-card-value">${node.progressCompleted} / ${node.progressTotal} ${tr("organization.items")}</div>
          </div>
        </div>

        ${
          node.blockerText
            ? `
          <div class="org-blocker-card">
            ${tr("organization.activeBlocker")}: ${node.blockerText}
          </div>`
            : ""
        }

        <div class="org-sheet-actions">
          ${
            node.isRootLeader
              ? `<button type="button" class="org-btn org-btn--primary" id="orgSendInstructionBtn">${tr("organization.sendInstruction")}</button>`
              : ""
          }
          <button type="button" class="org-btn ${node.isRootLeader ? "org-btn--secondary" : "org-btn--primary"}" id="orgViewDetailsBtn">${tr("organization.viewDetails")}</button>
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

    // --- Agent Detail Screen ---

    openDetailScreen(node) {
      if (!node) return;
      this.detailNodeId = node.id;
      const screen = this.dom.detailScreen;
      if (!screen) return;

      const role = node.role || NodeRole.fromString(node.nodeRole || node.sessionClass);
      const domain = node.domain || AgentDomain.infer(node.displayName, node.domainHint);
      const runtimeState = node.runtimeState || NodeRuntimeState.fromString(node.status, node.currentActivity, Boolean(node.blocker));
      const stateName = String(runtimeState).toLowerCase();
      const statusText = tr(`organization.${stateName === "failed" ? "failedStatus" : stateName}`) || runtimeState;
      const displayName = node.displayName || node.stableKey || node.id;
      const changedFiles = node.changedFiles || [];

      screen.innerHTML = `
        <div class="org-detail-top-bar">
          <button type="button" class="org-icon-btn" id="orgDetailBackBtn" aria-label="${tr("organization.backToRadar")}">
            ${root.AgentoCIcons?.render?.("chevron-left") || "←"}
          </button>
          <div class="org-detail-title">${displayName}</div>
        </div>

        <div class="org-detail-content">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div>
              <div style="font-size:12px;color:var(--text-secondary);">${role} · ${domain}</div>
              ${node.sessionId ? `<div style="font-size:11px;font-family:monospace;color:var(--text-tertiary);">Session: ${node.sessionId}</div>` : ""}
            </div>
            <div class="org-status-pill org-status-pill--${stateName}">
              <span class="org-status-pill-dot"></span>
              <span>${statusText}</span>
            </div>
          </div>

          <div class="org-info-card" style="margin-bottom:12px;">
            <div class="org-info-card-label">${tr("organization.currentTask")}</div>
            <div class="org-info-card-value" style="font-weight:600;">${node.currentTaskSummary || tr("organization.noActiveTask")}</div>
            ${node.currentTaskDetail ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${node.currentTaskDetail}</div>` : ""}
          </div>

          <div class="org-info-card" style="margin-bottom:12px;">
            <div class="org-info-card-label">${tr("organization.currentActivity")}</div>
            <div class="org-info-card-value" style="font-family:monospace;font-size:12px;">${node.currentActivity || tr("organization.idle")}</div>
          </div>

          <div class="org-info-card" style="margin-bottom:12px;">
            <div class="org-info-card-label">${tr("organization.changedFiles")} (${changedFiles.length})</div>
            <div class="org-file-list">
              ${
                changedFiles.length > 0
                  ? changedFiles
                      .map(
                        (f) => `
                    <div class="org-file-item">
                      ${root.AgentoCIcons?.render?.("file") || "📄"}
                      <span>${f}</span>
                    </div>`
                      )
                      .join("")
                  : `<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;">No changed files</div>`
              }
            </div>
          </div>

          <div class="org-info-card" style="margin-bottom:12px;"><button type="button" class="org-btn org-btn--secondary" id="orgNodeInboxBtn">Messages</button></div>

          ${
            node.resultPacketSummary
              ? `
            <div class="org-info-card" style="margin-bottom:12px;">
              <div class="org-info-card-label">${tr("organization.resultPacket")}</div>
              <div class="org-info-card-value">${node.resultPacketSummary}</div>
            </div>`
              : ""
          }

          ${
            node.blockerText
              ? `
            <div class="org-blocker-card" style="margin-bottom:12px;">
              <div style="font-weight:600;">${tr("organization.activeBlocker")}</div>
              <div style="margin-top:4px;">${node.blockerText}</div>
            </div>`
              : ""
          }
        </div>
      `;

      const backBtn = screen.querySelector("#orgDetailBackBtn");
      if (backBtn) {
        backBtn.addEventListener("click", () => this.closeDetailScreen());
      }
      screen.querySelector('#orgNodeInboxBtn')?.addEventListener('click', () => this.showNodeInbox(node));

      screen.hidden = false;
    }

    async showNodeInbox(node) {
      const organizationId = this.projection?.organizationId;
      const screen = this.dom.detailScreen;
      if (!organizationId || !screen) return;
      screen.replaceChildren();
      const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; screen.appendChild(el); return el; };
      const button = (label, action) => { const el = add('button', label); el.type = 'button'; el.className = 'org-btn org-btn--secondary'; el.addEventListener('click', action); return el; };
      button('Back', () => this.openDetailScreen(node));
      add('h2', `Messages to ${node.displayName || node.id}`);
      const list = add('div', 'Loading…');
      const field = document.createElement('textarea'); field.maxLength = 4000; field.placeholder = 'Informational message'; screen.appendChild(field);
      const receipt = add('p', 'Messages are queued for the node; delivery does not mean a reply.');
      const path = `/api/organizations/${encodeURIComponent(organizationId)}/factory/nodes/${encodeURIComponent(node.id)}/messages`;
      const fetcher = root.agentocFetch || fetch;
      const request = async options => { const res = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', ...options }); const data = await res.json(); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data; };
      const refresh = async () => {
        try { const data = await request(); list.replaceChildren(); for (const message of data.messages) { const p = document.createElement('p'); p.textContent = `${message.createdAt} · ${message.deliveryState === 'delivered' ? 'Delivered to Run' : message.deliveryState} · ${message.requestState || 'information'} · ${message.body}${message.reply ? ` · Reply: ${message.reply.body}` : ''}`; list.appendChild(p); } if (!data.messages.length) list.textContent = 'No messages.'; }
        catch (error) { list.textContent = `Unable to load messages: ${error.message}`; }
      };
      const send = requestType => {
        const body = field.value.trim(); if (!body) return;
        const command = { body, requestType, idempotencyKey: root.crypto.randomUUID() };
        const submit = async () => { try { const data = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }); receipt.textContent = `Message ${data.message.messageId}: ${data.message.deliveryState}`; field.value = ''; await refresh(); }
          catch (error) { receipt.textContent = `Not confirmed: ${error.message}. Retry uses the same message ID.`; button('Retry same message', submit); } };
        submit();
      };
      button('Send information', () => send('information'));
      button('Request a reply', () => send('required_response'));
      button('Refresh', refresh); await refresh();
    }

    closeDetailScreen() {
      this.detailNodeId = null;
      if (this.dom.detailScreen) {
        this.dom.detailScreen.hidden = true;
      }
    }
  }

  // --- 6. Global Export & Auto Initialization ---

  const manager = new AgentoCOrganizationViewManager();
  root.AgentocOrganizationView = manager;

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
