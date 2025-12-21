# Mailtrack Chrome Extension

Chrome extension that automatically inserts tracking pixels into Gmail compose windows and shows desktop notifications when emails are opened.

## Related Repository

**Main backend repo**: /Users/michaelbuckingham/Documents/my-apps/mailtracker

See the CLAUDE.md in the mailtracker repo for comprehensive documentation of:
- Server credentials and deployment
- API endpoints and authentication
- Database schema
- Full architecture overview
- Notification system details

## Quick Reference

- **API Base**: https://mailtrack.tachyonfuture.com
- **API Key**: `ldENqwQVrLtf2pzBSpAtPdEqaF+JkVuhFXYfAlBWthE=`

## Extension Structure

```
mailtracker-extension/
├── manifest.json              # Chrome extension manifest v3 (permissions: storage, activeTab, alarms, notifications)
├── popup/
│   ├── popup.html            # Settings UI (API key config, notification toggle)
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── gmail.js              # Gmail content script (main logic)
│   ├── xhr-interceptor.js    # Page context script (intercepts XHR/fetch)
│   └── gmail.css             # Tracking badge styles
├── background/
│   └── service-worker.js     # Handles API calls + notification polling
└── icons/
    └── *.png                 # Extension icons
```

## Key Implementation Details

### Browser Notifications
- Uses `chrome.alarms` API to poll every 2 minutes
- Fetches recent opens from `/api/opens/recent?since={timestamp}`
- Shows desktop notification via `chrome.notifications.create()` for each new real open
- Only notifies for real opens (proxy opens are filtered server-side)
- Controlled by `showNotification` setting in popup

### CORS Workaround
Content scripts running on mail.google.com cannot make cross-origin fetch requests. Solution:
1. Content script (`gmail.js`) uses `chrome.runtime.sendMessage()` to send data to background
2. Service worker (`service-worker.js`) makes the actual API call
3. Response is passed back via the message callback

### Gmail Detection
- Uses MutationObserver to watch for compose windows
- Detects compose body via selectors: `div[aria-label="Message Body"]`, `div[g_editable="true"]`
- Intercepts send button click, inserts pixel, then re-triggers send

### Message Types
- `CREATE_TRACK` - Create new tracking pixel via API
- `CHECK_CONNECTION` - Test API connectivity (used by popup)

## Installation (Developer Mode)

1. `chrome://extensions/` → Enable Developer mode
2. Load unpacked → Select this folder
3. Click extension icon → Enter API key → Save

## Development

After making changes:
```bash
git add -A && git commit -m "message" && git push
```
Then reload extension in `chrome://extensions/`
