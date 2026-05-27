/**
 * Bay & Stew — Persistent Cart
 *
 * Cross-device cart for logged-in customers.
 *
 *   - The current cart contents are mirrored to customer.metafields.cart.snapshot
 *     (JSON) via the App Proxy endpoint defined by <meta name="bs-cart-endpoint">
 *     (default: /apps/growth/cart).
 *   - On page load, if the customer is logged in AND their server snapshot has
 *     items AND the current browser's cart is empty AND the snapshot didn't
 *     originate from the current browser's cart token, restore the snapshot
 *     into Shopify's cart via /cart/update.js and refresh cart UI.
 *
 * Implementation:
 *   - Wraps window.fetch (and XMLHttpRequest.send) so any successful mutation
 *     to /cart/add /cart/change /cart/update /cart/clear triggers a debounced
 *     "snapshot push". One source of truth: we always re-fetch /cart.js right
 *     before pushing so we get the canonical post-mutation state including any
 *     line-item bundling done server-side.
 *   - Restore happens once per page load, before any user interaction.
 *   - Guests are no-ops (no metafield to read/write).
 *
 * Wire format (the JSON we PUT to the worker):
 *   {
 *     snapshot: {
 *       items:        [ { id, quantity, properties, selling_plan } ],
 *       note:         "",
 *       attributes:   {},
 *       updated_at:   <epoch ms>,
 *       source_token: "<current cart token>"
 *     }
 *   }
 */
(function () {
  'use strict';

  const DEBOUNCE_MS = 700;
  const CART_MUTATION_PATHS = ['/cart/add', '/cart/change', '/cart/update', '/cart/clear'];
  const LAST_APPLIED_KEY = 'bs:cart-snapshot:last-applied';

  function getLastApplied() {
    try {
      const id = getCustomerId();
      if (!id) return 0;
      const v = localStorage.getItem(LAST_APPLIED_KEY + ':' + id);
      return v ? Number(v) || 0 : 0;
    } catch (e) { return 0; }
  }

  function setLastApplied(ts) {
    try {
      const id = getCustomerId();
      if (!id) return;
      localStorage.setItem(LAST_APPLIED_KEY + ':' + id, String(ts || Date.now()));
    } catch (e) { /* private mode etc. */ }
  }

  function getCustomerId() {
    const meta = document.querySelector('meta[name="bs-customer-id"]');
    const id   = meta && meta.getAttribute('content');
    return id && id.trim() !== '' ? id.trim() : null;
  }

  function getEndpoint() {
    const meta = document.querySelector('meta[name="bs-cart-endpoint"]');
    const url  = meta && meta.getAttribute('content');
    return url && url.trim() !== '' ? url.trim() : null;
  }

  function readBootstrap() {
    const node = document.getElementById('bs-cart-bootstrap');
    if (!node) return null;
    const text = (node.textContent || '').trim();
    if (!text || text === 'null') return null;
    try {
      let parsed = JSON.parse(text);
      // Shopify json metafields sometimes round-trip as a JSON-encoded string.
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { /* leave as-is */ }
      }
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function fetchCart() {
    return fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // Push (mirror current cart → server)
  // ---------------------------------------------------------------------------

  let pushTimer       = null;
  let lastPushedJson  = null;

  function schedulePush() {
    if (!getCustomerId() || !getEndpoint()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, DEBOUNCE_MS);
  }

  function doPush() {
    if (!getCustomerId() || !getEndpoint()) return;
    fetchCart().then((cart) => {
      if (!cart) return;

      const snapshot = {
        items: (cart.items || []).map((it) => ({
          id:           it.variant_id,
          quantity:     it.quantity,
          properties:   it.properties || {},
          selling_plan: (it.selling_plan_allocation && it.selling_plan_allocation.selling_plan && it.selling_plan_allocation.selling_plan.id) || null,
        })),
        note:         cart.note || '',
        attributes:   cart.attributes || {},
        updated_at:   Date.now(),
        source_token: cart.token || '',
      };

      const payload = JSON.stringify({ snapshot: snapshot });
      // Skip if nothing meaningful changed (other than the timestamp/token).
      const sig = JSON.stringify({
        items: snapshot.items, note: snapshot.note, attributes: snapshot.attributes,
      });
      if (sig === lastPushedJson) return;
      lastPushedJson = sig;

      fetch(getEndpoint(), {
        method:      'PUT',
        credentials: 'same-origin',
        headers:     { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:        payload,
        keepalive:   true,
      }).then(() => {
        // Our own push is now the latest applied state for this browser.
        setLastApplied(snapshot.updated_at);
      }).catch(() => { /* offline / endpoint down — ignore */ });
    });
  }

  function flushPush() {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
      doPush();
    }
  }

  // If the page is being hidden / unloaded, push immediately so we don't lose
  // the snapshot. fetch with keepalive: true survives navigation.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushPush();
  });
  window.addEventListener('pagehide', flushPush);

  // ---------------------------------------------------------------------------
  // Restore (server snapshot → current empty cart)
  // ---------------------------------------------------------------------------

  /**
   * Compare two line items by Shopify's line-item identity rule:
   * same variant + same properties + same selling plan = same line.
   */
  function sameLine(a, b) {
    if (a.id !== b.id) return false;
    if ((a.selling_plan || null) !== (b.selling_plan || null)) return false;
    return JSON.stringify(a.properties || {}) === JSON.stringify(b.properties || {});
  }

  /**
   * Refresh visible cart UI (header bubble, drawer, /cart page) by fetching
   * the rendered sections from Shopify and patching matching DOM nodes.
   * Mirrors Dawn's CartItems.getSectionsToRender() approach.
   */
  function refreshCartSections() {
    const targets = [
      { id: 'cart-icon-bubble',     selector: '#cart-icon-bubble',  inner: '.shopify-section' },
      { id: 'cart-drawer',          selector: '#CartDrawer',        inner: false },
      { id: 'cart-live-region-text', selector: '#cart-live-region-text', inner: '.shopify-section' },
      // Only present on /cart page; harmless if missing.
      { id: 'main-cart-items',      selector: '#main-cart-items',   inner: '.js-contents' },
      { id: 'main-cart-footer',     selector: '#main-cart-footer',  inner: '.js-contents' },
    ];

    const present = targets.filter((t) => document.querySelector(t.selector));
    if (!present.length) return;

    const sectionsParam = present.map((t) => t.id).join(',');

    fetch('/?sections=' + encodeURIComponent(sectionsParam), {
      credentials: 'same-origin',
      headers:     { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((sections) => {
        if (!sections) return;

        present.forEach((t) => {
          const html = sections[t.id];
          if (!html) return;
          const doc = new DOMParser().parseFromString(html, 'text/html');

          if (t.inner) {
            const src  = doc.querySelector(t.inner);
            const dest = document.querySelector(t.selector + ' ' + t.inner)
                      || document.querySelector(t.selector);
            if (src && dest) dest.innerHTML = src.innerHTML;
          } else {
            // Replace the whole node.
            const src  = doc.querySelector(t.selector);
            const dest = document.querySelector(t.selector);
            if (src && dest) dest.innerHTML = src.innerHTML;
          }
        });

        // Let BLOY / rewards bar / anything else listening know.
        document.dispatchEvent(new CustomEvent('cart:refresh'));
        if (window.PUB_SUB_EVENTS && window.publish) {
          fetch('/cart.js').then((r) => r.json()).then((cart) => {
            try { window.publish(window.PUB_SUB_EVENTS.cartUpdate, { source: 'persistent-cart', cartData: cart }); } catch (e) {}
          });
        }
      })
      .catch(() => { /* ignore — user can refresh manually if needed */ });
  }

  function restoreSnapshot(snapshot, currentCart) {
    if (!snapshot || !Array.isArray(snapshot.items)) return;

    const snapshotTs   = Number(snapshot.updated_at) || 0;
    const lastApplied  = getLastApplied();
    const sourceToken  = snapshot.source_token || '';
    const currentToken = (currentCart && currentCart.token) || '';

    // If the snapshot was written by this browser's current cart, nothing to do.
    if (sourceToken && sourceToken === currentToken) {
      if (snapshotTs > lastApplied) setLastApplied(snapshotTs);
      return;
    }

    // Newer-wins: only restore if the server snapshot is newer than what this
    // browser has already applied (or has never applied anything).
    if (snapshotTs && snapshotTs <= lastApplied) return;

    // If the snapshot is empty AND the current cart has items added in this
    // browser since lastApplied, don't wipe them. Otherwise, clear the cart.
    const snapshotEmpty = !snapshot.items.length;

    // Build the line-item array Shopify's /cart/add.js expects.
    const items = snapshot.items
      .filter((it) => it && it.id && it.quantity > 0)
      .map((it) => ({
        id:           it.id,
        quantity:     it.quantity,
        properties:   it.properties || {},
        selling_plan: it.selling_plan || undefined,
      }));

    const applyAndFinish = function () {
      // Round-trip note + attributes if present.
      if (snapshot.note || (snapshot.attributes && Object.keys(snapshot.attributes).length)) {
        fetch('/cart/update.js', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    JSON.stringify({
            note:       snapshot.note || '',
            attributes: snapshot.attributes || {},
          }),
        }).catch(() => {});
      }

      // Suppress the next push (it would just mirror what we just restored).
      lastPushedJson = JSON.stringify({
        items: items.map((it) => ({
          id:           it.id,
          quantity:     it.quantity,
          properties:   it.properties,
          selling_plan: it.selling_plan || null,
        })),
        note:       snapshot.note || '',
        attributes: snapshot.attributes || {},
      });
      setLastApplied(snapshotTs || Date.now());

      document.dispatchEvent(new CustomEvent('cart:refresh'));

      // Soft-refresh the cart UI (header bubble, drawer, /cart page) without
      // a full page reload.
      refreshCartSections();
    };

    // Step 1: clear current cart (so we replace rather than merge / duplicate).
    fetch('/cart/clear.js', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })
      .then(() => {
        if (snapshotEmpty || !items.length) {
          // Snapshot is empty — cart is already cleared, just finish.
          applyAndFinish();
          return;
        }
        // Step 2: add snapshot items.
        return fetch('/cart/add.js', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    JSON.stringify({ items: items }),
        }).then(() => applyAndFinish());
      })
      .catch(() => { /* ignore — next page load will retry */ });
  }

  // ---------------------------------------------------------------------------
  // Fetch / XHR interception — detect cart mutations done by other code paths
  // ---------------------------------------------------------------------------

  function isCartMutationUrl(url) {
    if (!url) return false;
    const s = String(url);
    return CART_MUTATION_PATHS.some((p) => s.indexOf(p) !== -1);
  }

  function wrapFetch(target) {
    if (!target || target.__bsPersistentCartHooked) return target;
    const wrapped = function (input, init) {
      const url    = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const isMutation = isCartMutationUrl(url) && /POST/i.test(method);

      const promise = target.apply(this, arguments);
      if (!isMutation) return promise;

      return promise.then((res) => {
        if (res && res.ok) schedulePush();
        return res;
      });
    };
    wrapped.__bsPersistentCartHooked    = true;
    wrapped.__bsPersistentCartUnderlying = target;
    return wrapped;
  }

  function installFetchHook() {
    if (window.__bsFetchAccessorInstalled) {
      // Defensive: ensure current value is wrapped.
      const current = window.fetch;
      if (current && !current.__bsPersistentCartHooked) {
        window.fetch = current; // triggers our setter, which wraps it
      }
      return;
    }

    let stored = wrapFetch(window.fetch);

    try {
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        get: function () { return stored; },
        set: function (next) {
          // Any later assignment (third-party polyfill, etc.) is auto-wrapped.
          // Unwrap one layer first if it's already our wrapper, to avoid stacking.
          const base = next && next.__bsPersistentCartUnderlying
            ? next.__bsPersistentCartUnderlying
            : next;
          stored = wrapFetch(base);
        },
      });
      window.__bsFetchAccessorInstalled = true;
    } catch (e) {
      // Fallback: plain assignment.
      window.fetch = stored;
    }
  }

  function installXhrHook() {
    const proto = XMLHttpRequest && XMLHttpRequest.prototype;
    if (!proto || proto.__bsPersistentCartHooked) return;

    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (method, url) {
      this.__bsPcUrl    = url;
      this.__bsPcMethod = method;
      return origOpen.apply(this, arguments);
    };

    proto.send = function () {
      if (isCartMutationUrl(this.__bsPcUrl) && /POST/i.test(this.__bsPcMethod || '')) {
        this.addEventListener('load', () => {
          if (this.status >= 200 && this.status < 300) schedulePush();
        });
      }
      return origSend.apply(this, arguments);
    };

    proto.__bsPersistentCartHooked = true;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function alwaysInstallHooks() {
    // Always (re-)install hooks after DOMContentLoaded, in case fetch was polyfilled late.
    installFetchHook();
    installXhrHook();
  }

  function init() {
    if (!getCustomerId()) return; // guests: no-op
    alwaysInstallHooks();

    const snapshot = readBootstrap();
    if (!snapshot) return;

    // Seed dedupe baseline with the snapshot we just read; this prevents
    // an immediate redundant push if no mutations occur this session.
    lastPushedJson = JSON.stringify({
      items: (snapshot.items || []).map((it) => ({
        id: it.id,
        quantity: it.quantity,
        properties: it.properties || {},
        selling_plan: it.selling_plan || null,
      })),
      note: snapshot.note || '',
      attributes: snapshot.attributes || {},
    });

    fetchCart().then((cart) => restoreSnapshot(snapshot, cart));
  }

  // Install hooks as soon as possible, and again after DOMContentLoaded.
  alwaysInstallHooks();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('DOMContentLoaded', alwaysInstallHooks);
  } else {
    init();
    alwaysInstallHooks();
  }
})();
