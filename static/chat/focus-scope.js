// Small shared focus-scope primitive for mobile panels and dialogs.
(function attachRagentFocusScope(root) {
  "use strict";

  const documentRef = root.document;
  if (!documentRef) return;
  const stack = [];

  function resolveTarget(target) {
    return typeof target === "function" ? target() : target;
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    if (element.closest?.("[hidden], [inert], [aria-hidden=\"true\"]")) return false;
    const style = root.getComputedStyle?.(element);
    return style?.display !== "none" && style?.visibility !== "hidden";
  }

  function isFocusable(element) {
    if (!isVisible(element) || element.disabled) return false;
    const tabIndex = element.getAttribute?.("tabindex");
    if (tabIndex != null) return Number(tabIndex) >= 0;
    return element.matches?.(
      "a[href], area[href], button, input, select, textarea, summary, [contenteditable=\"true\"]",
    ) === true;
  }

  function getFocusable(rootElement) {
    if (!rootElement?.querySelectorAll) return [];
    const selectors = [
      "a[href]",
      "area[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[contenteditable=\"true\"]",
      "[tabindex]",
    ];
    const elements = [];
    if (isFocusable(rootElement)) elements.push(rootElement);
    rootElement.querySelectorAll(selectors.join(",")).forEach((element) => {
      if (isFocusable(element)) elements.push(element);
    });
    return elements;
  }

  function focusElement(element) {
    if (!element || typeof element.focus !== "function") return false;
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    return documentRef.activeElement === element || typeof documentRef.activeElement === "undefined";
  }

  function fallbackFocus(containmentRoot) {
    const candidate = containmentRoot?.querySelector?.(
      "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex=\"0\"]",
    ) || documentRef.querySelector?.("main, [role=\"main\"]");
    if (candidate && isFocusable(candidate)) return focusElement(candidate);
    const body = documentRef.body;
    if (!body) return false;
    const hadTabIndex = body.hasAttribute("tabindex");
    const previousTabIndex = body.getAttribute("tabindex");
    if (!hadTabIndex) body.setAttribute("tabindex", "-1");
    const focused = focusElement(body);
    if (!hadTabIndex) body.removeAttribute("tabindex");
    else body.setAttribute("tabindex", previousTabIndex);
    return focused;
  }

  function setSiblingIsolation(scope) {
    if (!scope.modal || !scope.containmentRoot?.children) return;
    for (const sibling of Array.from(scope.containmentRoot.children)) {
      if (sibling === scope.root) continue;
      scope.previousSiblings.set(sibling, {
        inertProperty: "inert" in sibling ? sibling.inert === true : null,
        inertAttribute: sibling.hasAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      if ("inert" in sibling) sibling.inert = true;
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
  }

  function restoreSiblingIsolation(scope) {
    for (const [sibling, previous] of scope.previousSiblings) {
      if ("inert" in sibling && previous.inertProperty !== null) {
        sibling.inert = previous.inertProperty;
      }
      if (previous.inertAttribute) sibling.setAttribute("inert", "");
      else sibling.removeAttribute("inert");
      if (previous.ariaHidden == null) sibling.removeAttribute("aria-hidden");
      else sibling.setAttribute("aria-hidden", previous.ariaHidden);
    }
    scope.previousSiblings.clear();
  }

  function topScope() {
    return stack[stack.length - 1] || null;
  }

  function activate(scopeRoot, options = {}) {
    if (!scopeRoot) return () => {};
    const scope = {
      root: scopeRoot,
      containmentRoot: options.containmentRoot || documentRef.body,
      modal: options.modal !== false,
      initialFocus: options.initialFocus,
      restoreFocus: options.restoreFocus,
      onEscape: options.onEscape,
      previousFocus: documentRef.activeElement,
      previousSiblings: new Map(),
      previousRootAriaHidden: scopeRoot.getAttribute("aria-hidden"),
      previousRootAriaModal: scopeRoot.getAttribute("aria-modal"),
      active: true,
    };

    stack.push(scope);
    setSiblingIsolation(scope);
    scope.root.setAttribute("aria-hidden", "false");
    if (scope.modal) scope.root.setAttribute("aria-modal", "true");
    else scope.root.removeAttribute("aria-modal");

    function focusInitial() {
      const requested = resolveTarget(scope.initialFocus);
      const candidate = requested && scope.root.contains(requested) && isFocusable(requested)
        ? requested
        : getFocusable(scope.root)[0];
      if (!focusElement(candidate)) fallbackFocus(scope.root);
    }

    function onKeydown(event) {
      if (!scope.active || topScope() !== scope) return;
      if (event.key === "Escape") {
        if (typeof scope.onEscape === "function") {
          event.preventDefault();
          event.stopPropagation();
          scope.onEscape(event);
        }
        return;
      }
      if (!scope.modal || event.key !== "Tab") return;
      const focusable = getFocusable(scope.root);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const index = focusable.indexOf(documentRef.activeElement);
      const nextIndex = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index < 0 || index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusElement(focusable[nextIndex]);
    }

    function onFocusIn(event) {
      if (!scope.active || topScope() !== scope || !scope.modal) return;
      if (scope.root.contains(event.target)) return;
      focusInitial();
    }

    documentRef.addEventListener("keydown", onKeydown, true);
    documentRef.addEventListener("focusin", onFocusIn, true);
    focusInitial();

    return function deactivate() {
      if (!scope.active) return;
      scope.active = false;
      documentRef.removeEventListener("keydown", onKeydown, true);
      documentRef.removeEventListener("focusin", onFocusIn, true);
      const index = stack.indexOf(scope);
      if (index >= 0) stack.splice(index, 1);
      restoreSiblingIsolation(scope);
      if (scope.previousRootAriaHidden == null) scope.root.removeAttribute("aria-hidden");
      else scope.root.setAttribute("aria-hidden", scope.previousRootAriaHidden);
      if (scope.previousRootAriaModal == null) scope.root.removeAttribute("aria-modal");
      else scope.root.setAttribute("aria-modal", scope.previousRootAriaModal);

      const target = resolveTarget(scope.restoreFocus) || scope.previousFocus;
      if (target && target.isConnected !== false && isFocusable(target)) {
        focusElement(target);
      } else {
        fallbackFocus(scope.containmentRoot);
      }
    };
  }

  root.RagentFocusScope = Object.freeze({ activate });
})(window);
