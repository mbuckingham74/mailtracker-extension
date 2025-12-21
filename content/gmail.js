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

// Extract recipient emails from Gmail's compose window
function extractRecipients(composeWindow) {
  const recipients = [];

  // Method 1: Look for email chips/pills (Gmail shows recipients as chips)
  // These are typically spans or divs with email attribute or data-hovercard-id
  const emailChips = composeWindow.querySelectorAll(
    '[email], [data-hovercard-id*="@"], [data-email]'
  );
  emailChips.forEach(chip => {
    const email = chip.getAttribute('email') ||
                  chip.getAttribute('data-email') ||
                  chip.getAttribute('data-hovercard-id');
    if (email && email.includes('@')) {
      recipients.push(email);
    }
  });

  // Method 2: Look for the "To" row and find emails within it
  if (recipients.length === 0) {
    const toRow = composeWindow.querySelector('[aria-label*="To"]')?.closest('tr, div[class]') ||
                  composeWindow.querySelector('[name="to"]')?.closest('tr, div[class]');
    if (toRow) {
      // Look for any element containing an email pattern
      const allText = toRow.innerText;
      const emailMatch = allText.match(/[\w.-]+@[\w.-]+\.\w+/g);
      if (emailMatch) {
        recipients.push(...emailMatch);
      }
    }
  }

  // Method 3: Look for spans with specific Gmail classes that contain email addresses
  if (recipients.length === 0) {
    const spans = composeWindow.querySelectorAll('span[email], div[email], span.vN, span[data-hovercard-owner-id]');
    spans.forEach(span => {
      const email = span.getAttribute('email') || span.textContent;
      if (email && email.includes('@')) {
        // Extract just the email if there's extra text
        const match = email.match(/[\w.-]+@[\w.-]+\.\w+/);
        if (match) recipients.push(match[0]);
      }
    });
  }

  // Method 4: Check the input field itself (for when user is still typing)
  if (recipients.length === 0) {
    const toInput = composeWindow.querySelector('input[name="to"]') ||
                    composeWindow.querySelector('input[aria-label="To recipients"]') ||
                    composeWindow.querySelector('input[aria-label="To"]') ||
                    composeWindow.querySelector('[name="to"]');
    if (toInput?.value && toInput.value.includes('@')) {
      const match = toInput.value.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (match) recipients.push(match[0]);
    }
  }

  // Return unique recipients as array
  return [...new Set(recipients)];
}

// Insert tracking pixels into compose window (one per recipient)
async function insertTrackingPixels(composeBody, composeWindow) {
  // Get recipients and subject from the compose window
  const recipients = extractRecipients(composeWindow);

  const subjectInput = composeWindow.querySelector('input[name="subjectbox"]') ||
                       composeWindow.querySelector('input[aria-label="Subject"]');

  const subject = subjectInput?.value || '';

  // If no recipients found, create one pixel with empty recipient
  const recipientList = recipients.length > 0 ? recipients : [''];

  console.log('Mailtrack: Inserting pixels for', recipientList.length, 'recipient(s):', recipientList, subject);

  // Generate a single group ID for all recipients in this email
  const messageGroupId = generateUUID();
  let successCount = 0;

  // Create a tracking pixel for each recipient
  for (const recipient of recipientList) {
    const track = await createTrackingPixel(recipient, subject, messageGroupId);

    if (track) {
      // Create the tracking pixel element
      const pixelHtml = `<img src="${track.pixel_url}" width="1" height="1" style="display:none" alt="" data-mailtrack-id="${track.id}" data-mailtrack-recipient="${recipient}">`;

      // Insert at the end of the email body
      composeBody.insertAdjacentHTML('beforeend', pixelHtml);

      console.log('Mailtrack: Inserted tracking pixel for', recipient || '(unknown)', track.id);
      successCount++;
    }
  }

  return successCount > 0;
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

        const success = await insertTrackingPixels(composeBody, composeWindow);

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
