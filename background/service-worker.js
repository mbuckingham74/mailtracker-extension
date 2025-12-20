// Mailtrack Background Service Worker

const API_BASE = 'https://mailtrack.tachyonfuture.com';

// Listen for installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Mailtrack extension installed');

    // Set default settings
    chrome.storage.sync.set({
      apiKey: '',
      enabled: true,
      showNotification: true
    });
  }
});

// Handle messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CREATE_TRACK') {
    handleCreateTrack(message.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'CHECK_CONNECTION') {
    handleCheckConnection()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// Create a tracking pixel
async function handleCreateTrack(data) {
  const settings = await chrome.storage.sync.get(['apiKey']);

  if (!settings.apiKey) {
    throw new Error('No API key configured');
  }

  const response = await fetch(`${API_BASE}/api/tracks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': settings.apiKey
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Check API connection
async function handleCheckConnection() {
  const settings = await chrome.storage.sync.get(['apiKey']);

  if (!settings.apiKey) {
    return { connected: false, error: 'No API key' };
  }

  try {
    const response = await fetch(`${API_BASE}/api/stats`, {
      headers: {
        'X-API-Key': settings.apiKey
      }
    });

    if (response.ok) {
      const stats = await response.json();
      return { connected: true, stats };
    } else {
      return { connected: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    return { connected: false, error: error.message };
  }
}
