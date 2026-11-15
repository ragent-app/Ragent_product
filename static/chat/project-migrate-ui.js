// Project migration settings and execution surface. The folder picker is the
// same component used by project creation; this module only owns migration
// state, mapping rows, and the result projection.
(function attachProjectMigration(root) {
  "use strict";

  let dialog = null;
  let picker = null;
  let activeProject = null;
  let mappings = {};
  let trigger = null;
  let focusScopeDeactivate = null;

  function t(key, vars) {
    return root.ragentT ? root.ragentT(key, vars) : key;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[char]);
  }

  function normalizePath(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function validRelativePath(value) {
    const path = String(value || "").trim();
    if (!path || path.startsWith("/") || path.includes("\\")) return false;
    return path.split("/").every((part) => part && part !== "." && part !== "..");
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("div");
    dialog.className = "project-migrate-dialog";
    dialog.hidden = true;
    dialog.innerHTML = `
      <div class="project-migrate-dialog__backdrop" data-migrate-close></div>
      <section class="project-migrate-dialog__sheet" role="dialog" aria-modal="true" aria-labelledby="projectMigrateTitle">
        <header class="project-migrate-dialog__header">
          <div><h2 id="projectMigrateTitle"></h2><div class="project-migrate-dialog__project"></div></div>
          <button class="project-migrate-dialog__close" type="button" data-migrate-close data-icon="close" aria-label="${escapeHtml(t("action.close"))}"></button>
        </header>
        <div class="project-migrate-dialog__body">
          <div class="project-migrate-path-summary"><span class="project-migrate-label"></span><code class="project-migrate-current"></code></div>
          <div class="project-migrate-field"><label class="project-migrate-label" for="projectMigrateTarget"></label><div class="project-migrate-target-row"><code id="projectMigrateTarget"></code><button type="button" class="project-migrate-choose"></button></div></div>
          <p class="project-migrate-copy-notice"></p>
          <div class="project-migrate-warning" hidden></div>
          <details class="project-migrate-renames"><summary></summary><div class="project-migrate-mapping-list"></div><button type="button" class="project-migrate-add-mapping"></button></details>
          <div class="project-migrate-result" role="status" aria-live="polite" hidden></div>
        </div>
        <footer class="project-migrate-dialog__actions"><button type="button" class="project-migrate-cancel" data-migrate-close></button><button type="button" class="project-migrate-run-all"></button><button type="button" class="project-migrate-save"></button></footer>
      </section>`;
    document.body.appendChild(dialog);
    root.RagentIcons?.hydrate?.(dialog);
    dialog.querySelectorAll("[data-migrate-close]").forEach((node) => node.addEventListener("click", close));
    dialog.querySelector(".project-migrate-choose")?.addEventListener("click", openPicker);
    dialog.querySelector(".project-migrate-add-mapping")?.addEventListener("click", () => {
      mappings[`entry-${Object.keys(mappings).length + 1}`] = "";
      renderMappings();
      dialog.querySelector(".project-migrate-mapping-row:last-child input")?.focus?.();
    });
    dialog.querySelector(".project-migrate-save")?.addEventListener("click", () => void saveSettings());
    dialog.querySelector(".project-migrate-run-all")?.addEventListener("click", () => void runMigration());
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    return dialog;
  }

  function renderMappings() {
    if (!dialog) return;
    const mount = dialog.querySelector(".project-migrate-mapping-list");
    const entries = Object.entries(mappings);
    mount.innerHTML = entries.length ? entries.map(([source, target], index) => `
      <div class="project-migrate-mapping-row" data-index="${index}">
        <input type="text" data-mapping-source autocomplete="off" aria-label="${escapeHtml(t("sidebar.project.sourcePath"))}" value="${escapeHtml(source)}" placeholder="${escapeHtml(t("sidebar.project.sourcePath"))}">
        <span aria-hidden="true" data-icon="arrow-right"></span>
        <input type="text" data-mapping-target autocomplete="off" aria-label="${escapeHtml(t("sidebar.project.targetPath"))}" value="${escapeHtml(target)}" placeholder="${escapeHtml(t("sidebar.project.targetPath"))}">
        <button type="button" data-remove-mapping data-icon="close" aria-label="${escapeHtml(t("action.close"))}"></button>
      </div>`).join("") : `<div class="project-migrate-no-mappings">${escapeHtml(t("sidebar.project.noMappings"))}</div>`;
    root.RagentIcons?.hydrate?.(mount);
    mount.querySelectorAll("[data-remove-mapping]").forEach((button) => button.addEventListener("click", () => {
      const row = button.closest(".project-migrate-mapping-row");
      const index = Number(row?.dataset.index);
      const key = Object.keys(mappings)[index];
      delete mappings[key];
      renderMappings();
    }));
  }

  function readMappings() {
    const result = {};
    let invalid = false;
    dialog.querySelectorAll(".project-migrate-mapping-row").forEach((row) => {
      const source = row.querySelector("[data-mapping-source]")?.value.trim() || "";
      const target = row.querySelector("[data-mapping-target]")?.value.trim() || "";
      if (!source && !target) return;
      if (!validRelativePath(source) || !validRelativePath(target)) invalid = true;
      else result[source] = target;
    });
    if (invalid) throw new Error(t("sidebar.project.invalidMapping"));
    return result;
  }

  function setText() {
    dialog.querySelector("#projectMigrateTitle").textContent = t("sidebar.project.migration");
    dialog.querySelector(".project-migrate-dialog__project").textContent = activeProject?.name || "";
    dialog.querySelector(".project-migrate-path-summary .project-migrate-label").textContent = t("sidebar.project.currentPath");
    dialog.querySelector(".project-migrate-current").textContent = activeProject?.rootPath || "";
    dialog.querySelector(".project-migrate-field .project-migrate-label").textContent = t("sidebar.project.migrateTarget");
    dialog.querySelector(".project-migrate-choose").textContent = t("sidebar.project.chooseFolder");
    dialog.querySelector(".project-migrate-copy-notice").textContent = t("sidebar.project.copyNotice");
    dialog.querySelector(".project-migrate-renames summary").textContent = t("sidebar.project.advancedRenames");
    dialog.querySelector(".project-migrate-add-mapping").textContent = t("sidebar.project.addMapping");
    dialog.querySelector(".project-migrate-cancel").textContent = t("action.cancel");
    dialog.querySelector(".project-migrate-run-all").textContent = t("sidebar.project.migrateAll");
    dialog.querySelector(".project-migrate-save").textContent = t("sidebar.project.saveMigration");
  }

  function updateTarget(path) {
    const target = dialog.querySelector("#projectMigrateTarget");
    target.textContent = normalizePath(path);
    target.title = normalizePath(path);
    const warning = dialog.querySelector(".project-migrate-warning");
    const same = normalizePath(path) === normalizePath(activeProject?.rootPath);
    warning.hidden = !same;
    warning.textContent = same ? t("sidebar.project.samePath") : "";
  }

  function openPicker() {
    const mount = dialog.querySelector(".project-migrate-picker");
    if (!mount) {
      const targetRow = dialog.querySelector(".project-migrate-target-row");
      const pickerMount = document.createElement("div");
      pickerMount.className = "project-migrate-picker";
      targetRow.parentElement.appendChild(pickerMount);
      picker = root.RagentFolderTreePicker?.create?.({
        container: pickerMount,
        startPath: dialog.querySelector("#projectMigrateTarget").textContent || activeProject?.rootPath || "~",
        onChange: ({ path }) => updateTarget(path),
      });
      return;
    }
    mount.hidden = !mount.hidden;
  }

  async function saveSettings({ closeAfter = false } = {}) {
    const target = normalizePath(dialog.querySelector("#projectMigrateTarget").textContent);
    let renames;
    try { renames = readMappings(); } catch (error) { showResult(error.message, true); return false; }
    const save = dialog.querySelector(".project-migrate-save");
    save.disabled = true;
    try {
      const response = await (window.ragentFetch || fetch)(`/api/projects/${encodeURIComponent(activeProject.id)}`, {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ migrateTargetPath: target, migrateRenames: renames }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || t("sidebar.project.migrationFailed"));
      activeProject = payload;
      updateTarget(activeProject.migrateTargetPath || "");
      showResult(t("sidebar.project.migrationSaved"), false);
      await root.ragentEnsureProjectsReady?.({ force: true });
      if (closeAfter) close();
      return true;
    } catch (error) {
      showResult(error?.message || t("sidebar.project.migrationFailed"), true);
      return false;
    } finally { save.disabled = false; }
  }

  function showResult(message, failed) {
    const result = dialog.querySelector(".project-migrate-result");
    result.hidden = false;
    result.className = `project-migrate-result${failed ? " is-error" : " is-success"}`;
    result.textContent = message;
  }

  async function runMigration() {
    const saved = await saveSettings();
    if (!saved) return;
    const run = dialog.querySelector(".project-migrate-run-all");
    run.disabled = true;
    run.textContent = t("sidebar.project.migrateNow");
    try {
      const response = await (window.ragentFetch || fetch)("/api/projects/migrate", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || t("sidebar.project.migrationFailed"));
      const migrated = Array.isArray(payload?.migrated) ? payload.migrated : [];
      const failed = Array.isArray(payload?.failed) ? payload.failed : [];
      const lines = [t("sidebar.project.migrationDone"), ...migrated.map((item) => `✓ ${item.name || item.id} → ${item.rootPath}`), ...failed.map((item) => `! ${item.name || item.id}: ${item.error || item.code || t("sidebar.project.migrationFailed")}`)];
      showResult(lines.join("\n"), failed.length > 0);
      await root.ragentEnsureProjectsReady?.({ force: true });
    } catch (error) { showResult(error?.message || t("sidebar.project.migrationFailed"), true); }
    finally { run.disabled = false; run.textContent = t("sidebar.project.migrateAll"); }
  }

  function open(project) {
    if (!project?.id) return false;
    activeProject = project;
    mappings = { ...(project.migrateRenames || {}) };
    const view = ensureDialog();
    setText();
    updateTarget(project.migrateTargetPath || project.rootPath || "~");
    renderMappings();
    view.hidden = false;
    trigger = document.activeElement;
    focusScopeDeactivate = root.RagentFocusScope?.activate?.(view.querySelector(".project-migrate-dialog__sheet"), { containmentRoot: document.body, initialFocus: view.querySelector(".project-migrate-save"), restoreFocus: () => trigger, modal: true, onEscape: close }) || null;
    return true;
  }

  function close() {
    if (!dialog) return;
    focusScopeDeactivate?.();
    focusScopeDeactivate = null;
    picker?.destroy?.(); picker = null;
    dialog.querySelector(".project-migrate-picker")?.remove();
    dialog.hidden = true;
    trigger?.focus?.({ preventScroll: true });
  }

  root.RagentProjectMigration = Object.freeze({ open, close });
  document.getElementById("sidebarProjectSettingsBtn")?.addEventListener("click", () => {
    const project = root.ragentGetBrowsingProject?.();
    if (project) open(project);
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
