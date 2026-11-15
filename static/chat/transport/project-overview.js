"use strict";

// Project overview projection (Stage 2 extraction of project-overview.js).
// The legacy module is already a pure function set — it attaches to the root
// under RagentProjectOverview and reads nothing from its scope; this transport
// copy keeps the function bodies verbatim so the parity tests in
// tests/test-chat-project-overview-core.mjs lock the two implementations
// together until the view layer re-binds to this module in Stage 3.
//
// Renders two derived views over the canonical session catalog:
//   1. buildProjectOverview  — first level: projects ordered by most recent
//      session activity, each showing a short preview of its most recent
//      sessions; orphan sessions group into a fixed bottom "inbox" group.
//   2. searchProjectView     — search mode: three match levels
//      (L1 project+session, L2 session only, L3 project only); matched
//      sessions float to the top of their group and the per-project slot
//      budget widens beyond the preview limit when matches exceed it.
//   3. sessionsOfProject     — plain projectId filter for the second level.
//
// Sorting follows the shared session activity semantic used by the session
// list (running sessions surface by their start time, otherwise by latest
// change time). Callers pass getSortTime so this module stays deterministic
// and unit-testable; it falls back to a local equivalent when omitted.

(function attachRagentProjectOverviewCore(root) {
  "use strict";

  const INBOX_PROJECT_KEY = "";

  const MATCH_LEVEL_PROJECT_AND_SESSION = 3; // L1
  const MATCH_LEVEL_SESSION = 2;             // L2
  const MATCH_LEVEL_PROJECT = 1;             // L3

  const SESSION_SEARCH_FIELDS = ["name", "description"];

  function getSortTimeValue(session, getSortTime) {
    if (typeof getSortTime === "function") {
      const time = getSortTime(session);
      return Number.isFinite(time) ? time : 0;
    }
    return fallbackGetSessionSortTime(session);
  }

  function fallbackGetSessionSortTime(session) {
    if (!session) return 0;
    const activity = session.activity || {};
    if (activity.run?.state === "running" && activity.run?.startedAt) {
      const startedAt = new Date(activity.run.startedAt).getTime();
      if (Number.isFinite(startedAt) && startedAt > 0) return startedAt;
    }
    const stamp = Object.prototype.hasOwnProperty.call(session || {}, "lastActivityAt")
      ? (session.lastActivityAt ?? session.updatedAt ?? session.created ?? "")
      : (session.lastEventAt || session.updatedAt || session.created || "");
    const time = new Date(stamp).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function normalizeProjectRootPath(path) {
    return String(path || "").trim().replace(/\/+$/, "");
  }

  // Project key of a session: its explicit projectId when bound, otherwise the
  // project whose rootPath contains the session folder. The folder fallback
  // mirrors the backend listSessions contract — sessions without a project
  // binding (e.g. an internal session) stay visible under the project
  // whose root they belong to, instead of drifting into the inbox group.
  function getSessionProjectKey(session, projects) {
    if (session?.projectDetached === true) return "";
    const projectId = String(session?.projectId || "").trim();
    if (projectId) return projectId;
    const folder = normalizeProjectRootPath(session?.folder);
    if (!folder || !Array.isArray(projects)) return "";
    const match = projects.find((project) => {
      const root = normalizeProjectRootPath(project?.rootPath);
      return root && root === folder;
    });
    return match ? String(match?.id || "").trim() : "";
  }

  function sessionMatchesQuery(session, query) {
    if (!query || !session) return false;
    const needle = query.toLowerCase();
    return SESSION_SEARCH_FIELDS.some((field) => {
      const value = String(session[field] || "").toLowerCase();
      return value.includes(needle);
    });
  }

  function projectMatchesQuery(project, query) {
    if (!query || !project) return false;
    const needle = query.toLowerCase();
    return String(project.name || "").toLowerCase().includes(needle);
  }

  function sortSessionsByActivity(sessions, getSortTime, compare, isRunning) {
    const sorted = [...sessions].sort((a, b) => {
      // Callers may pass the second-level list comparator (compare) so the
      // L1 preview order matches the L2 session list exactly — pinned
      // sessions, sidebar order, attention bands and workflow priority all
      // tie-break identically, which also keeps the L1→L2 expand animation
      // seamless (the clicked row stays in place). Falls back to recency.
      if (typeof compare === "function") {
        const delta = compare(a, b);
        if (delta !== 0) return delta;
      }
      const timeDelta = getSortTimeValue(b, getSortTime) - getSortTimeValue(a, getSortTime);
      if (timeDelta !== 0) return timeDelta;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
    // The second level renders a "running" section first, then the rest, each
    // in list order. Mirror that partition so the preview rows match the L2
    // DOM order even when running and idle sessions interleave.
    if (typeof isRunning !== "function" || sorted.length === 0) return sorted;
    const running = sorted.filter(isRunning);
    if (running.length === sorted.length) return sorted;
    const rest = sorted.filter((session) => !isRunning(session));
    return [...running, ...rest];
  }

  // Matched sessions (kept in recency order) float to the top; when fewer than
  // limit match, the remaining slots fill with the most recent unmatched
  // sessions. When matches reach the limit the group widens to show all of
  // them (search mode lifts the non-search preview cap).
  function mergeMatchedThenRecent(matched, sorted, limit) {
    if (matched.length === 0) return sorted.slice(0, limit);
    if (matched.length >= limit) return [...matched];
    const matchedIds = new Set(matched.map((session) => session.id));
    const rest = sorted.filter((session) => !matchedIds.has(session.id));
    return [...matched, ...rest.slice(0, limit - matched.length)];
  }

  function getGroupSortTime(sessions, getSortTime) {
    if (!sessions || sessions.length === 0) return 0;
    return getSortTimeValue(sessions[0], getSortTime);
  }

  function buildInboxGroup(sessions, getSortTime, limit, compare, isRunning) {
    const sorted = sortSessionsByActivity(sessions, getSortTime, compare, isRunning);
    return {
      project: null,
      projectId: INBOX_PROJECT_KEY,
      sessionCount: sessions.length,
      preview: sorted.slice(0, limit),
      sessions: sorted,
      sortTime: getGroupSortTime(sorted, getSortTime),
      matchLevel: 0,
      inbox: true,
    };
  }

  function buildGroup(project, projectSessions, getSortTime, limit, compare, isRunning) {
    const sorted = sortSessionsByActivity(projectSessions, getSortTime, compare, isRunning);
    return {
      project,
      projectId: String(project?.id || "").trim(),
      sessionCount: projectSessions.length,
      preview: sorted.slice(0, limit),
      sessions: sorted,
      sortTime: getGroupSortTime(sorted, getSortTime),
      matchLevel: 0,
      inbox: false,
    };
  }

  // First level: every project with its recent-session preview, ordered by the
  // most recent session activity inside the project. Orphan sessions (no
  // projectId) collect into a fixed bottom "inbox" group when inboxLast is set.
  function buildProjectOverview({ projects, sessions, getSortTime, limit = 3, inboxLast = true, compare, isRunning } = {}) {
    const byProject = new Map();
    const inboxSessions = [];
    for (const session of sessions || []) {
      const key = getSessionProjectKey(session, projects);
      if (key) {
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key).push(session);
      } else {
        inboxSessions.push(session);
      }
    }

    const groups = [];
    for (const project of projects || []) {
      const key = String(project?.id || "").trim();
      if (!key) continue;
      groups.push(buildGroup(project, byProject.get(key) || [], getSortTime, limit, compare, isRunning));
    }
    groups.sort((a, b) => (
      Number(b.project?.pinned === true) - Number(a.project?.pinned === true)
      || b.sortTime - a.sortTime
      || String(a.projectId).localeCompare(String(b.projectId))
    ));
    if (inboxLast && inboxSessions.length > 0) {
      groups.push(buildInboxGroup(inboxSessions, getSortTime, limit, compare, isRunning));
    }
    return groups;
  }

  // Search mode: three match levels with the slot rules from the user brief.
  // Group order is L1 (project + session) > L2 (session only) > L3 (project
  // only); within the same level groups follow project recency. The inbox
  // group has no project name, so it can only reach L2 via a session match.
  function searchProjectView({ projects, sessions, query, getSortTime, limit = 3, inboxLast = true, compare, isRunning } = {}) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) {
      return buildProjectOverview({ projects, sessions, getSortTime, limit, inboxLast, compare, isRunning });
    }

    const byProject = new Map();
    const inboxSessions = [];
    for (const session of sessions || []) {
      const key = getSessionProjectKey(session, projects);
      if (key) {
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key).push(session);
      } else {
        inboxSessions.push(session);
      }
    }

    const groups = [];
    for (const project of projects || []) {
      const key = String(project?.id || "").trim();
      if (!key) continue;
      const sorted = sortSessionsByActivity(byProject.get(key) || [], getSortTime, compare, isRunning);
      const projectMatch = projectMatchesQuery(project, normalizedQuery);
      const matched = sorted.filter((session) => sessionMatchesQuery(session, normalizedQuery));
      if (!projectMatch && matched.length === 0) continue;

      let matchLevel;
      let visible;
      if (projectMatch && matched.length > 0) {
        matchLevel = MATCH_LEVEL_PROJECT_AND_SESSION;
        visible = mergeMatchedThenRecent(matched, sorted, limit);
      } else if (matched.length > 0) {
        matchLevel = MATCH_LEVEL_SESSION;
        visible = mergeMatchedThenRecent(matched, sorted, limit);
      } else {
        matchLevel = MATCH_LEVEL_PROJECT;
        visible = sorted.slice(0, limit);
      }
      groups.push({
        project,
        projectId: key,
        sessionCount: byProject.get(key)?.length || 0,
        preview: visible,
        sessions: sorted,
        sortTime: getGroupSortTime(sorted, getSortTime),
        matchLevel,
        inbox: false,
      });
    }

    if (inboxSessions.length > 0) {
      const sorted = sortSessionsByActivity(inboxSessions, getSortTime, compare, isRunning);
      const matched = sorted.filter((session) => sessionMatchesQuery(session, normalizedQuery));
      if (matched.length > 0) {
        const inboxGroup = buildInboxGroup(inboxSessions, getSortTime, limit, compare, isRunning);
        inboxGroup.preview = mergeMatchedThenRecent(matched, sorted, limit);
        inboxGroup.matchLevel = MATCH_LEVEL_SESSION;
        groups.push(inboxGroup);
      }
    }

    groups.sort((a, b) => (
      b.matchLevel - a.matchLevel
      || Number(b.project?.pinned === true) - Number(a.project?.pinned === true)
      || b.sortTime - a.sortTime
      || String(a.projectId).localeCompare(String(b.projectId))
    ));
    return groups;
  }

  // Second level: the full session list of one project (or the inbox group
  // when projectId is empty). Projects are required for the folder fallback
  // so unbounded sessions surface under the project whose root contains them.
  function sessionsOfProject({ sessions, projectId, projects } = {}) {
    const key = String(projectId || "").trim();
    return (sessions || []).filter((session) => getSessionProjectKey(session, projects) === key);
  }

  root.RagentProjectOverviewCore = {
    buildProjectOverview,
    searchProjectView,
    sessionsOfProject,
    sessionMatchesQuery,
    projectMatchesQuery,
    sortSessionsByActivity,
    MATCH_LEVEL_PROJECT_AND_SESSION,
    MATCH_LEVEL_SESSION,
    MATCH_LEVEL_PROJECT,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
