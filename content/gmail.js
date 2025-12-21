// Mailtrack Gmail Content Script
// Automatically inserts tracking pixels into Gmail compose windows
//
// Strategy: Insert pixels IMMEDIATELY when compose window opens using execCommand.
// This ensures Gmail treats the pixel as user-typed content and preserves it through send.
// We use a single pixel per email (not per-recipient) for simplicity.

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

// Generate a UUID for message grouping
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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

// Check if a compose body already has a tracking pixel
function hasTrackingPixel(element) {
  return element.innerHTML.includes('mailtrack.tachyonfuture.com');
}

// Extract recipient emails from Gmail's compose window
function extractRecipients(composeWindow) {
  const recipients = new Set();

  // Method 1: Look for email chips/pills with email attribute (most reliable)
  const emailChips = composeWindow.querySelectorAll('[email]');
  console.log('Mailtrack: Method 1 - Found', emailChips.length, 'elements with [email] attribute');
  emailChips.forEach(chip => {
    const email = chip.getAttribute('email');
    if (email && email.includes('@')) {
      console.log('Mailtrack: Method 1 - Adding recipient:', email);
      recipients.add(email);
    }
  });

  // Method 2: Look for data-hovercard-id containing @ (always check, don't skip)
  const hovercardElements = composeWindow.querySelectorAll('[data-hovercard-id]');
  console.log('Mailtrack: Method 2 - Found', hovercardElements.length, 'elements with [data-hovercard-id]');
  hovercardElements.forEach(el => {
    const id = el.getAttribute('data-hovercard-id');
    if (id && id.includes('@')) {
      console.log('Mailtrack: Method 2 - Adding recipient:', id);
      recipients.add(id);
    }
  });

  // Method 3: Parse the "To" field text for email patterns (always check)
  const toContainer = composeWindow.querySelector('[aria-label="To recipients"]') ||
                      composeWindow.querySelector('[name="to"]')?.closest('div');
  if (toContainer) {
    const text = toContainer.textContent || '';
    console.log('Mailtrack: Method 3 - To field text:', text);
    const matches = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
    if (matches) {
      matches.forEach(email => {
        console.log('Mailtrack: Method 3 - Adding recipient:', email);
        recipients.add(email);
      });
    }
  }

  // Method 4: Look in CC and BCC fields too
  const ccContainer = composeWindow.querySelector('[aria-label="Cc recipients"]');
  const bccContainer = composeWindow.querySelector('[aria-label="Bcc recipients"]');
  [ccContainer, bccContainer].forEach(container => {
    if (container) {
      container.querySelectorAll('[email]').forEach(chip => {
        const email = chip.getAttribute('email');
        if (email && email.includes('@')) {
          console.log('Mailtrack: Method 4 (CC/BCC) - Adding recipient:', email);
          recipients.add(email);
        }
      });
    }
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

// Insert tracking pixel into compose body using execCommand
// Using div with background-image CSS which survives Gmail's sanitization better than img tags
async function insertTrackingPixel(composeBody, composeWindow) {
  if (hasTrackingPixel(composeBody)) {
    console.log('Mailtrack: Pixel already exists, skipping');
    return false;
  }

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
    return false;
  }

  console.log('Mailtrack: Inserting pixel via execCommand', track.id);

  // Focus the compose body
  composeBody.focus();

  // Move cursor to end of compose body
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composeBody);
  range.collapse(false); // collapse to end
  selection.removeAllRanges();
  selection.addRange(range);

  // Use a simple img tag with absolute minimal attributes
  // Gmail should preserve standard img tags with external URLs
  // Adding style to ensure it's truly invisible and doesn't affect layout
  const pixelHtml = `<img src="${track.pixel_url}" width="1" height="1" style="display:block;width:1px;height:1px;border:0;" alt="">`;

  console.log('Mailtrack: Pixel HTML to insert:', pixelHtml);

  // Try execCommand first
  let success = document.execCommand('insertHTML', false, pixelHtml);

  // If execCommand fails, try direct DOM insertion as fallback
  if (!success || !hasTrackingPixel(composeBody)) {
    console.log('Mailtrack: execCommand failed or pixel not found, trying direct DOM insertion');
    const img = document.createElement('img');
    img.src = track.pixel_url;
    img.width = 1;
    img.height = 1;
    img.style.cssText = 'display:block;width:1px;height:1px;border:0;';
    img.alt = '';
    composeBody.appendChild(img);
    success = hasTrackingPixel(composeBody);
  }

  if (success) {
    console.log('Mailtrack: execCommand returned true');
    // Log full compose body to see what's there
    console.log('Mailtrack: Full compose body innerHTML:', composeBody.innerHTML);

    // Verify it's actually in the DOM
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: SUCCESS - Pixel verified in compose body');
      return true;
    } else {
      console.warn('Mailtrack: FAILED - execCommand succeeded but pixel not found in DOM');
      console.log('Mailtrack: Searching for any img tags:', composeBody.querySelectorAll('img').length);
      return false;
    }
  } else {
    console.error('Mailtrack: execCommand returned false');
    return false;
  }
}

// Show notification badge
function showInsertedBadge(composeWindow, success) {
  // Find a good place to show the badge
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
    badge.title = success ? 'Tracking pixel inserted' : 'Failed to insert tracking pixel';
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

  // Find and intercept the send button instead of inserting immediately
  // This avoids disrupting the user's typing
  const findAndInterceptSendButton = () => {
    const sendButton = composeWindow?.querySelector('[aria-label*="Send"]') ||
                       composeWindow?.querySelector('[data-tooltip*="Send"]') ||
                       composeWindow?.querySelector('.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3');

    if (sendButton && !sendButton.dataset.mailtrackIntercepted) {
      sendButton.dataset.mailtrackIntercepted = 'true';
      console.log('Mailtrack: Intercepting send button');
      showInsertedBadge(composeWindow, true);

      // Intercept mousedown (before click) to insert pixel
      sendButton.addEventListener('mousedown', async (e) => {
        // Check if pixel already inserted
        if (hasTrackingPixel(composeBody)) {
          console.log('Mailtrack: Pixel already exists, allowing send');
          return;
        }

        console.log('Mailtrack: Intercepted send, inserting pixel...');
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Insert pixel now
        const success = await insertTrackingPixel(composeBody, composeWindow);
        console.log('Mailtrack: Pixel insertion result:', success);

        // Trigger send after delay to allow DOM to settle
        // Using 300ms to ensure Gmail has processed the content
        setTimeout(() => {
          console.log('Mailtrack: Triggering send after pixel insertion');
          // Verify pixel is still there before sending
          if (hasTrackingPixel(composeBody)) {
            console.log('Mailtrack: Pixel confirmed present before send');
          } else {
            console.warn('Mailtrack: WARNING - Pixel disappeared before send!');
          }
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          sendButton.dispatchEvent(clickEvent);
        }, 300);

      }, { capture: true, once: true });
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
