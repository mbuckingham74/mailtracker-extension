# Mailtrack Chrome Extension

Chrome extension that automatically inserts tracking pixels into Gmail compose windows.

## Related Repository

**Main backend repo**: /Users/michaelbuckingham/Documents/my-apps/mailtracker

See the CLAUDE.md in the mailtracker repo for comprehensive documentation of:
- Server credentials and deployment
- API endpoints and authentication
- Database schema
- Full architecture overview

## Quick Reference

- **API Base**: https://mailtrack.tachyonfuture.com
- **API Key**: `4gPuf7qyuHJMUtOQAUTOeI4RL3TfzXrwRrn/+Fte9yM=`

## Extension Structure

```
mailtracker-extension/
├── manifest.json              # Chrome extension manifest v3
├── popup/
│   ├── popup.html            # Settings UI (API key config)
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── gmail.js              # Gmail content script (main logic)
│   └── gmail.css             # Tracking badge styles
├── background/
│   └── service-worker.js     # Handles API calls (avoids CORS)
└── icons/
    └── *.png                 # Extension icons
```

## Key Implementation Details

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
