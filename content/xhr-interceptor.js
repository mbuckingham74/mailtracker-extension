// XHR Interceptor for Gmail
// Intercepts Gmail's XHR/fetch requests and injects tracking pixels
// into outgoing emails AFTER Gmail has sanitized the content but BEFORE
// the request leaves the browser.
//
// Must be injected into page context (not content script) to access XHR/fetch.

(function() {
  'use strict';

  // Store pending tracking pixels to inject
  window.__mailtrackPendingPixels = window.__mailtrackPendingPixels || {};

  // Flags for coordinating with content script
  window.__mailtrackWaitingForPixel = false;
  window.__mailtrackPixelReady = false;
  // Set true once pixel is injected so we stop intercepting further requests
  let pixelInjectedThisSend = false;

  window.addEventListener('mailtrack-inject-pixel', function(e) {
    const { pixelUrl, recipient, subject, messageId } = e.detail;
    console.log('Mailtrack XHR: Received pixel to inject:', pixelUrl);
    window.__mailtrackPendingPixels[messageId] = { pixelUrl, recipient, subject };
    window.__mailtrackPixelReady = true;
  });

  window.addEventListener('mailtrack-prepare-send', function() {
    console.log('Mailtrack XHR: Prepare-send signal received');
    window.__mailtrackWaitingForPixel = true;
    window.__mailtrackPixelReady = false;
    pixelInjectedThisSend = false;
  });

  // Returns true if there's a pixel pending and we haven't injected yet
  function shouldIntercept() {
    if (pixelInjectedThisSend) return false;
    return Object.keys(window.__mailtrackPendingPixels).length > 0 || window.__mailtrackWaitingForPixel;
  }

  // Mark injection complete and reset all flags
  function markDone() {
    pixelInjectedThisSend = true;
    window.__mailtrackWaitingForPixel = false;
  }

  // Check if a string body contains HTML email content
  function containsEmailHtml(str) {
    return str.includes('<div') || str.includes('<\\/div') || str.includes('</div');
  }

  // Inject tracking pixel into a string body
  function injectPixelIntoBody(body) {
    const pendingKeys = Object.keys(window.__mailtrackPendingPixels);
    if (pendingKeys.length === 0) return body;

    const messageId = pendingKeys[pendingKeys.length - 1];
    const pixelData = window.__mailtrackPendingPixels[messageId];
    if (!pixelData) return body;

    const pixelHtml = `<img src="${pixelData.pixelUrl}" width="1" height="1" style="display:none">`;
    const pixelHtmlJsonEscaped = pixelHtml.replace(/"/g, '\\"');
    const pixelHtmlFullEscaped = pixelHtml.replace(/"/g, '\\"').replace(/\//g, '\\/');

    let modifiedBody = body;

    // Pattern 1: JSON-escaped HTML with \/ escaping (most common Gmail format)
    if (modifiedBody === body) {
      const p = /<\\\/div>(?=")/;
      if (p.test(body)) {
        modifiedBody = body.replace(p, pixelHtmlFullEscaped + '<\\/div>');
      }
    }

    // Pattern 2: JSON-escaped HTML with regular /
    if (modifiedBody === body) {
      const p = /<\/div>(?=")/;
      if (p.test(body)) {
        modifiedBody = body.replace(p, pixelHtmlJsonEscaped + '</div>');
      }
    }

    // Pattern 3: Last escaped </div>
    if (modifiedBody === body) {
      const idx = body.lastIndexOf('<\\/div>');
      if (idx !== -1) {
        modifiedBody = body.slice(0, idx) + pixelHtmlFullEscaped + body.slice(idx);
      }
    }

    // Pattern 4: Unescaped HTML
    if (modifiedBody === body) {
      const idx = body.lastIndexOf('</div>');
      if (idx !== -1) {
        modifiedBody = body.slice(0, idx) + pixelHtml + body.slice(idx);
      }
    }

    // Pattern 5: Before </body>
    if (modifiedBody === body) {
      const idx = body.lastIndexOf('</body>');
      if (idx !== -1) {
        modifiedBody = body.slice(0, idx) + pixelHtml + body.slice(idx);
      }
    }

    delete window.__mailtrackPendingPixels[messageId];

    if (modifiedBody !== body) {
      console.log('Mailtrack XHR: Pixel injected successfully');
      markDone();
      window.dispatchEvent(new CustomEvent('mailtrack-pixel-injected', {
        detail: { messageId, success: true }
      }));
    }

    return modifiedBody;
  }

  // Try to inject pixel into a string. Returns { body, modified }.
  function tryInjectString(str) {
    if (!containsEmailHtml(str)) return { body: str, modified: false };
    const result = injectPixelIntoBody(str);
    return { body: result, modified: result !== str };
  }

  // Wait for pixel with timeout
  function waitForPixel(maxWaitMs = 2000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (window.__mailtrackPixelReady || Object.keys(window.__mailtrackPendingPixels).length > 0) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - start > maxWaitMs) {
          clearInterval(iv);
          console.log('Mailtrack XHR: Timeout waiting for pixel');
          resolve(false);
        }
      }, 50);
    });
  }

  // --- XHR Override ---
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._mtUrl = url;
    this._mtMethod = method;
    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  // Try to decode a Uint8Array/ArrayBuffer body as text and inject pixel
  function tryInjectBinary(body) {
    try {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (containsEmailHtml(text)) {
        const result = tryInjectString(text);
        if (result.modified) {
          return { body: new TextEncoder().encode(result.body), modified: true };
        }
      }
    } catch (e) { /* ignore decode errors */ }
    return { body, modified: false };
  }

  XMLHttpRequest.prototype.send = function(body) {
    const xhr = this;

    if (this._mtMethod === 'POST' && body && shouldIntercept()) {
      const bodyType = typeof body === 'string' ? 'string' : body?.constructor?.name || typeof body;
      const bodyLen = typeof body === 'string' ? body.length : body?.byteLength || body?.size || '?';
      console.log(`Mailtrack XHR: POST ${(this._mtUrl || '').toString().substring(0, 100)} | ${bodyType}(${bodyLen})`);

      // If still waiting for pixel, delay until ready
      if (window.__mailtrackWaitingForPixel && !window.__mailtrackPixelReady) {
        waitForPixel(2000).then(() => {
          const result = tryProcessBody(body);
          if (result.modified) console.log('Mailtrack XHR: Pixel injected (delayed)');
          originalXHRSend.call(xhr, result.body);
        });
        return;
      }

      const result = tryProcessBody(body);
      if (result.modified) console.log('Mailtrack XHR: Pixel injected');
      return originalXHRSend.call(this, result.body);
    }

    return originalXHRSend.call(this, body);
  };

  // Process string or binary body for injection
  function tryProcessBody(body) {
    if (typeof body === 'string' && containsEmailHtml(body)) {
      return tryInjectString(body);
    }
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      return tryInjectBinary(body);
    }
    return { body, modified: false };
  }

  // --- Fetch Override ---
  const originalFetch = window.fetch;

  window.fetch = async function(input, init) {
    let method, body;

    if (input instanceof Request) {
      method = init?.method || input.method;
      body = init?.body !== undefined ? init.body : null;
    } else {
      method = init?.method || 'GET';
      body = init?.body;
    }

    const isPost = (method || '').toUpperCase() === 'POST';

    if (isPost && shouldIntercept()) {
      const bodyType = body ? (typeof body === 'string' ? 'string' : body?.constructor?.name || typeof body) : 'null';
      const isReqObj = input instanceof Request && !init;
      console.log(`Mailtrack Fetch: POST ${isReqObj ? input.url.substring(0, 100) : 'init-based'} | body=${bodyType} | Request=${isReqObj}`);

      // Wait for pixel if needed
      if (window.__mailtrackWaitingForPixel && !window.__mailtrackPixelReady) {
        await waitForPixel(2000);
      }

      // Handle Request objects without init (body is on the Request)
      if (input instanceof Request && !init) {
        try {
          const cloned = input.clone();
          const bodyText = await cloned.text();

          if (containsEmailHtml(bodyText)) {
            const result = tryInjectString(bodyText);
            if (result.modified) {
              return originalFetch.call(this, input.url, {
                method: input.method,
                headers: input.headers,
                body: result.body,
                mode: input.mode,
                credentials: input.credentials,
                cache: input.cache,
                redirect: input.redirect,
                referrer: input.referrer,
                integrity: input.integrity,
              });
            }
          }

          // Body was consumed by text() - rebuild with original text
          return originalFetch.call(this, input.url, {
            method: input.method,
            headers: input.headers,
            body: bodyText,
            mode: input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrer: input.referrer,
            integrity: input.integrity,
          });
        } catch (e) {
          // Couldn't read as text - pass through original
          return originalFetch.call(this, input, init);
        }
      }

      // Handle init-based bodies (string or binary)
      if (body) {
        const result = tryProcessBody(body);
        if (result.modified) {
          const options = { ...init, body: result.body };
          if (input instanceof Request) {
            return originalFetch.call(this, input.url, { ...options, method });
          }
          return originalFetch.call(this, input, options);
        }
      }
    }

    // Pass through unmodified
    return originalFetch.call(this, input, init);
  };

  console.log('Mailtrack XHR Interceptor: Ready');
  window.__mailtrackInterceptorReady = true;
  window.dispatchEvent(new CustomEvent('mailtrack-interceptor-ready'));
})();
