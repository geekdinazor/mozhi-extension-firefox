"use strict";

// ---------------------------------------------------------------------------
// Default preferences (first run)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  apis: [{ url: "https://mozhi.aryak.me", enabled: true }],
  engine: "google",
  source: "auto",
  target: "en",
  showSelectionButton: true,
  rememberLastUsed: false,
};

const $ = (sel) => document.querySelector(sel); // jQuery style query selector syntax
const listEl = $("#api-list");
const newUrlEl = $("#new-api-url");
const engineEl = $("#engine");
const sourceEl = $("#source");
const targetEl = $("#target");
const statusEl = $("#status");
const selBtnEl = $("#show-selection-button");
const rememberEl = $("#remember-last-used");

// Deep clone defaults so we don't mutate the original object.
// We work on this local copy and only write back to storage when the user saves.
let state = JSON.parse(JSON.stringify(DEFAULTS));

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
// Redraw the API list in the UI
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function buildRemoveIcon() {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: "16",
    height: "16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  svg.appendChild(svgEl("polyline", { points: "3 6 5 6 21 6" }));
  svg.appendChild(svgEl("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }));
  svg.appendChild(svgEl("path", { d: "M10 11v6" }));
  svg.appendChild(svgEl("path", { d: "M14 11v6" }));
  svg.appendChild(svgEl("path", { d: "M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" }));
  return svg;
}

function renderList() {
  listEl.textContent = "";
  state.apis.forEach((api, idx) => {
    const li = document.createElement("li");
    li.className = "api-item";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "toggle";
    toggleLabel.title = "Enable / disable";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = !!api.enabled;
    toggleInput.dataset.idx = idx;
    toggleInput.dataset.field = "enabled";
    const slider = document.createElement("span");
    slider.className = "slider";
    toggleLabel.append(toggleInput, slider);

    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.value = api.url || "";
    urlInput.dataset.idx = idx;
    urlInput.dataset.field = "url";
    urlInput.placeholder = "https://mozhi.example.com";

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.title = "Remove";
    removeBtn.dataset.idx = idx;
    removeBtn.setAttribute("aria-label", "Remove");
    removeBtn.appendChild(buildRemoveIcon());

    li.append(toggleLabel, urlInput, removeBtn);
    listEl.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// API list event handlers
// ---------------------------------------------------------------------------
// Live updates while the user types in the API list
listEl.addEventListener("input", (e) => {
  const t = e.target;
  const idx = parseInt(t.dataset.idx, 10);
  if (Number.isNaN(idx)) {
    return;
  }
  if (t.dataset.field === "url") {
    state.apis[idx].url = t.value.trim().replace(/\/+$/, "");
    schedulePersist();
  }
  if (t.dataset.field === "enabled") {
    state.apis[idx].enabled = t.checked;
    persist();
  }
});

// Handle remove button clicks in the API list
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove");
  if (!btn) {
    return;
  }
  const idx = parseInt(btn.dataset.idx, 10);
  if (Number.isNaN(idx)) {
    return;
  }
  state.apis.splice(idx, 1);
  renderList();
  persist();
});

// Add a new API endpoint from the input field
$("#add-api").addEventListener("click", () => {
  const url = newUrlEl.value.trim();
  if (!url) {
    return;
  }
  state.apis.push({ url, enabled: true });
  newUrlEl.value = "";
  renderList();
  persist();
});

// ---------------------------------------------------------------------------
// Engine & language controls
// ---------------------------------------------------------------------------
// Manual reload button for engine and language lists
$("#reload-engines").addEventListener("click", () => {
  loadEnginesAndLanguages(true);
});

// Clear the background translation cache
$("#clear-cache").addEventListener("click", async () => {
  try {
    const res = await browser.runtime.sendMessage({ type: "mozhi:clearCache" });
    const n = res && typeof res.cleared === "number" ? res.cleared : 0;
    setStatus(
      n > 0
        ? `Cleared ${n} cached translation${n === 1 ? "" : "s"}.`
        : "Cache was already empty.",
      false,
    );
    refreshCacheCount();
  } catch (err) {
    setStatus(`Could not clear cache: ${err.message || err}`, true);
  }
});

// Update the cache size indicator in the UI
async function refreshCacheCount() {
  const el = $("#cache-count");
  if (!el) {
    return;
  }
  try {
    const res = await browser.runtime.sendMessage({ type: "mozhi:cacheStats" });
    el.textContent =
      res && typeof res.size === "number" ? String(res.size) : "0";
  } catch (_) {
    el.textContent = "0";
  }
}

// ---------------------------------------------------------------------------
// Persistence (debounced save)
// ---------------------------------------------------------------------------
// Debounced save: waits a bit before writing to storage
let persistTimer = null;
async function persist({ silent = false } = {}) {
  const snapshot = {
    apis: state.apis.filter((a) => a.url),
    engine: engineEl.value || state.engine,
    source: sourceEl.value || state.source,
    target: targetEl.value || state.target,
    showSelectionButton: !!selBtnEl.checked,
    rememberLastUsed: !!rememberEl.checked,
  };
  Object.assign(state, snapshot);
  try {
    await browser.storage.local.set(snapshot);
    if (!silent) {
      setStatus("Saved.", false);
    }
  } catch (err) {
    setStatus(`Could not save: ${err.message || err}`, true);
  }
}

// Queue a save that fires after the user stops typing
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", !!isError);
  if (msg) {
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2500);
  }
}

// ---------------------------------------------------------------------------
// Select helpers
// ---------------------------------------------------------------------------
function hasOption(el, value) {
  return Array.from(el.options).some((o) => o.value === value);
}

// Populate a <select> element with options and pick the right selected value.
// We try the user's saved preference first, then any fallbacks
// (like "auto" or "en"), and finally just pick the first option.
// The _unusedWithAuto param is left over from an earlier version.
function fillSelect(el, items, selected, _unusedWithAuto, fallbacks = []) {
  el.textContent = "";
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

// Normalize whatever the API returns into a simple {id, name} list.
// The Mozhi API can return an array of objects, or sometimes
// an object mapping codes to names. We handle both so the UI
// doesn't break if the API response format changes slightly.
function normalizeLangs(payload) {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => ({
        id: item.Id || item.id || item.code || item.value || "",
        name: item.Name || item.name || item.label || "",
      }))
      .filter((x) => x.id);
  }
  if (payload && typeof payload === "object") {
    return Object.entries(payload).map(([id, name]) => ({
      id,
      name: String(name),
    }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Engine & language loading
// ---------------------------------------------------------------------------
// Fetch the list of available engines and then load language lists
// for the currently selected engine. This runs on init and when
// the user manually reloads or switches engines.
// The "force" flag controls whether we show a success message.
async function loadEnginesAndLanguages(force) {
  try {
    const engines = await browser.runtime.sendMessage({
      type: "mozhi:engines",
    });
    const engineList =
      engines && typeof engines === "object"
        ? Object.entries(engines).map(([id, name]) => ({
            id,
            name: String(name),
          }))
        : [];
    fillSelect(engineEl, engineList, state.engine, false);

    const engineToUse =
      engineEl.value || state.engine || (engineList[0] && engineList[0].id);
    if (!engineToUse) {
      return;
    }
    engineEl.value = engineToUse;

    const [src, tgt] = await Promise.all([
      browser.runtime.sendMessage({
        type: "mozhi:languages",
        kind: "source",
        engine: engineToUse,
      }),
      browser.runtime.sendMessage({
        type: "mozhi:languages",
        kind: "target",
        engine: engineToUse,
      }),
    ]);
    fillSelect(sourceEl, normalizeLangs(src), state.source, true, [
      "auto",
      "en",
    ]);
    fillSelect(targetEl, normalizeLangs(tgt), state.target, false, ["en"]);
    if (force) {
      setStatus("Reloaded.", false);
    }
  } catch (err) {
    setStatus(`Could not load lists: ${err.message || err}`, true);
  }
}

engineEl.addEventListener("change", () => {
  state.engine = engineEl.value || state.engine;
  persist();
  loadEnginesAndLanguages(false);
});
sourceEl.addEventListener("change", () => {
  state.source = sourceEl.value || state.source;
  persist();
});
targetEl.addEventListener("change", () => {
  state.target = targetEl.value || state.target;
  persist();
});
selBtnEl.addEventListener("change", persist);
rememberEl.addEventListener("change", persist);

// ---------------------------------------------------------------------------
// Init: load settings, apply to UI, fetch engine/language lists
// ---------------------------------------------------------------------------
(async function init() {
  const stored = await browser.storage.local.get(DEFAULTS);
  state = Object.assign({}, DEFAULTS, stored);
  if (!Array.isArray(state.apis) || state.apis.length === 0) {
    state.apis = DEFAULTS.apis;
  }
  selBtnEl.checked = state.showSelectionButton !== false;
  rememberEl.checked = !!state.rememberLastUsed;
  renderList();
  fillSelect(engineEl, [], state.engine, false);
  fillSelect(sourceEl, [], state.source, true);
  fillSelect(targetEl, [], state.target, false);
  loadEnginesAndLanguages(false);
  refreshCacheCount();
})();
