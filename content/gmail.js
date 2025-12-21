// Mailtrack Gmail Content Script
// Automatically inserts tracking pixels into Gmail compose windows
//
// Strategy: Use XHR interception to inject tracking pixels AFTER Gmail has
// sanitized the email content but BEFORE the request leaves the browser.
// This bypasses Gmail's DOM sanitization.

// Track which compose windows we've already processed
const processedComposeWindows = new WeakSet();

// Track pending pixels for XHR injection
const pendingPixels = new Map();

// Get settings from storage
async function getSettings() {
  return chrome.storage.sync.get({
    apiKey: '',
    enabled: true,
    showNotification: true
  });
}

// Generate a UUID for message grouping
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Inject the XHR interceptor script into the page context
function injectXHRInterceptor() {
  // Check if already injected
  if (document.getElementById('mailtrack-xhr-interceptor')) {
    console.log('Mailtrack: XHR interceptor already injected');
    return;
  }

  const script = document.createElement('script');
  script.id = 'mailtrack-xhr-interceptor';
  script.src = chrome.runtime.getURL('content/xhr-interceptor.js');
  script.onload = function() {
    console.log('Mailtrack: XHR interceptor script loaded');
  };
  script.onerror = function(e) {
    console.error('Mailtrack: Failed to load XHR interceptor', e);
  };
  (document.head || document.documentElement).appendChild(script);
  console.log('Mailtrack: Injecting XHR interceptor into page context');
}

// Send pixel data to the XHR interceptor in page context
function sendPixelToInterceptor(pixelUrl, recipient, subject, messageId) {
  window.dispatchEvent(new CustomEvent('mailtrack-inject-pixel', {
    detail: { pixelUrl, recipient, subject, messageId }
  }));
  console.log('Mailtrack: Sent pixel to XHR interceptor:', messageId);
}

// Create a new tracking pixel via background service worker
async function createTrackingPixel(recipient, subject, messageGroupId) {
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
        notes: 'Created via Chrome extension',
        message_group_id: messageGroupId
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

// Extract recipient emails from Gmail's compose window
function extractRecipients(composeWindow) {
  const recipients = new Set();

  const allEmailElements = composeWindow.querySelectorAll('[email]');
  console.log('Mailtrack: Found', allEmailElements.length, 'elements with [email] attribute');

  allEmailElements.forEach(el => {
    const email = el.getAttribute('email');
    if (!email || !email.includes('@')) return;

    console.log('Mailtrack: Checking email:', email);
    console.log('  - tagName:', el.tagName);
    console.log('  - className:', el.className);
    console.log('  - has data-name:', el.hasAttribute('data-name'));
    console.log('  - in listbox:', !!el.closest('[role="listbox"]'));

    // ONLY exclude if inside a listbox (suggestions dropdown)
    if (el.closest('[role="listbox"]')) {
      console.log('Mailtrack: Skipping (in suggestion listbox):', email);
      return;
    }

    console.log('Mailtrack: Accepting recipient:', email);
    recipients.add(email);
  });

  const result = [...recipients];
  console.log('Mailtrack: Total recipients found:', result);
  return result;
}

// Extract subject from Gmail's compose window
function extractSubject(composeWindow) {
  const subjectInput = composeWindow.querySelector('input[name="subjectbox"]') ||
                       composeWindow.querySelector('input[aria-label="Subject"]');
  return subjectInput?.value || '';
}

// Prepare tracking pixel for XHR injection (doesn't modify DOM)
async function prepareTrackingPixel(composeBody, composeWindow) {
  // Extract recipient and subject from compose window
  const recipients = extractRecipients(composeWindow);
  const subject = extractSubject(composeWindow);
  const recipient = recipients.length > 0 ? recipients.join(', ') : '';

  console.log('Mailtrack: Extracted recipient:', recipient, 'subject:', subject);

  // Create a single tracking pixel for this email
  const messageGroupId = generateUUID();
  const track = await createTrackingPixel(recipient, subject, messageGroupId);

  if (!track) {
    console.error('Mailtrack: Failed to create tracking pixel');
    return null;
  }

  console.log('Mailtrack: Prepared pixel for XHR injection:', track.id);

  // Store the pixel data and send to XHR interceptor
  const messageId = messageGroupId;
  pendingPixels.set(messageId, {
    pixelUrl: track.pixel_url,
    recipient,
    subject,
    trackId: track.id
  });

  // Send to page context XHR interceptor
  sendPixelToInterceptor(track.pixel_url, recipient, subject, messageId);

  return track;
}

// Show notification badge
function showInsertedBadge(composeWindow, success) {
  const existingBadge = composeWindow.querySelector('.mailtrack-badge');
  if (existingBadge) {
    existingBadge.innerHTML = success ? '✓ Tracking' : '✗ No tracking';
    return;
  }

  const toolbar = composeWindow.querySelector('[role="toolbar"]') ||
                  composeWindow.querySelector('.btC') ||
                  composeWindow.querySelector('.gU.Up');

  if (toolbar) {
    const badge = document.createElement('div');
    badge.className = 'mailtrack-badge';
    badge.innerHTML = success ? '✓ Tracking' : '✗ No tracking';
    badge.title = success ? 'Tracking pixel will be injected via XHR' : 'Failed to prepare tracking pixel';
    badge.style.cssText = success
      ? 'color: #27ae60; font-size: 12px; padding: 4px 8px;'
      : 'color: #e74c3c; font-size: 12px; padding: 4px 8px;';
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
                        composeBody.parentElement?.parentElement?.parentElement;

  // Find and intercept the send button
  const findAndInterceptSendButton = () => {
    const sendButton = composeWindow?.querySelector('[aria-label*="Send"]') ||
                       composeWindow?.querySelector('[data-tooltip*="Send"]') ||
                       composeWindow?.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3');

    if (sendButton && !sendButton.dataset.mailtrackIntercepted) {
      sendButton.dataset.mailtrackIntercepted = 'true';
      console.log('Mailtrack: Intercepting send button');
      showInsertedBadge(composeWindow, true);

      // Intercept mousedown (before click) to prepare pixel for XHR injection
      sendButton.addEventListener('mousedown', async (e) => {
        console.log('Mailtrack: Intercepted send, preparing pixel for XHR injection...');

        // Don't prevent default - let Gmail send normally
        // The XHR interceptor will inject the pixel at the network level

        // Prepare the tracking pixel (creates record and sends to XHR interceptor)
        const track = await prepareTrackingPixel(composeBody, composeWindow);

        if (track) {
          console.log('Mailtrack: Pixel prepared:', track.id);
          console.log('Mailtrack: XHR interceptor will inject pixel into outgoing request');
        } else {
          console.error('Mailtrack: Failed to prepare pixel');
        }

      }, { capture: true });
    }
  };

  // Try to find send button now and watch for it
  findAndInterceptSendButton();

  const buttonObserver = new MutationObserver(() => {
    findAndInterceptSendButton();
  });
  if (composeWindow) {
    buttonObserver.observe(composeWindow, { childList: true, subtree: true });
  }

  // Clean up observer after 30 seconds
  setTimeout(() => buttonObserver.disconnect(), 30000);
}

// Main observer for compose windows
function observeComposeWindows() {
  console.log('Mailtrack: Starting compose window observer');

  const observer = new MutationObserver(() => {
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

// Listen for pixel injection confirmation from page context
window.addEventListener('mailtrack-pixel-injected', function(e) {
  const { messageId, success } = e.detail;
  console.log('Mailtrack: Received injection confirmation:', messageId, success);
  if (pendingPixels.has(messageId)) {
    pendingPixels.delete(messageId);
  }
});

// Initialize
console.log('Mailtrack: Content script loaded');
injectXHRInterceptor();
observeComposeWindows();
