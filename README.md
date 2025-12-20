# Mailtrack Chrome Extension

A Chrome extension that automatically inserts tracking pixels into Gmail compose windows.

## Features

- Automatically inserts tracking pixels when you send emails
- Manual insert button in compose toolbar
- Visual indicator when tracking is enabled
- Syncs settings across Chrome browsers

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
   - Enter your API key: `4gPuf7qyuHJMUtOQAUTOeI4RL3TfzXrwRrn/+Fte9yM=`
   - Click "Save Settings"

## How It Works

1. When you open Gmail, the extension watches for compose windows
2. When you click Send, it:
   - Creates a new tracking pixel via the Mailtrack API
   - Inserts the invisible 1x1 GIF into your email
   - Then sends the email
3. When the recipient opens the email, the pixel loads and logs the open

## Files

```
mailtracker-extension/
├── manifest.json          # Chrome extension manifest
├── popup/
│   ├── popup.html        # Settings popup UI
│   ├── popup.css         # Popup styles
│   └── popup.js          # Popup logic
├── content/
│   ├── gmail.js          # Gmail content script
│   └── gmail.css         # Gmail styles
├── background/
│   └── service-worker.js # Background service worker
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
