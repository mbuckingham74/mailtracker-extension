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
    checkConnection();
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

// Load settings on popup open
loadSettings();
