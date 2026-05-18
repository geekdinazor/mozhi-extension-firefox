"use strict";

const DEFAULTS = {
  engine: "google",
  source: "auto",
  target: "en",
  rememberLastUsed: false,
  lastEngine: "",
  lastSource: "",
  lastTarget: ""
};

const inputEl = document.getElementById("input");
const outEl = document.getElementById("output");
const metaEl = document.getElementById("meta");
const engineEl = document.getElementById("engine");
const sourceEl = document.getElementById("source");
const targetEl = document.getElementById("target");
const swapBtn = document.getElementById("swap");

document.getElementById("translate").addEventListener("click", run);
document.getElementById("open-options").addEventListener("click", () => browser.runtime.openOptionsPage());
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
});
engineEl.addEventListener("change", () => loadLanguages(engineEl.value, sourceEl.value, targetEl.value));
swapBtn.addEventListener("click", () => {
  if (sourceEl.value === "auto") return;
  const a = sourceEl.value, b = targetEl.value;
  sourceEl.value = b; targetEl.value = a;
});

function normalizeLangs(payload) {
  if (Array.isArray(payload)) {
    return payload.map(item => ({
      id: item.Id || item.id || item.code || item.value || "",
      name: item.Name || item.name || item.label || ""
    })).filter(x => x.id);
  }
  if (payload && typeof payload === "object") {
    return Object.entries(payload).map(([id, name]) => ({ id, name: String(name) }));
  }
  return [];
}

function hasOption(el, value) {
  return Array.from(el.options).some(o => o.value === value);
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
    if (hasOption(el, c)) { el.value = c; return; }
  }
  if (el.options.length > 0) el.value = el.options[0].value;
}

async function loadLanguages(engine, preferredSource, preferredTarget) {
  if (!engine) return;
  try {
    const [src, tgt] = await Promise.all([
      browser.runtime.sendMessage({ type: "mozhi:languages", kind: "source", engine }),
      browser.runtime.sendMessage({ type: "mozhi:languages", kind: "target", engine })
    ]);
    fillSelect(sourceEl, normalizeLangs(src), preferredSource || sourceEl.value, true, ["auto", "en"]);
    fillSelect(targetEl, normalizeLangs(tgt), preferredTarget || targetEl.value, false, ["en"]);
  } catch (_) { /* leave selects with whatever was there */ }
}

async function run() {
  const text = inputEl.value.trim();
  if (!text) return;
  outEl.hidden = false;
  outEl.classList.remove("err");
  outEl.textContent = "Translating…";
  metaEl.textContent = "";
  const opts = { engine: engineEl.value, source: sourceEl.value, target: targetEl.value };
  try {
    const result = await browser.runtime.sendMessage({ type: "mozhi:translate", text, opts });
    if (!result.translated) {
      outEl.classList.add("err");
      outEl.textContent = `Engine "${result.engine || "?"}" returned no translation. Try another engine. This Mozhi instance may not have credentials configured for it.`;
    } else {
      outEl.textContent = result.translated;
    }
    const parts = [];
    if (result.detected) parts.push(`detected: ${result.detected}`);
    parts.push(`${result.source} → ${result.target}`);
    if (result.engine) parts.push(`engine: ${result.engine}`);
    metaEl.textContent = parts.join(" · ");
    if (result.translated) {
      await browser.storage.local.set({
        lastEngine: opts.engine,
        lastSource: opts.source,
        lastTarget: opts.target
      });
    }
  } catch (err) {
    outEl.classList.add("err");
    outEl.textContent = String(err.message || err);
  }
}

(async function init() {
  const stored = await browser.storage.local.get(DEFAULTS);
  const cur = Object.assign({}, DEFAULTS, stored);
  const useLast = !!cur.rememberLastUsed;
  const initialEngine = useLast && cur.lastEngine ? cur.lastEngine : cur.engine;
  const initialSource = useLast && cur.lastSource ? cur.lastSource : cur.source;
  const initialTarget = useLast && cur.lastTarget ? cur.lastTarget : cur.target;

  fillSelect(engineEl, [], initialEngine, false);
  fillSelect(sourceEl, [], initialSource, true);
  fillSelect(targetEl, [], initialTarget, false);

  try {
    const engines = await browser.runtime.sendMessage({ type: "mozhi:engines" });
    const engineList = engines && typeof engines === "object"
      ? Object.entries(engines).map(([id, name]) => ({ id, name: String(name) }))
      : [];
    fillSelect(engineEl, engineList, initialEngine, false);
    await loadLanguages(engineEl.value, initialSource, initialTarget);
  } catch (_) { /* offline / no endpoint configured; selects keep saved values */ }

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const results = await browser.tabs.executeScript(tab.id, {
      code: "window.getSelection ? String(window.getSelection()) : ''"
    }).catch(() => null);
    if (results && results[0]) inputEl.value = results[0];
  } catch (_) { /* not allowed on this page */ }
})();
