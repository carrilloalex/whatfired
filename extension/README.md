# WhatFired

WhatFired is a live analytics event tracker that groups events under the page interaction they appeared after. It starts immediately in the tab where it is opened, with optional one-time site access for automatic tracking across tabs and reloads.

Its magnifier-and-signal identity is supplied at 16, 32, 48, and 128 pixels for Chrome's toolbar, extension manager, popup, and store surfaces.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` folder.
5. Open a normal website and click the WhatFired extension icon. It opens as a compact bubble attached to the toolbar without changing the website layout.
6. Interact with the page. No site permission is required for temporary inspection.
7. Optionally choose **Always track this site** to catch initial page-load events and new tabs before opening WhatFired.

## Try the included fixture

From the parent directory, start a local server:

```powershell
python -m http.server 8000
```

Open:

```text
http://localhost:8000/extension/test/fixture.html
```

Open the WhatFired popup, click the fixture buttons, then reopen the popup to review the captured activity.

## MVP capabilities

- Starts immediately in the current tab; there is no recording/session button or initial permission gate.
- Offers optional persistent access only after useful activity is captured, covering new tabs and reloads on that origin.
- Opens as a familiar toolbar popup, like common privacy and utility extensions, without changing the website viewport.
- Keeps capturing in the background when the popup closes; click the icon again to review the latest activity.
- Captures clicks, form submissions, selected control changes, initial page loads, and SPA navigation.
- Wraps common browser SDK calls for Segment, RudderStack, Amplitude, Mixpanel, PostHog and Heap.
- Observes analytics requests sent through `fetch`, XHR, and `sendBeacon`, including JSON, batched, form-encoded and Base64-wrapped payloads.
- Recognizes Segment, RudderStack, Dreamdata, Attribution, Amplitude, Mixpanel, PostHog, Google Analytics, Heap and Snowplow endpoints.
- Recognizes strict analytics-event shapes on first-party proxy and custom collection domains.
- Observes Google Tag Manager and Google Analytics event pushes through `dataLayer`.
- Groups captured events under the interaction active when they fired.
- Separates useful product signals from technical/supporting events.
- Shows the exact event name and one useful property by default.
- Lets users copy the event name and individual property values for Amplitude or another analytics tool.
- Shows a plain-language explanation while keeping provider and implementation details secondary.
- Reveals capture source, delivery evidence, identifiers, and raw JSON only on request.
- Stores recent activity locally in Chrome's session storage. Nothing is transmitted by WhatFired.

## Intentional MVP exclusions

- No Amplitude connection or funnel creation.
- No AI interpretation.
- No event-schema validation.
- No saved sessions or cloud sync.
- No cross-tab journey stitching.
- No guarantee that delayed asynchronous events were caused by the nearest interaction. Events with no defensible relationship are grouped as background activity.

## Privacy and security

- No persistent website access is requested at installation. Clicking WhatFired grants temporary access to that tab without a warning.
- Optional **Always track this site** access is granted one origin at a time and can be revoked through Chrome's extension site-access controls.
- All captured data stays inside the browser and is kept only in memory-backed session storage.
- The extension does not make external network requests.
- Input text values are never captured.
- Credential-like fields such as passwords, tokens, authorization headers, cookies, API keys, and secrets are redacted during serialization.
- Page text is used only for short labels on interactive controls such as buttons and links. Arbitrary page body text is not collected.
- Payload size, event rate, history, and per-field length are capped.
- WhatFired requests no access to downloads, browsing history, cookies, the clipboard, native applications, debugging or the computer filesystem.

See [SECURITY.md](SECURITY.md) for the threat model and residual risks.

## Accessibility

The popup targets WCAG 2.2 Level AA. It includes high-contrast light and dark palettes, visible keyboard focus, minimum 24 CSS pixel targets, programmatic expanded and selected states, screen-reader announcements, forced-colors support, and reduced-motion support. Text and controls remain usable without relying on color alone.

## Finding events quickly

The 600-pixel-wide popup includes instant search across event names, property keys, property values and analytics providers. Matching groups open when a filter changes and remain independently collapsible. Press `/` to focus search and `Escape` to clear it.

When a filter is active the result count shows the visible subset out of the total captured events. A selected source stays on a neutral surface with a blue inner boundary and blue text. Expanded event rows remain unfilled while their title and disclosure chevron use the same blue. Keyboard focus uses a thicker external outline. If the selected source has no visible events, the empty state explains that other events exist and offers a one-click return to all sources.

The event list stays intentionally minimal: event names and one useful property are visible immediately while the remaining properties and individual copy controls appear only after opening an event. Version 1.0 uses quiet tonal surfaces, restrained live-arrival motion and inline copy confirmation. Motion respects the browser's reduced-motion preference.

Action groups and event rows use the same disclosure chevron in normal and filtered views. When a filter changes only the newest relevant matching group opens while the remaining matches stay collapsed. Every group can still be expanded or collapsed independently. At narrow widths the provider badge yields space to the disclosure control while the provider name remains visible in the event summary.

Clearing captured activity offers a 10-second Undo action. WhatFired retains at most one short-lived snapshot in extension memory. It expires automatically and is removed if the tab closes or site access is revoked.

Expanded events provide individual copy controls for the exact event name and every property value, making it easy to transfer identifiers into Amplitude without selecting text manually.

Clicks and submissions that lead to navigation are represented as one journey, such as `Clicked “Pricing” → “Pricing plans”`. SPA route changes and the next full document enrich the initiating interaction instead of creating duplicate cards, while automatic navigation without a recent user action remains separate.

When multiple analytics providers are detected, a source selector appears beside search with counts for Segment, Google Tag Manager, Amplitude, and other providers. With `All sources` selected, accessible provider badges make mixed timelines scannable; the badges disappear when one source is selected.

Experiment events such as `ab_test`, `experiment`, and `exposure` remain in the normal event list. Their subtitle surfaces the experiment identifier and variant from common properties such as `test_id`, `experiment_name`, `variant`, and `variant_label`, while exact values remain available through individual copy controls.

The selected analytics source is remembered automatically per site origin across tabs, navigation, popup closes, and browser restarts. Choosing `All sources` removes that site's saved preference. Only the origin and provider name are stored locally; captured analytics remain session-only.

Runtime safeguards keep the extension lightweight on noisy pages: popup updates are coalesced to one render per animation frame, analytics discovery polling stops when capture is disabled, and per-tab state compacts older raw JSON before considering removal of normalized events.

## Known limitations

- Sites that replace or freeze their analytics SDK methods may only be visible through network observation.
- Private, encrypted, compressed, server-side-only or completely custom tracking cannot always be decoded in-browser.
- `FormData`, compressed streams and opaque request bodies are not decoded in the MVP.
- Event-to-action attribution uses synchronous context plus a short timing window. The UI avoids claiming certainty when no interaction is identified.
- Browser-internal pages such as `chrome://` cannot run content scripts.
- An enabled website can forge analytics-looking messages for its own tab. Those records are untrusted display data; they do not invoke privileged extension actions.
