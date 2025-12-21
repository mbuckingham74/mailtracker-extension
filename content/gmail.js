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

  // Strategy: Find elements with [email] attribute that are INSIDE the header area
  // but NOT inside dropdown/suggestion containers

  // The compose header contains To/CC/BCC rows
  // Suggestions appear in elements with role="listbox" or similar

  // First, find all elements with [email] attribute
  const allEmailElements = composeWindow.querySelectorAll('[email]');
  console.log('Mailtrack: Found', allEmailElements.length, 'elements with [email] attribute');

  allEmailElements.forEach(el => {
    const email = el.getAttribute('email');
    if (!email || !email.includes('@')) return;

    // Exclude if inside a listbox (suggestions dropdown)
    if (el.closest('[role="listbox"]')) {
      console.log('Mailtrack: Skipping (in listbox):', email);
      return;
    }

    // Exclude if inside autocomplete suggestions
    if (el.closest('[role="presentation"]') && !el.closest('[role="option"]')) {
      console.log('Mailtrack: Skipping (in presentation):', email);
      return;
    }

    // Check if this looks like a selected chip (has specific Gmail chip classes/structure)
    // Selected chips typically have data-name attribute or are inside a specific structure
    const isChip = el.hasAttribute('data-name') ||
                   el.closest('[data-name]') ||
                   el.closest('.afV') ||  // Gmail chip container class
                   el.getAttribute('tabindex') === '0';

    if (isChip) {
      console.log('Mailtrack: Found recipient chip:', email);
      recipients.add(email);
    } else {
      // Also accept if it's in a row that contains "To", "Cc", or "Bcc" text
      const row = el.closest('tr') || el.closest('[role="group"]') || el.parentElement?.parentElement?.parentElement;
      if (row) {
        const rowText = row.textContent?.toLowerCase() || '';
        if (rowText.includes('to') || rowText.includes('cc') || rowText.includes('bcc')) {
          console.log('Mailtrack: Found recipient in header row:', email);
          recipients.add(email);
        }
      }
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

  // Gmail strips most programmatically-inserted content during send.
  // The key insight: Gmail preserves content that looks like user-typed HTML.
  // We need to insert the pixel in a way that Gmail's sanitizer won't remove.
  //
  // Strategy: Insert as a simple img with no suspicious attributes.
  // The img must be inserted via execCommand while the compose body is focused.

  // Try multiple pixel formats - Gmail may accept one but not others
  const pixelFormats = [
    // Format 1: Bare minimum img tag
    `<img src="${track.pixel_url}">`,
    // Format 2: With dimensions as attributes only (no style)
    `<img src="${track.pixel_url}" width="1" height="1">`,
    // Format 3: Wrapped in a div (sometimes helps)
    `<div><img src="${track.pixel_url}" width="1" height="1"></div>`,
  ];

  let success = false;

  for (let i = 0; i < pixelFormats.length && !success; i++) {
    const pixelHtml = pixelFormats[i];
    console.log(`Mailtrack: Trying pixel format ${i + 1}:`, pixelHtml);

    // Re-focus and position cursor each attempt
    composeBody.focus();
    const sel = window.getSelection();
    const rng = document.createRange();
    rng.selectNodeContents(composeBody);
    rng.collapse(false);
    sel.removeAllRanges();
    sel.addRange(rng);

    // Insert via execCommand
    document.execCommand('insertHTML', false, pixelHtml);

    // Check if it worked
    if (hasTrackingPixel(composeBody)) {
      console.log(`Mailtrack: Format ${i + 1} succeeded!`);
      success = true;
    } else {
      console.log(`Mailtrack: Format ${i + 1} was stripped immediately`);
    }
  }

  // Last resort: direct DOM manipulation
  if (!success) {
    console.log('Mailtrack: All execCommand formats failed, trying direct DOM insertion');
    const img = document.createElement('img');
    img.src = track.pixel_url;
    img.width = 1;
    img.height = 1;
    composeBody.appendChild(img);
    success = hasTrackingPixel(composeBody);
    console.log('Mailtrack: Direct DOM insertion result:', success);
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
