(function () {
  if (window.BSCartUI) return;

  const root = window.Shopify?.routes?.root || '/';
  let version = 0;
  let renderedVersion = -1;
  let pendingMutations = 0;
  let pendingRefresh = null;
  let lastCart = null;
  let idleWaiters = [];
  const refreshErrorText = 'Cart could not be refreshed. Please refresh the page to review your cart.';

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
    if (message) message.textContent = refreshErrorText;
  }

  function clearRefreshError() {
    document.querySelectorAll('#cart-errors, #CartDrawer-CartErrors').forEach((message) => {
      if (message.textContent === refreshErrorText) message.textContent = '';
    });
  }

  async function fetchSections(targets, options) {
    if (!targets.length) return {};
    const url = new URL(root + 'cart', window.location.origin);
    url.searchParams.set('sections', targets.map((section) => section.id).join(','));
    try {
      const response = await fetch(url.href, { ...options, headers: { Accept: 'text/html' } });
      if (!response.ok) throw new Error(`Sections HTTP ${response.status}`);
      const sections = await response.json();
      if (!sections || typeof sections !== 'object' || Array.isArray(sections)) throw new Error('Invalid sections response');
      return sections;
    } catch (error) {
      console.warn('[cart-ui] Display sections unavailable', error);
      return {};
    }
  }

  function sectionSource(sections, section) {
    const html = sections[section.id];
    if (typeof html !== 'string' || !html.trim()) return null;
    return new DOMParser().parseFromString(html, 'text/html').querySelector(section.source);
  }

  function applySections(sections, targets, cart) {
    const activeId = document.activeElement?.id;
    const renderedSections = [];
    targets.forEach((section) => {
      const target = document.querySelector(section.target);
      if (!target) return;
      const source = sectionSource(sections, section);
      if (!source) {
        target.dataset.cartRenderState = 'stale';
        console.warn('[cart-ui] Display section skipped', section.id);
        return;
      }
      target.innerHTML = source.innerHTML;
      delete target.dataset.cartRenderState;
      renderedSections.push(section.id);
    });
    clearRefreshError();
    document.querySelectorAll('cart-drawer, cart-items, cart-drawer-items, #main-cart-footer').forEach((element) => {
      element.classList.toggle('is-empty', cart.item_count === 0);
    });
    const checkout = document.querySelector('#main-cart-footer #checkout');
    if (checkout) checkout.disabled = cart.item_count === 0;
    const drawer = document.querySelector('cart-drawer');
    const overlay = document.getElementById('CartDrawer-Overlay');
    if (drawer && overlay) overlay.onclick = () => drawer.close();
    try {
      const summary = drawer?.querySelector('[id^="Details-"] summary');
      if (summary) drawer.setSummaryAccessibility?.(summary);
      if (drawer?.classList.contains('active') && typeof trapFocus === 'function') {
        const container = drawer.querySelector(cart.item_count === 0 ? '.drawer__inner-empty' : '#CartDrawer');
        const previousFocus = activeId ? document.getElementById(activeId) : null;
        if (container) trapFocus(container, container.contains(previousFocus) ? previousFocus : drawer.querySelector('.drawer__close'));
      }
    } catch (error) {
      console.warn('[cart-ui] Drawer accessibility binding incomplete', error);
    }
    document.dispatchEvent(new CustomEvent('cart:rendered', { detail: { cart, renderedSections } }));
    return renderedSections;
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
        const options = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
        let cart;
        let sections;
        try {
          [cart, sections] = await Promise.all([
            fetch(root + 'cart.js', options).then(async (response) => {
              if (!response.ok) throw new Error(`Cart state HTTP ${response.status}`);
              const data = await response.json();
              if (!Array.isArray(data?.items) || typeof data.item_count !== 'number') throw new Error('Invalid cart response');
              return data;
            }),
            fetchSections(targets, options),
          ]);
        } catch (error) {
          if (requestVersion !== version || pendingMutations) continue;
          throw error;
        }
        if (requestVersion !== version || pendingMutations) continue;
        const drawerSection = targets.find((section) => section.target === '#CartDrawer' && document.querySelector(section.target));
        if (drawerSection && !sectionSource(sections, drawerSection)) {
          const recovered = await fetchSections([drawerSection], options);
          if (requestVersion !== version || pendingMutations) continue;
          sections = { ...sections, ...recovered };
        }
        const renderedSections = applySections(sections, targets, cart);
        lastCart = cart;
        renderedVersion = requestVersion;
        if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
          try {
            publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-render', cartData: cart, sectionsRendered: true, renderedSections });
          } catch (error) {
            console.warn('[cart-ui] Cart subscriber failed', error);
          }
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