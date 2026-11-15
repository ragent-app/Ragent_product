(function exposeMonetThemeContract(global) {
  "use strict";

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
    const cssSupports = global.CSS?.supports;
    return typeof cssSupports !== "function"
      ? /^#[\da-f]{3,8}$/i.test(normalized) || /^(rgb|hsl|oklch|color)\(/i.test(normalized)
      : cssSupports.call(global.CSS, "color", normalized);
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

  function clear(root) {
    for (const variables of Object.values(ROLE_BINDINGS)) {
      variables.forEach((variable) => root.style.removeProperty(variable));
    }
  }

  function apply(rawTheme, root = global.document?.documentElement) {
    if (!root?.style) throw new TypeError("Monet theme requires a document root");
    if (!isRecord(rawTheme)) {
      clear(root);
      return { applied: [], rejected: [], themeColorOverrides: null };
    }

    const { roles, lightSurface, darkSurface } = getPayloadParts(rawTheme);
    const themeColorOverrides = isValidColor(lightSurface)
      ? {
        light: lightSurface.trim(),
        dark: isValidColor(darkSurface) ? darkSurface.trim() : lightSurface.trim(),
      }
      : null;
    const applied = [];
    const rejected = [];
    for (const [rawRole, rawValue] of Object.entries(roles || {})) {
      if (RESERVED_KEYS.has(rawRole)) continue;
      const role = normalizeRoleName(rawRole);
      const variables = ROLE_BINDINGS[role];
      if (!variables || !isValidColor(rawValue)) {
        rejected.push(rawRole);
        continue;
      }
      variables.forEach((variable) => root.style.setProperty(variable, rawValue.trim()));
      applied.push(role);
    }
    return { applied, rejected, themeColorOverrides };
  }

  global.RagentMonetThemeContract = Object.freeze({
    version: 1,
    roleBindings: ROLE_BINDINGS,
    normalizeRoleName,
    isValidColor,
    apply,
  });
})(window);
