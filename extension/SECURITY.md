# WhatFired security model

WhatFired is designed for work browsers with least privilege and a small blast radius. This document describes the controls in version 1.0.12. It is a design review, not a claim of independent security certification.

## Permission boundary

- Installation grants no persistent website access.
- Opening WhatFired uses Chrome's temporary `activeTab` grant for the deliberately invoked tab and displays no site-access warning.
- The optional **Always track this site** action requests one `http` or `https` origin after explaining why. It enables initial page-load and new-tab capture for that origin.
- Automatic tracking can be revoked through Chrome's extension site-access controls. Revocation also purges session captures associated with that origin.
- Incognito use is disabled.
- WhatFired has no permissions for browsing history, cookies, downloads, clipboard reading, native messaging, debugger access, proxy configuration or filesystem access.
- Extension pages use a restrictive Content Security Policy and load no remote code.

## Data boundary

- WhatFired makes no external network requests and has no server component.
- Captures are stored in `chrome.storage.session`, which Chrome keeps in memory and clears when the browser restarts or the extension is reloaded, disabled, or updated.
- A source-filter preference may be stored in `chrome.storage.local` as an origin-to-provider mapping. It contains no page paths, events, properties, or payloads; selecting **All sources** deletes the mapping for that origin.
- Remembered source preferences expire after 90 days and are capped at 50 origins.
- Session and local storage are restricted to trusted extension contexts and are not exposed to content scripts.
- Obvious credential-like keys are redacted before data crosses into the extension.
- Strings, arrays, object depth, object keys, messages, retained actions, retained events, and message rate are capped.
- Retained tab state has a 3 MB soft budget and 4 MB emergency ceiling. Under pressure, older raw JSON is compacted first, then system noise; normalized product events are removed only as a last resort. Immediate session writes remain enabled to avoid losing recent captures if Chrome suspends the service worker.
- Text typed into inputs is never read. Interaction labels come only from metadata and short text on interactive controls.
- Network request bodies are accepted from a maintained list of analytics providers or when they match a strict analytics-event shape. Nonmatching bodies are discarded and never cross into extension storage.

## Untrusted page model

Code running on an enabled website is untrusted. A website can imitate analytics messages and cause false records to appear in WhatFired for that tab. WhatFired therefore treats all captured records as display-only data: they cannot request permissions, execute extension commands, access another tab or trigger computer-level operations.

Messages entering the service worker are checked for extension identity, an enabled origin, an allowed message type, schema shape, payload size and rate. Control messages are accepted only from WhatFired's own extension pages.

## Residual risk

Any extension that explains a site's analytics must read some data from that site. In temporary mode, access is limited to a deliberately invoked tab and origin. While persistent access is enabled, a compromised WhatFired build could read page data available to its injected script across that origin. Per-origin permissions contain this risk; they do not make a compromised build harmless.

For sensitive production systems, use a test account with minimal privileges, enable only the necessary origin, revoke access after testing, and have enterprise security review and sign the exact build before managed deployment.

## Packaging guidance for companies

1. Review source and dependency inventory (this MVP has no third-party runtime dependencies).
2. Build and sign from a controlled CI environment.
3. Pin the extension ID and update URL with enterprise policy.
4. Restrict allowed origins through enterprise policy where appropriate.
5. Re-review every permission or analytics-host allowlist change.
