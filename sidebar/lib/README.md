# Third-party libraries

## browser-polyfill.min.js

- **Version:** 0.12.0
- **Source:** https://github.com/mozilla/webextension-polyfill
- **License:** MPL-2.0
- **Purpose:** Maps `browser.*` Promise API to `chrome.*` in Chrome/Edge. No-op in Firefox where `browser` is already native. Required for Chrome (`manifest.chrome.json`) — loaded as first script in sidebar, options, content scripts, and the service worker.

## marked.min.js

- **Version:** 15.0.12
- **Source:** https://github.com/markedjs/marked
- **License:** MIT
- **Purpose:** Markdown-to-HTML rendering in the sidebar chat UI
