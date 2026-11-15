"use strict";

// Pure Monet/Material-3 theme contract helpers (Stage 2 extraction of
// monet-theme-contract.js): role-name normalization, color validity (with a
// CSS.supports probe injected via the environment contract
// (root.RagentMonetThemeContractEnvironment), falling back to the same
// token regexes as the legacy module when the probe is absent), payload
// slicing and the role→CSS-variable binding table. The DOM application
// half (apply/clear, which mutate CSS variables on the root element) stays
// in the legacy module. Locked against the legacy implementation by
// tests/test-chat-theme-contract-core.mjs.

(function attachRagentMonetThemeContractCore(root) {
  // Live environment: reads always go to the injected object (mutations
  // after attach are visible), falling back to the defaults for absent keys.
  const DEFAULT_ENVIRONMENT = Object.freeze({
    cssSupports: null,
  });
  const environment = new Proxy(
    root.RagentMonetThemeContractEnvironment || {},
    {
      get: (target, prop) => (prop in target ? target[prop] : DEFAULT_ENVIRONMENT[prop]),
    },
  );

  const ROLE_BINDINGS = Object.freeze({
    primary: ["--m3-primary", "--sys-primary", "--accent"],
    "on-primary": ["--m3-on-primary", "--sys-on-primary"],
    "primary-container": ["--m3-primary-container", "--sys-primary-container", "--accent-dim"],
    "on-primary-container": ["--m3-on-primary-container", "--sys-on-primary-container"],
    secondary: ["--m3-secondary", "--sys-secondary", "--notice"],
    "on-secondary": ["--m3-on-secondary", "--sys-on-secondary"],
    "secondary-container": ["--m3-secondary-container", "--sys-secondary-container"],
    "on-secondary-container": ["--m3-on-secondary-container", "--sys-on-secondary-container"],
    tertiary: ["--m3-tertiary", "--sys-tertiary", "--naming"],
    "on-tertiary": ["--m3-on-tertiary", "--sys-on-tertiary"],
    "tertiary-container": ["--m3-tertiary-container", "--sys-tertiary-container"],
    "on-tertiary-container": ["--m3-on-tertiary-container", "--sys-on-tertiary-container"],
    error: ["--m3-error", "--sys-error", "--error"],
    "on-error": ["--m3-on-error", "--sys-on-error"],
    "error-container": ["--m3-error-container", "--sys-error-container", "--error-bg"],
    "on-error-container": ["--m3-on-error-container", "--sys-on-error-container"],
    surface: ["--m3-surface", "--sys-surface", "--bg"],
    "surface-dim": ["--m3-surface-dim", "--sys-surface-dim"],
    "surface-bright": ["--m3-surface-bright", "--sys-surface-bright"],
    "surface-container-lowest": ["--m3-surface-container-lowest", "--sys-surface-container-lowest"],
    "surface-container-low": ["--m3-surface-container-low", "--sys-surface-container-low", "--bg-tertiary"],
    "surface-container": ["--m3-surface-container", "--sys-surface-container", "--bg-secondary"],
    "surface-container-high": ["--m3-surface-container-high", "--sys-surface-container-high"],
    "surface-container-highest": ["--m3-surface-container-highest", "--sys-surface-container-highest", "--surface-hover"],
    "on-surface": ["--m3-on-surface", "--sys-on-surface", "--text"],
    "on-surface-variant": ["--m3-on-surface-variant", "--sys-on-surface-variant", "--text-secondary"],
    outline: ["--m3-outline", "--sys-outline", "--border-strong"],
    "outline-variant": ["--m3-outline-variant", "--sys-outline-variant", "--border"],
    "inverse-surface": ["--m3-inverse-surface", "--sys-inverse-surface"],
    "inverse-on-surface": ["--m3-inverse-on-surface", "--sys-inverse-on-surface"],
    "inverse-primary": ["--m3-inverse-primary", "--sys-inverse-primary"],
    scrim: ["--m3-scrim", "--sys-scrim", "--modal-backdrop"],
  });

  const RESERVED_KEYS = new Set([
    "version",
    "roles",
    "themeColor",
    "theme-color",
    "surface-dark",
    "surfaceDark",
    "background",
    "darkBackground",
  ]);

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeRoleName(value) {
    if (typeof value !== "string") return "";
    return value
      .trim()
      .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      .replace(/^--sys-/, "")
      .replace(/^--/, "")
      .replace(/_/g, "-");
  }

  function isValidColor(value) {
    if (typeof value !== "string" || value.length > 128) return false;
    const normalized = value.trim();
    if (!normalized || normalized.includes(";") || normalized.includes("{") || normalized.includes("}")) return false;
    const supports = environment.cssSupports;
    return typeof supports !== "function"
      ? /^#[\da-f]{3,8}$/i.test(normalized) || /^(rgb|hsl|oklch|color)\(/i.test(normalized)
      : supports("color", normalized);
  }

  function getPayloadParts(rawTheme) {
    const roles = isRecord(rawTheme?.roles) ? rawTheme.roles : rawTheme;
    const themeColor = isRecord(rawTheme?.themeColor) ? rawTheme.themeColor : {};
    const lightSurface = themeColor.light
      ?? themeColor.surface
      ?? rawTheme?.surface
      ?? rawTheme?.background
      ?? roles?.surface
      ?? roles?.background;
    const darkSurface = themeColor.dark
      ?? themeColor.surfaceDark
      ?? rawTheme?.["surface-dark"]
      ?? rawTheme?.surfaceDark
      ?? rawTheme?.darkBackground
      ?? lightSurface;
    return { roles, lightSurface, darkSurface };
  }

  root.RagentMonetThemeContractCore = Object.freeze({
    version: 1,
    roleBindings: ROLE_BINDINGS,
    isRecord,
    normalizeRoleName,
    isValidColor,
    getPayloadParts,
  });
})(typeof globalThis !== "undefined" ? globalThis : {});
