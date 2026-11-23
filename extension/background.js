const states = new Map();
const loading = new Map();
const rateWindows = new Map();
const temporaryAccess = new Map();
const clearedStates = new Map();
let scriptSync = Promise.resolve();
const SCRIPT_IDS = ["signal-page-hook", "signal-bridge"];
const CAPTURE_TYPES = new Set(["ACTION", "ACTION_UPDATE", "EVENT"]);
const MAX_CAPTURE_BYTES = 131072;
const MAX_TEXT = 2048;
const RATE_WINDOW_MS = 10000;
const RATE_LIMIT = 250;
const SOFT_STATE_BYTES = 3 * 1024 * 1024;
const HARD_STATE_BYTES = 4 * 1024 * 1024;
const CLEAR_UNDO_MS = 10000;
const MAX_UNDO_STATES = 1;

function emptyState(tabId) { return { tabId, actions: [], events: [], actionAliases: {}, estimatedBytes: 0, updatedAt: Date.now() }; }
function storageKey(tabId) { return `signal-state-${tabId}`; }
function temporaryAccessKey(tabId) { return `signal-temp-access-${tabId}`; }
function text(value, max = MAX_TEXT) { return typeof value === "string" ? value.slice(0, max) : ""; }
function isWebUrl(value) {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch (_) { return false; }
}
function originPattern(value) {
  try {
    const url = new URL(value);
    return isWebUrl(url.href) ? `${url.origin}/*` : null;
  } catch (_) { return null; }
}
function safeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_CAPTURE_BYTES) return { truncated: "Payload exceeded WhatFired's safety limit" };
    return JSON.parse(serialized);
  } catch (_) { return {}; }
}
function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
}
function withinRateLimit(tabId) {
  const now = Date.now();
  const current = rateWindows.get(tabId);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateWindows.set(tabId, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

async function getState(tabId) {
  if (states.has(tabId)) return states.get(tabId);
  if (loading.has(tabId)) return loading.get(tabId);
  const promise = chrome.storage.session.get(storageKey(tabId)).then((stored) => {
    const state = stored[storageKey(tabId)] || emptyState(tabId);
    if (!state.actionAliases || typeof state.actionAliases !== "object") state.actionAliases = {};
    for (const event of state.events || []) updateEventBytes(event);
    state.estimatedBytes = estimateStateBytes(state);
    states.set(tabId, state);
    loading.delete(tabId);
    return state;
  });
  loading.set(tabId, promise);
  return promise;
}
async function saveState(state) {
  state.updatedAt = Date.now();
  states.set(state.tabId, state);
  await chrome.storage.session.set({ [storageKey(state.tabId)]: state });
  chrome.runtime.sendMessage({ kind: "STATE_UPDATED", tabId: state.tabId, state }).catch(() => {});
}
function jsonLength(value) {
  try { return JSON.stringify(value).length; } catch (_) { return 0; }
}
function updateEventBytes(event) {
  const previous = event._retainedBytes;
  delete event._retainedBytes;
  event._retainedBytes = jsonLength(event) + (previous ? String(previous).length : 0) + 24;
  return event._retainedBytes;
}
function estimateStateBytes(state) {
  const events = (state.events || []).reduce((total, event) => total + (Number(event._retainedBytes) || updateEventBytes(event)), 0);
  return events + jsonLength(state.actions || []) + jsonLength(state.actionAliases || {}) + 512;
}
function unlinkEvents(state, eventIds) {
  if (!eventIds.size) return;
  state.events = state.events.filter((event) => !eventIds.has(event.id));
  for (const action of state.actions) action.eventIds = action.eventIds.filter((id) => !eventIds.has(id));
}
function isSystemNoise(event) {
  const name = String(event.name || "").toLowerCase();
  return /(^tmp_|loaded$|heartbeat|session|sdk.?init|batch.?flush)/.test(name);
}
function compactRawPayload(event) {
  if (event.rawCompacted || !event.raw || !Object.keys(event.raw).length) return false;
  event.raw = { compacted: true, message: "Older raw payload removed to keep WhatFired lightweight" };
  event.rawCompacted = true;
  updateEventBytes(event);
  return true;
}
function compactState(state) {
  if (state.actions.length > 50) {
    const removed = state.actions.splice(0, state.actions.length - 50);
    const removedIds = new Set(removed.map((action) => action.id));
    state.events = state.events.filter((event) => !removedIds.has(event.actionId));
    for (const [alias, canonical] of Object.entries(state.actionAliases || {})) {
      if (removedIds.has(alias) || removedIds.has(canonical)) delete state.actionAliases[alias];
    }
  }
  if (state.events.length > 250) {
    const removedEventIds = new Set(state.events.slice(0, state.events.length - 250).map((event) => event.id));
    unlinkEvents(state, removedEventIds);
  }
  let estimatedBytes = estimateStateBytes(state);
  if (estimatedBytes > SOFT_STATE_BYTES) {
    for (const event of state.events) {
      if (!compactRawPayload(event)) continue;
      estimatedBytes = estimateStateBytes(state);
      if (estimatedBytes <= SOFT_STATE_BYTES) break;
    }
  }
  if (estimatedBytes > SOFT_STATE_BYTES) {
    for (const event of [...state.events]) {
      if (!isSystemNoise(event)) continue;
      unlinkEvents(state, new Set([event.id]));
      estimatedBytes = estimateStateBytes(state);
      if (estimatedBytes <= SOFT_STATE_BYTES) break;
    }
  }
  if (estimatedBytes > HARD_STATE_BYTES) {
    for (const event of [...state.events]) {
      unlinkEvents(state, new Set([event.id]));
      estimatedBytes = estimateStateBytes(state);
      if (estimatedBytes <= HARD_STATE_BYTES) break;
    }
  }
  state.estimatedBytes = estimatedBytes;
}

function rememberClearedState(tabId, state) {
  const now = Date.now();
  for (const [savedTabId, entry] of clearedStates) {
    if (entry.expiresAt <= now) clearedStates.delete(savedTabId);
  }
  if (!(state.actions?.length || state.events?.length)) {
    clearedStates.delete(tabId);
    return false;
  }
  clearedStates.delete(tabId);
  while (clearedStates.size >= MAX_UNDO_STATES) clearedStates.delete(clearedStates.keys().next().value);
  const expiresAt = now + CLEAR_UNDO_MS;
  clearedStates.set(tabId, { state, expiresAt });
  setTimeout(() => {
    if (clearedStates.get(tabId)?.expiresAt === expiresAt) clearedStates.delete(tabId);
  }, CLEAR_UNDO_MS);
  return true;
}

function mergeRestoredState(previous, current) {
  const restored = previous;
  const actionMap = new Map(restored.actions.map((action) => [action.id, action]));
  for (const action of current.actions || []) {
    const existing = actionMap.get(action.id);
    if (existing) {
      existing.eventIds = [...new Set([...(existing.eventIds || []), ...(action.eventIds || [])])];
    } else {
      restored.actions.push(action);
      actionMap.set(action.id, action);
    }
  }
  const eventIds = new Set(restored.events.map((event) => event.id));
  for (const event of current.events || []) {
    if (!eventIds.has(event.id)) restored.events.push(event);
  }
  restored.actionAliases = { ...(restored.actionAliases || {}), ...(current.actionAliases || {}) };
  restored.actions.sort((a, b) => a.timestamp - b.timestamp);
  restored.events.sort((a, b) => a.timestamp - b.timestamp);
  compactState(restored);
  return restored;
}
function normalizedJourneyUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch (_) { return ""; }
}
function destinationName(payload) {
  const label = text(payload?.label, 160);
  const quoted = label.match(/[“"](.+?)[”"]\s*$/)?.[1];
  return quoted || text(payload?.path, 500) || "next page";
}
function mergePageIntoJourney(state, payload) {
  if (payload?.kind !== "page") return false;
  const timestamp = Number(payload.timestamp) || Date.now();
  const currentUrl = normalizedJourneyUrl(payload.url);
  const candidate = [...state.actions].reverse().find((action) => {
    if (!["click", "navigation", "submit"].includes(action.kind)) return false;
    const elapsed = timestamp - action.timestamp;
    if (elapsed < 0 || elapsed > 8000) return false;
    const expected = normalizedJourneyUrl(action.destinationUrl);
    return expected ? expected === currentUrl || elapsed <= 4000 : elapsed <= 4000;
  });
  if (!candidate) return false;
  state.actionAliases ||= {};
  state.actionAliases[text(payload.id, 120)] = candidate.id;
  const trigger = candidate.triggerLabel || candidate.label.split(" → ")[0];
  candidate.kind = "navigation";
  candidate.triggerLabel = trigger;
  candidate.destinationUrl = text(payload.url);
  candidate.destinationPath = text(payload.path, 500);
  candidate.label = `${trigger} → “${destinationName(payload)}”`;
  return true;
}
function addAction(state, payload) {
  if (!text(payload?.id, 120)) return;
  if (mergePageIntoJourney(state, payload)) return;
  state.actions.push({
    id: text(payload.id, 120), kind: text(payload.kind, 32) || "interaction",
    label: text(payload.label, 160) || "Interaction", triggerLabel: text(payload.triggerLabel, 160) || text(payload.label, 160),
    selector: text(payload.selector, 240), url: text(payload.url), path: text(payload.path, 500),
    destinationUrl: text(payload.destinationUrl), destinationPath: text(payload.destinationPath, 500),
    timestamp: Number(payload.timestamp) || Date.now(), eventIds: []
  });
}
function updateAction(state, payload) {
  const payloadId = text(payload?.id, 120);
  if (!payloadId) return;
  const canonicalId = state.actionAliases?.[payloadId] || payloadId;
  const action = state.actions.find((item) => item.id === canonicalId);
  if (!action) return addAction(state, payload);
  if (canonicalId !== payloadId && payload.kind === "page") {
    const trigger = action.triggerLabel || action.label.split(" → ")[0];
    action.destinationUrl = text(payload.url) || action.destinationUrl;
    action.destinationPath = text(payload.path, 500) || action.destinationPath;
    action.label = `${trigger} → “${destinationName(payload)}”`;
    return;
  }
  action.kind = text(payload.kind, 32) || action.kind;
  action.label = text(payload.label, 160) || action.label;
  action.triggerLabel = text(payload.triggerLabel, 160) || action.triggerLabel;
  action.selector = text(payload.selector, 240) || action.selector;
  action.url = text(payload.url) || action.url;
  action.path = text(payload.path, 500) || action.path;
  action.destinationUrl = text(payload.destinationUrl) || action.destinationUrl;
  action.destinationPath = text(payload.destinationPath, 500) || action.destinationPath;
}
function findOrCreateBackgroundAction(state, event) {
  const bucket = Math.floor(event.timestamp / 5000);
  const existing = [...state.actions].reverse().find((action) => action.kind === "background" && action.bucket === bucket);
  if (existing) return existing;
  const action = { id: `background-${bucket}`, kind: "background", label: "Automatic activity", selector: "", url: event.url, path: "", timestamp: event.timestamp, bucket, eventIds: [] };
  state.actions.push(action);
  return action;
}
function mergeDuplicate(state, event) {
  return [...state.events].reverse().find((candidate) => candidate.actionId === event.actionId && candidate.type === event.type && candidate.name === event.name && candidate.source !== event.source && Math.abs(candidate.timestamp - event.timestamp) < 1500);
}
function addEvent(state, payload) {
  if (!text(payload?.id, 120)) return;
  const event = {
    id: text(payload.id, 120), type: text(payload.type, 32) || "track",
    name: text(payload.name, 160) || "Analytics event", properties: safeObject(payload.properties),
    extra: safeObject(payload.extra), raw: safeObject(payload.raw || payload),
    source: text(payload.source, 24) || "unknown", actionId: state.actionAliases?.[text(payload.actionId, 120)] || text(payload.actionId, 120) || null,
    timestamp: Number(payload.timestamp) || Date.now(), url: text(payload.url)
  };
  let action = event.actionId ? state.actions.find((item) => item.id === event.actionId) : null;
  if (!action) {
    const recent = [...state.actions].reverse().find((item) => event.timestamp - item.timestamp >= 0 && event.timestamp - item.timestamp <= 2500);
    action = recent || findOrCreateBackgroundAction(state, event);
    event.actionId = action.id;
  }
  const duplicate = mergeDuplicate(state, event);
  if (duplicate) {
    duplicate.properties = { ...duplicate.properties, ...event.properties };
    duplicate.extra = { ...duplicate.extra, ...event.extra };
    duplicate.raw = event.source === "network" ? event.raw : duplicate.raw;
    duplicate.sources = [...new Set([...(duplicate.sources || [duplicate.source]), event.source])];
    updateEventBytes(duplicate);
    return;
  }
  updateEventBytes(event);
  state.events.push(event);
  action.eventIds.push(event.id);
}

async function grantedOrigins() {
  const permissions = await chrome.permissions.getAll();
  return (permissions.origins || []).filter((origin) => /^https?:\/\//.test(origin));
}
async function syncRegisteredScripts() {
  await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => {});
  const matches = await grantedOrigins();
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_IDS[0], matches, js: ["page-hook.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
    { id: SCRIPT_IDS[1], matches, js: ["bridge.js"], runAt: "document_start", world: "ISOLATED", persistAcrossSessions: true }
  ]);
}
function queueScriptSync() {
  scriptSync = scriptSync.catch(() => {}).then(syncRegisteredScripts);
  return scriptSync;
}
async function purgeRevokedOrigins(patterns = []) {
  const origins = patterns.map((pattern) => pattern.replace(/\/\*$/, ""));
  if (!origins.length) return;
  const stored = await chrome.storage.session.get(null);
  const keysToRemove = [];
  for (const [key, state] of Object.entries(stored)) {
    if (!key.startsWith("signal-state-") || !state) continue;
    const urls = [...(state.actions || []), ...(state.events || [])].map((item) => item.url).filter(Boolean);
    if (urls.some((url) => origins.some((origin) => String(url).startsWith(`${origin}/`) || url === origin))) {
      keysToRemove.push(key);
      states.delete(state.tabId);
      rateWindows.delete(state.tabId);
    }
  }
  for (const [tabId, entry] of clearedStates) {
    const urls = [...(entry.state.actions || []), ...(entry.state.events || [])].map((item) => item.url).filter(Boolean);
    if (urls.some((url) => origins.some((origin) => String(url).startsWith(`${origin}/`) || url === origin))) clearedStates.delete(tabId);
  }
  if (keysToRemove.length) await chrome.storage.session.remove(keysToRemove);
}
async function injectCurrentTab(tabId, expectedPattern) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || originPattern(tab.url) !== expectedPattern) throw new Error("The active tab changed.");
  if (!await chrome.permissions.contains({ origins: [expectedPattern] })) throw new Error("Site access was not granted.");
  await injectScripts(tabId);
}
async function injectScripts(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page-hook.js"], world: "MAIN", injectImmediately: true });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["bridge.js"], world: "ISOLATED", injectImmediately: true });
  await chrome.tabs.sendMessage(tabId, { kind: "START_CAPTURE" });
}
async function enableTemporaryTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const pattern = originPattern(tab?.url);
  if (!pattern) throw new Error("This page cannot be inspected.");
  temporaryAccess.set(tabId, pattern);
  await chrome.storage.session.set({ [temporaryAccessKey(tabId)]: pattern });
  await injectScripts(tabId);
  return pattern;
}
async function hasTemporaryAccess(tabId, pattern) {
  const cached = temporaryAccess.get(tabId);
  if (cached) return cached === pattern;
  const stored = await chrome.storage.session.get(temporaryAccessKey(tabId));
  const saved = stored[temporaryAccessKey(tabId)];
  if (typeof saved !== "string") return false;
  temporaryAccess.set(tabId, saved);
  return saved === pattern;
}
async function capture(message, sender) {
  const tabId = sender.tab?.id;
  const pattern = originPattern(sender.url || sender.tab?.url);
  if (sender.id !== chrome.runtime.id || typeof tabId !== "number" || !pattern || !CAPTURE_TYPES.has(message.captureType)) return { ok: false };
  if (!withinRateLimit(tabId)) return { ok: false, limited: true };
  const persistent = await chrome.permissions.contains({ origins: [pattern] });
  const temporary = await hasTemporaryAccess(tabId, pattern);
  if (!persistent && !temporary) return { ok: false };
  let serialized;
  try { serialized = JSON.stringify(message.payload); } catch (_) { return { ok: false }; }
  if (!serialized || serialized.length > MAX_CAPTURE_BYTES) return { ok: false };
  const state = await getState(tabId);
  if (message.captureType === "ACTION") addAction(state, message.payload);
  if (message.captureType === "ACTION_UPDATE") updateAction(state, message.payload);
  if (message.captureType === "EVENT") addEvent(state, message.payload);
  compactState(state);
  await saveState(state);
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  queueScriptSync().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => queueScriptSync().catch(() => {}));
chrome.permissions.onAdded.addListener(() => queueScriptSync().catch(() => {}));
chrome.permissions.onRemoved.addListener((removed) => {
  queueScriptSync().catch(() => {});
  purgeRevokedOrigins(removed.origins).catch(() => {});
});
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
queueScriptSync().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === "CAPTURE") {
    capture(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!isExtensionPage(sender)) return false;
  if (message?.kind === "GET_STATE" && Number.isInteger(message.tabId)) {
    getState(message.tabId).then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.kind === "CLEAR_STATE" && Number.isInteger(message.tabId)) {
    getState(message.tabId).then(async (previous) => {
      const undoAvailable = rememberClearedState(message.tabId, previous);
      const state = emptyState(message.tabId);
      await saveState(state);
      sendResponse({ ok: true, state, undoAvailable, undoExpiresIn: CLEAR_UNDO_MS });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.kind === "UNDO_CLEAR" && Number.isInteger(message.tabId)) {
    const entry = clearedStates.get(message.tabId);
    if (!entry || entry.expiresAt <= Date.now()) {
      clearedStates.delete(message.tabId);
      sendResponse({ ok: false, expired: true });
      return false;
    }
    clearedStates.delete(message.tabId);
    getState(message.tabId).then(async (current) => {
      const state = mergeRestoredState(entry.state, current);
      await saveState(state);
      sendResponse({ ok: true, state });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.kind === "ENABLE_TAB" && Number.isInteger(message.tabId) && typeof message.origin === "string") {
    queueScriptSync().then(() => injectCurrentTab(message.tabId, message.origin)).then(async () => {
      temporaryAccess.delete(message.tabId);
      await chrome.storage.session.remove(temporaryAccessKey(message.tabId));
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "ENABLE_TEMP_TAB" && Number.isInteger(message.tabId)) {
    enableTemporaryTab(message.tabId).then((origin) => sendResponse({ ok: true, origin })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "STOP_TAB" && Number.isInteger(message.tabId)) {
    temporaryAccess.delete(message.tabId);
    chrome.storage.session.remove(temporaryAccessKey(message.tabId)).then(() => chrome.tabs.sendMessage(message.tabId, { kind: "STOP_CAPTURE" })).catch(() => {}).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.kind === "CHECK_TAB" && Number.isInteger(message.tabId)) {
    chrome.tabs.sendMessage(message.tabId, { kind: "PING_CAPTURE" }).then((response) => sendResponse({ ok: response?.ok === true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  states.delete(tabId);
  rateWindows.delete(tabId);
  temporaryAccess.delete(tabId);
  clearedStates.delete(tabId);
  chrome.storage.session.remove([storageKey(tabId), temporaryAccessKey(tabId)]).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  (async () => {
    let expectedPattern = temporaryAccess.get(tabId);
    if (!expectedPattern) {
      const stored = await chrome.storage.session.get(temporaryAccessKey(tabId));
      expectedPattern = stored[temporaryAccessKey(tabId)];
      if (expectedPattern) temporaryAccess.set(tabId, expectedPattern);
    }
    if (!expectedPattern) return;
    if (changeInfo.url && originPattern(changeInfo.url) !== expectedPattern) {
      temporaryAccess.delete(tabId);
      await chrome.storage.session.remove(temporaryAccessKey(tabId));
      return;
    }
    if (changeInfo.status === "loading" || changeInfo.status === "complete") {
      const tab = await chrome.tabs.get(tabId);
      if (originPattern(tab.url) !== expectedPattern) {
        temporaryAccess.delete(tabId);
        await chrome.storage.session.remove(temporaryAccessKey(tabId));
        return;
      }
      await injectScripts(tabId);
    }
  })().catch(() => {});
});

