"use strict";

(function () {
  if (window.__mozhiInjected) {
    return;
  }
  window.__mozhiInjected = true;

  let host = null;
  let shadow = null;
  let lastText = "";
  let enginesCache = null;
  let langsCache = {};
  let buttonHost = null;
  let buttonShadow = null;
  let pendingSelection = "";
  let pendingBlocks = null;
  let showButtonEnabled = true;

  const BLOCK_TAGS = new Set([
    "li", "p", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "figcaption", "dt", "dd"
  ]);

  // -----------------------------------------------------------------------
  // Range & block helpers
  // -----------------------------------------------------------------------
  function getTextInRange(node, range) {
    try {
      const r = document.createRange();
      r.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) {
        r.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) {
        r.setEnd(range.endContainer, range.endOffset);
      }
      return r.toString();
    } catch (_) {
      return node.textContent || "";
    }
  }

  function buildBlocks() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      return null;
    }
    const range = sel.getRangeAt(0);
    const ca = range.commonAncestorContainer;
    const root = ca && ca.nodeType === 3 ? ca.parentNode : ca;
    if (!root || root.nodeType !== 1) {
      return null;
    }

    const blocks = [];
    function walk(node) {
      if (!node || node.nodeType !== 1) {
        return;
      }
      try {
        if (!range.intersectsNode(node)) {
          return;
        }
      } catch (_) {
        return;
      }
      const tag = node.nodeName.toLowerCase();

      if (tag === "li") {
        const parent = node.parentNode;
        const ptag = parent && parent.nodeName ? parent.nodeName.toLowerCase() : "";
        const listType = ptag === "ol" ? "ol" : "ul";
        const text = getTextInRange(node, range).replace(/\s+/g, " ").trim();
        if (text) {
          blocks.push({ type: "li", listType, text });
        }
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        const text = getTextInRange(node, range).replace(/\s+/g, " ").trim();
        if (text) {
          blocks.push({ type: "heading", text });
        }
        return;
      }
      if (BLOCK_TAGS.has(tag)) {
        const text = getTextInRange(node, range).trim();
        if (text) {
          blocks.push({ type: "para", text });
        }
        return;
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    }
    walk(root);
    return blocks;
  }

  // preparePayload: turns detected blocks into a clean text payload for the API
  function preparePayload(blocks) {
    const lines = [];
    let prevType = null;
    let counter = 0;
    for (const b of blocks) {
      // Add newline between different block types (list <-> paragraph)
      if (prevType && prevType !== b.type) {
        lines.push("");
      }
      if (b.type === "li") {
        if (b.listType === "ol") {
          if (!prevType || prevType !== "li" || b.listType !== "ol") {
            counter = 1;
          } else {
            counter++;
          }
          lines.push(`${counter}. ${b.text}`);
        } else {
          lines.push(`* ${b.text}`);
        }
      } else {
        lines.push(b.text);
        counter = 0;
      }
      prevType = b.type;
    }
    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Translation box (shadow DOM)
  // -----------------------------------------------------------------------
  function ensureBox() {
    if (host && document.body.contains(host)) {
      return;
    }
    host = document.createElement("div");
    host.id = "mozhi-translate-host";
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .box {
        position: fixed;
        max-width: 420px;
        min-width: 280px;
        background: #1f2937;
        color: #f9fafb;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        padding: 10px 12px 12px;
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; cursor: move; user-select: none; touch-action: none; }
      .dragging { opacity: 0.95; }
      .title { font-weight: 600; font-size: 12px; opacity: 0.85; }
      .close {
        cursor: pointer; background: transparent; color: inherit; border: 0;
        font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px;
      }
      .close:hover { background: rgba(255,255,255,0.1); }
      .selectors { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .selectors select {
        background: rgba(255,255,255,0.08);
        color: #f9fafb;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px;
        padding: 4px 6px;
        font: inherit;
        max-width: 100%;
      }
      .selectors select option { color: #111827; background: #ffffff; }
      .lang-row { display: flex; gap: 6px; align-items: center; }
      .lang-row select { flex: 1; min-width: 0; }
      .swap {
        background: rgba(255,255,255,0.06);
        color: #f9fafb;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
        font: inherit;
      }
      .swap:hover { background: rgba(255,255,255,0.14); }
      .swap:disabled { opacity: 0.4; cursor: not-allowed; }
      .body { white-space: pre-wrap; word-wrap: break-word; max-height: 60vh; overflow-y: auto; overscroll-behavior: contain; }
      .body::-webkit-scrollbar { width: 8px; }
      .body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }
      .meta { margin-top: 8px; font-size: 11px; opacity: 0.7; }
      .err { color: #fca5a5; }
      .spinner {
        display: inline-block; width: 12px; height: 12px;
        border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
        border-radius: 50%; animation: mz-spin 0.8s linear infinite;
        vertical-align: middle; margin-right: 6px;
      }
      @keyframes mz-spin { to { transform: rotate(360deg); } }
    `;
    shadow.appendChild(style);

    const box = document.createElement("div");
    box.className = "box";
    box.innerHTML = `
      <div class="head">
        <span class="title">Mozhi Translate Unofficial</span>
        <button class="close" aria-label="Close">×</button>
      </div>
      <div class="selectors">
        <select class="engine" title="Engine"></select>
        <div class="lang-row">
          <select class="source" title="Source language"></select>
          <button class="swap" title="Swap languages" type="button">⇄</button>
          <select class="target" title="Target language"></select>
        </div>
      </div>
      <div class="body"></div>
      <div class="meta"></div>
    `;
    shadow.appendChild(box);

    box.querySelector(".close").addEventListener("click", hide);
    enableDrag(box, box.querySelector(".head"));
    const engineSel = box.querySelector(".engine");
    const sourceSel = box.querySelector(".source");
    const targetSel = box.querySelector(".target");
    const swapBtn = box.querySelector(".swap");

    engineSel.addEventListener("change", async () => {
      await loadLanguagesInto(engineSel.value, sourceSel.value, targetSel.value);
      retranslate();
    });
    sourceSel.addEventListener("change", retranslate);
    targetSel.addEventListener("change", retranslate);
    swapBtn.addEventListener("click", () => {
      if (sourceSel.value === "auto") {
        return;
      }
      const a = sourceSel.value, b = targetSel.value;
      sourceSel.value = b; targetSel.value = a;
      retranslate();
    });

    document.body.appendChild(host);
    positionBox(box);
    initSelectors().catch(() => {});
  }

  function enableDrag(box, handle) {
    let dragging = false, startX = 0, startY = 0, startTop = 0, startLeft = 0;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") {
        return;
      }
      if (e.target.closest(".close")) {
        return;
      }
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = box.getBoundingClientRect();
      startTop = rect.top; startLeft = rect.left;
      box.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) {
        return;
      }
      const dx = e.clientX - startX, dy = e.clientY - startY;
      const w = box.offsetWidth, h = box.offsetHeight;
      const top = Math.max(0, Math.min(window.innerHeight - h, startTop + dy));
      const left = Math.max(0, Math.min(window.innerWidth - w, startLeft + dx));
      box.style.top = `${top}px`;
      box.style.left = `${left}px`;
    });
    const stop = (e) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      box.classList.remove("dragging");
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function positionBox(box) {
    const sel = window.getSelection();
    let top = 80, left = 80;
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        top = Math.min(window.innerHeight - 240, Math.max(8, rect.bottom + 8));
        left = Math.min(window.innerWidth - 440, Math.max(8, rect.left));
      }
    }
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
  }

  function show() {
    ensureBox();
    host.style.display = "block";
  }

  function hide() {
    if (host) {
      host.style.display = "none";
    }
  }

  // -----------------------------------------------------------------------
  // Select & option helpers (for the box)
  // -----------------------------------------------------------------------
  function hasOption(el, value) {
    return Array.from(el.options).some((o) => o.value === value);
  }

  function fillSelect(el, items, selected, _unusedWithAuto, fallbacks = []) {
    el.innerHTML = "";
    items.forEach(({ id, name }) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name ? `${name} (${id})` : id;
      el.appendChild(opt);
    });
    const candidates = [selected, ...fallbacks].filter(Boolean);
    for (const c of candidates) {
      if (hasOption(el, c)) {
        el.value = c;
        return;
      }
    }
    if (el.options.length > 0) {
      el.value = el.options[0].value;
    }
  }

  function normalizeLangs(payload) {
    if (Array.isArray(payload)) {
      return payload.map((item) => ({
        id: item.Id || item.id || item.code || item.value || "",
        name: item.Name || item.name || item.label || ""
      })).filter((x) => x.id);
    }
    if (payload && typeof payload === "object") {
      return Object.entries(payload).map(([id, name]) => ({ id, name: String(name) }));
    }
    return [];
  }

  async function loadEnginesInto(selected) {
    const sel = shadow.querySelector(".engine");
    if (!enginesCache) {
      try {
        enginesCache = await browser.runtime.sendMessage({ type: "mozhi:engines" });
      } catch (_) {
        enginesCache = {};
      }
    }
    const items = enginesCache && typeof enginesCache === "object"
      ? Object.entries(enginesCache).map(([id, name]) => ({ id, name: String(name) }))
      : [];
    fillSelect(sel, items, selected, false);
    if (!sel.value && items[0]) {
      sel.value = items[0].id;
    }
  }

  async function loadLanguagesInto(engine, preferredSource, preferredTarget) {
    const srcSel = shadow.querySelector(".source");
    const tgtSel = shadow.querySelector(".target");
    if (!engine) {
      return;
    }
    if (!langsCache[engine]) {
      try {
        const [src, tgt] = await Promise.all([
          browser.runtime.sendMessage({ type: "mozhi:languages", kind: "source", engine }),
          browser.runtime.sendMessage({ type: "mozhi:languages", kind: "target", engine })
        ]);
        langsCache[engine] = { source: normalizeLangs(src), target: normalizeLangs(tgt) };
      } catch (_) {
        langsCache[engine] = { source: [], target: [] };
      }
    }
    const { source, target } = langsCache[engine];
    fillSelect(srcSel, source, preferredSource || srcSel.value, true, ["auto", "en"]);
    fillSelect(tgtSel, target, preferredTarget || tgtSel.value, false, ["en"]);
  }

  async function initSelectors(seed) {
    const stored = await browser.storage.local.get({ engine: "google", source: "auto", target: "en" });
    const engine = (seed && seed.engine) || stored.engine;
    const source = (seed && seed.source) || stored.source;
    const target = (seed && seed.target) || stored.target;
    await loadEnginesInto(engine);
    const engineSel = shadow.querySelector(".engine");
    await loadLanguagesInto(engineSel.value, source, target);
  }

  // -----------------------------------------------------------------------
  // Translation flow (from the box)
  // -----------------------------------------------------------------------
  async function retranslate() {
    if (!lastText) {
      return;
    }
    const engine = shadow.querySelector(".engine").value;
    const source = shadow.querySelector(".source").value;
    const target = shadow.querySelector(".target").value;
    setLoading(lastText);
    try {
      const result = await browser.runtime.sendMessage({
        type: "mozhi:translate", text: lastText, opts: { engine, source, target }
      });
      setResult(result);
      browser.storage.local.set({ engine, source, target }).catch(() => {});
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  function setLoading(text) {
    show();
    lastText = text;
    const body = shadow.querySelector(".body");
    const meta = shadow.querySelector(".meta");
    body.classList.remove("err");
    body.innerHTML = `<span class="spinner"></span>Translating…`;
    meta.textContent = text.length > 80 ? `“${text.slice(0, 80)}…”` : `“${text}”`;
  }

  function setResult(result) {
    show();
    const body = shadow.querySelector(".body");
    const meta = shadow.querySelector(".meta");
    if (!result.translated) {
      body.classList.add("err");
      body.textContent = `Engine "${result.engine || "?"}" returned no translation. Try another engine. This Mozhi instance may not have credentials configured for it.`;
    } else {
      body.classList.remove("err");
      body.textContent = result.translated;
    }
    const parts = [];
    if (result.detected) {
      parts.push(`detected: ${result.detected}`);
    }
    parts.push(`${result.source} → ${result.target}`);
    if (result.engine) {
      parts.push(`engine: ${result.engine}`);
    }
    meta.textContent = parts.join(" · ");
  }

  function setError(message) {
    show();
    const body = shadow.querySelector(".body");
    const meta = shadow.querySelector(".meta");
    body.classList.add("err");
    body.textContent = message;
    meta.textContent = "Mozhi Translate Unofficial error";
  }

  async function triggerTranslate(text) {
    setLoading(text);
    try {
      await initSelectors();
      const engineSel = shadow.querySelector(".engine");
      const sourceSel = shadow.querySelector(".source");
      const targetSel = shadow.querySelector(".target");
      const opts = {
        engine: engineSel.value || undefined,
        source: sourceSel.value || undefined,
        target: targetSel.value || undefined,
      };
      const result = await browser.runtime.sendMessage({ type: "mozhi:translate", text, opts });
      setResult(result);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  // -----------------------------------------------------------------------
  // Floating translate button (shown near selection)
  // -----------------------------------------------------------------------
  function ensureButton() {
    if (buttonHost && document.body.contains(buttonHost)) {
      return;
    }
    buttonHost = document.createElement("div");
    buttonHost.id = "mozhi-translate-btn-host";
    buttonHost.style.all = "initial";
    buttonHost.style.position = "fixed";
    buttonHost.style.zIndex = "2147483647";
    buttonHost.style.top = "0";
    buttonHost.style.left = "0";
    buttonHost.style.width = "0";
    buttonHost.style.height = "0";
    buttonHost.style.display = "none";
    buttonShadow = buttonHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .btn {
        position: fixed;
        width: 30px; height: 30px;
        background: linear-gradient(135deg, #ff9933, #f57c00);
        color: #fff;
        border: 0;
        border-radius: 50%;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        padding: 0;
        transition: transform 0.1s ease;
      }
      .btn:hover { transform: scale(1.08); }
      .btn:active { transform: scale(0.94); }
      .btn svg { width: 18px; height: 18px; display: block; }
    `;
    buttonShadow.appendChild(style);

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.title = "Translate with Mozhi";
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.5 17.5 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const blocks = pendingBlocks;
      const text = pendingSelection;
      hideButton();
      if (blocks && blocks.length > 0) {
        triggerTranslate(preparePayload(blocks));
      } else if (text) {
        triggerTranslate(text);
      }
    });
    buttonShadow.appendChild(btn);

    document.body.appendChild(buttonHost);
  }

  function showButtonNearSelection() {
    if (!showButtonEnabled) {
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideButton();
      return;
    }
    const text = String(sel).trim();
    if (!text) {
      hideButton();
      return;
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      hideButton();
      return;
    }

    pendingSelection = text;
    pendingBlocks = buildBlocks();
    ensureButton();
    buttonHost.style.display = "block";
    const btn = buttonShadow.querySelector(".btn");
    const top = Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 6));
    const left = Math.min(window.innerWidth - 38, Math.max(8, rect.right - 8));
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
  }

  function hideButton() {
    if (buttonHost) {
      buttonHost.style.display = "none";
    }
    pendingSelection = "";
  }

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------
  document.addEventListener("mouseup", () => {
    setTimeout(showButtonNearSelection, 1);
  });
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideButton();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hide();
      hideButton();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (buttonHost && e.target === buttonHost) {
      return;
    }
    hideButton();
    if (!host) {
      return;
    }
    if (e.target === host) {
      return;
    }
    if (host.style.display === "none") {
      return;
    }
    hide();
  }, true);

  // -----------------------------------------------------------------------
  // Settings & messaging
  // -----------------------------------------------------------------------
  browser.storage.local.get({ showSelectionButton: true }).then((s) => {
    showButtonEnabled = s.showSelectionButton !== false;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.showSelectionButton) {
      showButtonEnabled = changes.showSelectionButton.newValue !== false;
      if (!showButtonEnabled) {
        hideButton();
      }
    }
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) {
      return;
    }
    switch (msg.type) {
      case "mozhi:loading":
        setLoading(msg.text || "");
        break;
      case "mozhi:result":
        setResult(msg.result || {});
        break;
      case "mozhi:error":
        setError(msg.message || "Unknown error");
        break;
      case "mozhi:getStructured":
        var blocks = buildBlocks();
        if (!blocks || blocks.length === 0) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          payload: preparePayload(blocks),
          count: blocks.length
        });
    }
  });
})();
