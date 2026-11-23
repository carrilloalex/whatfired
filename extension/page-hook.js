(() => {
  if (window.__signalEventInspectorInstalled) return;
  window.__signalEventInspectorInstalled = true;

  const PAGE_SOURCE = "signal-event-inspector-page";
  const BRIDGE_SOURCE = "signal-event-inspector-bridge";
  const MAX_TEXT_LENGTH = 80;
  const MAX_VALUE_LENGTH = 2048;
  const SENSITIVE_KEY = /(password|passwd|token|authorization|secret|cookie|credit.?card|cvv|private.?key|api.?key|access.?key|session.?key|ssn)/i;
  const PROVIDER_RULES = [
    ["Segment", /(^|\.)(segment\.io|segment\.com)$/i],
    ["RudderStack", /(^|\.)(rudderlabs\.com|rudderstack\.com)$/i],
    ["Dreamdata", /(^|\.)(dreamdata\.cloud|dreamdata\.io)$/i],
    ["Attribution", /(^|\.)(attributionapp\.com|attribution\.io)$/i],
    ["Amplitude", /(^|\.)(amplitude\.com)$/i],
    ["Mixpanel", /(^|\.)(mixpanel\.com)$/i],
    ["PostHog", /(^|\.)(posthog\.com)$/i],
    ["Google Analytics", /(^|\.)(google-analytics\.com|analytics\.google\.com)$/i],
    ["Heap", /(^|\.)(heapanalytics\.com|heap\.io)$/i],
    ["Snowplow", /(^|\.)(snowplowanalytics\.com|snowplow\.io)$/i]
  ];
  const wrappedFunctions = new WeakMap();
  let sequence = 0;
  let bridgeReady = false;
  let stopped = false;
  let pageActionCreated = false;
  let activeAction = null;
  let analyticsPollTimer = null;

  function id(prefix) {
    sequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function post(type, payload) {
    if (!bridgeReady || stopped) return;
    window.postMessage({ source: PAGE_SOURCE, type, payload }, "*");
  }

  function cleanText(value, fallback = "") {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    return text.slice(0, MAX_TEXT_LENGTH);
  }

  function cloneSafe(value, depth = 0, seen = new WeakSet()) {
    if (depth > 6) return "[truncated]";
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string") return value.slice(0, MAX_VALUE_LENGTH);
    if (["number", "boolean"].includes(typeof value)) return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "function") return "[function]";
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => cloneSafe(item, depth + 1, seen));
    }

    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : cloneSafe(child, depth + 1, seen);
    }
    return result;
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) return `[data-testid="${cleanText(testId)}"]`;
    const name = element.getAttribute("name");
    if (name) return `${element.tagName.toLowerCase()}[name="${cleanText(name)}"]`;
    const classes = [...element.classList].slice(0, 2).map((item) => `.${CSS.escape(item)}`).join("");
    return `${element.tagName.toLowerCase()}${classes}`;
  }

  function labelFor(element) {
    if (!(element instanceof Element)) return "page";
    const control = element.closest("button, a, [role='button'], input, select, textarea, label, summary");
    if (!control) return cleanText(element.tagName.toLowerCase(), "element");
    const aria = control.getAttribute("aria-label");
    const title = control.getAttribute("title");
    const labelledBy = control.getAttribute("aria-labelledby");
    let labelledText = "";
    if (labelledBy) {
      labelledText = labelledBy.split(/\s+/).map((item) => document.getElementById(item)?.textContent || "").join(" ");
    }
    const inputLabel = control.labels ? [...control.labels].map((item) => item.textContent).join(" ") : "";
    return cleanText(aria || labelledText || inputLabel || title || control.getAttribute("name") || control.textContent || control.tagName.toLowerCase(), "element");
  }

  function createAction(kind, label, element = null, duration = 2200, extra = {}) {
    const now = Date.now();
    activeAction = {
      id: id("action"),
      kind,
      label: cleanText(label, "Interaction"),
      triggerLabel: cleanText(extra.triggerLabel || label, "Interaction"),
      selector: selectorFor(element),
      url: location.href,
      path: location.pathname,
      destinationUrl: String(extra.destinationUrl || "").slice(0, MAX_VALUE_LENGTH),
      destinationPath: cleanText(extra.destinationPath),
      timestamp: now,
      expiresAt: now + duration
    };
    post("ACTION", cloneSafe(activeAction));
    return activeAction;
  }

  function currentActionId() {
    return activeAction && activeAction.expiresAt >= Date.now() ? activeAction.id : null;
  }

  function pageLabel() {
    const title = cleanText(document.title);
    if (title) return `Opened “${title}”`;
    const path = location.pathname === "/" ? location.hostname : location.pathname;
    return `Opened “${cleanText(path, "page")}”`;
  }

  function createInitialPageAction() {
    if (pageActionCreated || !bridgeReady) return;
    pageActionCreated = true;
    createAction("page", pageLabel(), null, 5000);
  }

  function navigationDestination() {
    const title = cleanText(document.title);
    return title || cleanText(location.pathname === "/" ? location.hostname : location.pathname, "page");
  }

  function recordNavigationOutcome() {
    if (stopped) return;
    const now = Date.now();
    const canCorrelate = activeAction && ["click", "navigation", "submit"].includes(activeAction.kind) && now - activeAction.timestamp <= 4000;
    if (!canCorrelate) {
      createAction("navigation", `Navigated to “${navigationDestination()}”`, null, 4000);
      return;
    }
    const trigger = activeAction.triggerLabel || activeAction.label;
    activeAction.kind = "navigation";
    activeAction.triggerLabel = trigger;
    activeAction.label = `${trigger} → “${navigationDestination()}”`;
    activeAction.destinationUrl = location.href;
    activeAction.destinationPath = location.pathname;
    activeAction.expiresAt = now + 5000;
    post("ACTION_UPDATE", cloneSafe(activeAction));
  }

  function eventEnvelope(type, name, properties, extra, source, raw) {
    return {
      id: id("event"),
      type: cleanText(type, "track").toLowerCase(),
      name: cleanText(name, type || "Analytics event"),
      properties: cloneSafe(properties || {}),
      extra: cloneSafe(extra || {}),
      raw: cloneSafe(raw || {}),
      source,
      actionId: currentActionId(),
      timestamp: Date.now(),
      url: location.href
    };
  }

  function captureSdkCall(provider, method, args) {
    if (stopped) return;
    let name = method;
    let properties = {};
    let extra = {};

    if (["track", "capture", "logEvent"].includes(method)) {
      name = args[0] || "Track event";
      properties = args[1] || {};
      extra = { provider, options: args[2] || {} };
    } else if (method === "identify") {
      name = "identify";
      properties = typeof args[0] === "object" ? args[0] : (args[1] || {});
      extra = { provider, userId: typeof args[0] === "string" ? args[0] : null, options: args[2] || {} };
    } else if (method === "group") {
      name = "group";
      properties = args[1] || {};
      extra = { provider, groupId: args[0], options: args[2] || {} };
    } else if (method === "alias") {
      name = "alias";
      properties = {};
      extra = { provider, userId: args[0], previousId: args[1], options: args[2] || {} };
    } else if (method === "page" || method === "screen") {
      const hasCategory = typeof args[1] === "string";
      name = hasCategory ? args[1] : (typeof args[0] === "string" ? args[0] : `${method} viewed`);
      properties = (hasCategory ? args[2] : args[1]) || {};
      extra = { provider, category: hasCategory ? args[0] : null, options: (hasCategory ? args[3] : args[2]) || {} };
    }

    const eventType = ["track", "capture", "logEvent"].includes(method) ? "track" : method;
    post("EVENT", eventEnvelope(eventType, name, properties, extra, "sdk", { provider, method, args: cloneSafe(args) }));
  }

  function wrapAnalyticsMethod(analytics, provider, method) {
    const original = analytics?.[method];
    if (typeof original !== "function") return;
    if (original.__signalEventInspectorWrapped) return;
    if (wrappedFunctions.has(original)) return;

    function wrapped(...args) {
      captureSdkCall(provider, method, args);
      return original.apply(this, args);
    }
    Object.defineProperty(wrapped, "__signalEventInspectorWrapped", { value: true });
    wrappedFunctions.set(original, wrapped);
    try {
      analytics[method] = wrapped;
    } catch (_) {
      // Some SDK objects expose read-only methods. Network capture remains available.
    }
  }

  function ensureAnalyticsWrapped() {
    if (stopped) return;
    const candidates = [
      [window.analytics, "Segment", ["track", "page", "screen", "identify", "group", "alias"]],
      [window.rudderanalytics, "RudderStack", ["track", "page", "screen", "identify", "group", "alias"]],
      [window.amplitude, "Amplitude", ["track", "logEvent", "identify"]],
      [window.mixpanel, "Mixpanel", ["track", "identify"]],
      [window.posthog, "PostHog", ["capture", "identify", "group"]],
      [window.heap, "Heap", ["track", "identify"]]
    ];
    for (const [analytics, provider, methods] of candidates) {
      if (!analytics || (typeof analytics !== "object" && typeof analytics !== "function")) continue;
      methods.forEach((method) => wrapAnalyticsMethod(analytics, provider, method));
    }
    ensureDataLayerWrapped();
  }

  function startAnalyticsPolling() {
    if (stopped || analyticsPollTimer !== null) return;
    ensureAnalyticsWrapped();
    analyticsPollTimer = setInterval(ensureAnalyticsWrapped, 750);
  }

  function stopAnalyticsPolling() {
    if (analyticsPollTimer === null) return;
    clearInterval(analyticsPollTimer);
    analyticsPollTimer = null;
  }

  function ensureDataLayerWrapped() {
    const dataLayer = window.dataLayer;
    if (!Array.isArray(dataLayer) || dataLayer.push?.__signalEventInspectorWrapped) return;
    const original = dataLayer.push;
    function wrappedPush(...items) {
      if (stopped) return original.apply(this, items);
      for (const item of items) {
        const command = item && typeof item === "object" ? item[0] : null;
        if (command === "event" && typeof item[1] === "string") {
          post("EVENT", eventEnvelope("track", item[1], item[2] || {}, { provider: "Google Analytics", transport: "dataLayer" }, "dataLayer", item));
        } else if (item && typeof item === "object" && typeof item.event === "string") {
          const properties = { ...item };
          delete properties.event;
          post("EVENT", eventEnvelope("track", item.event, properties, { provider: "Google Tag Manager", transport: "dataLayer" }, "dataLayer", item));
        }
      }
      return original.apply(this, items);
    }
    Object.defineProperty(wrappedPush, "__signalEventInspectorWrapped", { value: true });
    try { dataLayer.push = wrappedPush; } catch (_) {}
  }

  function parseJson(value) {
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function decodeBase64Json(value) {
    try { return parseJson(atob(String(value).replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) { return null; }
  }

  function parsePayload(body, url) {
    if (typeof body === "string" && body.trim()) {
      const json = parseJson(body);
      if (json) return json;
      try {
        const params = new URLSearchParams(body);
        for (const key of ["data", "payload", "batch"]) {
          const value = params.get(key);
          if (!value) continue;
          const decoded = parseJson(value) || decodeBase64Json(value);
          if (decoded) return decoded;
        }
        if ([...params.keys()].length) return Object.fromEntries(params);
      } catch (_) {}
    }
    try {
      const params = new URL(String(url || ""), location.href).searchParams;
      for (const key of ["data", "payload", "batch"]) {
        const value = params.get(key);
        const decoded = value && (parseJson(value) || decodeBase64Json(value));
        if (decoded) return decoded;
      }
      return Object.fromEntries(params);
    } catch (_) { return null; }
  }

  function providerForUrl(url) {
    try {
      const parsed = new URL(String(url || ""), location.href);
      const rule = PROVIDER_RULES.find(([, pattern]) => pattern.test(parsed.hostname));
      return { name: rule?.[0] || "Other analytics", known: Boolean(rule), parsed };
    } catch (_) { return { name: "Other analytics", known: false, parsed: null }; }
  }

  function payloadItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.batch)) return payload.batch;
    if (Array.isArray(payload.events)) return payload.events;
    return [payload];
  }

  function looksLikeAnalyticsEvent(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const type = String(item.type || "").toLowerCase();
    const segmentShape = ["track", "page", "screen", "identify", "group", "alias"].includes(type) && Boolean(
      item.messageId || item.event || item.name || item.anonymousId || item.userId ||
      item.properties || item.traits || item.context || item.integrations
    );
    const namedShape = typeof (item.event || item.event_type || item.event_name) === "string" && Boolean(
      item.properties || item.event_properties || item.traits || item.distinct_id || item.device_id || item.user_id || item.uuid
    );
    return segmentShape || namedShape;
  }

  function normalizedEvent(provider, item, url) {
    if (!item || typeof item !== "object") return null;
    let type = item.type || "track";
    let name = item.event || item.event_type || item.event_name || item.name;
    let properties = item.properties || item.event_properties || item.traits || item.params || {};
    const extra = {
      provider,
      context: item.context,
      integrations: item.integrations,
      userProperties: item.user_properties,
      transportUrl: String(url || "").slice(0, 500)
    };
    if (provider === "Amplitude" && String(name || "").toLowerCase().includes("identify")) type = "identify";
    if (!name && ["identify", "group", "alias", "page", "screen"].includes(String(type).toLowerCase())) name = type;
    if (!name) return null;
    return { type, name, properties, extra };
  }

  function captureGoogleAnalyticsUrl(providerInfo) {
    if (providerInfo.name !== "Google Analytics" || !providerInfo.parsed) return;
    const params = providerInfo.parsed.searchParams;
    const name = params.get("en") || params.get("ea") || params.get("t");
    if (!name || name === "pageview") return;
    const properties = {};
    for (const [key, value] of params) {
      if (key.startsWith("ep.")) properties[key.slice(3)] = value;
      if (key.startsWith("up.")) properties[`user_${key.slice(3)}`] = value;
    }
    post("EVENT", eventEnvelope("track", name, properties, { provider: "Google Analytics", transportUrl: providerInfo.parsed.href.slice(0, 500) }, "network", Object.fromEntries(params)));
  }

  function captureNetworkBody(url, body, includeUrlEvent = true) {
    if (stopped) return;
    const providerInfo = providerForUrl(url);
    if (includeUrlEvent) captureGoogleAnalyticsUrl(providerInfo);
    const payload = parsePayload(body, url);
    const items = payloadItems(payload);
    if (!providerInfo.known && !items.some(looksLikeAnalyticsEvent)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (!providerInfo.known && !looksLikeAnalyticsEvent(item)) continue;
      const normalized = normalizedEvent(providerInfo.name, item, url);
      if (!normalized) continue;
      post("EVENT", eventEnvelope(normalized.type, normalized.name, normalized.properties, normalized.extra, "network", item));
    }
  }

  function inspectNetworkBody(url, body) {
    if (stopped) return;
    if (typeof body === "string") {
      captureNetworkBody(url, body, false);
      return;
    }
    if (body instanceof URLSearchParams) {
      captureNetworkBody(url, body.toString(), false);
      return;
    }
    if (body instanceof Blob) {
      body.text().then((value) => captureNetworkBody(url, value, false)).catch(() => {});
    }
  }

  function installNetworkObservers() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function signalFetch(input, init) {
        if (!stopped) {
          const url = typeof input === "string" ? input : input?.url;
          captureNetworkBody(url, "");
          inspectNetworkBody(url, init?.body);
          if (!init?.body && input instanceof Request) {
            input.clone().text().then((value) => captureNetworkBody(url, value, false)).catch(() => {});
          }
        }
        return originalFetch.apply(this, arguments);
      };
    }

    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    if (originalBeacon) {
      navigator.sendBeacon = function signalBeacon(url, data) {
        captureNetworkBody(url, "");
        inspectNetworkBody(url, data);
        return originalBeacon(url, data);
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function signalOpen(method, url) {
      this.__signalEventInspectorUrl = url;
      captureNetworkBody(url, "");
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function signalSend(body) {
      inspectNetworkBody(this.__signalEventInspectorUrl, body);
      return originalSend.apply(this, arguments);
    };
  }

  function installInteractionObservers() {
    window.addEventListener("click", (event) => {
      if (stopped) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const label = labelFor(target);
      const link = target.closest("a[href]");
      let destinationUrl = "";
      let destinationPath = "";
      if (link) {
        try {
          const destination = new URL(link.href, location.href);
          destinationUrl = destination.href;
          destinationPath = destination.pathname;
        } catch (_) {}
      }
      createAction(link ? "navigation" : "click", `Clicked “${label}”`, target, link ? 8000 : 2200, { destinationUrl, destinationPath });
    }, true);

    window.addEventListener("submit", (event) => {
      if (stopped) return;
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      const label = form ? labelFor(form) : "form";
      createAction("submit", `Submitted “${label}”`, form, 3000);
    }, true);

    window.addEventListener("change", (event) => {
      if (stopped) return;
      const target = event.target;
      if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type))) return;
      createAction("change", `Changed “${labelFor(target)}”`, target);
    }, true);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function signalPushState() {
      const result = originalPushState.apply(this, arguments);
      recordNavigationOutcome();
      return result;
    };
    history.replaceState = function signalReplaceState() {
      const result = originalReplaceState.apply(this, arguments);
      recordNavigationOutcome();
      return result;
    };
    window.addEventListener("popstate", recordNavigationOutcome);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== BRIDGE_SOURCE) return;
    if (event.data?.type === "STOP") {
      stopped = true;
      bridgeReady = false;
      stopAnalyticsPolling();
      return;
    }
    if (event.data?.type === "READY") {
      stopped = false;
      bridgeReady = true;
      startAnalyticsPolling();
      createInitialPageAction();
    }
  });

  installInteractionObservers();
  installNetworkObservers();
  startAnalyticsPolling();
  document.addEventListener("DOMContentLoaded", () => {
    if (activeAction?.kind === "page") {
      activeAction.label = pageLabel();
      activeAction.url = location.href;
      activeAction.path = location.pathname;
      post("ACTION_UPDATE", cloneSafe(activeAction));
    }
    if (!stopped) ensureAnalyticsWrapped();
  }, { once: true });

  window.postMessage({ source: PAGE_SOURCE, type: "HOOK_READY" }, "*");
})();
