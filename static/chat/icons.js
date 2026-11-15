"use strict";

const RAGENT_ICONS = Object.freeze({
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  // Match Android's compact filled home glyph rather than the older outlined
  // roof-and-door construction.
  home: '<path fill="currentColor" stroke="none" d="M12 3 2 11h3v10h6v-6h2v6h6V11h3z"/>',
  share: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M11 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  send: '<path stroke-width="2.2" d="M12 19V5M5 12l7-7 7 7"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  "debug-stop": '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  attach: '<path d="m21.4 11.6-8.5 8.5a5 5 0 0 1-7.1-7.1l9.2-9.2a3.4 3.4 0 0 1 4.8 4.8l-9.2 9.2a1.8 1.8 0 1 1-2.6-2.6l8.5-8.5"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  "file-download": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M12 11v6"/><path d="m9.5 14.5 2.5 2.5 2.5-2.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/><line x1="12" y1="12" x2="19.5" y2="4.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/>',
  pin: '<path d="m15 4 5 5-4 4v5l-2 2-4.5-4.5L5 20l-1-1 4.5-4.5L4 10l2-2h5Z"/>',
  pinned: '<path d="m15 4 5 5-4 4v5l-2 2-4.5-4.5L5 20l-1-1 4.5-4.5L4 10l2-2h5Z"/><path d="M4 4h.01"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  archive: '<path d="M4 7h16"/><path d="M6 7v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M8 4h8l2 3H6Z"/><path d="M10 12h4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  unarchive: '<path d="M4 7h16"/><path d="M6 7v11a2 2 0 0 0 2 2h5"/><path d="M8 4h8l2 3H6Z"/><path d="M18 21v-7"/><path d="m15 17 3-3 3 3"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12A9 9 0 0 1 18.3 5.6L21 8"/><path d="M21 3v5h-5"/>',
  fork: '<path d="M3 12h5l10-8"/><path d="M13 4h6v6"/><path d="M8 12l10 8"/><path d="M13 20h6v-6"/>',
  gear: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7A2 2 0 1 1 7.1 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 20 7.1l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.8.8Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
  gauge: '<path class="gauge-track" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="2.2" d="M3.43 17.95A9.9 9.9 0 1 1 20.57 17.95"/><path class="gauge-active" fill="none" stroke="#007AFF" stroke-width="2.2" pathLength="1" stroke-dasharray="0.0125 1" d="M3.43 17.95A9.9 9.9 0 1 1 20.57 17.95"/><path class="gauge-needle" fill="none" stroke="#1C1C1E" stroke-width="1.8" d="M12 13V6.27"/><circle class="gauge-hub" cx="12" cy="13" r="2" fill="#1C1C1E" stroke="none"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  "bolt-solid": '<path fill="currentColor" stroke="none" d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  "folder-plus": '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/>',
  // Solid (filled) variants: user-directed style shift for the sidebar
  // folder system and the agent-button star. The path-level attributes
  // override the outline wrapper's fill="none" stroke="currentColor";
  // everything else keeps the outline language.
  "folder-solid": '<path fill="currentColor" stroke="none" d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  // Solid settings control: compact, rounded, with a clear center cutout.
  "gear-solid": '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.37-.31-.6-.22l-2.49 1a7.6 7.6 0 0 0-1.69-.98l-.38-2.65A.51.51 0 0 0 14 2h-4a.51.51 0 0 0-.5.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1c-.23-.08-.48 0-.6.22l-2 3.46c-.12.22-.07.49.12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.37.31.6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.23.08.48 0 .6-.22l2-3.46c.12-.22.07-.49-.12-.64zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/>',
  "sparkle-solid": '<path fill="currentColor" stroke="none" d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  agent: '<path d="M12 3v3"/><rect x="5" y="6" width="14" height="12" rx="4"/><path d="M9 11h.01"/><path d="M15 11h.01"/><path d="M9.5 15h5"/>',
  sparkle: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  "new-chat": '<path d="M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8"/><path d="M18 3v6"/><path d="M15 6h6"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  "more-horizontal": '<path d="M7 12h.01"/><path d="M12 12h.01"/><path d="M17 12h.01"/>',
  // Android's overflow control is a vertical stack of filled dots.
  more: '<circle cx="12" cy="5" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.25" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="m7.5 9.5 3.5 2.8-3.5 2.8"/><path d="M13.5 15.3h3.5"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  "monitor-plus": '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="M16 8v4"/><path d="M14 10h4"/>',
  shield: '<path d="M12 3.6 19 6v5.4c0 4.3-3 7.4-7 9-4-1.6-7-4.7-7-9V6z"/>',
  // Classic fullscreen glyph: four corner brackets (lucide/feather maximize
  // shape). The old hybrid (two brackets + two diagonals) read as a vague
  // "expand diagonal" instead of the universal expand-to-fullscreen mark.
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  question: '<circle cx="12" cy="12" r="8.2"/><path d="M9.7 9.4a2.4 2.4 0 0 1 4.6.9c0 1.5-2.2 2-2.2 3.1"/><path d="M12.1 16.4h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  "target-arrow": '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6a6 6 0 1 0 6 6"/><path d="M21.5 2.5 12 12"/><path d="M12 7.5V12h4.5"/><path d="m18.5 2.5 3 3"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  play: '<path fill="currentColor" stroke="none" d="M7 5.5c0-.8.9-1.3 1.6-.9l11.5 6.5c.7.4.7 1.4 0 1.8L8.6 19.4c-.7.4-1.6-.1-1.6-.9V5.5z"/>',
  pause: '<path fill="currentColor" stroke="none" d="M6 5h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm8 0h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
});

function normalizeIconClassName(className) {
  return String(className || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function renderRagentIcon(name, options = {}) {
  const body = RAGENT_ICONS[name];
  if (!body) return "";
  const className = normalizeIconClassName(`rl-icon ${options.className || ""}`);
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function hydrateRagentIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    const iconName = node.getAttribute("data-icon");
    if (!iconName) return;
    node.innerHTML = renderRagentIcon(iconName, {
      className: node.getAttribute("data-icon-class") || "",
    });
  });
}

window.RagentIcons = Object.freeze({
  hydrate: hydrateRagentIcons,
  render: renderRagentIcon,
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => hydrateRagentIcons(), { once: true });
} else {
  hydrateRagentIcons();
}
