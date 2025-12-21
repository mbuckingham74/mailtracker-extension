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

  // Strategy: Find elements with [email] attribute
  // EXCLUDE only those in suggestion dropdowns (role="listbox")
  // This is more permissive - we accept any email chip that's not a suggestion

  const allEmailElements = composeWindow.querySelectorAll('[email]');
  console.log('Mailtrack: Found', allEmailElements.length, 'elements with [email] attribute');

  allEmailElements.forEach(el => {
    const email = el.getAttribute('email');
    if (!email || !email.includes('@')) return;

    // Log element details for debugging
    console.log('Mailtrack: Checking email:', email);
    console.log('  - tagName:', el.tagName);
    console.log('  - className:', el.className);
    console.log('  - has data-name:', el.hasAttribute('data-name'));
    console.log('  - in listbox:', !!el.closest('[role="listbox"]'));

    // ONLY exclude if inside a listbox (suggestions dropdown)
    // The listbox is the dropdown that appears while typing
    if (el.closest('[role="listbox"]')) {
      console.log('Mailtrack: Skipping (in suggestion listbox):', email);
      return;
    }

    // Accept this email
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

// Insert HTML using InputEvent (simulates paste-like behavior)
function insertViaInputEvent(element, html) {
  element.focus();

  // Create and dispatch an insertFromPaste input event
  const inputEvent = new InputEvent('beforeinput', {
    inputType: 'insertFromPaste',
    data: null,
    dataTransfer: createDataTransfer(html),
    bubbles: true,
    cancelable: true,
  });

  const dispatched = element.dispatchEvent(inputEvent);
  console.log('Mailtrack: InputEvent dispatched:', dispatched);
  return dispatched;
}

// Create a DataTransfer object with HTML content
function createDataTransfer(html) {
  const dt = new DataTransfer();
  dt.setData('text/html', html);
  return dt;
}

// Insert HTML by directly manipulating innerHTML (appending at end)
function insertViaInnerHTML(element, html) {
  const originalHTML = element.innerHTML;
  element.innerHTML = originalHTML + html;
  console.log('Mailtrack: Inserted via innerHTML append');
  return true;
}

// Insert using insertAdjacentHTML
function insertViaAdjacentHTML(element, html) {
  element.insertAdjacentHTML('beforeend', html);
  console.log('Mailtrack: Inserted via insertAdjacentHTML');
  return true;
}

// Trigger input event to notify Gmail of changes
function triggerInputEvent(element) {
  const event = new Event('input', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);

  // Also trigger a mutation-like change
  const changeEvent = new Event('change', { bubbles: true });
  element.dispatchEvent(changeEvent);
}

// Insert tracking pixel into compose body
// Try multiple methods since Gmail aggressively sanitizes content
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

  console.log('Mailtrack: Inserting pixel', track.id);

  // The pixel HTML - keeping it minimal
  const pixelHtml = `<img src="${track.pixel_url}" width="1" height="1">`;

  // Method 1: insertAdjacentHTML (most reliable for appending)
  console.log('Mailtrack: Method 1 - insertAdjacentHTML');
  try {
    insertViaAdjacentHTML(composeBody, pixelHtml);
    triggerInputEvent(composeBody);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: Method 1 SUCCESS');
      logResult(composeBody);
      return true;
    }
    console.log('Mailtrack: Method 1 failed - pixel stripped');
  } catch (e) {
    console.log('Mailtrack: Method 1 error:', e.message);
  }

  // Method 2: Direct innerHTML manipulation
  console.log('Mailtrack: Method 2 - innerHTML append');
  try {
    insertViaInnerHTML(composeBody, pixelHtml);
    triggerInputEvent(composeBody);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: Method 2 SUCCESS');
      logResult(composeBody);
      return true;
    }
    console.log('Mailtrack: Method 2 failed - pixel stripped');
  } catch (e) {
    console.log('Mailtrack: Method 2 error:', e.message);
  }

  // Method 3: Create img element and appendChild
  console.log('Mailtrack: Method 3 - createElement + appendChild');
  try {
    const img = document.createElement('img');
    img.src = track.pixel_url;
    img.width = 1;
    img.height = 1;
    composeBody.appendChild(img);
    triggerInputEvent(composeBody);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: Method 3 SUCCESS');
      logResult(composeBody);
      return true;
    }
    console.log('Mailtrack: Method 3 failed - pixel stripped');
  } catch (e) {
    console.log('Mailtrack: Method 3 error:', e.message);
  }

  // Method 4: execCommand as last resort (deprecated but sometimes works)
  console.log('Mailtrack: Method 4 - execCommand insertHTML');
  try {
    composeBody.focus();
    const execResult = document.execCommand('insertHTML', false, pixelHtml);
    console.log('Mailtrack: execCommand returned:', execResult);
    triggerInputEvent(composeBody);
    await new Promise(resolve => setTimeout(resolve, 50));
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: Method 4 SUCCESS');
      logResult(composeBody);
      return true;
    }
    console.log('Mailtrack: Method 4 failed - pixel stripped');
  } catch (e) {
    console.log('Mailtrack: Method 4 error:', e.message);
  }

  console.error('Mailtrack: All insertion methods failed');
  return false;
}

// Helper to log the result
function logResult(composeBody) {
  console.log('Mailtrack: Full compose body innerHTML:', composeBody.innerHTML);
  console.log('Mailtrack: Pixel verified in compose body');
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
