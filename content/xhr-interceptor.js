// XHR Interceptor for Gmail
// This script intercepts Gmail's XHR requests and injects tracking pixels
// into outgoing emails AFTER Gmail has sanitized the content but BEFORE
// the request leaves the browser.
//
// This script must be injected into the page context (not content script)
// because content scripts can't access the page's XHR/fetch objects.

(function() {
  'use strict';

  const MAILTRACK_DOMAIN = 'mailtrack.tachyonfuture.com';

  console.log('Mailtrack XHR Interceptor: Initializing...');

  // Store pending tracking pixels to inject
  // Key: message identifier, Value: { pixelUrl, recipient, subject }
  window.__mailtrackPendingPixels = window.__mailtrackPendingPixels || {};

  // Flag to indicate we're waiting for a pixel before sending
  window.__mailtrackWaitingForPixel = false;
  window.__mailtrackPixelReady = false;

  // Listen for messages from the content script
  window.addEventListener('mailtrack-inject-pixel', function(e) {
    const { pixelUrl, recipient, subject, messageId } = e.detail;
    console.log('Mailtrack XHR: Received pixel to inject:', pixelUrl);
    window.__mailtrackPendingPixels[messageId] = { pixelUrl, recipient, subject };
    window.__mailtrackPixelReady = true;
  });

  // Listen for "prepare for send" signal - this should come BEFORE the actual send
  window.addEventListener('mailtrack-prepare-send', function(e) {
    console.log('Mailtrack XHR: Received prepare-send signal, will wait for pixel');
    window.__mailtrackWaitingForPixel = true;
    window.__mailtrackPixelReady = false;
  });

  // Helper to detect if this is a Gmail send request
  function isGmailSendRequest(url, body) {
    const urlStr = url.toString();

    // Log ALL POST requests to find the send pattern
    if (body && typeof body === 'string' && body.length > 100) {
      // Check if body contains HTML content (likely an email)
      if (body.includes('<div') || body.includes('</div>')) {
        console.log('Mailtrack XHR: Found HTML in request body');
        console.log('Mailtrack XHR: URL:', urlStr);
        console.log('Mailtrack XHR: Body preview:', body.substring(0, 1000));
        return true;
      }
    }

    // Gmail send requests go to specific endpoints
    const sendPatterns = [
      '/mail/u/0/?', // Gmail send URL pattern
      'act=sm',      // Send mail action
    ];

    const isSendUrl = sendPatterns.some(pattern => urlStr.includes(pattern));

    // Also check if body contains email content indicators
    if (body && typeof body === 'string') {
      const hasEmailContent = body.includes('body=') ||
                              body.includes('composeid=');
      if (hasEmailContent) {
        console.log('Mailtrack XHR: Found email content in body');
        console.log('Mailtrack XHR: Body preview:', body.substring(0, 1000));
        return true;
      }
    }

    return isSendUrl;
  }

  // Inject tracking pixel into email body
  function injectPixelIntoBody(body) {
    const pendingKeys = Object.keys(window.__mailtrackPendingPixels);
    if (pendingKeys.length === 0) {
      console.log('Mailtrack XHR: No pending pixels to inject');
      return body;
    }

    // Get the most recent pending pixel
    const messageId = pendingKeys[pendingKeys.length - 1];
    const pixelData = window.__mailtrackPendingPixels[messageId];

    if (!pixelData) {
      return body;
    }

    console.log('Mailtrack XHR: Injecting pixel:', pixelData.pixelUrl);

    // The tracking pixel HTML - minimal to avoid detection
    const pixelHtml = `<img src="${pixelData.pixelUrl}" width="1" height="1">`;
    // JSON-escaped version (for when HTML is inside JSON strings)
    const pixelHtmlJsonEscaped = pixelHtml.replace(/"/g, '\\"');

    let modifiedBody = body;

    // Gmail uses a JSON array format where HTML is escaped within strings
    // Example: ..."<div dir=\"ltr\">content</div>"...
    // We need to insert our pixel with proper JSON escaping

    // Pattern 1: JSON-escaped HTML (most common Gmail format)
    // Look for escaped closing div: <\/div> or </div> within JSON
    const jsonEscapedDivPattern = /<\\\/div>(?=")/;
    if (jsonEscapedDivPattern.test(body)) {
      modifiedBody = body.replace(jsonEscapedDivPattern, pixelHtmlJsonEscaped + '<\\/div>');
      console.log('Mailtrack XHR: Inserted pixel (JSON-escaped format)');
    }

    // Pattern 2: Regular escaped div in JSON string (alternative escaping)
    if (modifiedBody === body) {
      const altPattern = /<\/div>(?=")/;
      if (altPattern.test(body)) {
        modifiedBody = body.replace(altPattern, pixelHtmlJsonEscaped + '</div>');
        console.log('Mailtrack XHR: Inserted pixel (alt JSON format)');
      }
    }

    // Pattern 3: Look for the email content pattern in Gmail's format
    // Gmail format: [0,"<div dir=\"ltr\">content</div>"]
    if (modifiedBody === body) {
      // Find HTML content in JSON array format
      const gmailHtmlPattern = /("< *div[^"]*>)([^"]*?)(<\\?\/div>")/ ;
      if (body.match(gmailHtmlPattern)) {
        modifiedBody = body.replace(gmailHtmlPattern, (match, start, content, end) => {
          // Insert pixel before closing div, with proper escaping
          const escapedPixel = pixelHtml.replace(/"/g, '\\"').replace(/\//g, '\\/');
          return start + content + escapedPixel + end;
        });
        console.log('Mailtrack XHR: Inserted pixel (Gmail HTML pattern)');
      }
    }

    // Pattern 4: Direct string replacement for escaped HTML
    if (modifiedBody === body) {
      // Try finding the last occurrence of escaped </div> in the body
      const escapedClosingDiv = '<\\/div>';
      const lastIndex = body.lastIndexOf(escapedClosingDiv);
      if (lastIndex !== -1) {
        const escapedPixel = pixelHtml.replace(/"/g, '\\"').replace(/\//g, '\\/');
        modifiedBody = body.slice(0, lastIndex) + escapedPixel + body.slice(lastIndex);
        console.log('Mailtrack XHR: Inserted pixel (escaped div search)');
      }
    }

    // Pattern 5: Fallback - unescaped HTML (older format or form data)
    if (modifiedBody === body) {
      const lastDivIndex = body.lastIndexOf('</div>');
      if (lastDivIndex !== -1 && !body.includes('<\\/div>')) {
        modifiedBody = body.slice(0, lastDivIndex) + pixelHtml + body.slice(lastDivIndex);
        console.log('Mailtrack XHR: Inserted pixel (unescaped HTML)');
      }
    }

    // Clean up the pending pixel
    delete window.__mailtrackPendingPixels[messageId];

    if (modifiedBody !== body) {
      console.log('Mailtrack XHR: Successfully injected pixel');
      // Notify content script of success
      window.dispatchEvent(new CustomEvent('mailtrack-pixel-injected', {
        detail: { messageId, success: true }
      }));
    } else {
      console.log('Mailtrack XHR: Could not find injection point');
      console.log('Mailtrack XHR: Body preview:', body.substring(0, 500));
    }

    return modifiedBody;
  }

  // Recursively search JSON for email content and inject pixel
  function injectPixelIntoJson(obj, pixelHtml) {
    if (typeof obj === 'string') {
      // If this looks like HTML content, inject the pixel
      if (obj.includes('<div') || obj.includes('<body') || obj.includes('<html')) {
        const lastDivIndex = obj.lastIndexOf('</div>');
        if (lastDivIndex !== -1) {
          return obj.slice(0, lastDivIndex) + pixelHtml + obj.slice(lastDivIndex);
        }
        // Try before </body>
        const lastBodyIndex = obj.lastIndexOf('</body>');
        if (lastBodyIndex !== -1) {
          return obj.slice(0, lastBodyIndex) + pixelHtml + obj.slice(lastBodyIndex);
        }
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => injectPixelIntoJson(item, pixelHtml));
    }

    if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const key of Object.keys(obj)) {
        result[key] = injectPixelIntoJson(obj[key], pixelHtml);
      }
      return result;
    }

    return obj;
  }

  // Helper to wait for pixel with timeout
  function waitForPixel(maxWaitMs = 2000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (window.__mailtrackPixelReady || Object.keys(window.__mailtrackPendingPixels).length > 0) {
          clearInterval(checkInterval);
          console.log('Mailtrack XHR: Pixel is ready, proceeding with send');
          resolve(true);
        } else if (Date.now() - startTime > maxWaitMs) {
          clearInterval(checkInterval);
          console.log('Mailtrack XHR: Timeout waiting for pixel, proceeding without');
          resolve(false);
        }
      }, 50);
    });
  }

  // Override XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._mailtrackUrl = url;
    this._mailtrackMethod = method;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const xhr = this;
    const url = this._mailtrackUrl;
    const method = this._mailtrackMethod;

    // Check if this looks like an email send request
    if (method === 'POST' && body && typeof body === 'string') {
      const isEmailSend = body.includes('<div') && body.includes('</div>');

      if (isEmailSend) {
        console.log('Mailtrack XHR: Detected email send request');

        // If we're waiting for a pixel, delay the send
        if (window.__mailtrackWaitingForPixel && !window.__mailtrackPixelReady) {
          console.log('Mailtrack XHR: Waiting for pixel before sending...');

          // We need to handle this asynchronously
          waitForPixel(2000).then(() => {
            const modifiedBody = injectPixelIntoBody(body);
            window.__mailtrackWaitingForPixel = false;
            originalXHRSend.call(xhr, modifiedBody);
          });
          return; // Don't send yet
        }

        // Pixel already ready or not waiting, inject and send
        const modifiedBody = injectPixelIntoBody(body);
        return originalXHRSend.call(this, modifiedBody);
      }
    }

    return originalXHRSend.call(this, body);
  };

  // Also override fetch for newer Gmail implementations
  const originalFetch = window.fetch;

  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;

    if (init && init.method === 'POST' && isGmailSendRequest(url, init.body)) {
      console.log('Mailtrack Fetch: Intercepted potential send request to:', url);

      if (init.body && typeof init.body === 'string') {
        init.body = injectPixelIntoBody(init.body);
      }
    }

    return originalFetch.call(this, input, init);
  };

  console.log('Mailtrack XHR Interceptor: Ready - XHR and Fetch intercepted');
})();
