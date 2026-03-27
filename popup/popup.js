// DOM elements
const apiKeyInput = document.getElementById('apiKey');
const enabledCheckbox = document.getElementById('enabled');
const showNotificationCheckbox = document.getElementById('showNotification');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const openPollStatusEl = document.getElementById('openPollStatus');
const lastOpenPollAtEl = document.getElementById('lastOpenPollAt');
const lastOpenPollNewCountEl = document.getElementById('lastOpenPollNewCount');
const lastOpenSummaryEl = document.getElementById('lastOpenSummary');
const lastOpenPollErrorRowEl = document.getElementById('lastOpenPollErrorRow');
const lastOpenPollErrorEl = document.getElementById('lastOpenPollError');

const POLL_ACTIVITY_KEYS = [
  'lastOpenPollAt',
  'openPollStatus',
  'lastOpenPollError',
  'lastOpenPollNewCount',
  'lastOpenSummary'
];
const DEFAULT_POLL_ACTIVITY = {
  lastOpenPollAt: null,
  openPollStatus: 'paused',
  lastOpenPollError: '',
  lastOpenPollNewCount: 0,
  lastOpenSummary: null
};

// Load saved settings
async function loadSettings() {
  const [settings, activity] = await Promise.all([
    chrome.storage.sync.get({
      apiKey: '',
      enabled: true,
      showNotification: true
    }),
    chrome.storage.local.get(DEFAULT_POLL_ACTIVITY)
  ]);

  apiKeyInput.value = settings.apiKey;
  enabledCheckbox.checked = settings.enabled;
  showNotificationCheckbox.checked = settings.showNotification;
  updateActivity(activity);

  // Check API connection
  if (settings.apiKey) {
    checkConnection();
  } else {
    updateStatus('No API key set', 'error');
  }
}

async function loadActivity() {
  const activity = await chrome.storage.local.get(DEFAULT_POLL_ACTIVITY);
  updateActivity(activity);
}

function formatTimestamp(timestampSeconds) {
  if (!timestampSeconds) {
    return 'Never';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(timestampSeconds * 1000));
}

function formatPollStatus(status) {
  if (status === 'ok') {
    return 'Active';
  }

  if (status === 'error') {
    return 'Error';
  }

  return 'Paused';
}

function formatOpenSummary(summary) {
  if (!summary) {
    return 'No recent opens';
  }

  return `${summary.recipient} opened "${summary.subject}" from ${summary.location}`;
}

function updateActivity(activity) {
  openPollStatusEl.textContent = formatPollStatus(activity.openPollStatus);
  lastOpenPollAtEl.textContent = formatTimestamp(activity.lastOpenPollAt);
  lastOpenPollNewCountEl.textContent = String(activity.lastOpenPollNewCount ?? 0);
  lastOpenSummaryEl.textContent = formatOpenSummary(activity.lastOpenSummary);

  const hasError = Boolean(activity.lastOpenPollError);
  lastOpenPollErrorRowEl.hidden = !hasError;
  lastOpenPollErrorEl.textContent = hasError ? activity.lastOpenPollError : 'None';
}

// Save settings
async function saveSettings() {
  const settings = {
    apiKey: apiKeyInput.value.trim(),
    enabled: enabledCheckbox.checked,
    showNotification: showNotificationCheckbox.checked
  };

  await chrome.storage.sync.set(settings);

  // Visual feedback
  saveBtn.textContent = 'Saved!';
  saveBtn.classList.add('saved');
  setTimeout(() => {
    saveBtn.textContent = 'Save Settings';
    saveBtn.classList.remove('saved');
  }, 1500);

  // Check connection with new API key
  if (settings.apiKey) {
    checkConnection();
  } else {
    updateStatus('No API key set', 'error');
  }
}

// Check API connection
async function checkConnection() {
  updateStatus('Checking...', '');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' });

    if (response?.connected) {
      const stats = response.stats || {};
      updateStatus(`Connected (${stats.total_tracks ?? 0} tracks)`, 'connected');
    } else if (response?.error === 'HTTP 401') {
      updateStatus('Invalid API key', 'error');
    } else if (response?.error === 'No API key') {
      updateStatus('No API key set', 'error');
    } else if (response?.error?.startsWith('HTTP ')) {
      updateStatus('Connection error', 'error');
    } else {
      updateStatus('Cannot reach server', 'error');
    }
  } catch (error) {
    updateStatus('Cannot reach server', 'error');
  }
}

// Update status display
function updateStatus(text, state) {
  statusEl.className = 'status ' + state;
  statusEl.querySelector('.status-text').textContent = text;
}

// Event listeners
saveBtn.addEventListener('click', saveSettings);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!POLL_ACTIVITY_KEYS.some((key) => changes[key])) {
    return;
  }

  loadActivity();
});

// Load settings on popup open
loadSettings();
