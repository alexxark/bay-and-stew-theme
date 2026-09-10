(function () {
  if (window.BSCartUI) return;

  const root = window.Shopify?.routes?.root || '/';
  let version = 0;
  let renderedVersion = -1;
  let pendingMutations = 0;
  let pendingRefresh = null;
  let lastCart = null;
  let idleWaiters = [];

  function sectionsToRender() {
    return [
      { id: 'cart-drawer', target: '#CartDrawer', source: '#CartDrawer' },
      { id: 'cart-icon-bubble', target: '#cart-icon-bubble', source: '.shopify-section' },
      { id: 'main-cart-items', target: '#main-cart-items .js-contents', source: '.js-contents' },
      { id: 'main-cart-footer', target: '#main-cart-footer .js-contents', source: '.js-contents' },
      { id: 'cart-live-region-text', target: '#cart-live-region-text', source: '.shopify-section' },
    ].filter((section) => document.querySelector(section.target)).map((section) => ({
      ...section,
      id: document.getElementById(section.id)?.dataset.id || section.id,
    }));
  }

  function reportError(error) {
    console.error('[cart-ui] Cart refresh failed', error);
    const message = document.getElementById('cart-errors') || document.getElementById('CartDrawer-CartErrors');
    if (message) message.textContent = 'Cart could not be refreshed. Please refresh the page to review your cart.';
  }

  function applySections(sections, targets, cart) {
    const activeId = document.activeElement?.id;
    const replacements = targets.map((section) => {
      if (!sections[section.id]) throw new Error(`Missing cart section: ${section.id}`);
      const html = new DOMParser().parseFromString(sections[section.id], 'text/html');
      const source = html.querySelector(section.source);
      const target = document.querySelector(section.target);
      if (!source || !target) throw new Error(`Missing cart section content: ${section.id}`);
      return { target, html: source.innerHTML };
    });
    replacements.forEach(({ target, html }) => { target.innerHTML = html; });
    document.querySelectorAll('cart-drawer, cart-items, cart-drawer-items, #main-cart-footer').forEach((element) => {
      element.classList.toggle('is-empty', cart.item_count === 0);
    });
    const checkout = document.querySelector('#main-cart-footer #checkout');
    if (checkout) checkout.disabled = cart.item_count === 0;
    const drawer = document.querySelector('cart-drawer');
    const overlay = document.getElementById('CartDrawer-Overlay');
    if (drawer && overlay) overlay.onclick = () => drawer.close();
    const summary = drawer?.querySelector('[id^="Details-"] summary');
    if (summary) drawer.setSummaryAccessibility?.(summary);
    if (drawer?.classList.contains('active') && typeof trapFocus === 'function') {
      const container = drawer.querySelector(cart.item_count === 0 ? '.drawer__inner-empty' : '#CartDrawer');
      const previousFocus = activeId ? document.getElementById(activeId) : null;
      if (container) trapFocus(container, container.contains(previousFocus) ? previousFocus : drawer.querySelector('.drawer__close'));
    }
    document.dispatchEvent(new CustomEvent('cart:rendered', { detail: { cart } }));
  }

  function refresh(options = {}) {
    if (options.force) version++;
    if (pendingRefresh) return pendingRefresh;
    if (!pendingMutations && renderedVersion === version) return Promise.resolve(lastCart);
    pendingRefresh = Promise.resolve().then(async () => {
      while (true) {
        if (pendingMutations) await new Promise((resolve) => idleWaiters.push(resolve));
        const requestVersion = version;
        const targets = sectionsToRender();
        const sectionUrl = new URL(root + 'cart', window.location.origin);
        sectionUrl.searchParams.set('sections', targets.map((section) => section.id).join(','));
        const options = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
        const [cartResponse, sectionResponse] = await Promise.all([
          fetch(root + 'cart.js', options),
          targets.length ? fetch(sectionUrl.href, options) : Promise.resolve(null),
        ]);
        if (!cartResponse.ok || (sectionResponse && !sectionResponse.ok)) throw new Error('Cart refresh request failed');
        const cart = await cartResponse.json();
        const sections = sectionResponse ? await sectionResponse.json() : {};
        if (requestVersion !== version || pendingMutations) continue;
        if (!Array.isArray(cart.items) || typeof cart.item_count !== 'number') throw new Error('Invalid cart response');
        applySections(sections, targets, cart);
        lastCart = cart;
        renderedVersion = requestVersion;
        if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
          publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-render', cartData: cart, sectionsRendered: true });
        }
        if (requestVersion !== version || pendingMutations) continue;
        return cart;
      }
    }).finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  }

  function beginMutation() {
    version++;
    pendingMutations++;
  }

  function finishMutation() {
    pendingMutations--;
    if (!pendingMutations) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
      void refresh().catch(reportError);
    }
  }

  function isMutation(input, options) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const method = options?.method || input?.method || 'GET';
    return /POST/i.test(method) && /\/cart\/(add|change|update|clear)(\.js)?(?:[?#]|$)/.test(url);
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, options) {
    if (!isMutation(input, options)) return originalFetch.apply(this, arguments);
    beginMutation();
    try {
      return Promise.resolve(originalFetch.apply(this, arguments)).finally(finishMutation);
    } catch (error) {
      finishMutation();
      throw error;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__bsCartMutation = isMutation(String(url), { method });
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (!this.__bsCartMutation) return originalSend.apply(this, arguments);
    beginMutation();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      finishMutation();
    };
    this.addEventListener('loadend', finish, { once: true });
    try {
      return originalSend.apply(this, arguments);
    } catch (error) {
      finish();
      throw error;
    }
  };

  function beginBatch() {
    beginMutation();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      finishMutation();
    };
  }

  window.BSCartUI = { refresh, reportError, beginBatch };
  document.addEventListener('cart:refresh', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('cart:updated', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('shopify:section:load', (event) => {
    if (event.target.matches?.('#shopify-section-cart-drawer, #shopify-section-main-cart-items, #shopify-section-main-cart-footer')) {
      void refresh({ force: true }).catch(reportError);
    }
  });
})();