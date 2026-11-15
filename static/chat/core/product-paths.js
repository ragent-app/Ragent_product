"use strict";

// Pure product path/URL resolution (Stage 1 extraction of product-paths.js).
// The legacy façade reads location / base[href] from its scope; this core
// takes those environment facts as injected values so it stays free of
// browser globals and runs identically in Node. Defaults mirror the legacy
// FALLBACK_ORIGIN path, so without a browser environment the two
// implementations produce identical results (locked by
// tests/test-chat-product-paths-core.mjs).

(function attachRagentProductPathsCore(root) {
  const FALLBACK_ORIGIN = "https://ragent.invalid";

  const TERMINAL_MARKERS = Object.freeze([
    Object.freeze(["m", "install"]),
    Object.freeze(["login"]),
    Object.freeze(["logout"]),
  ]);

  const BOUNDARY_MARKERS = Object.freeze([
    Object.freeze(["api"]),
    Object.freeze(["ws"]),
    Object.freeze(["share"]),
    Object.freeze(["share-asset"]),
    Object.freeze(["visitor"]),
    Object.freeze(["agent"]),
    Object.freeze(["app"]),
  ]);

  // Env contract: { href, origin, baseHref } — href/baseHref optional, origin
  // optional (falls back to FALLBACK_ORIGIN), matching legacy getLocationHref /
  // getLocationOrigin / getExplicitBaseHref outputs.
  function normalizeEnvironment(env = {}) {
    const origin = typeof env.origin === "string" && env.origin ? env.origin : FALLBACK_ORIGIN;
    const href = typeof env.href === "string" && env.href ? env.href : `${origin}/`;
    return {
      origin,
      href,
      baseHref: typeof env.baseHref === "string" ? env.baseHref.trim() : "",
    };
  }

  function splitPathSegments(pathname) {
    return String(pathname || "/")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  function joinPathSegments(segments) {
    return Array.isArray(segments) && segments.length > 0
      ? `/${segments.join("/")}`
      : "/";
  }

  function markerMatchesAt(segments, marker, startIndex) {
    if (!Array.isArray(segments) || !Array.isArray(marker)) return false;
    if (!Number.isInteger(startIndex) || startIndex < 0) return false;
    if (startIndex + marker.length > segments.length) return false;
    for (let index = 0; index < marker.length; index += 1) {
      if (segments[startIndex + index] !== marker[index]) {
        return false;
      }
    }
    return true;
  }

  function inferProductBasePath(pathname) {
    const segments = splitPathSegments(pathname);
    if (segments.length === 0) return "/";

    for (const marker of TERMINAL_MARKERS) {
      const markerStart = segments.length - marker.length;
      if (markerMatchesAt(segments, marker, markerStart)) {
        return joinPathSegments(segments.slice(0, markerStart));
      }
    }

    for (let index = 0; index < segments.length; index += 1) {
      for (const marker of BOUNDARY_MARKERS) {
        if (markerMatchesAt(segments, marker, index)) {
          return joinPathSegments(segments.slice(0, index));
        }
      }
    }

    return joinPathSegments(segments);
  }

  function ensureDirectoryPath(pathname) {
    const normalized = inferProductBasePath(pathname);
    return normalized === "/" ? "/" : `${normalized.replace(/\/+$/, "")}/`;
  }

  function getProductBasePath(env = {}) {
    const environment = normalizeEnvironment(env);
    if (environment.baseHref) {
      try {
        return inferProductBasePath(new URL(environment.baseHref, environment.href).pathname);
      } catch {
        // fall through to href-based inference
      }
    }
    return inferProductBasePath(new URL(environment.href, environment.origin).pathname);
  }

  function getProductBaseUrl(env = {}) {
    const environment = normalizeEnvironment(env);
    return new URL(ensureDirectoryPath(getProductBasePath(environment)), environment.origin).toString();
  }

  function isAbsoluteUrl(value) {
    return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
  }

  function isAlreadyScopedAbsolutePath(pathname, basePath) {
    if (!pathname.startsWith("/")) return false;
    if (basePath === "/") return true;
    return (
      pathname === basePath
      || pathname.startsWith(`${basePath}/`)
      || pathname.startsWith(`${basePath}?`)
      || pathname.startsWith(`${basePath}#`)
    );
  }

  function resolveProductUrl(value = "", env = {}) {
    const environment = normalizeEnvironment(env);
    const text = typeof value === "string" ? value.trim() : String(value || "");
    if (!text) {
      return getProductBaseUrl(environment);
    }
    if (isAbsoluteUrl(text)) {
      return text;
    }
    if (text.startsWith("//")) {
      return new URL(text, environment.href).toString();
    }

    const baseUrl = getProductBaseUrl(environment);
    const basePath = getProductBasePath(environment);
    if (text.startsWith("?") || text.startsWith("#")) {
      return new URL(text, baseUrl).toString();
    }
    if (text.startsWith("/")) {
      if (isAlreadyScopedAbsolutePath(text, basePath)) {
        return new URL(text, environment.origin).toString();
      }
      return new URL(text.slice(1), baseUrl).toString();
    }
    return new URL(text, baseUrl).toString();
  }

  function resolveProductPath(value = "", env = {}) {
    const environment = normalizeEnvironment(env);
    const resolvedUrl = new URL(resolveProductUrl(value, environment), environment.href);
    return `${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  }

  // helpers' getSessionSidebarUrl: the sidebar-view API URL for a session.
  function getSessionSidebarUrl(sessionId) {
    return `/api/sessions/${encodeURIComponent(sessionId)}?view=sidebar`;
  }

  // session-http.js's getWorkspaceFilteredSessionListUrl: the session-list API
  // URL scoped to the selected project (or, falling back, the selected / default
  // folder). The workspace selectors are injected env functions mirroring the
  // legacy global ragentGet* hooks.
  function getWorkspaceFilteredSessionListUrl(baseUrl, env = {}) {
    const projectId = typeof env.getSelectedProjectId === "function" ? env.getSelectedProjectId() : "";
    const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
    if (normalizedProjectId) {
      const separator = String(baseUrl).includes("?") ? "&" : "?";
      return `${baseUrl}${separator}projectId=${encodeURIComponent(normalizedProjectId)}`;
    }
    const folder = typeof env.getSelectedSessionFolder === "function"
      ? env.getSelectedSessionFolder()
      : (typeof env.getDefaultSessionFolder === "function" ? env.getDefaultSessionFolder() : "");
    const normalizedFolder = typeof folder === "string" ? folder.trim() : "";
    if (!normalizedFolder) return baseUrl;
    const separator = String(baseUrl).includes("?") ? "&" : "?";
    return `${baseUrl}${separator}folder=${encodeURIComponent(normalizedFolder)}`;
  }

  root.RagentProductPathsCore = {
    splitPathSegments,
    joinPathSegments,
    inferProductBasePath,
    ensureDirectoryPath,
    isAbsoluteUrl,
    isAlreadyScopedAbsolutePath,
    getProductBasePath,
    getProductBaseUrl,
    resolveProductUrl,
    resolveProductPath,
    getSessionSidebarUrl,
    getWorkspaceFilteredSessionListUrl,
  };
})(typeof globalThis !== "undefined" ? globalThis : {});
