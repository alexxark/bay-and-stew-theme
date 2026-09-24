(function () {
  if (window.BSPriceState) return;

  const timers = new WeakMap();
  const storedLiveModes = new WeakMap();
  const storedAriaHidden = new WeakMap();

  function normalizeTargets(targets) {
    if (!targets) return [];
    if (typeof targets === 'string') return Array.from(document.querySelectorAll(targets));
    if (targets instanceof Element) return [targets];
    if (typeof targets.length === 'number') return Array.from(targets).filter(Boolean);
    return [];
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function computePlaceholderWidth(node) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const px = text ? text.length * 9 : 72;
    return `${clamp(px, 56, 220)}px`;
  }

  function clearWatchdog(targets) {
    normalizeTargets(targets).forEach((node) => {
      const timer = timers.get(node);
      if (timer) {
        clearTimeout(timer);
        timers.delete(node);
      }
    });
  }

  function setPending(targets, options = {}) {
    const nodes = normalizeTargets(targets);
    nodes.forEach((node) => {
      if (!node || typeof node.setAttribute !== 'function') return;
      if (!node.style.getPropertyValue('--bs-price-placeholder-width')) {
        node.style.setProperty('--bs-price-placeholder-width', computePlaceholderWidth(node));
      }
      if (options.alignEnd) node.dataset.priceAlign = 'end';
      node.dataset.priceState = 'pending';

      if (options.busy !== false) {
        node.setAttribute('aria-busy', 'true');
      }

      if (options.pauseLiveRegion) {
        if (!storedLiveModes.has(node)) {
          storedLiveModes.set(node, node.getAttribute('aria-live') || '');
        }
        node.setAttribute('aria-live', 'off');
      }

      if (options.hideLiveRegion) {
        if (!storedAriaHidden.has(node)) {
          storedAriaHidden.set(node, node.getAttribute('aria-hidden'));
        }
        node.setAttribute('aria-hidden', 'true');
      }
    });

    if (Number.isFinite(options.watchdogMs) && options.watchdogMs >= 0) {
      armWatchdog(nodes, options.watchdogMs, options.onTimeout);
    }

    return nodes;
  }

  function setReady(targets, options = {}) {
    const nodes = normalizeTargets(targets);
    clearWatchdog(nodes);

    nodes.forEach((node) => {
      if (!node || typeof node.setAttribute !== 'function') return;
      node.dataset.priceState = 'ready';

      if (options.clearBusy !== false) {
        node.removeAttribute('aria-busy');
      }

      if (options.resumeLiveRegion) {
        const previous = storedLiveModes.get(node);
        if (previous === undefined) {
          node.removeAttribute('aria-live');
        } else if (previous) {
          node.setAttribute('aria-live', previous);
        } else {
          node.removeAttribute('aria-live');
        }
        storedLiveModes.delete(node);
      }

      if (options.restoreHidden) {
        const previousHidden = storedAriaHidden.get(node);
        if (previousHidden === null) {
          node.removeAttribute('aria-hidden');
        } else if (previousHidden === undefined) {
          node.removeAttribute('aria-hidden');
        } else {
          node.setAttribute('aria-hidden', previousHidden);
        }
        storedAriaHidden.delete(node);
      }
    });

    return nodes;
  }

  function armWatchdog(targets, timeoutMs, onTimeout) {
    const nodes = normalizeTargets(targets);
    clearWatchdog(nodes);
    nodes.forEach((node) => {
      const timer = setTimeout(() => {
        timers.delete(node);
        if (node.dataset.priceState === 'pending') {
          setReady(node, { clearBusy: true, resumeLiveRegion: true, restoreHidden: true });
          if (typeof onTimeout === 'function') onTimeout(node);
        }
      }, timeoutMs);
      timers.set(node, timer);
    });
  }

  function isBssRuntimePresent() {
    return Boolean(
      window.BSS_B2B ||
      window.BSSB2B ||
      window.BSSCommerce ||
      document.getElementById('bss-b2b-store-data')
    );
  }

  function triggerBssRefresh(container) {
    const scope = container instanceof Element ? container : document;
    const parentWithSection = scope.closest && scope.closest('[data-section-id]');
    const sectionId = parentWithSection ? parentWithSection.dataset.sectionId : null;

    document.dispatchEvent(
      new CustomEvent('shopify:section:load', {
        bubbles: true,
        detail: { sectionId },
      })
    );

    if (scope && typeof scope.dispatchEvent === 'function') {
      scope.dispatchEvent(new CustomEvent('bss:content:updated', { bubbles: true }));
    }

    if (typeof window.BSSB2B !== 'undefined' && typeof window.BSSB2B.refresh === 'function') {
      window.BSSB2B.refresh();
    }

    if (typeof window.BSSCommerce !== 'undefined' && typeof window.BSSCommerce.initPrices === 'function') {
      window.BSSCommerce.initPrices(scope);
    }

    document.dispatchEvent(new CustomEvent('price:refresh', { detail: { container: scope } }));

    if (typeof window.BssB2BTax !== 'undefined' && typeof window.BssB2BTax.calculate === 'function') {
      window.BssB2BTax.calculate();
    }
  }

  function waitForBssReady(options = {}) {
    if (!isBssRuntimePresent()) return Promise.resolve(false);

    const root = options.root instanceof Element ? options.root : document;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1600;
    const eventNames = Array.isArray(options.eventNames) && options.eventNames.length
      ? options.eventNames
      : ['bss_b2b:CustomCartUpdate', 'bss_b2b:module:loaded', 'bss_b2b:loadedObserver'];
    const readySelector = options.readySelector || '[bss-b2b-cart-price-active], [bss-b2b-product-active]';
    const resolveOnEvent = options.resolveOnEvent !== false;
    const attributeFilter = Array.isArray(options.attributeFilter) && options.attributeFilter.length
      ? options.attributeFilter
      : ['bss-b2b-cart-price-active', 'bss-b2b-product-active'];

    const hasReadyMarker = () => {
      if (!readySelector) return false;
      try {
        return Boolean(root.querySelector(readySelector));
      } catch (error) {
        return false;
      }
    };

    if (hasReadyMarker()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let timeoutId;
      let observer;

      const cleanup = () => {
        eventNames.forEach((name) => {
          document.removeEventListener(name, onSignal);
          window.removeEventListener(name, onSignal);
        });
        if (observer) observer.disconnect();
        clearTimeout(timeoutId);
      };

      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onSignal = () => {
        if (hasReadyMarker()) {
          finish(true);
          return;
        }
        if (resolveOnEvent) finish(true);
      };

      eventNames.forEach((name) => {
        document.addEventListener(name, onSignal);
        window.addEventListener(name, onSignal);
      });

      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver((mutations) => {
          if (!mutations.length) return;
          if (hasReadyMarker()) {
            finish(true);
            return;
          }
          if (resolveOnEvent && mutations.some((mutation) => attributeFilter.includes(mutation.attributeName || ''))) {
            finish(true);
          }
        });

        observer.observe(root === document ? document.documentElement : root, {
          subtree: true,
          attributes: true,
          attributeFilter,
        });
      }

      timeoutId = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function announceOnce(targets, key) {
    normalizeTargets(targets).forEach((node) => {
      if (!node) return;
      if (node.dataset.bsAnnounceKey === key) return;
      node.dataset.bsAnnounceKey = key;
      node.setAttribute('aria-hidden', 'false');
      setTimeout(() => {
        if (node.isConnected) node.setAttribute('aria-hidden', 'true');
      }, 1100);
    });
  }

  window.BSPriceState = {
    normalizeTargets,
    setPending,
    setReady,
    armWatchdog,
    clearWatchdog,
    isBssRuntimePresent,
    triggerBssRefresh,
    waitForBssReady,
    announceOnce,
  };
})();
