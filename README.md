# WhatFired

WhatFired is a lightweight browser extension for inspecting analytics events as they happen. It connects clicks, submissions and navigation with the events that follow them so product, analytics and engineering teams can find the right event names and properties without reading raw network requests.

## What it supports

WhatFired recognizes Segment, GA4, Google Tag Manager, RudderStack, Amplitude, Mixpanel, PostHog, Heap, Snowplow, Dreamdata, Attribution and compatible analytics endpoints.

## Privacy

WhatFired has no developer-operated server and makes no external network requests. Captured analytics data stays inside the browser.

Read the [privacy policy](docs/privacy-policy.html) and the [security design](extension/SECURITY.md).

## Install locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, Brave or another Chromium browser.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `extension` folder.

## Repository structure

- `extension/` contains the browser extension source.
- `docs/` contains the public website and privacy policy for GitHub Pages.

## Publish the privacy site

In the GitHub repository settings, open **Pages**. Select **Deploy from a branch**, choose the `main` branch and set the folder to `/docs`.

The privacy policy will be available at:

```text
https://YOUR-GITHUB-USERNAME.github.io/whatfired/privacy-policy.html
```

## Development

The extension has no build step, package manager or remote dependencies. Edit the files in `extension/` and reload the unpacked extension from the extensions page.

## Status

WhatFired is independently developed by Alejandro Carrillo. Product names belong to their respective owners.

## License

WhatFired is open source under the [MIT License](LICENSE).
