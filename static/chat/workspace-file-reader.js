"use strict";

(function attachWorkspaceFileReader(root) {
  const LIST_PANEL_WIDTH_STORAGE_KEY = "ragent.workspaceFileReaderListWidth";
  const LIST_PANEL_RESIZE_QUERY = "(min-width: 768px)";
  const MIN_LIST_PANEL_WIDTH = 240;
  const MAX_LIST_PANEL_WIDTH = 560;

  const state = {
    open: false,
    loading: false,
    error: "",
    files: [],
    directories: [],
    rootPath: "",
    loadedWorkspace: "",
    selectedPath: "",
    selectedFile: null,
    reading: false,
    search: "",
    requestSeq: 0,
    readSeq: 0,
    listWidth: 0,
    resizingList: false,
  };

  const dom = {
    panel: null,
    backButton: null,
    closeButton: null,
    refreshButton: null,
    rootLabel: null,
    layout: null,
    preview: null,
    listPanel: null,
    listResizeHandle: null,
    searchInput: null,
    tree: null,
    boundPanel: null,
  };

  function t(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function renderIcon(name, className = "") {
    return root.RagentIcons?.render(name, { className }) || "";
  }

  function resolveRequestPath(path) {
    if (typeof root.ragentResolveProductPath === "function") {
      return root.ragentResolveProductPath(path);
    }
    return String(path || "");
  }

  function getCurrentWorkspaceSafe() {
    if (typeof root.ragentGetSelectedSessionFolder === "function") {
      const selected = String(root.ragentGetSelectedSessionFolder() || "").trim();
      if (selected) return selected;
    }
    if (typeof root.ragentGetDefaultSessionFolder === "function") {
      const fallback = String(root.ragentGetDefaultSessionFolder() || "").trim();
      if (fallback) return fallback;
    }
    return "~";
  }

  function getShortPath(path) {
    return String(path || "").replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  }

  function inferReadableKind(file) {
    const source = `${file?.kind || ""} ${file?.mimeType || ""} ${file?.name || ""} ${file?.path || ""} ${file?.url || ""}`;
    if (/pdf/i.test(source)) return "pdf";
    return "markdown";
  }

  function appendUrlParam(url, key, value) {
    const source = String(url || "").trim();
    if (!source) return "";
    try {
      const parsed = new URL(source, document.baseURI || window.location.href);
      parsed.searchParams.set(key, value);
      if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return parsed.toString();
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      const separator = source.includes("?") ? "&" : "?";
      return `${source}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }

  function readStoredListWidth() {
    try {
      const value = Number.parseInt(localStorage.getItem(LIST_PANEL_WIDTH_STORAGE_KEY) || "", 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function writeStoredListWidth(width) {
    try {
      localStorage.setItem(LIST_PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Keep the live CSS variable even when storage is unavailable.
    }
  }

  function canResizeListPanel() {
    return root.matchMedia?.(LIST_PANEL_RESIZE_QUERY)?.matches !== false;
  }

  function getListPanelMaxWidth() {
    const layoutWidth =
      dom.layout?.getBoundingClientRect?.().width
      || dom.panel?.getBoundingClientRect?.().width
      || root.innerWidth
      || MAX_LIST_PANEL_WIDTH;
    return Math.max(
      MIN_LIST_PANEL_WIDTH,
      Math.min(MAX_LIST_PANEL_WIDTH, Math.floor(layoutWidth * 0.68)),
    );
  }

  function clampListPanelWidth(width) {
    const maxWidth = getListPanelMaxWidth();
    return Math.max(MIN_LIST_PANEL_WIDTH, Math.min(maxWidth, width || MIN_LIST_PANEL_WIDTH));
  }

  function applyListPanelWidth(width, { persist = false } = {}) {
    if (!dom.panel) return 0;
    const nextWidth = clampListPanelWidth(width);
    state.listWidth = nextWidth;
    dom.panel.style.setProperty("--workspace-file-reader-list-width", `${Math.round(nextWidth)}px`);
    if (persist) writeStoredListWidth(nextWidth);
    return nextWidth;
  }

  function hydrateStoredListPanelWidth() {
    if (!canResizeListPanel()) return;
    const storedWidth = state.listWidth || readStoredListWidth();
    if (storedWidth) applyListPanelWidth(storedWidth);
  }

  function buildWorkspaceFileUrl(file) {
    const workspace = getCurrentWorkspaceSafe();
    const path = String(file?.path || file?.relativePath || "").trim();
    if (!workspace || !path) return "";
    return resolveRequestPath(`/api/workspace-files/content?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`);
  }

  function normalizeReadableFile(file) {
    const url = String(file?.url || file?.downloadUrl || buildWorkspaceFileUrl(file) || "").trim();
    const name = String(file?.name || file?.originalName || file?.filename || file?.path || "file").trim();
    return {
      ...file,
      url,
      rawUrl: String(file?.rawUrl || url).trim(),
      downloadUrl: String(file?.downloadUrl || appendUrlParam(url, "download", "1")).trim(),
      name,
      path: String(file?.path || file?.relativePath || name).trim(),
      kind: inferReadableKind(file),
    };
  }

  function setReading(reading) {
    state.reading = reading === true;
    if (dom.panel) {
      dom.panel.classList.toggle("workspace-file-reader--reading", state.reading);
    }
    if (dom.backButton) {
      dom.backButton.hidden = !state.reading;
    }
  }

  function setOpen(open) {
    state.open = open === true;
    if (dom.panel) dom.panel.hidden = !state.open;
    if (state.open) hydrateStoredListPanelWidth();
    if (!state.open) {
      state.readSeq += 1;
    }
  }

  function closeReader({ switchBack = false } = {}) {
    setReading(false);
    setOpen(false);
    if (switchBack && typeof root.showRightSidebarHome === "function") {
      root.showRightSidebarHome();
    }
  }

  function renderStatus(title, body = "") {
    if (!dom.preview) return;
    dom.preview.innerHTML = `
      <div class="workspace-file-reader-status">
        <div class="workspace-file-reader-status-title">${escapeHtml(title)}</div>
        ${body ? `<div class="workspace-file-reader-status-body">${escapeHtml(body)}</div>` : ""}
      </div>`;
  }

  function renderEmptyPreview() {
    if (!dom.preview) return;
    dom.preview.innerHTML = `
      <div class="workspace-file-reader-empty">
        <div class="workspace-file-reader-empty-icon">${renderIcon("file")}</div>
        <div class="workspace-file-reader-empty-title">${escapeHtml(t("fileReader.emptyTitle"))}</div>
        <div class="workspace-file-reader-empty-body">${escapeHtml(t("fileReader.emptyBody"))}</div>
      </div>`;
  }

  function renderReadableToolbar(file) {
    return `
      <div class="workspace-readable-toolbar">
        <div class="workspace-readable-toolbar-title" title="${escapeHtml(file.path || file.name)}">${escapeHtml(file.name)}</div>
        <div class="workspace-readable-toolbar-actions">
          ${file.rawUrl ? `<a class="workspace-readable-action" href="${escapeHtml(file.rawUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(t("fileReader.openRaw"))}</a>` : ""}
          ${file.downloadUrl ? `<a class="workspace-readable-action" href="${escapeHtml(file.downloadUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(t("action.download"))}</a>` : ""}
        </div>
      </div>`;
  }

  function renderMarkdownInto(container, markdown) {
    if (typeof root.renderMarkdownIntoNode === "function") {
      root.renderMarkdownIntoNode(container, markdown);
      return;
    }
    if (root.marked?.parse) {
      container.innerHTML = root.marked.parse(String(markdown || ""));
      if (typeof root.enhanceRenderedContentLinks === "function") {
        root.enhanceRenderedContentLinks(container);
      }
      return;
    }
    container.textContent = String(markdown || "");
  }

  async function openReadableFile(input) {
    if (!bindDom()) return false;
    const file = normalizeReadableFile(input);
    if (!file.url) return false;
    setOpen(true);
    state.selectedPath = file.path || file.url;
    state.selectedFile = file;
    setReading(true);
    renderTree();
    const readSeq = state.readSeq + 1;
    state.readSeq = readSeq;
    renderStatus(t("fileReader.loading"));

    if (file.kind === "pdf") {
      if (readSeq !== state.readSeq || !dom.preview) return true;
      dom.preview.innerHTML = `${renderReadableToolbar(file)}<iframe class="workspace-readable-pdf" src="${escapeHtml(file.url)}" title="${escapeHtml(file.name)}"></iframe>`;
      return true;
    }

    try {
      const response = await (root.ragentFetch || fetch)(file.url, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (readSeq !== state.readSeq) return true;
      if (!response.ok) throw new Error(`${response.status} ${response.statusText || ""}`.trim());
      const markdown = await response.text();
      if (readSeq !== state.readSeq || !dom.preview) return true;
      dom.preview.innerHTML = `${renderReadableToolbar(file)}<article class="workspace-readable-markdown md-content"></article>`;
      const content = dom.preview.querySelector(".workspace-readable-markdown");
      renderMarkdownInto(content, markdown);
      return true;
    } catch (error) {
      if (readSeq !== state.readSeq) return true;
      renderStatus(t("fileReader.readFailed"), error?.message || "");
      return true;
    }
  }

  function createTreeNode(name = "", path = "") {
    return { name, path, dirs: new Map(), files: [], count: 0 };
  }

  function ensureTreeDirectory(rootNode, rawPath) {
    const path = String(rawPath || "").replace(/\\/g, "/");
    const parts = path.split("/").filter(Boolean);
    let node = rootNode;
    for (const segment of parts) {
      const nextPath = node.path ? `${node.path}/${segment}` : segment;
      if (!node.dirs.has(segment)) node.dirs.set(segment, createTreeNode(segment, nextPath));
      node = node.dirs.get(segment);
    }
    return node;
  }

  function buildTree(files, directories = []) {
    const rootNode = createTreeNode("", "");
    for (const directory of directories) {
      ensureTreeDirectory(rootNode, directory.path || directory.relativePath || directory.name || "");
    }
    for (const file of files) {
      const path = String(file.path || file.relativePath || file.name || "").replace(/\\/g, "/");
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 0) continue;
      const node = ensureTreeDirectory(rootNode, parts.slice(0, -1).join("/"));
      node.files.push({ ...file, path });
    }
    function finalize(node) {
      let count = node.files.length;
      for (const child of node.dirs.values()) count += finalize(child);
      node.count = count;
      node.files.sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path)));
      node.dirs = new Map([...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)));
      return count;
    }
    finalize(rootNode);
    return rootNode;
  }

  function getFilteredFiles() {
    const query = state.search.trim().toLowerCase();
    if (!query) return state.files;
    return state.files.filter((file) => {
      const haystack = `${file.name || ""} ${file.path || file.relativePath || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  function getFilteredDirectories() {
    const query = state.search.trim().toLowerCase();
    if (!query) return state.directories;
    return state.directories.filter((directory) => {
      const haystack = `${directory.name || ""} ${directory.path || directory.relativePath || ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  function renderTreeNode(node, { nested = false } = {}) {
    const dirItems = [...node.dirs.values()].map((child) => `
      <li class="workspace-file-tree-folder">
        <details>
          <summary class="workspace-file-tree-folder-toggle">
            ${renderIcon("chevron-down", "workspace-file-tree-chevron")}
            <span class="workspace-file-tree-name" title="${escapeHtml(child.path)}">${escapeHtml(child.name)}</span>
            ${child.count > 0 ? `<span class="workspace-file-tree-count">${child.count}</span>` : ""}
          </summary>
          ${renderTreeNode(child, { nested: true })}
        </details>
      </li>
    `).join("");
    const fileItems = node.files.map((file) => {
      const kind = inferReadableKind(file);
      const selected = state.selectedPath && state.selectedPath === (file.path || file.relativePath);
      return `
        <li>
          <button type="button" class="workspace-file-tree-file ${selected ? "active" : ""}" data-workspace-file-path="${escapeHtml(file.path || file.relativePath)}">
            ${renderIcon(kind === "pdf" ? "file" : "file")}
            <span class="workspace-file-tree-name" title="${escapeHtml(file.path || file.relativePath || file.name)}">${escapeHtml(file.name || file.path)}</span>
            <span class="workspace-file-tree-kind ${escapeHtml(kind)}">${escapeHtml(kind === "pdf" ? t("fileReader.pdf") : "MD")}</span>
          </button>
        </li>`;
    }).join("");
    return `<ul class="workspace-file-tree-list ${nested ? "nested" : ""}">${dirItems}${fileItems}</ul>`;
  }

  function renderTree() {
    if (!dom.tree) return;
    if (state.loading) {
      dom.tree.innerHTML = `<div class="workspace-file-reader-status-body">${escapeHtml(t("fileReader.loading"))}</div>`;
      return;
    }
    if (state.error) {
      dom.tree.innerHTML = `<div class="workspace-file-reader-status-body">${escapeHtml(state.error)}</div>`;
      return;
    }
    const files = getFilteredFiles();
    const directories = getFilteredDirectories();
    if (files.length === 0 && directories.length === 0) {
      dom.tree.innerHTML = `<div class="workspace-file-reader-status-body">${escapeHtml(t("fileReader.noFiles"))}</div>`;
      return;
    }
    dom.tree.innerHTML = renderTreeNode(buildTree(files, directories));
    root.RagentIcons?.hydrate?.(dom.tree);
  }

  async function loadWorkspaceFiles({ force = false } = {}) {
    if (!bindDom()) return false;
    const workspace = getCurrentWorkspaceSafe();
    if (!workspace) {
      state.files = [];
      state.directories = [];
      state.rootPath = "";
      state.loadedWorkspace = "";
      state.error = t("fileReader.noWorkspace");
      setReading(false);
      if (dom.rootLabel) dom.rootLabel.textContent = "";
      renderTree();
      renderStatus(t("fileReader.noWorkspace"));
      return false;
    }
    if (!force && state.loadedWorkspace === workspace && (state.files.length > 0 || state.directories.length > 0)) {
      renderTree();
      if (state.selectedFile && state.reading) {
        openReadableFile(state.selectedFile).catch(() => {});
      } else {
        renderEmptyPreview();
      }
      return true;
    }
    if (state.loadedWorkspace && state.loadedWorkspace !== workspace) {
      state.selectedPath = "";
      state.selectedFile = null;
      setReading(false);
      renderEmptyPreview();
    }
    const requestSeq = state.requestSeq + 1;
    state.requestSeq = requestSeq;
    state.loading = true;
    state.error = "";
    renderTree();
    try {
      const data = await fetchJsonOrRedirect(`/api/workspace-files?workspace=${encodeURIComponent(workspace)}`, {
        revalidate: false,
        cache: "no-store",
      });
      if (requestSeq !== state.requestSeq) return false;
      state.files = Array.isArray(data?.files) ? data.files : [];
      state.directories = Array.isArray(data?.directories) ? data.directories : [];
      state.rootPath = String(data?.root || "");
      state.loadedWorkspace = workspace;
      state.loading = false;
      state.error = "";
      if (dom.rootLabel) dom.rootLabel.textContent = getShortPath(state.rootPath);
      renderTree();
      if (state.selectedFile && state.reading) {
        openReadableFile(state.selectedFile).catch(() => {});
      } else if (!state.selectedPath) {
        renderEmptyPreview();
      }
      return true;
    } catch (error) {
      if (requestSeq !== state.requestSeq) return false;
      state.files = [];
      state.directories = [];
      state.loading = false;
      state.error = error?.message || t("fileReader.loadFailed");
      renderTree();
      renderStatus(t("fileReader.loadFailed"), state.error);
      return false;
    }
  }

  function openPanel({ load = true } = {}) {
    bindDom();
    setOpen(true);
    if (load) {
      loadWorkspaceFiles().catch(() => {});
    }
  }

  function syncForSidebarTab(showingFiles) {
    if (showingFiles) {
      openPanel();
      return;
    }
    setReading(false);
    if (state.open) {
      setOpen(false);
      return;
    }
    bindDom();
    setOpen(false);
  }

  function openExternalReadableFile(file) {
    if (typeof root.openRightSidebarFiles === "function") {
      root.openRightSidebarFiles();
    }
    openPanel({ load: false });
    openReadableFile(file);
    return true;
  }

  function showFileTree() {
    if (!bindDom()) return;
    setReading(false);
    renderTree();
    root.RagentIcons?.hydrate?.(dom.panel);
  }

  function restartReaderAnimation() {
    if (!dom.panel?.classList) return;
    dom.panel.classList.remove("sidebar-surface-enter");
    void dom.panel.offsetWidth;
    dom.panel.classList.add("sidebar-surface-enter");
  }

  function handleTreeClick(event) {
    const button = event.target?.closest?.("[data-workspace-file-path]");
    if (!button) return;
    const path = button.dataset.workspaceFilePath || "";
    const file = state.files.find((item) => (item.path || item.relativePath) === path);
    if (!file) return;
    openReadableFile(file);
  }

  function handleListResizePointerDown(event) {
    if (!dom.listPanel || !canResizeListPanel()) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      dom.listPanel.getBoundingClientRect?.().width
      || state.listWidth
      || readStoredListWidth()
      || MIN_LIST_PANEL_WIDTH;
    state.resizingList = true;
    document.body.classList.add("workspace-file-reader-list-resizing");
    dom.listResizeHandle?.setPointerCapture?.(event.pointerId);

    function handlePointerMove(moveEvent) {
      if (!state.resizingList) return;
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      applyListPanelWidth(nextWidth);
    }

    function handlePointerUp(upEvent) {
      if (!state.resizingList) return;
      state.resizingList = false;
      document.body.classList.remove("workspace-file-reader-list-resizing");
      dom.listResizeHandle?.releasePointerCapture?.(upEvent.pointerId);
      applyListPanelWidth(state.listWidth || startWidth, { persist: true });
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerup", handlePointerUp);
      root.removeEventListener("pointercancel", handlePointerUp);
    }

    root.addEventListener("pointermove", handlePointerMove);
    root.addEventListener("pointerup", handlePointerUp);
    root.addEventListener("pointercancel", handlePointerUp);
  }

  function handleListResizeKeydown(event) {
    if (!canResizeListPanel()) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.shiftKey ? 48 : 24;
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    const currentWidth =
      state.listWidth
      || dom.listPanel?.getBoundingClientRect?.().width
      || readStoredListWidth()
      || MIN_LIST_PANEL_WIDTH;
    applyListPanelWidth(currentWidth + direction * delta, { persist: true });
  }

  function bindDom() {
    const panel = document.getElementById("workspaceFileReader");
    if (!panel) {
      dom.panel = null;
      dom.backButton = null;
      dom.closeButton = null;
      dom.refreshButton = null;
      dom.rootLabel = null;
      dom.layout = null;
      dom.preview = null;
      dom.listPanel = null;
      dom.listResizeHandle = null;
      dom.searchInput = null;
      dom.tree = null;
      dom.boundPanel = null;
      return false;
    }
    if (dom.boundPanel === panel) return true;
    dom.panel = panel;
    dom.backButton = document.getElementById("workspaceFileReaderBackBtn");
    dom.closeButton = document.getElementById("workspaceFileReaderCloseBtn");
    dom.refreshButton = document.getElementById("workspaceFileReaderRefreshBtn");
    dom.rootLabel = document.getElementById("workspaceFileReaderRoot");
    dom.layout = panel.querySelector(".workspace-file-reader-layout");
    dom.preview = document.getElementById("workspaceFileReaderPreview");
    dom.listPanel = panel.querySelector(".workspace-file-reader-list-panel");
    dom.listResizeHandle = document.getElementById("workspaceFileReaderListResizeHandle");
    dom.searchInput = document.getElementById("workspaceFileReaderSearchInput");
    dom.tree = document.getElementById("workspaceFileReaderTree");
    if (!dom.preview || !dom.tree) return false;
    dom.boundPanel = panel;

    dom.backButton?.addEventListener("click", showFileTree);
    dom.closeButton?.addEventListener("click", () => closeReader({ switchBack: true }));
    dom.refreshButton?.addEventListener("click", () => loadWorkspaceFiles({ force: true }));
    dom.searchInput?.addEventListener("input", () => {
      state.search = dom.searchInput.value || "";
      renderTree();
    });
    dom.listResizeHandle?.addEventListener("pointerdown", handleListResizePointerDown);
    dom.listResizeHandle?.addEventListener("keydown", handleListResizeKeydown);
    dom.tree.addEventListener("click", handleTreeClick);
    root.RagentIcons?.hydrate?.(dom.panel);
    setOpen(state.open);
    setReading(state.reading);
    if (dom.searchInput) dom.searchInput.value = state.search || "";
    if (dom.rootLabel) dom.rootLabel.textContent = getShortPath(state.rootPath);
    hydrateStoredListPanelWidth();
    renderTree();
    if (!state.selectedFile) renderEmptyPreview();
    return true;
  }

  function syncMount({ active = false, force = false } = {}) {
    if (!bindDom()) return false;
    if (!active) setReading(false);
    setOpen(active);
    if (active) loadWorkspaceFiles({ force }).catch(() => {});
    return true;
  }

  function init() {
    bindDom();
    root.addEventListener?.("resize", () => {
      if (state.open && state.listWidth && canResizeListPanel()) {
        applyListPanelWidth(state.listWidth);
      }
    });
  }

  root.syncWorkspaceFileReaderForSidebarTab = syncForSidebarTab;
  root.restartWorkspaceFileReaderAnimation = restartReaderAnimation;
  root.syncWorkspaceFileReaderMount = syncMount;
  root.openRagentReadableFile = openExternalReadableFile;
  root.openWorkspaceReadableFile = openExternalReadableFile;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(window);
