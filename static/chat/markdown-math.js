"use strict";

(function attachMarkdownMath(root) {
  const TOKEN_PREFIX = "RAGENT_MATH_TOKEN_";
  const TOKEN_RE = /RAGENT_MATH_TOKEN_(\d+)/g;

  const GREEK = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ϵ",
    varepsilon: "ε",
    zeta: "ζ",
    eta: "η",
    theta: "θ",
    vartheta: "ϑ",
    iota: "ι",
    kappa: "κ",
    lambda: "λ",
    mu: "μ",
    nu: "ν",
    xi: "ξ",
    pi: "π",
    varpi: "ϖ",
    rho: "ρ",
    varrho: "ϱ",
    sigma: "σ",
    varsigma: "ς",
    tau: "τ",
    upsilon: "υ",
    phi: "ϕ",
    varphi: "φ",
    chi: "χ",
    psi: "ψ",
    omega: "ω",
    Gamma: "Γ",
    Delta: "Δ",
    Theta: "Θ",
    Lambda: "Λ",
    Xi: "Ξ",
    Pi: "Π",
    Sigma: "Σ",
    Upsilon: "Υ",
    Phi: "Φ",
    Psi: "Ψ",
    Omega: "Ω",
  };

  const OPERATORS = {
    pm: "±",
    mp: "∓",
    times: "×",
    div: "÷",
    cdot: "⋅",
    ast: "∗",
    star: "⋆",
    circ: "∘",
    bullet: "∙",
    le: "≤",
    leq: "≤",
    ge: "≥",
    geq: "≥",
    neq: "≠",
    ne: "≠",
    approx: "≈",
    sim: "∼",
    simeq: "≃",
    equiv: "≡",
    propto: "∝",
    in: "∈",
    notin: "∉",
    subset: "⊂",
    subseteq: "⊆",
    supset: "⊃",
    supseteq: "⊇",
    cup: "∪",
    cap: "∩",
    setminus: "∖",
    land: "∧",
    wedge: "∧",
    lor: "∨",
    vee: "∨",
    neg: "¬",
    to: "→",
    rightarrow: "→",
    leftarrow: "←",
    leftrightarrow: "↔",
    Rightarrow: "⇒",
    Leftarrow: "⇐",
    Leftrightarrow: "⇔",
    mapsto: "↦",
    infinity: "∞",
    infty: "∞",
    partial: "∂",
    nabla: "∇",
    forall: "∀",
    exists: "∃",
    emptyset: "∅",
    angle: "∠",
    perp: "⊥",
    parallel: "∥",
    sum: "∑",
    prod: "∏",
    coprod: "∐",
    int: "∫",
    iint: "∬",
    iiint: "∭",
    oint: "∮",
    lim: "lim",
    min: "min",
    max: "max",
    sup: "sup",
    inf: "inf",
    sin: "sin",
    cos: "cos",
    tan: "tan",
    cot: "cot",
    sec: "sec",
    csc: "csc",
    arcsin: "arcsin",
    arccos: "arccos",
    arctan: "arctan",
    sinh: "sinh",
    cosh: "cosh",
    tanh: "tanh",
    log: "log",
    ln: "ln",
    exp: "exp",
    det: "det",
    dim: "dim",
    gcd: "gcd",
    deg: "deg",
    mod: "mod",
  };

  const ACCENTS = {
    hat: "^",
    widehat: "^",
    bar: "¯",
    overline: "¯",
    vec: "→",
    tilde: "~",
    widetilde: "~",
    dot: ".",
  };

  const DELIMITERS = {
    lbrace: "{",
    rbrace: "}",
    langle: "⟨",
    rangle: "⟩",
    lvert: "|",
    rvert: "|",
    lVert: "‖",
    rVert: "‖",
  };

  function escapeHtml(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function isEscaped(source, index) {
    let count = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      count += 1;
    }
    return count % 2 === 1;
  }

  function isFenceAt(source, index) {
    if (index > 0 && source[index - 1] !== "\n") return null;
    let cursor = index;
    let spaces = 0;
    while (source[cursor] === " " && spaces < 4) {
      spaces += 1;
      cursor += 1;
    }
    const marker = source.slice(cursor, cursor + 3);
    if (marker !== "```" && marker !== "~~~") return null;
    let end = cursor + 3;
    while (source[end] === marker[0]) end += 1;
    return { marker: source.slice(cursor, end), cursor };
  }

  function findUnescaped(source, needle, start, { singleLine = false } = {}) {
    for (let index = start; index < source.length; index += 1) {
      if (singleLine && source[index] === "\n") return -1;
      if (source.startsWith(needle, index) && !isEscaped(source, index)) return index;
    }
    return -1;
  }

  function findInlineMathEnd(source, start) {
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "\n") return -1;
      if (source[index] !== "$" || isEscaped(source, index)) continue;
      if (source[index + 1] === "$") {
        index += 1;
        continue;
      }
      const previous = source[index - 1] || "";
      if (/\s/.test(previous)) continue;
      return index;
    }
    return -1;
  }

  function readBacktickRun(source, index) {
    if (source[index] !== "`") return "";
    let end = index;
    while (source[end] === "`") end += 1;
    return source.slice(index, end);
  }

  function prepareMarkdownMath(markdown) {
    const source = String(markdown || "");
    const tokens = [];
    let output = "";
    let index = 0;
    let fenceMarker = "";

    function addToken(tex, display) {
      const token = `${TOKEN_PREFIX}${tokens.length}`;
      tokens.push({ token, tex: tex.trim(), display: display === true });
      return token;
    }

    while (index < source.length) {
      const fence = isFenceAt(source, index);
      if (fence) {
        const lineEnd = source.indexOf("\n", index);
        const nextIndex = lineEnd < 0 ? source.length : lineEnd + 1;
        if (!fenceMarker) {
          fenceMarker = fence.marker;
        } else if (fence.marker[0] === fenceMarker[0] && fence.marker.length >= fenceMarker.length) {
          fenceMarker = "";
        }
        output += source.slice(index, nextIndex);
        index = nextIndex;
        continue;
      }

      if (fenceMarker) {
        output += source[index];
        index += 1;
        continue;
      }

      const backticks = readBacktickRun(source, index);
      if (backticks) {
        const close = source.indexOf(backticks, index + backticks.length);
        const nextIndex = close < 0 ? index + backticks.length : close + backticks.length;
        output += source.slice(index, nextIndex);
        index = nextIndex;
        continue;
      }

      if (source.startsWith("$$", index) && !isEscaped(source, index)) {
        const close = findUnescaped(source, "$$", index + 2);
        if (close >= 0) {
          const token = addToken(source.slice(index + 2, close), true);
          output += `\n\n${token}\n\n`;
          index = close + 2;
          continue;
        }
      }

      if (source[index] === "$" && !isEscaped(source, index) && source[index + 1] !== "$") {
        const next = source[index + 1] || "";
        if (next && !/\s|\d/.test(next)) {
          const close = findInlineMathEnd(source, index + 1);
          if (close >= 0) {
            output += addToken(source.slice(index + 1, close), false);
            index = close + 1;
            continue;
          }
        }
      }

      output += source[index];
      index += 1;
    }

    return { markdown: output, tokens };
  }

  function parseTexToMathMl(tex) {
    const source = String(tex || "");
    let index = 0;

    function skipSpaces() {
      while (/\s/.test(source[index] || "")) index += 1;
    }

    function peekCommandName() {
      if (source[index] !== "\\") return "";
      let cursor = index + 1;
      if (/[A-Za-z]/.test(source[cursor] || "")) {
        while (/[A-Za-z]/.test(source[cursor] || "")) cursor += 1;
        return source.slice(index + 1, cursor);
      }
      return source[cursor] || "";
    }

    function readCommandName() {
      const name = peekCommandName();
      index += name.length + 1;
      return name;
    }

    function parseExpression({ stopChar = "", stopCommands = new Set() } = {}) {
      const parts = [];
      while (index < source.length) {
        skipSpaces();
        if (!source[index]) break;
        if (stopChar && source[index] === stopChar) break;
        if (source[index] === "\\" && stopCommands.has(peekCommandName())) break;
        const atom = parseScriptedAtom();
        if (atom) parts.push(atom);
        else index += 1;
      }
      return parts.join("");
    }

    function parseScriptedAtom() {
      let base = parseAtom();
      if (!base) return "";
      let sub = "";
      let sup = "";
      while (source[index] === "_" || source[index] === "^") {
        const marker = source[index];
        index += 1;
        const value = parseScriptArgument();
        if (marker === "_") sub = value;
        else sup = value;
      }
      if (sub && sup) return `<msubsup>${base}${sub}${sup}</msubsup>`;
      if (sub) return `<msub>${base}${sub}</msub>`;
      if (sup) return `<msup>${base}${sup}</msup>`;
      return base;
    }

    function parseScriptArgument() {
      skipSpaces();
      if (source[index] === "{") return parseGroup();
      return parseAtom();
    }

    function parseGroup() {
      if (source[index] !== "{") return parseAtom();
      index += 1;
      const body = parseExpression({ stopChar: "}" });
      if (source[index] === "}") index += 1;
      return `<mrow>${body}</mrow>`;
    }

    function readRawGroup() {
      skipSpaces();
      if (source[index] !== "{") return "";
      index += 1;
      const start = index;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "\\" && source[index + 1]) {
          index += 2;
          continue;
        }
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") depth -= 1;
        index += 1;
      }
      return source.slice(start, Math.max(start, index - 1));
    }

    function skipOptionalArgument() {
      skipSpaces();
      if (source[index] !== "[") return;
      let depth = 1;
      index += 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "[") depth += 1;
        else if (source[index] === "]") depth -= 1;
        index += 1;
      }
    }

    function parseDelimiter() {
      skipSpaces();
      if (source[index] === "\\") {
        const name = readCommandName();
        if (name === "." || !name) return "";
        return `<mo>${escapeHtml(DELIMITERS[name] || OPERATORS[name] || name)}</mo>`;
      }
      const delimiter = source[index] || "";
      index += delimiter ? 1 : 0;
      return delimiter === "." ? "" : `<mo>${escapeHtml(delimiter)}</mo>`;
    }

    function readUntilEndEnvironment(name) {
      const needle = `\\end{${name}}`;
      const end = source.indexOf(needle, index);
      if (end < 0) {
        const body = source.slice(index);
        index = source.length;
        return body;
      }
      const body = source.slice(index, end);
      index = end + needle.length;
      return body;
    }

    function splitUnescaped(value, delimiter) {
      const parts = [];
      let start = 0;
      for (let cursor = 0; cursor < value.length; cursor += 1) {
        if (value.startsWith(delimiter, cursor) && !isEscaped(value, cursor)) {
          parts.push(value.slice(start, cursor));
          cursor += delimiter.length - 1;
          start = cursor + 1;
        }
      }
      parts.push(value.slice(start));
      return parts;
    }

    function renderEnvironment(name, body) {
      const rowParts = splitUnescaped(body, "\\\\");
      const rows = rowParts.map((row) => {
        const cells = splitUnescaped(row, "&")
          .map((cell) => `<mtd>${parseTexToMathMl(cell)}</mtd>`)
          .join("");
        return `<mtr>${cells || "<mtd></mtd>"}</mtr>`;
      }).join("");
      const table = `<mtable>${rows}</mtable>`;
      if (name === "pmatrix") return `<mrow><mo>(</mo>${table}<mo>)</mo></mrow>`;
      if (name === "bmatrix") return `<mrow><mo>[</mo>${table}<mo>]</mo></mrow>`;
      if (name === "Bmatrix") return `<mrow><mo>{</mo>${table}<mo>}</mo></mrow>`;
      if (name === "vmatrix") return `<mrow><mo>|</mo>${table}<mo>|</mo></mrow>`;
      if (name === "Vmatrix") return `<mrow><mo>‖</mo>${table}<mo>‖</mo></mrow>`;
      if (name === "cases") return `<mrow><mo>{</mo>${table}</mrow>`;
      return table;
    }

    function parseCommandAtom() {
      const name = readCommandName();
      if (!name) return "";

      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        return `<mfrac>${parseGroup()}${parseGroup()}</mfrac>`;
      }
      if (name === "sqrt") {
        skipOptionalArgument();
        return `<msqrt>${parseGroup()}</msqrt>`;
      }
      if (name === "text" || name === "mathrm") {
        return `<mtext>${escapeHtml(readRawGroup())}</mtext>`;
      }
      if (name === "left") {
        const open = parseDelimiter();
        const body = parseExpression({ stopCommands: new Set(["right"]) });
        let close = "";
        if (source[index] === "\\" && peekCommandName() === "right") {
          readCommandName();
          close = parseDelimiter();
        }
        return `<mrow>${open}${body}${close}</mrow>`;
      }
      if (name === "right") {
        return parseDelimiter();
      }
      if (name === "begin") {
        const envName = readRawGroup().trim();
        return renderEnvironment(envName, readUntilEndEnvironment(envName));
      }
      if (ACCENTS[name]) {
        return `<mover>${parseGroup()}<mo>${escapeHtml(ACCENTS[name])}</mo></mover>`;
      }
      if (name === "," || name === ";" || name === ":" || name === "quad" || name === "qquad") {
        const width = name === "qquad" ? "2em" : name === "quad" ? "1em" : "0.25em";
        return `<mspace width="${width}"></mspace>`;
      }
      if (GREEK[name]) return `<mi>${GREEK[name]}</mi>`;
      if (DELIMITERS[name]) return `<mo>${escapeHtml(DELIMITERS[name])}</mo>`;
      if (OPERATORS[name]) {
        const value = OPERATORS[name];
        if (/^[A-Za-z]+$/.test(value)) return `<mi>${escapeHtml(value)}</mi>`;
        return `<mo>${escapeHtml(value)}</mo>`;
      }
      if (name.length === 1 && /[^A-Za-z]/.test(name)) return `<mo>${escapeHtml(name)}</mo>`;
      return `<mi>${escapeHtml(name)}</mi>`;
    }

    function parseAtom() {
      skipSpaces();
      const char = source[index];
      if (!char) return "";
      if (char === "{") return parseGroup();
      if (char === "\\") return parseCommandAtom();
      if (/[0-9.]/.test(char)) {
        const start = index;
        while (/[0-9.]/.test(source[index] || "")) index += 1;
        return `<mn>${escapeHtml(source.slice(start, index))}</mn>`;
      }
      if (/[A-Za-z]/.test(char)) {
        index += 1;
        return `<mi>${escapeHtml(char)}</mi>`;
      }
      index += 1;
      if ("+-=<>|,;:()[]{}".includes(char)) return `<mo>${escapeHtml(char)}</mo>`;
      return `<mo>${escapeHtml(char)}</mo>`;
    }

    return parseExpression();
  }

  function createMathNode(token) {
    const wrapper = document.createElement(token.display ? "div" : "span");
    wrapper.className = token.display ? "markdown-math markdown-math--display" : "markdown-math markdown-math--inline";
    wrapper.dataset.tex = token.tex;

    if (root.katex?.render) {
      try {
        root.katex.render(token.tex, wrapper, {
          displayMode: token.display,
          throwOnError: false,
          strict: "ignore",
        });
        return wrapper;
      } catch {
        wrapper.textContent = token.tex;
        return wrapper;
      }
    }

    try {
      wrapper.innerHTML = `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${token.display ? "block" : "inline"}"><mrow>${parseTexToMathMl(token.tex)}</mrow></math>`;
    } catch {
      wrapper.textContent = token.tex;
    }
    return wrapper;
  }

  function replaceMathTokenTextNode(textNode, tokenMap) {
    const value = textNode.nodeValue || "";
    if (!TOKEN_RE.test(value)) return;
    TOKEN_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let match;
    while ((match = TOKEN_RE.exec(value))) {
      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
      }
      const token = tokenMap.get(match[0]);
      fragment.appendChild(token ? createMathNode(token) : document.createTextNode(match[0]));
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }

  function unwrapDisplayMathParagraphs(rootNode) {
    rootNode.querySelectorAll?.("p").forEach((paragraph) => {
      const children = Array.from(paragraph.childNodes).filter((child) => {
        return child.nodeType !== Node.TEXT_NODE || String(child.nodeValue || "").trim();
      });
      if (children.length !== 1) return;
      const child = children[0];
      if (child.nodeType === Node.ELEMENT_NODE && child.classList?.contains("markdown-math--display")) {
        paragraph.replaceWith(child);
      }
    });
  }

  function renderMarkdownMathInNode(rootNode, tokens = []) {
    if (!rootNode || !Array.isArray(tokens) || tokens.length === 0) return;
    const tokenMap = new Map(tokens.map((token) => [token.token, token]));
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((textNode) => replaceMathTokenTextNode(textNode, tokenMap));
    unwrapDisplayMathParagraphs(rootNode);
  }

  root.prepareMarkdownMath = prepareMarkdownMath;
  root.renderMarkdownMathInNode = renderMarkdownMathInNode;
  root.renderTexMathToMathMl = parseTexToMathMl;
})(window);
