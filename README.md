# Mailtrack Chrome Extension

A Chrome extension that automatically inserts tracking pixels into Gmail compose windows and notifies you when emails are opened.

## Features

- Automatically inserts tracking pixels when you send emails
- **Desktop notifications** when emails are opened (polls every 2 minutes)
- Manual insert button in compose toolbar
- Visual indicator when tracking is enabled
- Syncs settings across Chrome browsers
- Filters out proxy opens (Apple Mail Privacy Protection, Google Image Proxy)

## Installation (Developer Mode)

Since this is a personal extension, you'll load it unpacked:

1. **Generate Icons** (one-time setup):
   - Open `icons/create-icons.html` in Chrome
   - Right-click each canvas and "Save image as..."
   - Save as `icon16.png`, `icon48.png`, `icon128.png` in the `icons/` folder

2. **Load the Extension**:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select this folder (`mailtracker-extension`)

3. **Configure**:
   - Click the extension icon in Chrome toolbar
   - Enter your API key
   - Toggle "Show Notifications" to enable desktop alerts
   - Click "Save Settings"

## How It Works

The extension uses XHR interception to inject tracking pixels at the network layer, bypassing Gmail's content sanitization:

1. When you open Gmail, the extension:
   - Watches for compose windows
   - Injects an XHR interceptor into the page context
2. When you click Send:
   - Creates a new tracking pixel via the Mailtrack API
   - Sends pixel data to the XHR interceptor
   - The interceptor modifies Gmail's send request to include the pixel
3. The email arrives with the invisible 1x1 tracking pixel
4. When the recipient opens the email, the pixel loads and logs the open

**Why XHR Interception?**
Gmail strips programmatically-inserted DOM content during send. By intercepting the XHR request, we inject the pixel AFTER Gmail processes the email but BEFORE it leaves the browser.

## Files

```
mailtracker-extension/
├── manifest.json          # Chrome extension manifest v3
├── popup/
│   ├── popup.html        # Settings popup UI
│   ├── popup.css         # Popup styles
│   └── popup.js          # Popup logic
├── content/
│   ├── gmail.js          # Gmail content script (coordinates tracking)
│   ├── xhr-interceptor.js # Page context script (intercepts XHR/fetch)
│   └── gmail.css         # Gmail styles
├── background/
│   └── service-worker.js # Background service worker (handles API calls)
└── icons/
    ├── create-icons.html # Icon generator
    ├── icon16.png        # Toolbar icon
    ├── icon48.png        # Extension page icon
    └── icon128.png       # Chrome Web Store icon
```

## API Connection

The extension connects to:
- **API Base**: `https://mailtrack.tachyonfuture.com`
- **Create Track**: `POST /api/tracks`
- **Check Stats**: `GET /api/stats`
- **Recent Opens**: `GET /api/opens/recent?since={timestamp}` (for notifications)

All requests include the `X-API-Key` header.

## Troubleshooting

### Extension not working
1. Check that you've entered the correct API key
2. Make sure the extension is enabled
3. Reload Gmail after installing/updating the extension

### "Cannot reach server" error
- Check that https://mailtrack.tachyonfuture.com is accessible
- Verify your API key is correct

### Tracking pixel not inserted
- Look for the green "✓ Tracking" badge in the compose toolbar
- Check the browser console for errors (F12 → Console)

### Not receiving notifications
- Make sure "Show Notifications" is enabled in extension settings
- Check that Chrome has permission to show notifications (System Preferences → Notifications → Chrome)
- Notifications only appear for "real" opens (proxy opens from Apple/Google are filtered out)
- Notifications poll every 2 minutes, so there may be a short delay

## Development

To modify the extension:
1. Edit the files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload Gmail

## Privacy

- The extension only activates on `mail.google.com`
- It only sends recipient/subject to your own Mailtrack server
- No data is sent to third parties
