(function () {
  if (window.BSCartUI) return;

  const root = window.Shopify?.routes?.root || '/';
  let version = 0;
  let renderedVersion = -1;
  let pendingMutations = 0;
  let pendingRefresh = null;
  let lastCart = null;
  let lastPayableEventKey = '';
  let lastAnnouncedPayableKey = '';
  let idleWaiters = [];
  let payableFallbackTimer = null;
  let payablePendingVersion = 0;
  let forcePendingUntilNextRender = false;
  const refreshErrorText = 'Cart could not be refreshed. Please refresh the page to review your cart.';
  const payableSubtotalSelector = '#main-cart-footer .totals__total-value, .cart-drawer__footer .totals__total-value';
  const payableLiveRegionSelector = '#cart-live-region-text, #CartDrawer-LiveRegionText';
  const BSS_FAIL_OPEN_MS = Number(window.__BSPriceFailOpenMs) || 1800;
  const RETAIL_FAIL_OPEN_MS = Number(window.__BSPriceRetailFailOpenMs) || 550;
  const B2B_SAFE_FALLBACK_MS = Number(window.__BSPriceB2BSafeFallbackMs) || 5000;
  const B2B_SAFE_FALLBACK_TEXT = 'Calculated at checkout';

  const priceState = window.BSPriceState || {
    setPending(targets) {
      (Array.isArray(targets) ? targets : []).forEach((node) => {
        if (node?.dataset) node.dataset.priceState = 'pending';
      });
    },
    setReady(targets) {
      (Array.isArray(targets) ? targets : []).forEach((node) => {
        if (node?.dataset) node.dataset.priceState = 'ready';
      });
    },
    isBssRuntimePresent() {
      return Boolean(window.BSS_B2B || document.getElementById('bss-b2b-store-data'));
    },
    announceOnce() {},
  };

  function payableSubtotalNodes() {
    return Array.from(document.querySelectorAll(payableSubtotalSelector));
  }

  function payableLiveRegionNodes() {
    return Array.from(document.querySelectorAll(payableLiveRegionSelector));
  }

  function hasB2BCandidateNode() {
    return Boolean(document.querySelector('[data-bss-payable-candidate="true"]'));
  }

  function hasBssSubtotalHint() {
    const bssCart = window.BSS_B2B?.shopData?.cart;
    return normalizeCents(bssCart?.bss_b2b_total_price) !== null || normalizeCents(bssCart?.bss_b2b_total_priceTD) !== null;
  }

  function rootPricingMode() {
    return document.documentElement?.dataset.cartPricingMode || '';
  }

  function setRootPricingState(state, options = {}) {
    if (!document.documentElement) return;
    document.documentElement.dataset.cartPricingState = state;
    if (options.reason) {
      document.documentElement.dataset.cartPricingReason = options.reason;
    } else {
      delete document.documentElement.dataset.cartPricingReason;
    }
    if (options.mode) {
      document.documentElement.dataset.cartPricingMode = options.mode;
    } else if (state === 'ready') {
      delete document.documentElement.dataset.cartPricingMode;
    }
  }

  function setRewardsPricingState(state, fallbackText = '') {
    const rewardsRoots = document.querySelectorAll('cart-rewards');
    rewardsRoots.forEach((element) => {
      element.dataset.rewardsPriceState = state;
      element.setAttribute('aria-busy', state === 'pending' ? 'true' : 'false');
    });

    if (state !== 'fallback' || !fallbackText) return;

    document.querySelectorAll('cart-rewards [data-rewards-message]').forEach((node) => {
      node.textContent = fallbackText;
    });
  }

  function setPricingPending(reason, mode) {
    setRootPricingState('pending', { reason, mode });
    setRewardsPricingState('pending');
  }

  function setPricingReady(mode) {
    setRootPricingState('ready', { mode });
    setRewardsPricingState('ready');
  }

  function setPricingFallback(reason, text) {
    setRootPricingState('fallback', { reason, mode: 'bss' });
    setRewardsPricingState('fallback', text);
  }

  function isB2BMode() {
    if (hasB2BCandidateNode()) return true;
    if (hasBssSubtotalHint()) return true;
    if (rootPricingMode() === 'bss') return true;
    return false;
  }

  function shouldExpectBssPricing() {
    if (hasB2BCandidateNode()) return true;
    if (hasBssSubtotalHint()) return true;
    if (rootPricingMode() === 'bss') return true;
    return false;
  }

  function clearPayableFallbackTimer() {
    if (!payableFallbackTimer) return;
    clearTimeout(payableFallbackTimer);
    payableFallbackTimer = null;
  }

  function readyPayableNodes() {
    const subtotalNodes = payableSubtotalNodes();
    const liveNodes = payableLiveRegionNodes();

    subtotalNodes.forEach((node) => {
      delete node.dataset.payablePendingReason;
      delete node.dataset.payableFallback;
    });
    liveNodes.forEach((node) => {
      delete node.dataset.payablePendingReason;
      delete node.dataset.payableFallback;
    });

    priceState.setReady(subtotalNodes, { clearBusy: true });
    priceState.setReady(liveNodes, { clearBusy: true, resumeLiveRegion: true, restoreHidden: true });
  }

  function failOpenRetailPayable(token, reason, timeoutMs) {
    if (token !== payablePendingVersion) return;
    readyPayableNodes();
    clearPayableFallbackTimer();
    setPricingReady('retail');
    document.dispatchEvent(new CustomEvent('cart:payable-fail-open', { detail: { reason, timeoutMs, mode: 'retail' } }));
  }

  function applyB2BSafeFallback(token, reason, timeoutMs) {
    if (token !== payablePendingVersion) return;

    payableSubtotalNodes().forEach((node) => {
      node.textContent = B2B_SAFE_FALLBACK_TEXT;
      node.dataset.payableFallback = 'checkout';
      delete node.dataset.bssPayableSubtotal;
      delete node.dataset.payablePendingReason;
    });

    payableLiveRegionNodes().forEach((node) => {
      const label = node.dataset.estimatedTotalLabel;
      node.textContent = label ? `${label}: ${B2B_SAFE_FALLBACK_TEXT}` : B2B_SAFE_FALLBACK_TEXT;
      node.dataset.payableFallback = 'checkout';
      delete node.dataset.bssPayableSubtotal;
      delete node.dataset.payablePendingReason;
    });

    readyPayableNodes();
    clearPayableFallbackTimer();
    setPricingFallback(reason, B2B_SAFE_FALLBACK_TEXT);
    document.dispatchEvent(new CustomEvent('cart:payable-fail-open', {
      detail: { reason, timeoutMs, mode: 'bss', text: B2B_SAFE_FALLBACK_TEXT },
    }));
    document.dispatchEvent(new CustomEvent('cart:payable-fallback', {
      detail: { reason, mode: 'bss', text: B2B_SAFE_FALLBACK_TEXT },
    }));
  }

  function handleB2BPendingTimeout(token, reason, timeoutMs) {
    if (token !== payablePendingVersion) return;

    if (lastCart && syncPayableSubtotal(lastCart)) return;

    if (priceState.isBssRuntimePresent?.()) {
      clearPayableFallbackTimer();
      payableFallbackTimer = setTimeout(() => {
        applyB2BSafeFallback(token, reason, B2B_SAFE_FALLBACK_MS);
      }, B2B_SAFE_FALLBACK_MS);
      document.dispatchEvent(new CustomEvent('cart:payable-pending-extended', {
        detail: { reason, timeoutMs, mode: 'bss', graceMs: B2B_SAFE_FALLBACK_MS },
      }));
      return;
    }

    applyB2BSafeFallback(token, reason, timeoutMs);
  }

  function setPayablePending(reason, options = {}) {
    const subtotalNodes = payableSubtotalNodes();
    const liveNodes = payableLiveRegionNodes();
    if (!subtotalNodes.length && !liveNodes.length) return 0;

    const expectBss = options.expectBss ?? shouldExpectBssPricing();
    const pricingMode = options.pricingMode || (isB2BMode() ? 'bss' : 'retail');

    if (!expectBss) {
      readyPayableNodes();
      clearPayableFallbackTimer();
      setPricingReady('retail');
      return 0;
    }

    setPricingPending(reason, pricingMode);

    const token = ++payablePendingVersion;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : (pricingMode === 'bss' ? BSS_FAIL_OPEN_MS : RETAIL_FAIL_OPEN_MS);

    clearPayableFallbackTimer();

    subtotalNodes.forEach((node) => {
      node.dataset.payablePendingReason = reason;
    });
    liveNodes.forEach((node) => {
      node.dataset.payablePendingReason = reason;
    });

    priceState.setPending(subtotalNodes, { busy: true, alignEnd: true });
    priceState.setPending(liveNodes, { pauseLiveRegion: true, hideLiveRegion: true, busy: true });

    if (timeoutMs > 0) {
      payableFallbackTimer = setTimeout(() => {
        if (pricingMode === 'bss') {
          handleB2BPendingTimeout(token, reason, timeoutMs);
          return;
        }
        failOpenRetailPayable(token, reason, timeoutMs);
      }, timeoutMs);
    }

    return token;
  }

  function writePayableReady(cents, formatted) {
    const subtotalNodes = payableSubtotalNodes();
    const liveNodes = payableLiveRegionNodes();

    subtotalNodes.forEach((node) => {
      if (node.textContent !== formatted) node.textContent = formatted;
      node.dataset.bssPayableSubtotal = String(cents);
      delete node.dataset.payableFallback;
      delete node.dataset.payablePendingReason;
    });

    liveNodes.forEach((node) => {
      const label = node.dataset.estimatedTotalLabel;
      node.textContent = label ? `${label}: ${formatted}` : formatted;
      node.dataset.bssPayableSubtotal = String(cents);
      delete node.dataset.payableFallback;
      delete node.dataset.payablePendingReason;
    });

    return liveNodes;
  }

  function setPayableReady(cents, cart, liveNodes) {
    readyPayableNodes();
    clearPayableFallbackTimer();
    setPricingReady('bss');

    const announceKey = `${cents}:${cart?.item_count ?? ''}`;
    if (announceKey !== lastAnnouncedPayableKey) {
      lastAnnouncedPayableKey = announceKey;
      priceState.announceOnce(liveNodes || payableLiveRegionNodes(), announceKey);
    }
  }

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

  function normalizeCents(value) {
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return Math.round(numeric);
  }

  function cartLineSignature(cart) {
    if (!Array.isArray(cart?.items)) return null;
    return cart.items.map((item) => {
      const key = item?.key || item?.id || item?.variant_id || '';
      const quantity = Number(item?.quantity || 0);
      return `${key}:${Number.isFinite(quantity) ? quantity : 0}`;
    }).sort().join('|');
  }

  function bssCartMatchesCartSnapshot(cart, bssCart) {
    if (!cart || !bssCart) return false;
    if (typeof cart.item_count === 'number' && typeof bssCart.item_count === 'number' && cart.item_count !== bssCart.item_count) {
      return false;
    }
    const cartSignature = cartLineSignature(cart);
    const bssSignature = cartLineSignature(bssCart);
    if (cartSignature !== null && bssSignature !== null && cartSignature !== bssSignature) {
      return false;
    }
    return true;
  }

  function readBssPayableSubtotalCents(cart) {
    const bssCart = window.BSS_B2B?.shopData?.cart;
    if (!bssCart) return null;
    if (!bssCartMatchesCartSnapshot(cart, bssCart)) return null;
    const subtotal = normalizeCents(bssCart.bss_b2b_total_price);
    if (subtotal !== null) return subtotal;
    return normalizeCents(bssCart.bss_b2b_total_priceTD);
  }

  function ensureCurrencyCode(formatted, cart) {
    if (typeof formatted !== 'string' || !formatted.trim()) return formatted;
    const currency = cart?.currency || window.Shopify?.currency?.active;
    if (!currency) return formatted;
    const currencyPattern = new RegExp(`\\b${currency}\\b`);
    if (currencyPattern.test(formatted)) return formatted;
    const sample = document.querySelector('#main-cart-footer .totals__total-value, .cart-drawer__footer .totals__total-value')?.textContent || '';
    if (!currencyPattern.test(sample)) return formatted;
    return `${formatted} ${currency}`;
  }

  function formatPayableSubtotal(cents, cart) {
    const bssFormatter = window.BSS_B2B?.formatMoney;
    if (typeof bssFormatter === 'function') {
      try {
        const formatted = bssFormatter(cents);
        if (typeof formatted === 'string' && formatted.trim()) return ensureCurrencyCode(formatted.trim(), cart);
      } catch (error) {
        console.warn('[cart-ui] BSS formatter failed', error);
      }
    }
    const currency = cart?.currency || window.Shopify?.currency?.active;
    if (currency && typeof Intl !== 'undefined' && typeof Intl.NumberFormat === 'function') {
      const formatted = new Intl.NumberFormat(window.Shopify?.locale || undefined, { style: 'currency', currency }).format(cents / 100);
      return ensureCurrencyCode(formatted, cart);
    }
    return ensureCurrencyCode(`$${(cents / 100).toFixed(2)}`, cart);
  }

  function emitPayableSubtotal(cart, cents, formatted) {
    const eventKey = `${cents}:${cart?.item_count ?? ''}`;
    if (eventKey === lastPayableEventKey) return;
    lastPayableEventKey = eventKey;
    document.dispatchEvent(new CustomEvent('cart:payable-total', { detail: { cart, cents, formatted } }));
  }

  function syncPayableSubtotal(cart) {
    const cents = readBssPayableSubtotalCents(cart);
    if (cents === null) return false;
    const formatted = formatPayableSubtotal(cents, cart);
    const liveNodes = writePayableReady(cents, formatted);
    emitPayableSubtotal(cart, cents, formatted);
    setPayableReady(cents, cart, liveNodes);
    return true;
  }

  function schedulePayableSync() {
    if (!lastCart) return;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => { syncPayableSubtotal(lastCart); });
      return;
    }
    setTimeout(() => { syncPayableSubtotal(lastCart); }, 0);
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
    const expectBss = forcePendingUntilNextRender || shouldExpectBssPricing();
    setPayablePending('section-render', { expectBss });
    syncPayableSubtotal(cart);
    forcePendingUntilNextRender = false;
    document.dispatchEvent(new CustomEvent('cart:rendered', { detail: { cart, renderedSections } }));
    return renderedSections;
  }

  function refresh(options = {}) {
    if (options.force) version++;
    if (pendingRefresh) return pendingRefresh;
    if (!pendingMutations && renderedVersion === version) return Promise.resolve(lastCart);
    if (shouldExpectBssPricing()) {
      setPayablePending(options.force ? 'refresh-force' : 'refresh-start', { expectBss: true });
    }
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
    if (!pendingMutations) {
      const mutationExpectBss = shouldExpectBssPricing();
      forcePendingUntilNextRender = mutationExpectBss;
      setPayablePending('mutation-start', { expectBss: mutationExpectBss });
    }
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
  if (!document.documentElement?.dataset.cartPricingState) {
    setPricingReady(shouldExpectBssPricing() ? 'bss' : 'retail');
  }
  if (document.querySelector(`${payableSubtotalSelector}[data-price-state="pending"], ${payableLiveRegionSelector}[data-price-state="pending"]`)) {
    setPayablePending('initial-seed', { expectBss: true, timeoutMs: BSS_FAIL_OPEN_MS });
  }
  document.addEventListener('cart:refresh', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('cart:updated', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('bss_b2b:CustomCartUpdate', schedulePayableSync);
  window.addEventListener('bss_b2b:module:loaded', schedulePayableSync);
  if (typeof MutationObserver === 'function' && document.documentElement) {
    const observer = new MutationObserver((mutations) => {
      if (!lastCart) return;
      if (mutations.some((mutation) => mutation.attributeName === 'bss-b2b-cart-price-active')) {
        schedulePayableSync();
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['bss-b2b-cart-price-active'],
    });
  }
  document.addEventListener('shopify:section:load', (event) => {
    if (event.target.matches?.('#shopify-section-cart-drawer, #shopify-section-main-cart-items, #shopify-section-main-cart-footer')) {
      void refresh({ force: true }).catch(reportError);
    }
  });
})();