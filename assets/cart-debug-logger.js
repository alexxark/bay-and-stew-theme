/*
 * cart-debug-logger.js
 *
 * READ-ONLY diagnostic. Wraps window.fetch (and XMLHttpRequest) to log every
 * call to Shopify's cart endpoints with URL, request body, response summary,
 * and the JS call stack. Use to find the source of the cart-duplicate bug.
 *
 * Output goes to console.group entries prefixed with [cart-debug].
 *
 * To enable: this script is loaded by the theme. To disable, remove the
 * <script> tag in layout/theme.liquid.
 *
 * To filter logs in DevTools console: filter on the string  cart-debug
 *
 * To dump the full mutation history at any time, run in console:
 *   copy(JSON.stringify(window.__cartDebugLog, null, 2))
 */

(function () {
  if (window.__cartDebugLoggerInstalled) return;
  window.__cartDebugLoggerInstalled = true;

  const CART_PATTERNS = [
    '/cart/add',
    '/cart/change',
    '/cart/update',
    '/cart/clear',
    '/cart.js',
    '/cart?',
    '/cart/',
  ];

  window.__cartDebugLog = [];

  const MAX_LOG_ENTRIES = 200;

  function isCartUrl(url) {
    if (!url) return false;
    const s = String(url);
    return CART_PATTERNS.some((p) => s.indexOf(p) !== -1);
  }

  function shortStack() {
    const e = new Error();
    if (!e.stack) return '';
    return e.stack
      .split('\n')
      .slice(2, 9) /* skip Error + this fn + caller */
      .map((l) => l.trim())
      .join('\n');
  }

  function safeParse(body) {
    if (!body) return null;
    if (typeof body !== 'string') {
      try {
        return { _formData: true, _summary: '[non-string body]' };
      } catch (e) {
        return null;
      }
    }
    try {
      return JSON.parse(body);
    } catch (e) {
      return body.length > 500 ? body.slice(0, 500) + '…' : body;
    }
  }

  function summariseResponse(json) {
    if (!json || typeof json !== 'object') return json;
    const summary = {
      item_count: json.item_count,
      total_price: json.total_price,
      lines: Array.isArray(json.items)
        ? json.items.map((i) => ({
            variant_id: i.variant_id,
            qty: i.quantity,
            line_price: i.final_line_price,
            props: i.properties && Object.keys(i.properties).length ? i.properties : undefined,
          }))
        : undefined,
    };
    /* /cart/add returns the just-added item, not the full cart */
    if (summary.item_count === undefined && json.id && json.quantity !== undefined) {
      return {
        added_variant: json.variant_id || json.id,
        added_qty: json.quantity,
        properties: json.properties,
      };
    }
    return summary;
  }

  function record(entry) {
    window.__cartDebugLog.push(entry);
    if (window.__cartDebugLog.length > MAX_LOG_ENTRIES) {
      window.__cartDebugLog.shift();
    }
    /* eslint-disable no-console */
    console.groupCollapsed(
      `%c[cart-debug] ${entry.method} ${entry.url} ${entry.status ?? ''}`,
      'color:#a35;font-weight:bold;'
    );
    if (entry.requestBody) console.log('request:', entry.requestBody);
    if (entry.responseSummary) console.log('response:', entry.responseSummary);
    if (entry.stack) console.log('stack:\n' + entry.stack);
    if (entry.error) console.log('error:', entry.error);
    console.groupEnd();
    /* eslint-enable no-console */
  }

  /* ---------- fetch wrapper ---------- */
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const isCart = isCartUrl(url);
    if (!isCart) return origFetch(input, init);

    const method = (init && init.method) || (input && input.method) || 'GET';
    const requestBody = safeParse(init && init.body);
    const stack = shortStack();
    const startedAt = new Date().toISOString();

    return origFetch(input, init).then(
      async (res) => {
        let cloneJson = null;
        try {
          cloneJson = await res.clone().json();
        } catch (e) {
          /* not JSON, ignore */
        }
        record({
          startedAt,
          method,
          url: String(url),
          status: res.status,
          requestBody,
          responseSummary: summariseResponse(cloneJson),
          stack,
        });
        return res;
      },
      (err) => {
        record({
          startedAt,
          method,
          url: String(url),
          status: 'ERR',
          requestBody,
          error: err && err.message,
          stack,
        });
        throw err;
      }
    );
  };

  /* ---------- XHR wrapper (some apps still use XHR, e.g. BSS) ---------- */
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cartDebug = { method, url, isCart: isCartUrl(url) };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__cartDebug && this.__cartDebug.isCart) {
      const stack = shortStack();
      const startedAt = new Date().toISOString();
      const requestBody = safeParse(body);
      this.addEventListener('loadend', () => {
        let json = null;
        try {
          json = JSON.parse(this.responseText);
        } catch (e) {
          /* not JSON */
        }
        record({
          startedAt,
          method: this.__cartDebug.method,
          url: this.__cartDebug.url,
          status: this.status,
          requestBody,
          responseSummary: summariseResponse(json),
          stack,
          via: 'xhr',
        });
      });
    }
    return origSend.apply(this, arguments);
  };

  /* eslint-disable no-console */
  console.log(
    '%c[cart-debug] logger installed. window.__cartDebugLog has the history. Filter console on "cart-debug".',
    'color:#a35;font-weight:bold;'
  );
  /* eslint-enable no-console */
})();
