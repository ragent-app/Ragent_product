/*
 * Small, dependency-free Markdown presentation enhancements.
 *
 * This deliberately stays local to the chat surface: code highlighting is a
 * readable token treatment, not a second editor, and Mermaid support renders
 * the two workflow shapes Ragent uses most often without loading a remote
 * runtime into an authenticated chat page.
 */
(function installMarkdownEnhancements(root) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);
  const LANGUAGE_ALIASES = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps: "powershell",
    ps1: "powershell",
    psm1: "powershell",
    pwsh: "powershell",
    yml: "yaml",
    md: "markdown",
    html: "markup",
    xml: "markup",
    htm: "markup",
  };

  const LANGUAGE_LABELS = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    powershell: "PowerShell",
    shell: "Shell",
    yaml: "YAML",
    markdown: "Markdown",
    markup: "HTML",
    css: "CSS",
    sql: "SQL",
    ruby: "Ruby",
    go: "Go",
    rust: "Rust",
    java: "Java",
    kotlin: "Kotlin",
    json: "JSON",
    diff: "Diff",
    patch: "Patch",
    text: "Plain text",
    plaintext: "Plain text",
    plain: "Plain text",
  };
  const EMPTY_TOKENS = new Set();

  const KEYWORDS = {
    javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof let new of package private protected public return set static super switch this throw try typeof undefined var void while with yield true false null NaN Infinity".split(" ")),
    typescript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof let new of package private protected public return set static super switch this throw try typeof undefined var void while with yield true false null NaN Infinity interface type enum namespace declare readonly keyof unknown never any boolean number string".split(" ")),
    python: new Set("and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield".split(" ")),
    powershell: new Set("begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function if in inline param process return switch throw trap try until using var while true false null".split(" ")),
    shell: new Set("if then else elif fi for while in do done case esac function select time until do return export local readonly shift source alias unalias true false".split(" ")),
    sql: new Set("select from where and or not insert into values update set delete create alter drop table view index join inner left right full outer on as group by order having limit offset distinct union all null is like between exists asc desc case when then else end".split(" ")),
    ruby: new Set("BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield".split(" ")),
    go: new Set("break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var".split(" ")),
    rust: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
    java: new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null".split(" ")),
    css: new Set("important".split(" ")),
    markup: new Set("doctype".split(" ")),
  };

  const BUILTINS = {
    javascript: new Set("Array Boolean Date Error JSON Math Number Object Promise RegExp Set String Symbol Map WeakMap console document window fetch Intl parseInt parseFloat".split(" ")),
    typescript: new Set("Array Boolean Date Error JSON Math Number Object Promise RegExp Set String Symbol Map WeakMap console document window fetch".split(" ")),
    python: new Set("abs all any bool dict enumerate filter float input int len list map max min open print range repr set sorted str sum tuple zip self".split(" ")),
    powershell: new Set("New-Item Copy-Item Move-Item Remove-Item Get-Item Set-Item Set-Location Write-Host Write-Output Invoke-Expression Invoke-Command Start-Process ForEach-Object Where-Object Select-Object Out-File Test-Path Get-ChildItem".split(" ")),
    shell: new Set("echo printf read pwd cd mkdir rm cp mv grep sed awk cat find npm node git curl".split(" ")),
    go: new Set("append cap close copy delete len make new panic print println recover".split(" ")),
    rust: new Set("String Vec Option Result Some None Ok Err println format".split(" ")),
  };

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizedLanguage(code) {
    const classes = Array.from(code?.classList || []);
    const languageClass = classes.find((name) => /^(?:language|lang)-/i.test(name));
    const raw = languageClass ? languageClass.replace(/^(?:language|lang)-/i, "") : "";
    return LANGUAGE_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
  }

  function codeLanguageLabel(language) {
    const raw = String(language || "").trim().toLowerCase();
    const normalized = LANGUAGE_ALIASES[raw] || raw;
    return LANGUAGE_LABELS[normalized] || (normalized || "Plain text");
  }

  function tokenSpan(type, value) {
    return `<span class="code-token code-token--${type}">${escapeHtml(value)}</span>`;
  }

  function highlightCode(source, language) {
    const text = String(source || "");
    const rawLanguage = String(language || "").trim().toLowerCase();
    const lang = LANGUAGE_ALIASES[rawLanguage] || rawLanguage;
    const isPlainText = !lang || ["text", "plaintext", "plain"].includes(lang);
    // Unknown fenced languages keep the existing readable JavaScript-like
    // treatment, while an omitted/plain-text fence must remain genuinely
    // plain instead of accidentally coloring words such as `true`.
    const keywords = isPlainText ? EMPTY_TOKENS : (KEYWORDS[lang] || KEYWORDS.javascript);
    const builtins = isPlainText ? EMPTY_TOKENS : (BUILTINS[lang] || BUILTINS.javascript);
    const supportsHashComment = !isPlainText && ["python", "powershell", "shell", "yaml", "ruby", "perl"].includes(lang);
    const supportsSlashComment = !isPlainText && !["powershell", "shell", "yaml", "markdown", "sql"].includes(lang);
    let html = "";
    let index = 0;

    while (index < text.length) {
      const rest = text.slice(index);
      const lineComment = (supportsSlashComment && rest.startsWith("//")) || (supportsHashComment && rest.startsWith("#"));
      if (lineComment) {
        const end = text.indexOf("\n", index);
        const value = end < 0 ? text.slice(index) : text.slice(index, end);
        html += tokenSpan("comment", value);
        index += value.length;
        continue;
      }
      if (supportsSlashComment && rest.startsWith("/*")) {
        const end = text.indexOf("*/", index + 2);
        const value = end < 0 ? text.slice(index) : text.slice(index, end + 2);
        html += tokenSpan("comment", value);
        index += value.length;
        continue;
      }
      const first = text[index];
      if (first === "\"" || first === "'" || (first === "`" && ["javascript", "typescript", "powershell"].includes(lang))) {
        let cursor = index + 1;
        while (cursor < text.length) {
          if (text[cursor] === "\\") {
            cursor += 2;
            continue;
          }
          if (text[cursor] === first) {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        html += tokenSpan("string", text.slice(index, cursor));
        index = cursor;
        continue;
      }
      const number = rest.match(/^(?:0x[\da-f]+|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/i);
      if (number) {
        html += tokenSpan("number", number[0]);
        index += number[0].length;
        continue;
      }
      const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
      if (identifier) {
        const value = identifier[0];
        const type = keywords.has(value) ? "keyword" : builtins.has(value) ? "builtin" : "identifier";
        html += type === "identifier" ? escapeHtml(value) : tokenSpan(type, value);
        index += value.length;
        continue;
      }
      html += escapeHtml(first);
      index += 1;
    }
    return html;
  }

  function svgElement(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function svgText(parent, value, x, y, className = "") {
    const node = svgElement("text", { x, y, class: className, "text-anchor": "middle" });
    node.textContent = String(value || "");
    parent.appendChild(node);
    return node;
  }

  function addArrowMarker(svg, id) {
    const defs = svgElement("defs");
    const marker = svgElement("marker", { id, viewBox: "0 0 10 10", refX: "8", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "mermaid-arrowhead" }));
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  function cleanDiagramLabel(value) {
    return String(value || "").replace(/^\s*[|:]+|[|:]+\s*$/g, "").replace(/<br\s*\/?>/gi, " ").trim();
  }

  function parseFlowNode(raw) {
    const value = String(raw || "").trim();
    const match = value.match(/^([A-Za-z][\w-]*)(?:\s*(\[\[[^\]]*\]\]|\[[^\]]*\]|\{\{[^}]*\}\}|\{[^}]*\}|\(\([^)]*\)\)|\([^)]*\)))?/);
    if (!match) return null;
    const id = match[1];
    const shapeValue = match[2] || "";
    let shape = "round";
    let label = id;
    if (shapeValue) {
      label = shapeValue.slice(1, -1);
      if (shapeValue.startsWith("[[")) shape = "stadium";
      else if (shapeValue.startsWith("{")) shape = "diamond";
      else if (shapeValue.startsWith("(")) shape = "round";
      else shape = "rect";
    }
    return { id, label: cleanDiagramLabel(label), shape, hasExplicitLabel: Boolean(shapeValue) };
  }

  function parseFlowchart(source) {
    const lines = String(source || "").split(/\r?\n/).map((line) => line.replace(/%%.*$/, "").trim()).filter(Boolean);
    const header = lines.shift()?.match(/^(?:flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i);
    if (!header) return null;
    const direction = header[1].toUpperCase();
    const nodes = new Map();
    const edges = [];
    const ensureNode = (raw) => {
      const node = parseFlowNode(raw);
      if (node && !nodes.has(node.id)) nodes.set(node.id, node);
      else if (node?.hasExplicitLabel) Object.assign(nodes.get(node.id), node);
      return node;
    };
    for (const line of lines) {
      const match = line.match(/^(.+?)\s*(-->|---|-.->|==>|--)\s*(?:\|([^|]+)\|\s*)?(.+)$/);
      const foundEdge = Boolean(match);
      if (match) {
        const from = ensureNode(match[1]);
        const to = ensureNode(match[4]);
        if (from && to) edges.push({ from: from.id, to: to.id, label: cleanDiagramLabel(match[3] || ""), dashed: match[2] === "-.->" });
      }
      if (!foundEdge) ensureNode(line);
    }
    if (nodes.size < 1) return null;

    const list = Array.from(nodes.values());
    const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(list.length))));
    const nodeWidth = 150;
    const nodeHeight = 46;
    const gapX = 48;
    const gapY = 60;
    const width = Math.max(360, columns * nodeWidth + (columns + 1) * gapX);
    const rows = Math.ceil(list.length / columns);
    const height = Math.max(150, rows * nodeHeight + (rows + 1) * gapY);
    const positions = new Map();
    list.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      let x = gapX + column * (nodeWidth + gapX) + nodeWidth / 2;
      let y = gapY + row * (nodeHeight + gapY) + nodeHeight / 2;
      if (direction === "RL") x = width - x;
      if (direction === "BT") y = height - y;
      positions.set(node.id, { x, y });
    });

    const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Mermaid flowchart", preserveAspectRatio: "xMinYMin meet" });
    addArrowMarker(svg, "agento-mermaid-arrow");
    const edgeLayer = svgElement("g", { class: "mermaid-edges" });
    for (const edge of edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const line = svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: edge.dashed ? "mermaid-edge mermaid-edge--dashed" : "mermaid-edge", "marker-end": "url(#agento-mermaid-arrow)" });
      edgeLayer.appendChild(line);
      if (edge.label) svgText(edgeLayer, edge.label, (from.x + to.x) / 2, (from.y + to.y) / 2 - 8, "mermaid-edge-label");
    }
    svg.appendChild(edgeLayer);
    const nodeLayer = svgElement("g", { class: "mermaid-nodes" });
    for (const node of list) {
      const position = positions.get(node.id);
      const group = svgElement("g", { class: `mermaid-node mermaid-node--${node.shape}` });
      if (node.shape === "diamond") {
        group.appendChild(svgElement("polygon", { points: `${position.x},${position.y - 28} ${position.x + 78},${position.y} ${position.x},${position.y + 28} ${position.x - 78},${position.y}` }));
      } else {
        group.appendChild(svgElement("rect", { x: position.x - nodeWidth / 2, y: position.y - nodeHeight / 2, width: nodeWidth, height: nodeHeight, rx: node.shape === "round" || node.shape === "stadium" ? 18 : 8 }));
      }
      svgText(group, node.label.slice(0, 30), position.x, position.y + 5, "mermaid-node-label");
      nodeLayer.appendChild(group);
    }
    svg.appendChild(nodeLayer);
    return svg;
  }

  function parseSequence(source) {
    const lines = String(source || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!/^sequenceDiagram\b/i.test(lines.shift() || "")) return null;
    const participants = new Map();
    const messages = [];
    const ensureParticipant = (id, label = id) => {
      const key = String(id || "").trim();
      if (!key) return;
      if (!participants.has(key)) participants.set(key, { id: key, label: String(label || key).trim() });
    };
    for (const line of lines) {
      const participant = line.match(/^(?:participant|actor)\s+([\w-]+)(?:\s+as\s+(.+))?$/i);
      if (participant) {
        ensureParticipant(participant[1], participant[2] || participant[1]);
        continue;
      }
      const note = line.match(/^Note\s+(?:over|left of|right of)\s+([\w-]+)(?:\s*,\s*[\w-]+)?\s*:\s*(.+)$/i);
      if (note) {
        ensureParticipant(note[1]);
        messages.push({ from: note[1], to: note[1], arrow: "note", text: note[2] });
        continue;
      }
      const message = line.match(/^([\w-]+?)(-->>|->>|-->|->x|->|--x|-x)\s*([\w-]+)\s*:\s*(.+)$/);
      if (message) {
        ensureParticipant(message[1]);
        ensureParticipant(message[3]);
        messages.push({ from: message[1], to: message[3], arrow: message[2], text: message[4] });
      }
    }
    if (participants.size < 1 || messages.length < 1) return null;
    const participantList = Array.from(participants.values());
    // Spread participants across a bounded span so the diagram does not
    // downscale its text on narrow surfaces: 2–3 participants stay at ~1:1
    // scale on a 360px viewport; wider casts fall back to horizontal scroll.
    const xGap = Math.max(130, Math.floor(300 / Math.max(1, participantList.length - 1)));
    const left = 86;
    const width = Math.min(760, Math.max(360, left * 2 + (participantList.length - 1) * xGap));
    const rowHeight = 58;
    const headerHeight = 74;
    const height = headerHeight + messages.length * rowHeight + 30;
    const xById = new Map(participantList.map((participant, index) => [participant.id, left + index * xGap]));
    const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Mermaid sequence diagram", preserveAspectRatio: "xMinYMin meet" });
    addArrowMarker(svg, "agento-mermaid-sequence-arrow");
    const lifelineLayer = svgElement("g", { class: "mermaid-lifelines" });
    for (const participant of participantList) {
      const x = xById.get(participant.id);
      const header = svgElement("rect", { x: x - 62, y: 12, width: 124, height: 34, rx: 12, class: "mermaid-sequence-participant" });
      lifelineLayer.appendChild(header);
      svgText(lifelineLayer, participant.label.slice(0, 18), x, 34, "mermaid-sequence-label");
      lifelineLayer.appendChild(svgElement("line", { x1: x, y1: 46, x2: x, y2: height - 16, class: "mermaid-lifeline" }));
    }
    svg.appendChild(lifelineLayer);
    const messageLayer = svgElement("g", { class: "mermaid-messages" });
    messages.forEach((message, index) => {
      const y = headerHeight + index * rowHeight;
      if (message.arrow === "note") {
        const x = xById.get(message.from);
        messageLayer.appendChild(svgElement("rect", { x: x - 70, y: y - 18, width: 140, height: 36, rx: 10, class: "mermaid-note" }));
        svgText(messageLayer, message.text.slice(0, 23), x, y + 4, "mermaid-note-label");
        return;
      }
      const x1 = xById.get(message.from);
      const x2 = xById.get(message.to);
      if (!Number.isFinite(x1) || !Number.isFinite(x2)) return;
      const line = svgElement("line", { x1, y1: y, x2, y2: y, class: message.arrow.startsWith("--") ? "mermaid-message mermaid-message--dashed" : "mermaid-message", "marker-end": "url(#agento-mermaid-sequence-arrow)" });
      messageLayer.appendChild(line);
      svgText(messageLayer, message.text.slice(0, 32), (x1 + x2) / 2, y - 8, "mermaid-message-label");
    });
    svg.appendChild(messageLayer);
    return svg;
  }

  function renderMermaidBlock(code, wrapper) {
    const source = String(code?.textContent || "").trim();
    const firstLine = source.split(/\r?\n/, 1)[0].trim();
    const language = normalizedLanguage(code);
    const isMermaid = MERMAID_LANGUAGES.has(language) || /^(?:flowchart|graph|sequenceDiagram)\b/i.test(firstLine);
    if (!isMermaid || wrapper.querySelector(".mermaid-diagram")) return false;
    const svg = /^sequenceDiagram\b/i.test(firstLine) ? parseSequence(source) : parseFlowchart(source);
    if (!svg) return false;
    const diagram = document.createElement("div");
    diagram.className = "mermaid-diagram";
    diagram.setAttribute("aria-label", "Rendered Mermaid diagram");
    diagram.setAttribute("translate", "no");
    diagram.appendChild(svg);
    wrapper.classList.add("code-block-wrap--diagram");
    // Keep the language/copy rail at the top of the shared code surface;
    // Mermaid's rendered content belongs immediately below that rail.
    wrapper.insertBefore(diagram, code.parentElement);
    code.classList.add("mermaid-source");
    code.dataset.highlighted = "true";
    code.parentElement?.setAttribute("aria-hidden", "true");
    return true;
  }

  function enhanceColorChips(rootNode) {
    if (!rootNode?.querySelectorAll) return;
    const hexPattern = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;
    const targets = rootNode.querySelectorAll("code, td, p, li");
    for (const el of targets) {
      if (el.dataset.colorEnhanced === "true" || el.querySelector(".color-chip") || el.closest("pre")) continue;
      const text = el.textContent || "";
      if (hexPattern.test(text)) {
        el.dataset.colorEnhanced = "true";
        el.innerHTML = el.innerHTML.replace(/(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)/g, (match) => {
          return `${match} <span class="color-chip" style="background-color:${match}" aria-hidden="true"></span>`;
        });
      }
    }
  }

  function enhanceCodeBlocks(rootNode) {
    if (!rootNode?.querySelectorAll) return;
    for (const code of rootNode.querySelectorAll("pre > code")) {
      if (code.dataset.highlighted === "true" || code.classList.contains("mermaid-source")) continue;
      const language = normalizedLanguage(code);
      if (MERMAID_LANGUAGES.has(language)) continue;
      code.setAttribute("translate", "no");
      code.innerHTML = highlightCode(code.textContent || "", language);
      code.dataset.highlighted = "true";
    }
    for (const code of rootNode.querySelectorAll("pre > code")) {
      const wrapper = code.parentElement?.parentElement;
      if (wrapper?.classList.contains("code-block-wrap")) renderMermaidBlock(code, wrapper);
    }
    enhanceColorChips(rootNode);
  }

  root.RagentMarkdownEnhancements = {
    enhanceCodeBlocks,
    enhanceColorChips,
    highlightCode,
    renderMermaidBlock,
    codeLanguageLabel,
  };
})(window);
