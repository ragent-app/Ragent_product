"use strict";

/**
 * Flat, drill-down folder picker (used by the project create dialog).
 *
 * Mobile-first by design: no nested tree. The list always shows the direct
 * subfolders of the current directory; tapping a row enters that folder and
 * the chevron-up button returns to the parent (disabled at the filesystem
 * root). The previous lazy <details> tree was replaced because its nested
 * rendering (full path shown as a folder label, bare "/" entries, "…"
 * overflow nodes, inconsistent indentation) was unusable on small screens.
 */

(function attachFolderPicker(root) {
  if (root.RagentFolderTreePicker) return;

  function t(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function resolveRequestPath(path) {
    if (typeof root.ragentResolveProductPath === "function") {
      return root.ragentResolveProductPath(path);
    }
    return String(path || "");
  }

  function normalizePath(path) {
    return typeof path === "string" && path.trim() ? path.trim() : "~";
  }

  function basename(path) {
    const text = String(path || "").replace(/\/+$/, "");
    const parts = text.split("/").filter(Boolean);
    // The filesystem root has no name of its own: render it as "/" instead of
    // a generic fallback that reads like a real folder ("Project").
    return parts[parts.length - 1] || text || "/";
  }

  async function fetchFolderChildren(path) {
    const url = resolveRequestPath(`/api/browse?path=${encodeURIComponent(normalizePath(path))}&mode=directories`);
    const response = await (root.ragentFetch || fetch)(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || t("sidebar.project.folderLoadFailed"));
      error.payload = payload || {};
      error.status = response.status;
      throw error;
    }
    return payload || { path, parent: null, children: [] };
  }

  async function createFolder(path, name) {
    const response = await (root.ragentFetch || fetch)(resolveRequestPath("/api/browse/mkdir"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ path: normalizePath(path), name }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || t("sidebar.project.folderCreateFailed"));
      error.payload = payload || {};
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function create({ container, startPath = "~", onChange = null } = {}) {
    if (!container) return null;
    const treeView = root.RagentFileTreeView; // only used for escapeHtml
    const state = {
      currentPath: normalizePath(startPath),
      selectedPath: normalizePath(startPath),
      // Raw parent of currentPath. Empty string means the filesystem root —
      // keep it raw instead of normalizePath("") which would fall back to
      // "~" and wrongly make the root look navigable.
      parent: "",
      children: [], // [{ path, name }] — direct subfolders of currentPath
      loading: false,
      error: "",
      createOpen: false,
      createError: "",
      creating: false,
      requestSeq: 0,
    };

    function emit(path) {
      if (typeof onChange === "function") {
        const resolved = normalizePath(path);
        onChange({ path: resolved, name: basename(resolved) });
      }
    }

    async function load(path) {
      const targetPath = normalizePath(path);
      const seq = ++state.requestSeq;
      state.currentPath = targetPath;
      state.selectedPath = targetPath;
      // Clear the parent immediately: until the response arrives the picker
      // cannot know this directory's own parent, so the up button must be
      // disabled instead of reusing the previous directory's parent (which
      // would let a fast double-tap skip two levels).
      state.parent = "";
      state.loading = true;
      state.error = "";
      state.createError = "";
      render();
      try {
        const payload = await fetchFolderChildren(targetPath);
        if (seq !== state.requestSeq) return null;
        const resolvedPath = normalizePath(payload?.path || targetPath);
        state.parent = typeof payload?.parent === "string" ? payload.parent.trim() : "";
        state.children = (Array.isArray(payload?.children) ? payload.children : [])
          .map((child) => {
            const childPath = normalizePath(child?.path || "");
            return {
              path: childPath,
              name: String(child?.name || basename(childPath)),
            };
          })
          .filter((child) => child.path);
        state.currentPath = resolvedPath;
        state.selectedPath = resolvedPath;
        state.loading = false;
        render();
        emit(resolvedPath);
        return null;
      } catch (error) {
        if (seq !== state.requestSeq) return null;
        state.loading = false;
        state.error = error?.message || t("sidebar.project.folderLoadFailed");
        render();
        return null;
      }
    }

    function goUp() {
      if (!state.parent || state.parent === state.currentPath) return;
      void load(state.parent);
    }

    function renderFallback() {
      container.innerHTML = `
        <div class="folder-tree-picker-fallback">
          <input class="folder-tree-picker-path-input" type="text" value="${treeView.escapeHtml(state.selectedPath)}" aria-label="${treeView.escapeHtml(t("sidebar.project.folderPath"))}">
        </div>`;
      container.querySelector(".folder-tree-picker-path-input")?.addEventListener("change", (event) => {
        emit(event.target.value);
      });
    }

    function render() {
      if (!treeView) {
        renderFallback();
        return;
      }
      const escapeHtml = treeView.escapeHtml;
      let listHtml;
      if (state.loading) {
        listHtml = `<div class="folder-tree-picker-empty">${escapeHtml(t("sidebar.project.loading"))}</div>`;
      } else if (state.error) {
        // Tapping the error row retries the current directory.
        listHtml = `<button type="button" class="folder-tree-picker-empty folder-tree-picker-error" data-retry="1">${escapeHtml(state.error)}</button>`;
      } else if (state.children.length === 0) {
        listHtml = `<div class="folder-tree-picker-empty">${escapeHtml(t("sidebar.workspace.noChildren"))}</div>`;
      } else {
        listHtml = state.children
          .map((child) => `
            <button type="button" class="folder-tree-picker-item" data-path="${escapeHtml(child.path)}">
              <span class="folder-tree-picker-item-icon" data-icon="folder-solid"></span>
              <span class="folder-tree-picker-item-name">${escapeHtml(child.name)}</span>
              <span class="folder-tree-picker-item-chevron" data-icon="chevron-right"></span>
            </button>`)
          .join("");
      }
      container.innerHTML = `
        <div class="folder-tree-picker">
          <div class="folder-tree-picker-current">
            <button type="button" class="folder-tree-picker-up" data-icon="chevron-up" title="${escapeHtml(t("sidebar.project.goUp"))}" aria-label="${escapeHtml(t("sidebar.project.goUp"))}" ${state.parent ? "" : "disabled"}></button>
            <div class="folder-tree-picker-current-path" title="${escapeHtml(state.selectedPath)}">${escapeHtml(state.selectedPath)}</div>
            <button type="button" class="folder-tree-picker-new" data-create-toggle="1" aria-expanded="${state.createOpen ? "true" : "false"}"><span data-icon="folder-plus" aria-hidden="true"></span><span>${escapeHtml(t("sidebar.project.newFolder"))}</span></button>
            <button type="button" class="folder-tree-picker-current-select">${escapeHtml(t("sidebar.project.selectCurrentFolder"))}</button>
          </div>
          ${state.createOpen ? `<form class="folder-tree-picker-create" data-create-form="1">
            <label class="folder-tree-picker-create-label" for="folderTreePickerCreateName">${escapeHtml(t("sidebar.project.newFolderName"))}</label>
            <div class="folder-tree-picker-create-row"><input id="folderTreePickerCreateName" name="name" type="text" maxlength="120" autocomplete="off" placeholder="${escapeHtml(t("sidebar.project.newFolderPlaceholder"))}"><button type="submit" ${state.creating ? "disabled" : ""}>${escapeHtml(t("action.create"))}</button></div>
            ${state.createError ? `<div class="folder-tree-picker-create-error" role="alert" aria-live="polite">${escapeHtml(state.createError)}</div>` : ""}
          </form>` : ""}
          <div class="folder-tree-picker-tree">${listHtml}</div>
        </div>`;
      root.RagentIcons?.hydrate?.(container);
      container.querySelector(".folder-tree-picker-up")?.addEventListener("click", goUp);
      container.querySelector("[data-create-toggle]")?.addEventListener("click", () => {
        state.createOpen = !state.createOpen;
        state.createError = "";
        render();
        container.querySelector("#folderTreePickerCreateName")?.focus?.();
      });
      container.querySelector("[data-create-form]")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.creating) return;
        const input = event.currentTarget.querySelector("[name=name]");
        const name = String(input?.value || "").trim();
        if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
          state.createError = t("sidebar.project.folderNameInvalid");
          render();
          container.querySelector("#folderTreePickerCreateName")?.focus?.();
          return;
        }
        state.creating = true;
        state.createError = "";
        render();
        try {
          const payload = await createFolder(state.currentPath, name);
          const createdPath = normalizePath(payload?.path || `${state.currentPath.replace(/\/+$/, "")}/${name}`);
          state.createOpen = false;
          await load(createdPath);
          state.selectedPath = createdPath;
          emit(createdPath);
        } catch (error) {
          state.createError = error?.message || t("sidebar.project.folderCreateFailed");
        } finally {
          state.creating = false;
          render();
        }
      });
      container.querySelector(".folder-tree-picker-current-select")?.addEventListener("click", () => {
        emit(state.selectedPath);
      });
      container.querySelector(".folder-tree-picker-error[data-retry]")?.addEventListener("click", () => {
        void load(state.currentPath);
      });
      container.querySelectorAll(".folder-tree-picker-item").forEach((item) => {
        item.addEventListener("click", () => {
          void load(item.getAttribute("data-path"));
        });
      });
    }

    function setStartPath(path) {
      state.currentPath = normalizePath(path);
      state.selectedPath = state.currentPath;
      state.parent = "";
      state.children = [];
      state.error = "";
      void load(state.currentPath);
    }

    render();
    void load(state.currentPath);

    return {
      getSelectedPath: () => state.selectedPath,
      setStartPath,
      refresh: () => load(state.currentPath),
      destroy: () => {
        container.innerHTML = "";
      },
    };
  }

  root.RagentFolderTreePicker = Object.freeze({
    create,
  });
})(window);
