// Mailtrack Gmail Content Script
// Automatically inserts tracking pixels into Gmail compose windows

const API_BASE = 'https://mailtrack.tachyonfuture.com';

// Track which compose windows we've already processed
const processedComposeWindows = new WeakSet();

// Get settings from storage
async function getSettings() {
  return chrome.storage.sync.get({
    apiKey: '',
    enabled: true,
    showNotification: true
  });
}

// Create a new tracking pixel via API
async function createTrackingPixel(recipient, subject) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    console.log('Mailtrack: No API key configured');
    return null;
  }

  try {
    const response = await fetch(`${API_BASE}/api/tracks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': settings.apiKey
      },
      body: JSON.stringify({
        recipient: recipient || '',
        subject: subject || '',
        notes: 'Created via Chrome extension'
      })
    });

    if (!response.ok) {
      console.error('Mailtrack: Failed to create tracking pixel', response.status);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Mailtrack: API error', error);
    return null;
  }
}

// Insert tracking pixel into compose window
async function insertTrackingPixel(composeWindow) {
  // Get recipient and subject
  const recipientField = composeWindow.querySelector('input[aria-label="To"]') ||
                         composeWindow.querySelector('input[name="to"]') ||
                         composeWindow.querySelector('[data-hovercard-id]');
  const subjectField = composeWindow.querySelector('input[name="subjectbox"]') ||
                       composeWindow.querySelector('input[aria-label="Subject"]');

  const recipient = recipientField?.value || '';
  const subject = subjectField?.value || '';

  // Create tracking pixel
  const track = await createTrackingPixel(recipient, subject);

  if (!track) {
    return false;
  }

  // Find the compose body
  const composeBody = composeWindow.querySelector('[aria-label="Message Body"]') ||
                      composeWindow.querySelector('[g_editable="true"]') ||
                      composeWindow.querySelector('[contenteditable="true"]');

  if (!composeBody) {
    console.error('Mailtrack: Could not find compose body');
    return false;
  }

  // Create the tracking pixel element
  const pixelHtml = `<img src="${track.pixel_url}" width="1" height="1" style="display:none" alt="" data-mailtrack-id="${track.id}">`;

  // Insert at the end of the email body
  composeBody.insertAdjacentHTML('beforeend', pixelHtml);

  console.log('Mailtrack: Inserted tracking pixel', track.id);
  return true;
}

// Show notification badge on compose window
function showInsertedBadge(composeWindow) {
  // Check if badge already exists
  if (composeWindow.querySelector('.mailtrack-badge')) {
    return;
  }

  // Find the toolbar area
  const toolbar = composeWindow.querySelector('[role="toolbar"]') ||
                  composeWindow.querySelector('.btC');

  if (!toolbar) {
    return;
  }

  // Create badge
  const badge = document.createElement('div');
  badge.className = 'mailtrack-badge';
  badge.innerHTML = '✓ Tracking';
  badge.title = 'Mailtrack pixel inserted';

  toolbar.appendChild(badge);
}

// Check if a compose window has a tracking pixel
function hasTrackingPixel(composeWindow) {
  return composeWindow.querySelector('img[data-mailtrack-id]') !== null;
}

// Process a compose window
async function processComposeWindow(composeWindow) {
  // Skip if already processed
  if (processedComposeWindows.has(composeWindow)) {
    return;
  }

  const settings = await getSettings();

  // Skip if disabled
  if (!settings.enabled) {
    return;
  }

  // Skip if no API key
  if (!settings.apiKey) {
    return;
  }

  // Mark as processed
  processedComposeWindows.add(composeWindow);

  // Wait for compose window to fully load
  await new Promise(resolve => setTimeout(resolve, 500));

  // Skip if already has a tracking pixel
  if (hasTrackingPixel(composeWindow)) {
    showInsertedBadge(composeWindow);
    return;
  }

  // Watch for send button click to insert pixel just before sending
  const sendButton = composeWindow.querySelector('[aria-label*="Send"]') ||
                     composeWindow.querySelector('[data-tooltip*="Send"]');

  if (sendButton) {
    sendButton.addEventListener('click', async (e) => {
      // Check if pixel already inserted
      if (hasTrackingPixel(composeWindow)) {
        return;
      }

      // Prevent immediate send
      e.preventDefault();
      e.stopPropagation();

      // Insert pixel
      const success = await insertTrackingPixel(composeWindow);

      if (success) {
        showInsertedBadge(composeWindow);

        // Now actually send
        setTimeout(() => {
          sendButton.click();
        }, 100);
      } else {
        // Failed to insert, let the email send anyway
        setTimeout(() => {
          sendButton.click();
        }, 100);
      }
    }, { once: true, capture: true });
  }

  // Also add a manual insert button
  addManualInsertButton(composeWindow);
}

// Add a manual insert button to the compose toolbar
function addManualInsertButton(composeWindow) {
  const toolbar = composeWindow.querySelector('[role="toolbar"]') ||
                  composeWindow.querySelector('.btC');

  if (!toolbar || toolbar.querySelector('.mailtrack-insert-btn')) {
    return;
  }

  const button = document.createElement('div');
  button.className = 'mailtrack-insert-btn';
  button.innerHTML = '📧';
  button.title = 'Insert Mailtrack pixel';

  button.addEventListener('click', async () => {
    if (hasTrackingPixel(composeWindow)) {
      alert('Tracking pixel already inserted!');
      return;
    }

    const success = await insertTrackingPixel(composeWindow);

    if (success) {
      showInsertedBadge(composeWindow);
      button.style.display = 'none';
    } else {
      alert('Failed to insert tracking pixel. Check your API key.');
    }
  });

  toolbar.insertBefore(button, toolbar.firstChild);
}

// Observe for new compose windows
function observeComposeWindows() {
  const observer = new MutationObserver((mutations) => {
    // Look for compose windows
    const composeWindows = document.querySelectorAll('[role="dialog"]');

    composeWindows.forEach(dialog => {
      // Check if this is a compose window (has a "To" field)
      const isCompose = dialog.querySelector('input[aria-label="To"]') ||
                        dialog.querySelector('input[name="to"]');

      if (isCompose) {
        processComposeWindow(dialog);
      }
    });

    // Also check for inline compose (reply)
    const inlineCompose = document.querySelectorAll('[g_editable="true"]');
    inlineCompose.forEach(compose => {
      const composeContainer = compose.closest('tr') || compose.closest('[role="listitem"]');
      if (composeContainer) {
        processComposeWindow(composeContainer);
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Initialize
console.log('Mailtrack: Content script loaded');
observeComposeWindows();
