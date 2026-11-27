// Off-main-thread Markdown conversion for large composer pastes.
// The worker only produces Vditor's WYSIWYG HTML; DOM ownership stays on the
// page so selection, editing, and accessibility remain in the main document.
(function initMarkdownComposerWorker() {
  "use strict";

  const luteVersionSearch = self.location?.search || "";
  const luteUrl = new URL(`vendor/vditor/dist/js/lute/lute.min.js${luteVersionSearch}`, self.location.href).toString();
  importScripts(luteUrl);

  const lute = self.Lute.New({
    sanitize: true,
    paragraphBeginningSpace: false,
    autoSpace: false,
  });

  self.onmessage = (event) => {
    const id = event?.data?.id;
    const text = String(event?.data?.text ?? "");
    try {
      self.postMessage({ id, html: lute.Md2VditorDOM(text) });
    } catch (error) {
      self.postMessage({ id, error: String(error?.message || error) });
    }
  };
})();
