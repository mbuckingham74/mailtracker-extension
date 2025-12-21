// Mailtrack Background Service Worker

const API_BASE = 'https://mailtrack.tachyonfuture.com';
const POLL_INTERVAL_MINUTES = 2;
const ALARM_NAME = 'checkOpens';

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

    // Initialize last check timestamp
    chrome.storage.local.set({ lastOpenCheck: Date.now() / 1000 });
  }

  // Set up polling alarm
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
});

// Handle alarm for polling
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await checkForNewOpens();
  }
});

// Check for new opens and show notifications
async function checkForNewOpens() {
  const settings = await chrome.storage.sync.get(['apiKey', 'showNotification']);

  if (!settings.apiKey || !settings.showNotification) {
    return;
  }

  const { lastOpenCheck } = await chrome.storage.local.get(['lastOpenCheck']);
  const since = lastOpenCheck || (Date.now() / 1000 - 300); // Default to 5 min ago

  try {
    const response = await fetch(`${API_BASE}/api/opens/recent?since=${since}`, {
      headers: {
        'X-API-Key': settings.apiKey
      }
    });

    if (!response.ok) {
      console.error('Failed to check opens:', response.status);
      return;
    }

    const opens = await response.json();

    // Show notification for each new open
    for (const open of opens) {
      const location = [open.city, open.country].filter(Boolean).join(', ') || 'Unknown location';

      chrome.notifications.create(`open-${open.open_id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Email Opened!',
        message: `${open.recipient || 'Someone'} opened "${open.subject || '(no subject)'}"\n${location}`,
        priority: 2
      });
    }

    // Update last check timestamp
    chrome.storage.local.set({ lastOpenCheck: Date.now() / 1000 });

  } catch (error) {
    console.error('Error checking for opens:', error);
  }
}

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
