const feed = document.getElementById("feed");
const emptyTemplate = document.getElementById("empty-template");
const keepTemplate = document.getElementById("keep-template");
const explainTemplate = document.getElementById("explain-template");
const siteLabel = document.getElementById("site-label");
const clearButton = document.getElementById("clear-button");
const liveStatus = document.getElementById("live-status");
const statusText = document.getElementById("status-text");
const announcer = document.getElementById("announcer");
const eventSearch = document.getElementById("event-search");
const sourceSelect = document.getElementById("source-filter");
const resultsCount = document.getElementById("results-count");

let activeTabId = null;
let activeOrigin = null;
let hasSiteAccess = false;
let accessMode = "none";
let dismissedKeepPrompt = false;
let explainingPermission = false;
let showReloadPrompt = false;
let currentState = null;
let newestActionId = null;
let initialExpansionApplied = false;
const openActions = new Set();
const openFilteredActions = new Set();
let filterExpansionSignature = "";
let openEventId = null;
let openingActionId = null;
let openingEventId = null;
const openTechnical = new Set();
const openJson = new Set();
const openSupporting = new Set();
let searchQuery = "";
let selectedSource = "";
let sourceSignature = "";
let detectedSourceCount = 0;
let renderFrameId = null;
let clearUndoAvailable = false;
let clearUndoTimer = null;
const highlightedActions = new Map();
const highlightedEvents = new Map();
const LIVE_HIGHLIGHT_MS = 1200;
const SOURCE_PREFERENCES_KEY = "event-inspector-source-preferences-v1";
const SOURCE_PREFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_PREFERENCES = 50;

function domId(prefix, value) {
  return `${prefix}-${String(value).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function announce(message) {
  announcer.textContent = "";
  requestAnimationFrame(() => { announcer.textContent = message; });
}

function rerenderAndFocus(key) {
  render();
  requestAnimationFrame(() => feed.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus());
}

function scheduleRender() {
  if (renderFrameId !== null) return;
  const feedTop = feed.getBoundingClientRect().top;
  const visibleAnchor = feed.scrollTop > 2
    ? [...feed.querySelectorAll("[data-action-id]")].find((card) => card.getBoundingClientRect().bottom > feedTop)
    : null;
  const anchorId = visibleAnchor?.dataset.actionId || "";
  const anchorOffset = visibleAnchor ? visibleAnchor.getBoundingClientRect().top - feedTop : 0;
  renderFrameId = requestAnimationFrame(() => {
    renderFrameId = null;
    render();
    if (anchorId) {
      const nextAnchor = [...feed.querySelectorAll("[data-action-id]")].find((card) => card.dataset.actionId === anchorId);
      if (nextAnchor) feed.scrollTop += nextAnchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchorOffset;
    }
  });
}

function markLiveArrivals(nextState) {
  const now = Date.now();
  for (const [id, expiresAt] of highlightedActions) if (expiresAt <= now) highlightedActions.delete(id);
  for (const [id, expiresAt] of highlightedEvents) if (expiresAt <= now) highlightedEvents.delete(id);
  const previousActionIds = new Set((currentState?.actions || []).map((action) => action.id));
  const previousEventIds = new Set((currentState?.events || []).map((event) => event.id));
  const expiresAt = now + LIVE_HIGHLIGHT_MS;
  for (const action of nextState?.actions || []) {
    if (!previousActionIds.has(action.id)) highlightedActions.set(action.id, expiresAt);
  }
  for (const event of nextState?.events || []) {
    if (!previousEventIds.has(event.id)) highlightedEvents.set(event.id, expiresAt);
  }
}

function isLiveArrival(collection, id) {
  const expiresAt = collection.get(id) || 0;
  if (expiresAt > Date.now()) return true;
  collection.delete(id);
  return false;
}

function patternFor(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return `${parsed.origin}/*`;
  } catch (_) { return null; }
}

function currentSiteOrigin() {
  try {
    const origin = new URL(String(activeOrigin || "").replace(/\/\*$/, "")).origin;
    return /^https?:\/\//.test(origin) ? origin : "";
  } catch (_) { return ""; }
}

function sanitizedSourcePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(value)
    .filter(([origin, entry]) => {
      if (!entry || typeof entry !== "object" || typeof entry.provider !== "string" || entry.provider.length < 1 || entry.provider.length > 80) return false;
      if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > SOURCE_PREFERENCE_TTL_MS || entry.updatedAt > now + 60000) return false;
      try {
        const parsed = new URL(origin);
        return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === origin;
      } catch (_) { return false; }
    })
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_SOURCE_PREFERENCES));
}

async function loadSourcePreference() {
  selectedSource = "";
  const origin = currentSiteOrigin();
  if (!origin) return;
  try {
    const stored = await chrome.storage.local.get(SOURCE_PREFERENCES_KEY);
    const rawPreferences = stored[SOURCE_PREFERENCES_KEY] || {};
    const preferences = sanitizedSourcePreferences(rawPreferences);
    if (JSON.stringify(rawPreferences) !== JSON.stringify(preferences)) {
      if (Object.keys(preferences).length) await chrome.storage.local.set({ [SOURCE_PREFERENCES_KEY]: preferences });
      else await chrome.storage.local.remove(SOURCE_PREFERENCES_KEY);
    }
    selectedSource = preferences[origin]?.provider || "";
  } catch (_) {}
}

async function saveSourcePreference() {
  const origin = currentSiteOrigin();
  if (!origin) return;
  const stored = await chrome.storage.local.get(SOURCE_PREFERENCES_KEY);
  const preferences = sanitizedSourcePreferences(stored[SOURCE_PREFERENCES_KEY]);
  if (selectedSource) preferences[origin] = { provider: selectedSource.slice(0, 80), updatedAt: Date.now() };
  else delete preferences[origin];
  const bounded = Object.fromEntries(Object.entries(preferences).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_SOURCE_PREFERENCES));
  if (Object.keys(bounded).length) await chrome.storage.local.set({ [SOURCE_PREFERENCES_KEY]: bounded });
  else await chrome.storage.local.remove(SOURCE_PREFERENCES_KEY);
}

function setAccessUi(mode) {
  accessMode = mode;
  hasSiteAccess = mode !== "none";
  liveStatus.classList.toggle("is-off", !hasSiteAccess);
  statusText.textContent = hasSiteAccess ? "Live" : "Off";
  liveStatus.setAttribute("aria-label", mode === "persistent" ? "Live. Automatic tracking is enabled for this site." : mode === "temporary" ? "Live in this tab." : "Tracking is off.");
  clearButton.hidden = !hasSiteAccess;
}

function currentHost() {
  return activeOrigin ? new URL(activeOrigin.replace(/\/\*$/, "")).hostname : "this site";
}

function dismissPromptKey() {
  return `signal-dismiss-prompt-${activeTabId}-${encodeURIComponent(activeOrigin || "")}`;
}

function renderKeepPrompt() {
  const fragment = keepTemplate.content.cloneNode(true);
  const hostLabel = fragment.querySelector("[data-access-host]");
  if (hostLabel) hostLabel.textContent = currentHost();
  fragment.querySelector("[data-keep-tracking]").addEventListener("click", () => {
    explainingPermission = true;
    render();
  });
  fragment.querySelector("[data-only-tab]").addEventListener("click", async () => {
    dismissedKeepPrompt = true;
    await chrome.storage.session.set({ [dismissPromptKey()]: true });
    render();
  });
  return fragment;
}

function renderPermissionExplanation() {
  feed.replaceChildren(explainTemplate.content.cloneNode(true));
  feed.querySelector("[data-permission-host]").textContent = currentHost();
  feed.querySelector("[data-continue-permission]").addEventListener("click", enableCurrentSite);
  feed.querySelector("[data-cancel-permission]").addEventListener("click", () => {
    explainingPermission = false;
    render();
  });
}

function renderReloadPrompt() {
  const notice = node("div", "notice");
  notice.append(node("div", "", "Reload this page once for full provider coverage."));
  const button = node("button", "text-button", "Reload page");
  button.type = "button";
  button.addEventListener("click", async () => {
    showReloadPrompt = false;
    await chrome.tabs.reload(activeTabId);
  });
  notice.append(button);
  return notice;
}

function hideClearUndo() {
  clearUndoAvailable = false;
  if (clearUndoTimer !== null) clearTimeout(clearUndoTimer);
  clearUndoTimer = null;
}

function renderClearUndo() {
  const notice = node("div", "undo-notice");
  const button = node("button", "text-button", "Undo");
  button.type = "button";
  button.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ kind: "UNDO_CLEAR", tabId: activeTabId });
    hideClearUndo();
    if (!response?.ok) {
      render();
      announce("Undo is no longer available.");
      return;
    }
    currentState = response.state;
    highlightedActions.clear();
    highlightedEvents.clear();
    openActions.clear();
    const latestInteraction = [...currentState.actions].reverse().find((action) => action.kind !== "background");
    if (latestInteraction) openActions.add(latestInteraction.id);
    render();
    announce("Captured activity restored.");
  });
  notice.append(node("span", "", "Activity cleared"), button);
  return notice;
}

async function enableCurrentSite(event) {
  if (!activeTabId || !activeOrigin) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Enabling…";
  const granted = await chrome.permissions.request({ origins: [activeOrigin] });
  if (!granted) {
    button.disabled = false;
    button.textContent = "Allow for this site";
    return;
  }
  const response = await chrome.runtime.sendMessage({ kind: "ENABLE_TAB", tabId: activeTabId, origin: activeOrigin });
  if (!response?.ok) {
    button.disabled = false;
    button.textContent = "Try again";
    return;
  }
  setAccessUi("persistent");
  explainingPermission = false;
  dismissedKeepPrompt = true;
  showReloadPrompt = true;
  await loadState();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function disclosureChevron() {
  const wrapper = node("span", "chevron");
  wrapper.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 3.5 10.5 8 6 12.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.75");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  wrapper.append(svg);
  return wrapper;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function humanize(value) {
  const special = {
    message_shown: "Message displayed",
    ab_test: "Experiment applied",
    identify: "Identity updated",
    workspace_share_loaded: "Sharing module loaded",
    tmp_view_page_section: "Temporary page view",
    view_page_section: "Page section viewed"
  };
  if (special[value]) return special[value];
  return String(value || "Analytics event")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isSupporting(event) {
  const type = String(event.type || "").toLowerCase();
  const name = String(event.name || "").toLowerCase();
  return ["identify", "group", "alias"].includes(type) ||
    /(^tmp_|loaded$|heartbeat|session|identify)/.test(name);
}

function supportingMeaning(event) {
  const name = String(event.name || "").toLowerCase();
  if (name === "identify" || event.type === "identify") return "Identity context";
  if (/ab_test|experiment|exposure/.test(name)) return "Experiment exposure";
  if (/tmp_/.test(name)) return "Possible duplicate";
  if (/loaded/.test(name)) return "Technical load";
  return "Technical context";
}

function explanation(event) {
  const name = String(event.name || "").toLowerCase();
  if (name === "message_shown") return "This records that a message became visible on the page.";
  if (name === "view_page_section" || /page.*view|view.*page/.test(name)) return "This records that someone reached this part of the product.";
  if (/ab_test|experiment|exposure/.test(name)) return "This records which experiment or variant was shown.";
  if (event.type === "identify" || name === "identify") return "This updates the user information attached to later events.";
  if (event.type === "page") return "This records that someone viewed this page.";
  return `This records that “${humanize(event.name).toLowerCase()}” happened.`;
}

function eventIcon(event) {
  if (event.type === "page" || /view/.test(String(event.name).toLowerCase())) return "◉";
  if (/message/.test(String(event.name).toLowerCase())) return "◌";
  return "◇";
}

function actionIcon(action) {
  if (action.kind === "click") return "↖";
  if (action.kind === "submit") return "✓";
  if (action.kind === "change") return "↕";
  if (action.kind === "background") return "···";
  return "▣";
}

function usefulProperties(event, limit = Infinity) {
  const source = event.properties && typeof event.properties === "object" ? event.properties : {};
  const hidden = /(timestamp|message.?id|anonymous.?id|session.?id|unique.?pageview|user.?agent|library|integrations)/i;
  const priority = ["page", "section", "form", "workspace", "action", "plan", "variant", "source", "category", "type"];
  return Object.entries(source)
    .filter(([key, value]) => !hidden.test(key) && value !== null && value !== undefined && typeof value !== "object")
    .map((entry, index) => ({ entry, index, rank: priority.findIndex((name) => entry[0].toLowerCase() === name || entry[0].toLowerCase().endsWith(`_${name}`)) }))
    .sort((a, b) => (a.rank < 0 ? 999 : a.rank) - (b.rank < 0 ? 999 : b.rank) || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.entry);
}

function valueText(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function propertyValue(properties, candidates) {
  const entries = Object.entries(properties || {});
  for (const candidate of candidates) {
    const match = entries.find(([key]) => key.toLocaleLowerCase() === candidate || key.toLocaleLowerCase().endsWith(`_${candidate}`));
    if (match && match[1] !== null && match[1] !== undefined && typeof match[1] !== "object") return String(match[1]);
  }
  return "";
}

function experimentSummary(event) {
  const name = String(event.name || "").toLocaleLowerCase();
  const type = String(event.type || "").toLocaleLowerCase();
  if (!/(ab.?test|experiment|exposure)/.test(`${name} ${type}`)) return "";
  const properties = event.properties || {};
  const experiment = propertyValue(properties, ["test_id", "experiment_id", "experiment_name", "test_name", "feature_flag", "flag_key"]);
  const variant = propertyValue(properties, ["variant_label", "variant", "treatment", "variation", "bucket"]);
  if (!experiment && !variant) return "Experiment exposure";
  return [experiment, variant].filter(Boolean).join(" · ");
}

function primaryProperty(event) {
  const property = usefulProperties(event, 1)[0];
  if (!property) return null;
  const [key, value] = property;
  const compact = valueText(value).replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return { key, value: compact.length > 80 ? `${compact.slice(0, 77)}…` : compact };
}

function searchableEventText(event) {
  const properties = event.properties && typeof event.properties === "object" ? event.properties : {};
  return [event.name, event.type, event.extra?.provider, event.source, ...Object.entries(properties).flat()]
    .filter((value) => value !== null && value !== undefined && typeof value !== "object")
    .join(" ")
    .toLocaleLowerCase();
}

function providerFor(event) {
  return String(event.extra?.provider || "Other");
}

function providerKey(provider) {
  return provider.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
}

function providerMark(provider) {
  const known = { Segment: "S", "Google Tag Manager": "G", "Google Analytics": "GA", Amplitude: "A", RudderStack: "R", Mixpanel: "M", PostHog: "P", Heap: "H", Snowplow: "S" };
  return known[provider] || provider.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase() || "?";
}

function updateSourceOptions(events) {
  const counts = new Map();
  for (const event of events) {
    const provider = providerFor(event);
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  const providers = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  detectedSourceCount = providers.length;
  const signature = JSON.stringify([selectedSource, providers]);
  if (signature !== sourceSignature) {
    sourceSignature = signature;
    sourceSelect.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = `All sources (${events.length})`;
    sourceSelect.append(all);
    for (const [provider, count] of providers) {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = `${provider} (${count})`;
      sourceSelect.append(option);
    }
    if (selectedSource && !counts.has(selectedSource)) {
      const waiting = document.createElement("option");
      waiting.value = selectedSource;
      waiting.textContent = `${selectedSource} (0)`;
      sourceSelect.append(waiting);
    }
  }
  sourceSelect.value = selectedSource;
  sourceSelect.classList.toggle("is-active", Boolean(selectedSource));
  sourceSelect.hidden = providers.length <= 1 && !selectedSource;
}

async function copyItem(value, label, button) {
  await navigator.clipboard.writeText(valueText(value));
  const previous = button.textContent;
  const surface = button.closest(".copy-row");
  surface?.classList.add("is-copied");
  button.textContent = "✓ Copied";
  announce(`${label} copied.`);
  setTimeout(() => {
    button.textContent = previous;
    surface?.classList.remove("is-copied");
  }, 1600);
}

function renderCopyRow(label, value, className = "") {
  const row = node("div", `copy-row${className ? ` ${className}` : ""}`);
  const copyButton = node("button", "copy-item", "Copy");
  copyButton.type = "button";
  copyButton.setAttribute("aria-label", `Copy ${label}: ${valueText(value)}`);
  copyButton.addEventListener("click", () => copyItem(value, label, copyButton));
  row.append(
    node("span", "copy-label", label),
    node("span", "copy-value", valueText(value)),
    copyButton
  );
  return row;
}

function renderPropertyGrid(event) {
  const properties = usefulProperties(event);
  if (!properties.length) return null;
  const grid = node("div", "property-grid");
  for (const [key, value] of properties) {
    grid.append(renderCopyRow(key, value, "property-copy-row"));
  }
  return grid;
}

function renderTechnical(event) {
  const panel = node("div", "technical-panel");
  panel.id = domId("technical", event.id);
  panel.hidden = !openTechnical.has(event.id);
  const entries = [
    ["Event name", event.name],
    ["Event type", event.type],
    ["Provider", event.extra?.provider || "Not identified"],
    ["Captured from", event.sources?.join(" + ") || event.source],
    ["Relationship", event.actionId?.startsWith("background-") ? "Not linked to an interaction" : "Appeared after this interaction"],
    ["Delivery", event.source === "network" || event.sources?.includes("network") ? "Request observed" : "SDK call observed"]
  ];
  for (const [label, value] of entries) {
    const row = node("div", "technical-row");
    row.append(node("span", "technical-label", label), node("span", "technical-value", value || "Not available"));
    panel.append(row);
  }

  const jsonButton = node("button", "text-button", openJson.has(event.id) ? "Hide JSON" : "View JSON");
  jsonButton.type = "button";
  jsonButton.setAttribute("aria-expanded", String(openJson.has(event.id)));
  jsonButton.setAttribute("aria-controls", domId("json", event.id));
  jsonButton.dataset.focusKey = `json-${event.id}`;
  const pre = node("pre", "raw-json", JSON.stringify(event.raw || event, null, 2));
  pre.id = domId("json", event.id);
  pre.setAttribute("tabindex", "0");
  pre.setAttribute("aria-label", `Raw JSON for ${event.name}`);
  pre.hidden = !openJson.has(event.id);
  jsonButton.addEventListener("click", () => {
    if (openJson.has(event.id)) openJson.delete(event.id); else openJson.add(event.id);
    rerenderAndFocus(jsonButton.dataset.focusKey);
  });
  panel.append(jsonButton, pre);
  return panel;
}

function renderEventDetail(event) {
  const detail = node("div", "event-detail");
  detail.id = domId("event-detail", event.id);
  detail.append(
    renderCopyRow("Event name", event.name, "event-name-copy"),
    node("div", "event-explanation", explanation(event))
  );
  const properties = renderPropertyGrid(event);
  if (properties) {
    detail.append(node("div", "detail-label", "Properties"), properties);
  }

  const actions = node("div", "detail-actions");
  const technicalButton = node("button", "text-button", openTechnical.has(event.id) ? "Hide technical details" : "Technical details");
  technicalButton.type = "button";
  technicalButton.setAttribute("aria-expanded", String(openTechnical.has(event.id)));
  technicalButton.setAttribute("aria-controls", domId("technical", event.id));
  technicalButton.dataset.focusKey = `technical-${event.id}`;
  technicalButton.addEventListener("click", () => {
    if (openTechnical.has(event.id)) openTechnical.delete(event.id); else openTechnical.add(event.id);
    rerenderAndFocus(technicalButton.dataset.focusKey);
  });
  actions.append(technicalButton);
  detail.append(actions, renderTechnical(event));
  return detail;
}

function renderEventRow(event) {
  const isOpening = openingEventId === event.id;
  const wrapper = node("div", `event-block${isLiveArrival(highlightedEvents, event.id) ? " is-new" : ""}${isOpening ? " is-opening" : ""}`);
  if (isOpening) openingEventId = null;
  const button = node("button", "event-row");
  button.type = "button";
  button.setAttribute("aria-expanded", String(openEventId === event.id));
  button.setAttribute("aria-controls", domId("event-detail", event.id));
  const provider = providerFor(event);
  button.setAttribute("aria-label", `${openEventId === event.id ? "Hide" : "Show"} details for event ${event.name}, source ${provider}`);
  button.dataset.focusKey = `event-${event.id}`;
  const icon = node("span", "event-icon", eventIcon(event));
  icon.setAttribute("aria-hidden", "true");
  const copy = node("span");
  const showBadge = !selectedSource && detectedSourceCount > 1;
  const experiment = experimentSummary(event);
  const property = primaryProperty(event);
  const summary = node("div", "event-summary");
  if (experiment) {
    summary.append(node("span", "event-summary-value", experiment));
  } else if (property) {
    summary.append(node("span", "event-summary-label", `${humanize(property.key)}:`), node("span", "event-summary-value", property.value));
  } else {
    summary.append(node("span", "event-summary-value", humanize(event.type || "Event")));
  }
  if (!selectedSource) {
    const compactClass = showBadge ? " compact-provider" : "";
    summary.append(node("span", `event-summary-separator${compactClass}`, "·"), node("span", `event-summary-provider${compactClass}`, provider));
  }
  copy.append(node("div", "event-title event-name", event.name), summary);
  const chevron = disclosureChevron();
  const trailing = node("span", "event-trailing");
  if (showBadge) {
    const badge = node("span", "source-badge");
    badge.dataset.provider = providerKey(provider);
    badge.setAttribute("aria-hidden", "true");
    badge.append(node("span", "source-mark", providerMark(provider)), node("span", "", provider));
    trailing.append(badge);
  }
  trailing.append(chevron);
  button.append(icon, copy, trailing);
  button.addEventListener("click", () => {
    if (openEventId === event.id) {
      openEventId = null;
    } else {
      openEventId = event.id;
      openingEventId = event.id;
    }
    rerenderAndFocus(button.dataset.focusKey);
  });
  wrapper.append(button);

  if (openEventId === event.id) wrapper.append(renderEventDetail(event));
  return wrapper;
}

function renderSupporting(action, events) {
  const wrapper = document.createDocumentFragment();
  const open = openSupporting.has(action.id);
  const button = node("button", "supporting-button");
  button.type = "button";
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-controls", domId("supporting", action.id));
  button.dataset.focusKey = `supporting-${action.id}`;
  const supportingChevron = disclosureChevron();
  button.append(node("span", "", open ? "Hide more events" : `${events.length} more event${events.length === 1 ? "" : "s"}`), supportingChevron);
  button.addEventListener("click", () => {
    if (open) openSupporting.delete(action.id); else openSupporting.add(action.id);
    rerenderAndFocus(button.dataset.focusKey);
  });
  wrapper.append(button);
  if (open) {
    const list = node("div", "supporting-list");
    list.id = domId("supporting", action.id);
    for (const event of events) {
      const meaning = supportingMeaning(event);
      const row = node("div", "supporting-row");
      row.append(node("span", `supporting-name${meaning === "Possible duplicate" ? " possible-duplicate" : ""}`, event.name), node("span", "supporting-meaning", meaning));
      list.append(row);
    }
    wrapper.append(list);
  }
  return wrapper;
}

function renderAction(action, eventMap, visibleEvents = null, filterMode = false) {
  const events = visibleEvents || action.eventIds.map((id) => eventMap.get(id)).filter(Boolean);
  const meaningful = filterMode ? events : events.filter((event) => !isSupporting(event));
  const supporting = filterMode ? [] : events.filter(isSupporting);
  const isOpen = filterMode ? openFilteredActions.has(action.id) : openActions.has(action.id);
  const isAutomatic = action.kind === "background";
  const isOpening = openingActionId === action.id;
  const card = node("article", `action-card${isOpen ? " is-open" : ""}${isAutomatic ? " automatic-activity" : ""}${isLiveArrival(highlightedActions, action.id) ? " is-new" : ""}${isOpening ? " is-opening" : ""}`);
  if (isOpening) openingActionId = null;
  card.dataset.actionId = action.id;

  const actionButton = node("button", "action-button");
  actionButton.type = "button";
  actionButton.setAttribute("aria-expanded", String(isOpen));
  actionButton.setAttribute("aria-controls", domId("action-results", action.id));
  actionButton.dataset.focusKey = `action-${action.id}`;
  const icon = node("span", "action-icon", actionIcon(action));
  icon.setAttribute("aria-hidden", "true");
  const copy = node("span");
  copy.append(node("div", "action-title", isAutomatic ? "Automatic activity" : action.label));
  if (isAutomatic) copy.append(node("div", "action-meta", "Not directly linked to a click or navigation"));
  copy.append(node("div", "action-meta", `${formatTime(action.timestamp)} · ${events.length} event${events.length === 1 ? "" : "s"}`));
  const actionChevron = disclosureChevron();
  actionButton.append(icon, copy, actionChevron);
  actionButton.addEventListener("click", () => {
    const expansionSet = filterMode ? openFilteredActions : openActions;
    if (expansionSet.has(action.id)) {
      expansionSet.delete(action.id);
    } else {
      expansionSet.add(action.id);
      openingActionId = action.id;
    }
    rerenderAndFocus(actionButton.dataset.focusKey);
  });
  card.append(actionButton);

  if (isOpen) {
    const results = node("div", "action-results");
    results.id = domId("action-results", action.id);
    if (!events.length) {
      results.append(node("div", "result-intro", "No analytics events detected for this interaction."));
    } else {
      const intro = meaningful.length
        ? isAutomatic
          ? `${meaningful.length} automatic event${meaningful.length === 1 ? "" : "s"} detected.`
          : `${meaningful.length} event${meaningful.length === 1 ? "" : "s"} appeared after this interaction.`
        : "Additional analytics activity was detected.";
      results.append(node("div", "result-intro", intro));
      meaningful.forEach((event) => results.append(renderEventRow(event)));
      if (supporting.length) results.append(renderSupporting(action, supporting));
    }
    card.append(results);
  }
  return card;
}

function render() {
  if (renderFrameId !== null) {
    cancelAnimationFrame(renderFrameId);
    renderFrameId = null;
  }
  feed.replaceChildren();
  updateSourceOptions(currentState?.events || []);
  if (!hasSiteAccess) {
    feed.append(node("div", "notice", "WhatFired could not access this tab. Close the popup and click the extension icon again."));
    return;
  }
  if (explainingPermission) return renderPermissionExplanation();
  if (showReloadPrompt) feed.append(renderReloadPrompt());
  if (clearUndoAvailable) feed.append(renderClearUndo());
  const hasUsefulActivity = Boolean(currentState?.events?.length || currentState?.actions?.some((action) => action.kind !== "page"));
  if (accessMode === "temporary" && hasUsefulActivity && !dismissedKeepPrompt) feed.append(renderKeepPrompt());
  if (!currentState?.actions?.length) {
    resultsCount.textContent = "0 events";
    if (selectedSource) {
      const waiting = node("section", "empty-state");
      waiting.append(node("h2", "", `Waiting for ${selectedSource} events`), node("p", "", "This source preference is remembered for this site."));
      feed.append(waiting);
    } else {
      feed.append(emptyTemplate.content.cloneNode(true));
    }
    return;
  }

  const eventMap = new Map(currentState.events.map((event) => [event.id, event]));
  const query = searchQuery.trim().toLocaleLowerCase();
  const isFiltering = Boolean(query || selectedSource);
  const nextFilterSignature = isFiltering ? `${selectedSource}\u0000${query}` : "";
  const initializeFilteredExpansion = isFiltering && nextFilterSignature !== filterExpansionSignature;
  if (initializeFilteredExpansion || !isFiltering) openFilteredActions.clear();
  filterExpansionSignature = nextFilterSignature;
  const visibleActions = [...currentState.actions].reverse().slice(0, 50);
  let shownEvents = 0;
  let shownActions = 0;
  if (!isFiltering) {
    for (const action of visibleActions) {
      const actionEvents = action.eventIds.map((id) => eventMap.get(id)).filter(Boolean);
      shownEvents += actionEvents.length;
      shownActions += 1;
      feed.append(renderAction(action, eventMap));
    }
  } else {
    const matchingRows = [];
    for (const action of visibleActions) {
      const actionEvents = action.eventIds.map((id) => eventMap.get(id)).filter(Boolean);
      const sourceEvents = selectedSource ? actionEvents.filter((event) => providerFor(event) === selectedSource) : actionEvents;
      if (selectedSource && !sourceEvents.length) continue;
      const actionMatches = `${action.label} ${action.kind} ${action.path || ""}`.toLocaleLowerCase().includes(query);
      const matchingEvents = !query || actionMatches ? sourceEvents : sourceEvents.filter((event) => searchableEventText(event).includes(query));
      if (!actionMatches && !matchingEvents.length) continue;
      matchingRows.push({ action, events: matchingEvents });
      shownEvents += matchingEvents.length;
    }
    shownActions = matchingRows.length;
    if (initializeFilteredExpansion) {
      const preferred = matchingRows.find(({ action }) => action.kind !== "background") || matchingRows[0];
      if (preferred) openFilteredActions.add(preferred.action.id);
    }
    for (const { action, events } of matchingRows) feed.append(renderAction(action, eventMap, events, true));
  }
  resultsCount.textContent = isFiltering
    ? `${shownEvents} of ${currentState.events.length} events`
    : `${currentState.events.length} event${currentState.events.length === 1 ? "" : "s"}`;
  if (isFiltering && !shownActions) {
    const empty = node("section", "empty-state");
    if (selectedSource && !query) {
      if (currentState.events.length) {
        empty.append(
          node("h2", "", `No ${selectedSource} events shown`),
          node("p", "", `${currentState.events.length} event${currentState.events.length === 1 ? " is" : "s are"} available from other sources.`)
        );
        const showAllButton = node("button", "filter-reset-button", "Show all sources");
        showAllButton.type = "button";
        showAllButton.addEventListener("click", async () => {
          selectedSource = "";
          sourceSignature = "";
          await saveSourcePreference().catch(() => {});
          render();
          announce("Showing all analytics sources.");
        });
        empty.append(showAllButton);
      } else {
        empty.append(node("h2", "", `Waiting for ${selectedSource} events`), node("p", "", "The source filter remains active for this site."));
      }
    } else {
      empty.append(node("h2", "", "No matching events"), node("p", "", "Try another search or source."));
    }
    feed.append(empty);
  }
  feed.append(node("div", "listening", "Interact with the page to see the next events."));
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ kind: "GET_STATE", tabId: activeTabId });
  if (!response?.ok) return;
  currentState = response.state;
  const latest = currentState.actions.at(-1)?.id;
  if (!initialExpansionApplied) {
    const latestInteraction = [...currentState.actions].reverse().find((action) => action.kind !== "background");
    openActions.clear();
    openFilteredActions.clear();
    filterExpansionSignature = "";
    if (latestInteraction) openActions.add(latestInteraction.id);
    initialExpansionApplied = true;
  }
  if (latest) newestActionId = latest;
  render();
}

async function loadActiveTab() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  if (activeTabId !== tab.id) {
    hideClearUndo();
    sourceSignature = "";
    newestActionId = null;
    initialExpansionApplied = false;
    highlightedActions.clear();
    highlightedEvents.clear();
    openActions.clear();
    openFilteredActions.clear();
    filterExpansionSignature = "";
    openSupporting.clear();
    openTechnical.clear();
    openJson.clear();
    openEventId = null;
    explainingPermission = false;
  }
  activeTabId = tab.id;
  activeOrigin = patternFor(tab.url);
  siteLabel.textContent = tab.url ? new URL(tab.url).hostname || tab.title || "Current tab" : tab.title || "Current tab";
  if (!activeOrigin) {
    setAccessUi("none");
    feed.replaceChildren(node("div", "notice", "WhatFired works on normal http and https pages. Open a website, then click the WhatFired icon again."));
    return;
  }
  await loadSourcePreference();
  const persistent = await chrome.permissions.contains({ origins: [activeOrigin] });
  setAccessUi(persistent ? "persistent" : "temporary");
  if (!persistent) {
    const key = dismissPromptKey();
    const stored = await chrome.storage.session.get(key);
    dismissedKeepPrompt = stored[key] === true;
  }
  statusText.textContent = "Connecting";
  const connection = await chrome.runtime.sendMessage({ kind: "CHECK_TAB", tabId: activeTabId });
  if (!connection?.ok) {
    const injection = persistent
      ? await chrome.runtime.sendMessage({ kind: "ENABLE_TAB", tabId: activeTabId, origin: activeOrigin })
      : await chrome.runtime.sendMessage({ kind: "ENABLE_TEMP_TAB", tabId: activeTabId });
    if (!injection?.ok) {
      liveStatus.classList.add("is-off");
      statusText.textContent = "Reload needed";
      feed.replaceChildren(node("div", "notice", "WhatFired could not connect to this page. Reload the page, then reopen WhatFired."));
      return;
    }
    if (persistent) showReloadPrompt = true;
  }
  liveStatus.classList.remove("is-off");
  statusText.textContent = "Live";
  await loadState();
}

chrome.runtime.onMessage.addListener((message) => {
  if (!hasSiteAccess || message?.kind !== "STATE_UPDATED" || message.tabId !== activeTabId) return;
  markLiveArrivals(message.state);
  currentState = message.state;
  const latest = currentState.actions.at(-1)?.id;
  if (latest) newestActionId = latest;
  scheduleRender();
});

chrome.tabs.onActivated.addListener(() => {
  loadActiveTab().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === "loading") showReloadPrompt = false;
  if (tabId === activeTabId && (changeInfo.status === "complete" || changeInfo.url)) loadActiveTab().catch(() => {});
});

clearButton.addEventListener("click", async () => {
  if (!activeTabId || !(currentState?.actions?.length || currentState?.events?.length)) return;
  const response = await chrome.runtime.sendMessage({ kind: "CLEAR_STATE", tabId: activeTabId });
  if (response?.ok) {
    currentState = response.state;
    highlightedActions.clear();
    highlightedEvents.clear();
    openActions.clear();
    openFilteredActions.clear();
    filterExpansionSignature = "";
    openSupporting.clear();
    openTechnical.clear();
    openJson.clear();
    openEventId = null;
    hideClearUndo();
    clearUndoAvailable = response.undoAvailable === true;
    if (clearUndoAvailable) {
      clearUndoTimer = setTimeout(() => {
        hideClearUndo();
        render();
      }, Math.max(1000, Number(response.undoExpiresIn) || 10000));
    }
    render();
    announce("Captured activity cleared.");
  }
});

eventSearch.addEventListener("input", () => {
  searchQuery = eventSearch.value;
  render();
});

eventSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && eventSearch.value) {
    event.preventDefault();
    eventSearch.value = "";
    searchQuery = "";
    render();
  }
});

sourceSelect.addEventListener("change", async () => {
  selectedSource = sourceSelect.value;
  await saveSourcePreference().catch(() => {});
  render();
  announce(selectedSource ? `Showing ${selectedSource} events.` : "Showing all analytics sources.");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== eventSearch) {
    event.preventDefault();
    eventSearch.focus();
  }
});

loadActiveTab().catch(() => {
  feed.replaceChildren(node("div", "notice", "Open a normal web page, then reopen WhatFired."));
});
