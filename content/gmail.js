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
  // Check for our tracking div with background-image
  return element.querySelector('div[data-mailtrack]') !== null ||
         element.innerHTML.includes('mailtrack.tachyonfuture.com');
}

// Insert tracking pixel into compose body using execCommand
// Using div with background-image CSS which survives Gmail's sanitization better than img tags
async function insertTrackingPixel(composeBody) {
  if (hasTrackingPixel(composeBody)) {
    console.log('Mailtrack: Pixel already exists, skipping');
    return false;
  }

  // Create a single tracking pixel for this email
  const messageGroupId = generateUUID();
  const track = await createTrackingPixel('', '', messageGroupId);

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

  // Use a div with background-image CSS - this approach survives Gmail's sanitization
  // Gmail strips custom data attributes but preserves inline styles with background-image
  // The 1x1 dimensions and display:block ensure it loads but is invisible
  const pixelHtml = `<div style="background-image:url('${track.pixel_url}');width:1px;height:1px;display:block;font-size:0;line-height:0;overflow:hidden;" data-mailtrack="${track.id}"></div>`;

  const success = document.execCommand('insertHTML', false, pixelHtml);

  if (success) {
    console.log('Mailtrack: Pixel inserted successfully via execCommand');
    // Verify it's actually in the DOM
    if (hasTrackingPixel(composeBody)) {
      console.log('Mailtrack: Verified pixel is in compose body');
      console.log('Mailtrack: Compose body HTML preview:', composeBody.innerHTML.substring(0, 500));
      return true;
    } else {
      console.warn('Mailtrack: execCommand returned true but pixel not found in DOM');
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

  // Insert tracking pixel immediately
  // Small delay to let Gmail finish initializing the compose area
  setTimeout(async () => {
    const success = await insertTrackingPixel(composeBody);
    showInsertedBadge(composeWindow, success);
  }, 500);
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
