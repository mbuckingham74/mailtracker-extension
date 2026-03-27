// Mailtrack Background Service Worker

const API_BASE = 'https://mailtrack.tachyonfuture.com';
const POLL_INTERVAL_MINUTES = 2;
const ALARM_NAME = 'checkOpens';
const OPEN_CHECK_OVERLAP_SECONDS = 30;
const MAX_NOTIFIED_OPEN_IDS = 500;
const OPEN_TIMESTAMP_FIELDS = ['opened_at', 'open_time', 'timestamp', 'created_at', 'time'];

function normalizeOpenTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return numericValue > 1e12 ? numericValue / 1000 : numericValue;
  }

  const parsedValue = Date.parse(value);
  if (Number.isNaN(parsedValue)) {
    return null;
  }

  return parsedValue / 1000;
}

function ensurePollingAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm || alarm.periodInMinutes !== POLL_INTERVAL_MINUTES) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
    }
  });
}

function hashString(value) {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function getOpenTimestamp(open) {
  for (const field of OPEN_TIMESTAMP_FIELDS) {
    const parsedTimestamp = normalizeOpenTimestamp(open?.[field]);
    if (parsedTimestamp !== null) {
      return parsedTimestamp;
    }
  }

  return null;
}

function getFallbackOpenFingerprint(open) {
  const fingerprintEntries = Object.entries(open || {})
    .filter(([field, value]) => (
      field !== 'open_id' &&
      !OPEN_TIMESTAMP_FIELDS.includes(field) &&
      value !== undefined &&
      value !== null &&
      value !== ''
    ))
    .map(([field, value]) => [field, String(value)]);
  const timestamp = getOpenTimestamp(open);

  if (timestamp !== null) {
    fingerprintEntries.push(['normalized_timestamp', String(timestamp)]);
  }

  fingerprintEntries.sort(([left], [right]) => left.localeCompare(right));

  return hashString(
    fingerprintEntries.map(([field, value]) => `${field}:${value}`).join('|') || 'unknown-open'
  );
}

function getOpenIdentity(open) {
  const openId = open?.open_id;
  if (openId !== undefined && openId !== null && openId !== '') {
    const key = String(openId);
    return {
      dedupeKey: key,
      notificationId: `open-${key}`
    };
  }

  const fingerprint = getFallbackOpenFingerprint(open);
  return {
    dedupeKey: `fingerprint:${fingerprint}`,
    notificationId: `open-fallback-${fingerprint}`
  };
}

function getLatestOpenTimestamp(opens, since) {
  return opens.reduce((latest, open) => {
    const openTimestamp = getOpenTimestamp(open);
    if (openTimestamp !== null) {
      return Math.max(latest, openTimestamp);
    }

    return latest;
  }, since);
}

function trimRecentOpenIds(openIds) {
  return openIds.slice(-MAX_NOTIFIED_OPEN_IDS);
}

ensurePollingAlarm();

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

  ensurePollingAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollingAlarm();
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

  const pollStartedAt = Date.now() / 1000;
  const { lastOpenCheck, notifiedOpenIds = [] } = await chrome.storage.local.get([
    'lastOpenCheck',
    'notifiedOpenIds'
  ]);
  const watermark = lastOpenCheck || (pollStartedAt - 300); // Default to 5 min ago
  const since = Math.max(0, watermark - OPEN_CHECK_OVERLAP_SECONDS);

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
    const seenOpenKeys = new Set(notifiedOpenIds);

    const latestOpenTimestamp = getLatestOpenTimestamp(opens, watermark);
    const nextOpenCheck = latestOpenTimestamp > watermark
      ? latestOpenTimestamp
      : (opens.length > 0 ? pollStartedAt : watermark);

    // Show notification for each new open, suppressing overlap duplicates.
    for (const open of opens) {
      const { dedupeKey, notificationId } = getOpenIdentity(open);
      if (seenOpenKeys.has(dedupeKey)) {
        continue;
      }
      seenOpenKeys.add(dedupeKey);

      const location = [open.city, open.country].filter(Boolean).join(', ') || 'Unknown location';

      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Email Opened!',
        message: `${open.recipient || 'Someone'} opened "${open.subject || '(no subject)'}"\n${location}`,
        priority: 2
      });
    }

    // Prefer the newest returned open time; if the payload does not expose a
    // parseable timestamp, fall back to poll start plus a small overlap window.
    await chrome.storage.local.set({
      lastOpenCheck: nextOpenCheck,
      notifiedOpenIds: trimRecentOpenIds(Array.from(seenOpenKeys))
    });

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
