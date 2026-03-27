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

// Track if XHR interceptor is ready
let xhrInterceptorReady = false;

function findComposeWindow(element) {
  return element?.closest('[role="dialog"], .nH.Hd, form') ||
         element?.parentElement?.parentElement?.parentElement ||
         null;
}

// Function to check if interceptor is ready (checks global variable set by interceptor)
function checkInterceptorReady() {
  // The XHR interceptor sets this global when it loads
  if (window.__mailtrackInterceptorReady) {
    xhrInterceptorReady = true;
    return true;
  }
  return xhrInterceptorReady;
}

function updateInterceptorBadges() {
  document.querySelectorAll('[data-mailtrack-intercepted="true"]').forEach(sendButton => {
    const composeWindow = findComposeWindow(sendButton);
    if (composeWindow) {
      showInsertedBadge(composeWindow, true);
    }
  });
}

// Listen for XHR interceptor ready signal
window.addEventListener('mailtrack-interceptor-ready', function() {
  console.log('Mailtrack: XHR interceptor confirmed ready via event');
  xhrInterceptorReady = true;
  updateInterceptorBadges();
});

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
  pendingPixels.set(messageId, { pixelUrl, recipient, subject });
  window.dispatchEvent(new CustomEvent('mailtrack-inject-pixel', {
    detail: { pixelUrl, recipient, subject, messageId }
  }));
  console.log('Mailtrack: Sent pixel to XHR interceptor:', messageId);
}

function clearPendingPixel(messageId, { notifyInterceptor = true, keepWaiting = false } = {}) {
  pendingPixels.delete(messageId);

  if (notifyInterceptor) {
    window.dispatchEvent(new CustomEvent('mailtrack-clear-pixel', {
      detail: { messageId, keepWaiting }
    }));
  }
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

function getComposeDetails(composeWindow) {
  const recipients = extractRecipients(composeWindow);
  const subject = extractSubject(composeWindow);
  const recipient = recipients.length > 0 ? recipients.join(', ') : '';
  const signature = JSON.stringify({
    recipients: [...recipients].map(email => email.trim().toLowerCase()).sort(),
    subject
  });

  return { recipient, subject, signature };
}

// Prepare tracking pixel for XHR injection (doesn't modify DOM)
async function prepareTrackingPixel(composeBody, composeWindow, composeDetails = getComposeDetails(composeWindow)) {
  const { recipient, subject, signature } = composeDetails;

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
  track.messageId = messageId;
  track.composeSignature = signature;
  track.recipient = recipient;
  track.subject = subject;

  // Send to page context XHR interceptor
  sendPixelToInterceptor(track.pixel_url, recipient, subject, messageId);

  return track;
}

// Inject pixel directly into compose body DOM (primary injection method)
function injectPixelIntoDom(composeBody, pixelUrl) {
  try {
    let img = composeBody.querySelector('img[data-mailtrack-pixel="true"]');
    if (!img) {
      img = document.createElement('img');
      img.dataset.mailtrackPixel = 'true';
      composeBody.appendChild(img);
    }
    img.src = pixelUrl;
    img.width = 1;
    img.height = 1;
    img.style.display = 'none';
    console.log('Mailtrack: Pixel injected into DOM');
  } catch (e) {
    console.error('Mailtrack: DOM injection failed:', e);
  }
}

// Show notification badge
function applyBadgeState(badge, success) {
  badge.textContent = success ? '✓ Tracking' : '✗ No tracking';
  badge.title = success ? 'Tracking pixel will be injected via XHR' : 'Failed to prepare tracking pixel';
  badge.style.cssText = success
    ? 'color: #27ae60; font-size: 12px; padding: 4px 8px;'
    : 'color: #e74c3c; font-size: 12px; padding: 4px 8px;';
}

function showInsertedBadge(composeWindow, success) {
  const existingBadge = composeWindow.querySelector('.mailtrack-badge');
  if (existingBadge) {
    applyBadgeState(existingBadge, success);
    return;
  }

  const toolbar = composeWindow.querySelector('[role="toolbar"]') ||
                  composeWindow.querySelector('.btC') ||
                  composeWindow.querySelector('.gU.Up');

  if (toolbar) {
    const badge = document.createElement('div');
    badge.className = 'mailtrack-badge';
    applyBadgeState(badge, success);
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
  const composeWindow = findComposeWindow(composeBody);

  let currentTrack = null;
  let composeDisposed = false;
  let buttonObserver = null;
  let composeLifecycleObserver = null;

  // Function to prepare/update pixel with current recipient/subject
  const preparePixelNow = async () => {
    if (composeDisposed) {
      return null;
    }

    const composeDetails = getComposeDetails(composeWindow);
    const needsNewTrack = !currentTrack || currentTrack.composeSignature !== composeDetails.signature;

    if (needsNewTrack) {
      if (currentTrack?.messageId) {
        console.log('Mailtrack: Recipient or subject changed, refreshing tracking pixel');
        clearPendingPixel(currentTrack.messageId, { keepWaiting: true });
      }

      console.log('Mailtrack: Preparing pixel for:', composeDetails.recipient, composeDetails.subject);
      currentTrack = await prepareTrackingPixel(composeBody, composeWindow, composeDetails);
      if (composeDisposed && currentTrack?.messageId) {
        clearPendingPixel(currentTrack.messageId);
        currentTrack = null;
        return null;
      }
      if (currentTrack) {
        console.log('Mailtrack: Pixel prepared and sent to XHR interceptor:', currentTrack.id);
      }
    } else if (currentTrack) {
      sendPixelToInterceptor(
        currentTrack.pixel_url,
        composeDetails.recipient,
        composeDetails.subject,
        currentTrack.messageId
      );
    }

    return currentTrack;
  };

  // Find and intercept the send button
  const findAndInterceptSendButton = () => {
    const sendButton = composeWindow?.querySelector('[aria-label*="Send"]') ||
                       composeWindow?.querySelector('[data-tooltip*="Send"]') ||
                       composeWindow?.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3');

    if (sendButton && !sendButton.dataset.mailtrackIntercepted) {
      sendButton.dataset.mailtrackIntercepted = 'true';
      console.log('Mailtrack: Intercepting send button');

      // Only show "Tracking" badge if XHR interceptor is confirmed ready
      // Check both the event-based flag AND the global variable (in case event fired before listener)
      if (checkInterceptorReady()) {
        showInsertedBadge(composeWindow, true);
      } else {
        console.warn('Mailtrack: XHR interceptor not ready, badge will show error');
        showInsertedBadge(composeWindow, false);
      }

      // Intercept mousedown (before click) - inject pixel into DOM + signal XHR interceptor
      sendButton.addEventListener('mousedown', async (e) => {
        console.log('Mailtrack: Send button clicked, preparing pixel...');

        // IMMEDIATELY signal XHR interceptor to wait for pixel (backup method)
        window.dispatchEvent(new CustomEvent('mailtrack-prepare-send'));

        // Prepare the tracking pixel
        await preparePixelNow();

        // PRIMARY: Inject pixel directly into compose body DOM
        if (currentTrack) {
          injectPixelIntoDom(composeBody, currentTrack.pixel_url);
        }

        console.log('Mailtrack: Pixel ready (DOM + XHR backup)');
      }, { capture: true });
    }
  };

  // Intercept keyboard send (Ctrl+Enter / Cmd+Enter)
  const handleKeyboardSend = async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      console.log('Mailtrack: Keyboard send detected (Ctrl/Cmd+Enter)');

      window.dispatchEvent(new CustomEvent('mailtrack-prepare-send'));

      await preparePixelNow();

      if (currentTrack) {
        injectPixelIntoDom(composeBody, currentTrack.pixel_url);
      }
    }
  };

  const cleanupComposeState = () => {
    if (composeDisposed) {
      return;
    }

    composeDisposed = true;

    if (currentTrack?.messageId) {
      clearPendingPixel(currentTrack.messageId);
    }

    composeBody.removeEventListener('keydown', handleKeyboardSend, true);
    if (composeWindow) {
      composeWindow.removeEventListener('keydown', handleKeyboardSend, true);
    }

    buttonObserver?.disconnect();
    composeLifecycleObserver?.disconnect();
  };

  // Add keyboard listener to the compose body
  composeBody.addEventListener('keydown', handleKeyboardSend, { capture: true });
  // Also listen on the compose window for subject field Ctrl+Enter
  if (composeWindow) {
    composeWindow.addEventListener('keydown', handleKeyboardSend, { capture: true });
  }

  // Try to find send button now and watch for it
  findAndInterceptSendButton();

  buttonObserver = new MutationObserver(() => {
    findAndInterceptSendButton();
  });
  if (composeWindow) {
    buttonObserver.observe(composeWindow, { childList: true, subtree: true });
  }

  composeLifecycleObserver = new MutationObserver(() => {
    if (!composeBody.isConnected || (composeWindow && !composeWindow.isConnected)) {
      cleanupComposeState();
    }
  });
  composeLifecycleObserver.observe(document.body, { childList: true, subtree: true });
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
  clearPendingPixel(messageId, { notifyInterceptor: false });
});

// Initialize
console.log('Mailtrack: Content script loaded at', new Date().toISOString());
console.log('Mailtrack: Document readyState:', document.readyState);

// Inject XHR interceptor immediately
injectXHRInterceptor();

// Start observing when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('Mailtrack: DOMContentLoaded fired');
    observeComposeWindows();
  });
} else {
  console.log('Mailtrack: DOM already ready, starting observer');
  observeComposeWindows();
}
