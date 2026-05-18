"use strict";

// ---------------------------------------------------------------------------
// Default settings (used when storage is empty)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  apis: [{ url: "https://mozhi.aryak.me", enabled: true }],
  engine: "google",
  source: "auto",
  target: "en",
};

// ---------------------------------------------------------------------------
// Simple in-memory translation cache (LRU-ish, 30 min TTL, max 100 items)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 100;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) {
    return null;
  }
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // move to end to approximate LRU
  cache.delete(key);
  cache.set(key, hit);
  return hit.v;
}

function cacheSet(key, value) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, { t: Date.now(), v: value });
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  if (!Array.isArray(stored.apis) || stored.apis.length === 0) {
    stored.apis = DEFAULT_SETTINGS.apis;
  }
  return stored;
}

function pickApi(apis) {
  const enabled = apis.filter((a) => a && a.enabled && a.url);
  if (enabled.length === 0) {
    return null;
  }
  const idx = Math.floor(Math.random() * enabled.length);
  return enabled[idx].url;
}

// ---------------------------------------------------------------------------
// Translation core
// ---------------------------------------------------------------------------
async function translate(text, opts = {}) {
  const settings = await getSettings();
  const base = pickApi(settings.apis);
  if (!base) {
    throw new Error("No enabled Mozhi API endpoint configured. Open the addon options.");
  }

  const engine = opts.engine || settings.engine;
  const source = opts.source || settings.source;
  const target = opts.target || settings.target;

  const cacheKey = `${base}|${engine}|${source}|${target}|${text}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const params = new URLSearchParams({ engine, from: source, to: target, text });
  const url = `${base}/api/translate?${params.toString()}`;

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(`Mozhi API request failed at ${base}: ${err.message || err}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mozhi API ${res.status} at ${base}: ${body || res.statusText}`);
  }

  const data = await res.json();
  const raw = data["translated-text"] || data.translated || "";
  const result = {
    translated: raw,
    rawTranslated: raw,
    detected: data.detected || "",
    source,
    target,
    engine,
    endpoint: base,
  };

  if (result.translated) {
    cacheSet(cacheKey, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Engine & language list fetchers
// ---------------------------------------------------------------------------
async function fetchEngines(baseOverride) {
  const settings = await getSettings();
  const base = baseOverride || pickApi(settings.apis);
  if (!base) {
    throw new Error("No enabled API endpoint.");
  }

  let res;
  try {
    res = await fetch(`${base}/api/engines`);
  } catch (err) {
    throw new Error(`Engines request failed at ${base}: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`Engines ${res.status} at ${base}`);
  }
  return res.json();
}

async function fetchLanguages(kind, engine, baseOverride) {
  const settings = await getSettings();
  const base = baseOverride || pickApi(settings.apis);
  if (!base) {
    throw new Error("No enabled API endpoint.");
  }

  const path = kind === "source" ? "source_languages" : "target_languages";
  const url = `${base}/api/${path}?engine=${encodeURIComponent(engine)}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`${path} request failed at ${base}: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`${path} ${res.status} at ${base}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Context menu: translate selected text
// ---------------------------------------------------------------------------
function buildMenu() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "mozhi-translate-selection",
      title: "Translate selection with Mozhi",
      contexts: ["selection"],
    });
  });
}

browser.runtime.onInstalled.addListener(buildMenu);
browser.runtime.onStartup.addListener(buildMenu);
buildMenu();

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "mozhi-translate-selection") {
    return;
  }
  if (!tab || tab.id == null) {
    return;
  }

  // get structured content from the page (prepared by content script)
  let payload;
  try {
    const structured = await browser.tabs.sendMessage(tab.id, {
      type: "mozhi:getStructured",
    });
    payload = structured && structured.payload;
  } catch (_) {
    // content script not available
    return;
  }

  if (!payload) {
    return;
  }

  // let the page know we're working on it
  try {
    await browser.tabs.sendMessage(tab.id, { type: "mozhi:loading", text: payload });
  } catch (_) {
    // content script might have gone away
  }

  try {
    const result = await translate(payload);
    await browser.tabs.sendMessage(tab.id, {
      type: "mozhi:result",
      text: payload,
      result,
    });
  } catch (err) {
    await browser.tabs.sendMessage(tab.id, {
      type: "mozhi:error",
      text: payload,
      message: String(err.message || err),
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Message handler (options page and content script)
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) {
    return;
  }

  switch (msg.type) {
    case "mozhi:translate":
      return translate(msg.text, msg.opts || {});
    case "mozhi:engines":
      return fetchEngines(msg.base);
    case "mozhi:languages":
      return fetchLanguages(msg.kind, msg.engine, msg.base);
    case "mozhi:clearCache":
      var cacheSizeBeforeClear = cache.size;
      cache.clear();
      return Promise.resolve({ cleared: cacheSizeBeforeClear });
    case "mozhi:cacheStats":
      return Promise.resolve({ size: cache.size });
    default:
      return undefined;
  }
});
