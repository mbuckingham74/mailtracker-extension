importScripts('open-helpers.js');

// Mailtrack Background Service Worker

const API_BASE = 'https://mailtrack.tachyonfuture.com';
const DASHBOARD_URL = 'https://mailtrack.tachyonfuture.com';
const POLL_INTERVAL_MINUTES = 2;
const ALARM_NAME = 'checkOpens';
const OPEN_CHECK_OVERLAP_SECONDS = 30;
const MAX_NOTIFIED_OPEN_IDS = 500;
const OPEN_NOTIFICATION_BUTTONS = [{ title: 'Open Dashboard' }];
const OPEN_NOTIFICATION_PREFIX = 'open-';

const {
  getOpenIdentity,
  getOpenTimestamp,
  getLatestOpenTimestamp
} = globalThis.mailtrackOpenHelpers;

function ensurePollingAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm || alarm.periodInMinutes !== POLL_INTERVAL_MINUTES) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
    }
  });
}

function trimRecentOpenIds(openIds) {
  return openIds.slice(-MAX_NOTIFIED_OPEN_IDS);
}

function buildOpenSummary(open) {
  const location = [open?.city, open?.country].filter(Boolean).join(', ') || 'Unknown location';

  return {
    recipient: open?.recipient || 'Someone',
    subject: open?.subject || '(no subject)',
    location
  };
}

function pickLatestOpen(left, right) {
  if (!left) {
    return right;
  }

  const leftTimestamp = getOpenTimestamp(left) ?? 0;
  const rightTimestamp = getOpenTimestamp(right) ?? 0;

  return rightTimestamp >= leftTimestamp ? right : left;
}

async function bumpOpenPollWatermark(timestamp = Date.now() / 1000) {
  await chrome.storage.local.set({ lastOpenCheck: timestamp });
}

function isOpenNotification(notificationId) {
  return typeof notificationId === 'string' && notificationId.startsWith(OPEN_NOTIFICATION_PREFIX);
}

function openDashboardForNotification(notificationId) {
  if (!isOpenNotification(notificationId)) {
    return;
  }

  chrome.notifications.clear(notificationId);
  chrome.tabs.create({ url: DASHBOARD_URL });
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
  const pollStartedAt = Date.now() / 1000;
  const settings = await chrome.storage.sync.get({
    apiKey: '',
    enabled: true,
    showNotification: true
  });

  if (!settings.apiKey || !settings.enabled || !settings.showNotification) {
    await chrome.storage.local.set({
      lastOpenPollAt: pollStartedAt,
      openPollStatus: 'paused',
      lastOpenPollError: '',
      lastOpenPollNewCount: 0
    });
    await bumpOpenPollWatermark(pollStartedAt);
    return;
  }

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
      await chrome.storage.local.set({
        lastOpenPollAt: pollStartedAt,
        openPollStatus: 'error',
        lastOpenPollError: `HTTP ${response.status}`,
        lastOpenPollNewCount: 0
      });
      return;
    }

    const opens = await response.json();
    const seenOpenKeys = new Set(notifiedOpenIds);
    let latestNotifiedOpen = null;
    let newOpenCount = 0;

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
      latestNotifiedOpen = pickLatestOpen(latestNotifiedOpen, open);
      newOpenCount += 1;

      const location = [open.city, open.country].filter(Boolean).join(', ') || 'Unknown location';

      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Email Opened!',
        message: `${open.recipient || 'Someone'} opened "${open.subject || '(no subject)'}"\n${location}`,
        buttons: OPEN_NOTIFICATION_BUTTONS,
        priority: 2
      });
    }

    // Prefer the newest returned open time; if the payload does not expose a
    // parseable timestamp, fall back to poll start plus a small overlap window.
    const pollStateUpdate = {
      lastOpenPollAt: pollStartedAt,
      openPollStatus: 'ok',
      lastOpenPollError: '',
      lastOpenPollNewCount: newOpenCount
    };
    if (latestNotifiedOpen) {
      pollStateUpdate.lastOpenSummary = buildOpenSummary(latestNotifiedOpen);
    }

    await chrome.storage.local.set({
      lastOpenCheck: nextOpenCheck,
      notifiedOpenIds: trimRecentOpenIds(Array.from(seenOpenKeys)),
      ...pollStateUpdate
    });

  } catch (error) {
    console.error('Error checking for opens:', error);
    await chrome.storage.local.set({
      lastOpenPollAt: pollStartedAt,
      openPollStatus: 'error',
      lastOpenPollError: error.message || 'Unknown error',
      lastOpenPollNewCount: 0
    });
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  openDashboardForNotification(notificationId);
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  openDashboardForNotification(notificationId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') {
    return;
  }

  if (!changes.apiKey && !changes.enabled && !changes.showNotification) {
    return;
  }

  chrome.storage.sync.get({
    apiKey: '',
    enabled: true,
    showNotification: true
  })
    .then((settings) => {
      if (!settings.apiKey || !settings.enabled || !settings.showNotification) {
        return bumpOpenPollWatermark();
      }
      return undefined;
    })
    .catch((error) => {
      console.error('Error syncing poll watermark:', error);
    });
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
