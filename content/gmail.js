// Mailtrack Gmail Content Script
// Automatically inserts tracking pixels into Gmail compose windows

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

// Create a new tracking pixel via background service worker
async function createTrackingPixel(recipient, subject) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    console.log('Mailtrack: No API key configured');
    return null;
  }

  try {
    // Use message passing to background service worker (avoids CORS issues)
    const response = await chrome.runtime.sendMessage({
      type: 'CREATE_TRACK',
      data: {
        recipient: recipient || '',
        subject: subject || '',
        notes: 'Created via Chrome extension'
      }
    });

    if (response.error) {
      console.error('Mailtrack: Failed to create tracking pixel', response.error);
      return null;
    }

    console.log('Mailtrack: Created tracking pixel', response.id);
    return response;
  } catch (error) {
    console.error('Mailtrack: API error', error);
    return null;
  }
}

// Insert tracking pixel into compose window
async function insertTrackingPixel(composeBody, composeWindow) {
  // Get recipient and subject from the compose window
  const recipientInput = composeWindow.querySelector('input[name="to"]') ||
                         composeWindow.querySelector('input[aria-label="To recipients"]') ||
                         composeWindow.querySelector('input[aria-label="To"]') ||
                         composeWindow.querySelector('[name="to"]');

  const subjectInput = composeWindow.querySelector('input[name="subjectbox"]') ||
                       composeWindow.querySelector('input[aria-label="Subject"]');

  const recipient = recipientInput?.value || '';
  const subject = subjectInput?.value || '';

  console.log('Mailtrack: Inserting pixel for:', recipient, subject);

  // Create tracking pixel
  const track = await createTrackingPixel(recipient, subject);

  if (!track) {
    return false;
  }

  // Create the tracking pixel element
  const pixelHtml = `<img src="${track.pixel_url}" width="1" height="1" style="display:none" alt="" data-mailtrack-id="${track.id}">`;

  // Insert at the end of the email body
  composeBody.insertAdjacentHTML('beforeend', pixelHtml);

  console.log('Mailtrack: Inserted tracking pixel', track.id);
  return true;
}

// Check if a compose body has a tracking pixel
function hasTrackingPixel(element) {
  return element.querySelector('img[data-mailtrack-id]') !== null;
}

// Show notification badge
function showInsertedBadge(composeWindow) {
  // Find a good place to show the badge
  const existingBadge = composeWindow.querySelector('.mailtrack-badge');
  if (existingBadge) return;

  const toolbar = composeWindow.querySelector('[role="toolbar"]') ||
                  composeWindow.querySelector('.btC') ||
                  composeWindow.querySelector('.gU.Up');

  if (toolbar) {
    const badge = document.createElement('div');
    badge.className = 'mailtrack-badge';
    badge.innerHTML = '✓ Tracking';
    badge.title = 'Mailtrack pixel will be inserted on send';
    toolbar.appendChild(badge);
  }
}

// Process a compose body element
async function processComposeBody(composeBody) {
  if (processedComposeWindows.has(composeBody)) {
    return;
  }

  const settings = await getSettings();
  if (!settings.enabled || !settings.apiKey) {
    console.log('Mailtrack: Disabled or no API key');
    return;
  }

  processedComposeWindows.add(composeBody);
  console.log('Mailtrack: Found compose window');

  // Find the parent compose window/dialog
  const composeWindow = composeBody.closest('[role="dialog"]') ||
                        composeBody.closest('.nH.Hd') ||
                        composeBody.closest('form') ||
                        composeBody.parentElement.parentElement.parentElement;

  // Show badge
  showInsertedBadge(composeWindow);

  // Find and intercept the send button
  const findAndInterceptSendButton = () => {
    // Gmail send button selectors
    const sendButton = composeWindow.querySelector('[aria-label*="Send"]') ||
                       composeWindow.querySelector('[data-tooltip*="Send"]') ||
                       composeWindow.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3');

    if (sendButton && !sendButton.dataset.mailtrackIntercepted) {
      sendButton.dataset.mailtrackIntercepted = 'true';
      console.log('Mailtrack: Intercepting send button');

      sendButton.addEventListener('mousedown', async (e) => {
        if (hasTrackingPixel(composeBody)) {
          console.log('Mailtrack: Pixel already inserted, allowing send');
          return; // Already has pixel, let it send
        }

        console.log('Mailtrack: Intercepted send, inserting pixel...');
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const success = await insertTrackingPixel(composeBody, composeWindow);

        if (success) {
          console.log('Mailtrack: Pixel inserted, triggering send');
        } else {
          console.log('Mailtrack: Failed to insert pixel, sending anyway');
        }

        // Trigger the send after a brief delay
        setTimeout(() => {
          // Create and dispatch a new click event
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          sendButton.dispatchEvent(clickEvent);
        }, 100);

      }, { capture: true, once: true });
    }
  };

  // Try to find send button now and also watch for it
  findAndInterceptSendButton();

  // Also observe for the send button appearing later
  const buttonObserver = new MutationObserver(() => {
    findAndInterceptSendButton();
  });
  buttonObserver.observe(composeWindow, { childList: true, subtree: true });

  // Clean up observer after 30 seconds
  setTimeout(() => buttonObserver.disconnect(), 30000);
}

// Main observer for compose windows
function observeComposeWindows() {
  console.log('Mailtrack: Starting compose window observer');

  const observer = new MutationObserver((mutations) => {
    // Look for contenteditable divs which are compose bodies
    const composeBodies = document.querySelectorAll(
      'div[aria-label="Message Body"][contenteditable="true"], ' +
      'div[g_editable="true"], ' +
      'div[contenteditable="true"][aria-multiline="true"]'
    );

    composeBodies.forEach(body => {
      if (!processedComposeWindows.has(body)) {
        processComposeBody(body);
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Also check immediately
  const existingBodies = document.querySelectorAll(
    'div[aria-label="Message Body"][contenteditable="true"], ' +
    'div[g_editable="true"], ' +
    'div[contenteditable="true"][aria-multiline="true"]'
  );
  existingBodies.forEach(body => processComposeBody(body));
}

// Initialize
console.log('Mailtrack: Content script loaded');
observeComposeWindows();
