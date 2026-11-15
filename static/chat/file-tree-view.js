"use strict";

(function attachFileTreeView(root) {
  if (root.RagentFileTreeView) return;

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function renderIcon(name, className = "") {
    return root.RagentIcons?.render(name, { className }) || "";
  }

  function renderFolderSummary({
    name,
    path,
    selected = false,
    loading = false,
    disabled = false,
  } = {}) {
    const title = String(path || name || "");
    return `
      <summary class="workspace-file-tree-folder-toggle file-tree-folder-toggle ${selected ? "active" : ""} ${disabled ? "disabled" : ""}" data-folder-path="${escapeHtml(path)}" title="${escapeHtml(title)}">
        ${renderIcon("chevron-down", "workspace-file-tree-chevron")}
        <span class="workspace-file-tree-folder-icon">${renderIcon("folder")}</span>
        <span class="workspace-file-tree-name">${escapeHtml(name || path || "")}</span>
        ${loading ? `<span class="workspace-file-tree-count">${escapeHtml("...")}</span>` : ""}
      </summary>`;
  }

  function renderFolderButton({
    name,
    path,
    selected = false,
    disabled = false,
    meta = "",
  } = {}) {
    const title = String(path || name || "");
    return `
      <button type="button" class="workspace-file-tree-file file-tree-folder-row ${selected ? "active" : ""}" data-folder-path="${escapeHtml(path)}" ${disabled ? "disabled" : ""} title="${escapeHtml(title)}">
        <span class="workspace-file-tree-folder-icon">${renderIcon("folder")}</span>
        <span class="workspace-file-tree-name">${escapeHtml(name || path || "")}</span>
        ${meta ? `<span class="workspace-file-tree-count">${escapeHtml(meta)}</span>` : ""}
      </button>`;
  }

  function normalizeFolderNode(node = {}) {
    const path = String(node.path || "").trim();
    return {
      path,
      name: String(node.name || path || "").trim(),
      parent: String(node.parent || "").trim(),
      children: Array.isArray(node.children) ? node.children.map(normalizeFolderNode).filter((child) => child.path) : [],
      loaded: node.loaded === true,
      loading: node.loading === true,
      error: String(node.error || "").trim(),
    };
  }

  function renderFolderTreeNode(node, {
    selectedPath = "",
    nested = false,
    emptyText = "",
    isExpanded = null,
  } = {}) {
    const normalized = normalizeFolderNode(node);
    const selected = normalized.path && normalized.path === selectedPath;
    const children = Array.isArray(normalized.children) ? normalized.children : [];
    const childMarkup = children.length > 0
      ? children.map((child) => renderFolderTreeNode(child, {
          selectedPath,
          nested: true,
          emptyText,
          isExpanded,
        })).join("")
      : (normalized.loaded
        ? `<li><div class="workspace-file-reader-status-body">${escapeHtml(emptyText)}</div></li>`
        : "");
    const errorMarkup = normalized.error
      ? `<li><div class="workspace-file-reader-status-body">${escapeHtml(normalized.error)}</div></li>`
      : "";
    // With an external isExpanded callback the caller owns the open/closed
    // state (lazy trees that re-render after loading a level must keep their
    // expanded folders open). Without it, keep the legacy default: the root
    // node open, everything else closed.
    const open = typeof isExpanded === "function"
      ? isExpanded(normalized.path)
      : !nested;
    return `
      <li class="workspace-file-tree-folder">
        <details ${open ? "open" : ""} data-folder-path="${escapeHtml(normalized.path)}">
          ${renderFolderSummary({
            name: normalized.name,
            path: normalized.path,
            selected,
            loading: normalized.loading,
          })}
          <ul class="workspace-file-tree-list nested">
            ${errorMarkup || childMarkup}
          </ul>
        </details>
      </li>`;
  }

  function renderFolderTree(rootNode, options = {}) {
    return `<ul class="workspace-file-tree-list file-tree-folder-list">${renderFolderTreeNode(rootNode, options)}</ul>`;
  }

  root.RagentFileTreeView = Object.freeze({
    escapeHtml,
    normalizeFolderNode,
    renderFolderButton,
    renderFolderSummary,
    renderFolderTree,
    renderFolderTreeNode,
  });
})(window);
