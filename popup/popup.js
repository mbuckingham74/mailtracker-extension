// Mailtrack API configuration
const API_BASE = 'https://mailtrack.tachyonfuture.com';

// DOM elements
const apiKeyInput = document.getElementById('apiKey');
const enabledCheckbox = document.getElementById('enabled');
const showNotificationCheckbox = document.getElementById('showNotification');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    apiKey: '',
    enabled: true,
    showNotification: true
  });

  apiKeyInput.value = settings.apiKey;
  enabledCheckbox.checked = settings.enabled;
  showNotificationCheckbox.checked = settings.showNotification;

  // Check API connection
  if (settings.apiKey) {
    checkConnection(settings.apiKey);
  } else {
    updateStatus('No API key set', 'error');
  }
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
    checkConnection(settings.apiKey);
  }
}

// Check API connection
async function checkConnection(apiKey) {
  updateStatus('Checking...', '');

  try {
    const response = await fetch(`${API_BASE}/api/stats`, {
      headers: {
        'X-API-Key': apiKey
      }
    });

    if (response.ok) {
      const stats = await response.json();
      updateStatus(`Connected (${stats.total_tracks} tracks)`, 'connected');
    } else if (response.status === 401) {
      updateStatus('Invalid API key', 'error');
    } else {
      updateStatus('Connection error', 'error');
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

// Load settings on popup open
loadSettings();
