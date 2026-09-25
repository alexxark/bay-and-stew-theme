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
  let internalBatchDepth = 0;
  let pricingGeneration = 0;
  let activePricingGeneration = 0;
  let generationCartSignature = null;
  let generationCartItemCount = null;
  let generationNeedsCartSnapshot = false;
  let generationReadyApplied = false;
  let generationMode = 'retail';
  let generationSourceEvent = '';
  const refreshErrorText = 'Cart could not be refreshed. Please refresh the page to review your cart.';
  const payableSubtotalSelector = '#main-cart-footer .totals__total-value, .cart-drawer__footer .totals__total-value';
  const payableLiveRegionSelector = '#cart-live-region-text, #CartDrawer-LiveRegionText';
  const BSS_FAIL_OPEN_MS = Number(window.__BSPriceFailOpenMs) || 1800;
  const RETAIL_FAIL_OPEN_MS = Number(window.__BSPriceRetailFailOpenMs) || 550;
  const B2B_SAFE_FALLBACK_MS = Number(window.__BSPriceB2BSafeFallbackMs) || 5000;
  const B2B_SAFE_FALLBACK_TEXT = 'Calculated at checkout';

  function shouldCapturePricingTrace() {
    return Boolean(window.__BSPriceDebug || window.__BSPriceDebugCollect);
  }

  function tracePricing(eventName, detail = {}) {
    if (!shouldCapturePricingTrace()) return;

    const bssCart = window.BSS_B2B?.shopData?.cart || null;
    const bssPayableCents = normalizeCents(bssCart?.bss_b2b_total_price) ?? normalizeCents(bssCart?.bss_b2b_total_priceTD);

    const entry = {
      timestamp: Date.now(),
      eventName,
      reason: detail.reason || '',
      generation: activePricingGeneration || 0,
      generationMode,
      cartPricingState: document.documentElement?.dataset.cartPricingState || '',
      cartPricingMode: document.documentElement?.dataset.cartPricingMode || '',
      pendingMutations,
      pendingRefresh: Boolean(pendingRefresh),
      shopifyCartSignature: detail.shopifyCartSignature ?? generationCartSignature,
      bssCartSignature: cartLineSignature(bssCart),
      bssPayableCents,
      eventSource: detail.eventSource || '',
      token: detail.token,
      ...detail,
    };

    window.__bsPricingTrace = window.__bsPricingTrace || [];
    window.__bsPricingTrace.push(entry);

    if (window.__BSPriceDebug && typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[pricing]', entry);
    }
  }

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

    tracePricing('state:root', {
      reason: options.reason || '',
      nextState: state,
      nextMode: options.mode || '',
      eventSource: options.eventSource || '',
    });
  }

  function setRewardsPricingState(state, fallbackText = '') {
    const rewardsRoots = document.querySelectorAll('cart-rewards');
    rewardsRoots.forEach((element) => {
      element.dataset.rewardsPriceState = state;
      element.setAttribute('aria-busy', state === 'pending' ? 'true' : 'false');
      if (typeof element.applyPricingState === 'function') {
        element.applyPricingState(state, fallbackText);
      }
    });

    if (state !== 'fallback' || !fallbackText) return;

    document.querySelectorAll('cart-rewards [data-rewards-message]').forEach((node) => {
      const rewardsRoot = node.closest('cart-rewards');
      if (rewardsRoot && typeof rewardsRoot.applyPricingState === 'function') {
        return;
      }
      node.textContent = fallbackText;
    });
  }

  function setPricingPending(reason, mode, eventSource = '') {
    setRootPricingState('pending', { reason, mode, eventSource });
    setRewardsPricingState('pending');
  }

  function setPricingReady(mode, reason = '', eventSource = '') {
    setRootPricingState('ready', { reason, mode, eventSource });
    setRewardsPricingState('ready');
  }

  function setPricingFallback(reason, text, eventSource = '') {
    setRootPricingState('fallback', { reason, mode: 'bss', eventSource });
    setRewardsPricingState('fallback', text);
  }

  function isB2BMode() {
    if (hasB2BCandidateNode()) return true;
    if (hasBssSubtotalHint()) return true;
    if (rootPricingMode() === 'bss') return true;
    return false;
  }

  function startPricingGeneration(reason, options = {}) {
    const joinCurrent = Boolean(
      options.joinCurrent
      && activePricingGeneration
      && document.documentElement?.dataset.cartPricingState === 'pending'
    );

    if (joinCurrent) {
      tracePricing('generation:join', {
        reason,
        eventSource: options.eventSource || '',
        joinGeneration: activePricingGeneration,
      });
      return activePricingGeneration;
    }

    if (activePricingGeneration) {
      tracePricing('generation:superseded', {
        reason,
        eventSource: options.eventSource || '',
        supersededGeneration: activePricingGeneration,
      });
    }

    activePricingGeneration = ++pricingGeneration;
    generationCartSignature = null;
    generationCartItemCount = null;
    generationNeedsCartSnapshot = options.awaitShopifySnapshot !== false;
    generationReadyApplied = false;
    generationMode = options.mode || (isB2BMode() ? 'bss' : 'retail');
    generationSourceEvent = options.eventSource || '';

    tracePricing('generation:start', {
      reason,
      eventSource: generationSourceEvent,
      generation: activePricingGeneration,
      awaitShopifySnapshot: generationNeedsCartSnapshot,
      generationMode,
    });

    return activePricingGeneration;
  }

  function bindGenerationCartSnapshot(cart, reason = 'section-render') {
    if (!activePricingGeneration) return;
    generationCartSignature = cartLineSignature(cart);
    generationCartItemCount = typeof cart?.item_count === 'number' ? cart.item_count : null;
    generationNeedsCartSnapshot = false;

    tracePricing('generation:snapshot', {
      reason,
      shopifyCartSignature: generationCartSignature,
      shopifyItemCount: generationCartItemCount,
      generation: activePricingGeneration,
    });
  }

  function clearPricingGeneration(reason = 'ready-settled') {
    if (!activePricingGeneration) return;

    tracePricing('generation:clear', {
      reason,
      generation: activePricingGeneration,
      generationReadyApplied,
    });

    activePricingGeneration = 0;
    generationCartSignature = null;
    generationCartItemCount = null;
    generationNeedsCartSnapshot = false;
    generationReadyApplied = false;
    generationMode = 'retail';
    generationSourceEvent = '';
  }

  function canApplyReadyForActiveGeneration(cart, options = {}) {
    const source = options.source || '';

    if (!activePricingGeneration) {
      return { ok: true, reason: 'no-active-generation' };
    }

    if (generationNeedsCartSnapshot) {
      return { ok: false, reason: 'awaiting-shopify-snapshot' };
    }

    if (pendingMutations > 0) {
      return { ok: false, reason: 'pending-mutations' };
    }

    if (pendingRefresh && source !== 'apply-sections') {
      return { ok: false, reason: 'refresh-in-flight' };
    }

    const shopifySignature = cartLineSignature(cart);
    if (generationCartSignature !== null && shopifySignature !== generationCartSignature) {
      return { ok: false, reason: 'shopify-signature-mismatch', shopifySignature };
    }

    if (generationCartItemCount !== null && cart?.item_count !== generationCartItemCount) {
      return { ok: false, reason: 'shopify-item-count-mismatch', shopifySignature };
    }

    return { ok: true, reason: 'ready-allowed', shopifySignature };
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
    setPricingReady('retail', reason, 'retail-fail-open');
    clearPricingGeneration('retail-fail-open');
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
    setPricingFallback(reason, B2B_SAFE_FALLBACK_TEXT, 'b2b-fallback');
    clearPricingGeneration('b2b-fallback');
    document.dispatchEvent(new CustomEvent('cart:payable-fail-open', {
      detail: { reason, timeoutMs, mode: 'bss', text: B2B_SAFE_FALLBACK_TEXT },
    }));
    document.dispatchEvent(new CustomEvent('cart:payable-fallback', {
      detail: { reason, mode: 'bss', text: B2B_SAFE_FALLBACK_TEXT },
    }));
  }

  function handleB2BPendingTimeout(token, reason, timeoutMs) {
    if (token !== payablePendingVersion) return;

    if (lastCart && syncPayableSubtotal(lastCart, { source: 'b2b-watchdog-timeout' })) return;

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
    const eventSource = options.eventSource || reason;

    if (!expectBss) {
      readyPayableNodes();
      clearPayableFallbackTimer();
      setPricingReady('retail', reason, eventSource);
      clearPricingGeneration('retail-no-bss-expected');
      return 0;
    }

    if (!activePricingGeneration) {
      startPricingGeneration(reason, {
        awaitShopifySnapshot: reason !== 'initial-seed',
        mode: pricingMode,
        eventSource,
      });
    }

    setPricingPending(reason, pricingMode, eventSource);

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
          tracePricing('watchdog:timeout', { reason, token, eventSource, mode: 'bss', timeoutMs });
          handleB2BPendingTimeout(token, reason, timeoutMs);
          return;
        }
        tracePricing('watchdog:timeout', { reason, token, eventSource, mode: 'retail', timeoutMs });
        failOpenRetailPayable(token, reason, timeoutMs);
      }, timeoutMs);
    }

    tracePricing('state:pending', {
      reason,
      eventSource,
      token,
      timeoutMs,
      mode: pricingMode,
      generation: activePricingGeneration,
    });

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

  function setPayableReady(cents, cart, liveNodes, options = {}) {
    readyPayableNodes();
    clearPayableFallbackTimer();
    setPricingReady('bss', options.reason || 'payable-ready', options.source || 'payable-sync');
    generationReadyApplied = true;

    tracePricing('state:ready', {
      reason: options.reason || 'payable-ready',
      eventSource: options.source || 'payable-sync',
      generation: activePricingGeneration,
      cents,
    });

    const announceKey = `${cents}:${cart?.item_count ?? ''}`;
    if (announceKey !== lastAnnouncedPayableKey) {
      lastAnnouncedPayableKey = announceKey;
      priceState.announceOnce(liveNodes || payableLiveRegionNodes(), announceKey);
    }

    clearPricingGeneration('payable-ready');
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

  function syncPayableSubtotal(cart, options = {}) {
    const cents = readBssPayableSubtotalCents(cart);
    if (cents === null) {
      tracePricing('ready-attempt-rejected', {
        reason: 'bss-subtotal-unavailable',
        eventSource: options.source || '',
        shopifyCartSignature: cartLineSignature(cart),
      });
      return false;
    }

    const readyGate = canApplyReadyForActiveGeneration(cart, options);
    if (!readyGate.ok) {
      tracePricing('ready-attempt-rejected', {
        reason: readyGate.reason,
        eventSource: options.source || '',
        shopifyCartSignature: readyGate.shopifySignature || cartLineSignature(cart),
      });
      return false;
    }

    tracePricing('ready-attempt-accepted', {
      reason: readyGate.reason,
      eventSource: options.source || '',
      shopifyCartSignature: readyGate.shopifySignature || cartLineSignature(cart),
      cents,
    });

    const formatted = formatPayableSubtotal(cents, cart);
    const liveNodes = writePayableReady(cents, formatted);
    emitPayableSubtotal(cart, cents, formatted);
    setPayableReady(cents, cart, liveNodes, {
      reason: 'bss-payable-current',
      source: options.source || 'payable-sync',
    });
    return true;
  }

  function schedulePayableSync(source = 'bss-event') {
    if (!lastCart) return;
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => { syncPayableSubtotal(lastCart, { source }); });
      return;
    }
    setTimeout(() => { syncPayableSubtotal(lastCart, { source }); }, 0);
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
    bindGenerationCartSnapshot(cart, 'section-render');
    const expectBss = forcePendingUntilNextRender || shouldExpectBssPricing();
    setPayablePending('section-render', { expectBss, eventSource: 'apply-sections' });
    syncPayableSubtotal(cart, { source: 'apply-sections' });
    forcePendingUntilNextRender = false;
    document.dispatchEvent(new CustomEvent('cart:rendered', { detail: { cart, renderedSections } }));
    return renderedSections;
  }

  function refresh(options = {}) {
    if (options.force) version++;
    if (pendingRefresh) return pendingRefresh;
    if (!pendingMutations && renderedVersion === version) return Promise.resolve(lastCart);
    if (shouldExpectBssPricing()) {
      setPayablePending(options.force ? 'refresh-force' : 'refresh-start', {
        expectBss: true,
        eventSource: options.force ? 'refresh-force' : 'refresh-start',
      });
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

  function beginMutation(options = {}) {
    const mutationExpectBss = shouldExpectBssPricing();
    const joinCurrentGeneration = Boolean(options.joinCurrent || internalBatchDepth > 0);
    const eventSource = options.eventSource || 'mutation';

    const generation = startPricingGeneration(options.reason || 'mutation-start', {
      joinCurrent: joinCurrentGeneration,
      awaitShopifySnapshot: true,
      mode: mutationExpectBss || rootPricingMode() === 'bss' ? 'bss' : 'retail',
      eventSource,
    });

    forcePendingUntilNextRender = mutationExpectBss;
    setPayablePending('mutation-start', {
      expectBss: mutationExpectBss || rootPricingMode() === 'bss',
      pricingMode: generationMode,
      eventSource,
    });

    version++;
    pendingMutations++;

    tracePricing('mutation:begin', {
      reason: options.reason || 'mutation-start',
      eventSource,
      generation,
      joinCurrentGeneration,
      pendingMutations,
    });
  }

  function finishMutation(options = {}) {
    pendingMutations--;
    if (pendingMutations < 0) pendingMutations = 0;

    tracePricing('mutation:finish', {
      reason: options.reason || 'mutation-finish',
      eventSource: options.eventSource || 'mutation',
      pendingMutations,
      generation: activePricingGeneration,
    });

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
    beginMutation({ reason: 'cart-fetch-mutation', eventSource: 'fetch', joinCurrent: internalBatchDepth > 0 });
    try {
      return Promise.resolve(originalFetch.apply(this, arguments)).finally(() => {
        finishMutation({ reason: 'cart-fetch-mutation-complete', eventSource: 'fetch' });
      });
    } catch (error) {
      finishMutation({ reason: 'cart-fetch-mutation-error', eventSource: 'fetch' });
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
    beginMutation({ reason: 'cart-xhr-mutation', eventSource: 'xhr', joinCurrent: internalBatchDepth > 0 });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      finishMutation({ reason: 'cart-xhr-mutation-complete', eventSource: 'xhr' });
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
    internalBatchDepth++;
    beginMutation({ reason: 'batch-start', eventSource: 'beginBatch', joinCurrent: true });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      finishMutation({ reason: 'batch-finish', eventSource: 'beginBatch' });
      internalBatchDepth = Math.max(0, internalBatchDepth - 1);
    };
  }

  window.BSCartUI = { refresh, reportError, beginBatch };
  if (!document.documentElement?.dataset.cartPricingState) {
    setPricingReady(shouldExpectBssPricing() ? 'bss' : 'retail', 'init-ready', 'init');
  }
  if (document.querySelector(`${payableSubtotalSelector}[data-price-state="pending"], ${payableLiveRegionSelector}[data-price-state="pending"]`)) {
    setPayablePending('initial-seed', { expectBss: true, timeoutMs: BSS_FAIL_OPEN_MS, eventSource: 'initial-seed' });
  }
  document.addEventListener('cart:refresh', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('cart:updated', () => { void refresh({ force: true }).catch(reportError); });
  document.addEventListener('bss_b2b:CustomCartUpdate', () => schedulePayableSync('bss_b2b:CustomCartUpdate'));
  window.addEventListener('bss_b2b:module:loaded', () => schedulePayableSync('bss_b2b:module:loaded'));
  if (typeof MutationObserver === 'function' && document.documentElement) {
    const observer = new MutationObserver((mutations) => {
      if (!lastCart) return;
      if (mutations.some((mutation) => mutation.attributeName === 'bss-b2b-cart-price-active')) {
        schedulePayableSync('bss-b2b-cart-price-active');
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