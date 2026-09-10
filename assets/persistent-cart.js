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
 *     into Shopify's cart via /cart/add.js and refresh cart UI.
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
  const RESTORE_ATTEMPT_KEY = 'bs:cart-snapshot:restore-attempt';
  const cartRoot = window.Shopify?.routes?.root || '/';
  let restoreInProgress = false;
  let restoreUncertain = false;
  let cartMutationVersion = 0;

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
    return fetch(cartRoot + 'cart.js', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // Push (mirror current cart → server)
  // ---------------------------------------------------------------------------

  let pushTimer       = null;
  let lastPushedJson  = null;

  function schedulePush() {
    if (!getCustomerId() || !getEndpoint() || restoreInProgress || restoreUncertain) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, DEBOUNCE_MS);
  }

  function doPush() {
    if (!getCustomerId() || !getEndpoint() || restoreInProgress || restoreUncertain) return;
    const version = cartMutationVersion;
    fetchCart().then((cart) => {
      if (!cart || restoreInProgress || restoreUncertain || version !== cartMutationVersion) return;

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

      fetch(getEndpoint(), {
        method:      'PUT',
        credentials: 'same-origin',
        headers:     { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:        payload,
        keepalive:   true,
      }).then((response) => {
        if (!response.ok) throw new Error(`Snapshot save HTTP ${response.status}`);
        lastPushedJson = sig;
        // Our own push is now the latest applied state for this browser.
        setLastApplied(snapshot.updated_at);
      }).catch((error) => console.error('[persistent-cart] Snapshot save failed', error));
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
    if (String(a.id) !== String(b.id)) return false;
    if (String(a.selling_plan || '') !== String(b.selling_plan || '')) return false;
    const sortedProperties = (properties) => Object.entries(properties || {}).sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(sortedProperties(a.properties)) === JSON.stringify(sortedProperties(b.properties));
  }

  /**
   * Refresh visible cart UI (header bubble, drawer, /cart page) by fetching
   * the rendered sections from Shopify and patching matching DOM nodes.
   * Mirrors Dawn's CartItems.getSectionsToRender() approach.
   */
  function refreshCartSections() {
    if (window.BSCartUI) return window.BSCartUI.refresh().catch(window.BSCartUI.reportError);
    document.dispatchEvent(new CustomEvent('cart:refresh'));
  }

  async function restoreSnapshot(snapshot, currentCart) {
    if (!getCustomerId() || restoreInProgress || restoreUncertain) return;
    if (!snapshot || !Array.isArray(snapshot.items) || !snapshot.items.length) return;
    if (!currentCart || !Array.isArray(currentCart.items) || currentCart.items.length) return;

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

    const validId = (id) => /^[1-9]\d*$/.test(String(id)) && (typeof id !== 'number' || Number.isSafeInteger(id));
    const validObject = (value) => value == null || (typeof value === 'object' && !Array.isArray(value));
    if (!snapshot.items.every((item) => item && validId(item.id) && Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
      validObject(item.properties) && (!item.selling_plan || validId(item.selling_plan)))) return;
    if (!validObject(snapshot.attributes) || (snapshot.note != null && typeof snapshot.note !== 'string')) return;

    const items = snapshot.items.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      properties: item.properties || {},
      selling_plan: item.selling_plan || undefined,
    }));
    const attemptKey = RESTORE_ATTEMPT_KEY + ':' + getCustomerId();
    const attempt = JSON.stringify({ timestamp: snapshotTs, items });
    restoreInProgress = true;
    clearTimeout(pushTimer);
    const finishRenderBatch = window.BSCartUI?.beginBatch();
    let attempted = false;
    try {
      if (localStorage.getItem(attemptKey) === attempt) return;
      const version = cartMutationVersion;
      const latest = await fetchCart();
      if (!latest || !Array.isArray(latest.items) || latest.items.length || version !== cartMutationVersion) return;
      localStorage.setItem(attemptKey, attempt);
      attempted = true;
      const result = await fetch(cartRoot + 'cart/add.js', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!result.ok) throw new Error(`Cart restore HTTP ${result.status}`);
      let restored = await fetchCart();
      if (!restored || !Array.isArray(restored.items)) throw new Error('Restored cart could not be verified');
      const restoredItems = restored.items.map((item) => ({
        ...item, id: item.variant_id, selling_plan: item.selling_plan_allocation?.selling_plan?.id,
      }));
      const complete = items.every((item) => {
        const expectedQuantity = items.filter((candidate) => sameLine(candidate, item)).reduce((total, candidate) => total + candidate.quantity, 0);
        const actualQuantity = restoredItems.filter((candidate) => sameLine(candidate, item)).reduce((total, candidate) => total + candidate.quantity, 0);
        return actualQuantity >= expectedQuantity;
      });
      if (!complete) throw new Error('Restored cart is incomplete');
      if (snapshot.note || Object.keys(snapshot.attributes || {}).length) {
        const metadata = await fetch(cartRoot + 'cart/update.js', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            note: restored.note || snapshot.note || '',
            attributes: { ...snapshot.attributes, ...restored.attributes },
          }),
        });
        if (!metadata.ok) throw new Error(`Cart metadata restore HTTP ${metadata.status}`);
        restored = await metadata.json();
      }
      setLastApplied(snapshotTs || Date.now());
      return restored;
    } catch (error) {
      restoreUncertain = attempted;
      console.error('[persistent-cart] Restore stopped; current cart preserved', error);
      document.dispatchEvent(new CustomEvent('cart:restore-error'));
    } finally {
      restoreInProgress = false;
      finishRenderBatch?.();
      if (attempted) refreshCartSections();
    }
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
      cartMutationVersion++;

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
        cartMutationVersion++;
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
