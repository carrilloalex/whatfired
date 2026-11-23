(() => {
  if (window.__signalEventInspectorBridgeInstalled) return;
  window.__signalEventInspectorBridgeInstalled = true;

  const PAGE_SOURCE = "signal-event-inspector-page";
  const BRIDGE_SOURCE = "signal-event-inspector-bridge";
  const ALLOWED_TYPES = new Set(["ACTION", "ACTION_UPDATE", "EVENT"]);
  const MAX_MESSAGE_BYTES = 131072;

  function isSafePayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try { return JSON.stringify(value).length <= MAX_MESSAGE_BYTES; } catch (_) { return false; }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    if (event.data.type === "HOOK_READY") {
      window.postMessage({ source: BRIDGE_SOURCE, type: "READY" }, "*");
      return;
    }
    if (!ALLOWED_TYPES.has(event.data.type) || !isSafePayload(event.data.payload)) return;
    try {
      chrome.runtime.sendMessage({ kind: "CAPTURE", captureType: event.data.type, payload: event.data.payload }).catch(() => {});
    } catch (_) {
      // Extension reloads invalidate the context until the page reloads.
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === "STOP_CAPTURE") window.postMessage({ source: BRIDGE_SOURCE, type: "STOP" }, "*");
    if (message?.kind === "START_CAPTURE") window.postMessage({ source: BRIDGE_SOURCE, type: "READY" }, "*");
    if (message?.kind === "PING_CAPTURE") {
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  window.postMessage({ source: BRIDGE_SOURCE, type: "READY" }, "*");
  setTimeout(() => window.postMessage({ source: BRIDGE_SOURCE, type: "READY" }, "*"), 50);
  setTimeout(() => window.postMessage({ source: BRIDGE_SOURCE, type: "READY" }, "*"), 250);
})();
