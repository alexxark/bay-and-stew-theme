/*
 * cart-checkout-guard.js
 *
 * Two-layer defense against a stale cart drawer / cart page being submitted
 * to checkout.
 *
 * Background: the BSS B2B app hides the native theme price elements via
 * `display: none !important` and writes its own totals into the DOM by
 * watching a mutation handle (`miniCartMutateHandle`). The displayed cart
 * total therefore comes from the rendered HTML (specifically the
 * `data-cart-total-price` attribute that Liquid bakes into
 * bss-b2b-tax-cart-subtotal.liquid) plus what BSS reads from per-line
 * `[bss-b2b-final-line-price]` elements — NOT from /cart.js.
 *
 * If the cart-drawer section is ever rendered against a server cart that
 * later changes (e.g. cart-rewards removes an excess gift via /cart/change),
 * the drawer keeps showing the OLD total and the form keeps the OLD line
 * rows. Submitting it then re-creates the stale state at checkout.
 *
 * Layer 1 — Pre-display sync: whenever the drawer opens (or the page loads
 *   on the cart page), fetch /cart.js. If item_count or total_price differs
 *   from the rendered DOM, refresh the cart-drawer / main-cart-items
 *   sections from the server before the user sees the wrong total.
 *
 * Layer 2 — Pre-checkout sync: every Checkout button click is intercepted.
 *   We re-fetch /cart.js, compare with the form's updates[] inputs, and if
 *   they differ we block the submission, refresh the sections, and ask the
 *   user to click again.
 */

(function () {
  if (window.__cartCheckoutGuardInstalled) return;
  window.__cartCheckoutGuardInstalled = true;

  const CHECKOUT_BUTTON_SELECTORS = [
    '#CartDrawer-Checkout',
    '#checkout',
    'button[name="checkout"]',
  ];

  const SECTIONS_TO_REFRESH = ['cart-drawer', 'cart-icon-bubble', 'main-cart-items'];

  const SHOPIFY_ROOT = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

  function getCheckoutButton(target) {
    if (!target) return null;
    for (const sel of CHECKOUT_BUTTON_SELECTORS) {
      const btn = target.closest ? target.closest(sel) : null;
      if (btn) return btn;
    }
    return null;
  }

  function sumFormUpdates(form) {
    if (!form) return 0;
    let sum = 0;
    form.querySelectorAll('input[name="updates[]"]').forEach((input) => {
      const v = parseInt(input.value, 10);
      if (!isNaN(v) && v > 0) sum += v;
    });
    return sum;
  }

  async function fetchLiveCart() {
    const res = await fetch(`${SHOPIFY_ROOT}cart.js`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`cart.js HTTP ${res.status}`);
    return res.json();
  }

  async function fetchSections() {
    const url = `${SHOPIFY_ROOT}?sections=${SECTIONS_TO_REFRESH.join(',')}`;
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error(`sections HTTP ${res.status}`);
    return res.json();
  }

  function applySections(sections) {
    const drawerHtml = sections['cart-drawer'];
    if (drawerHtml) {
      const doc = new DOMParser().parseFromString(drawerHtml, 'text/html');
      ['cart-drawer-items', '.cart-drawer__footer'].forEach((sel) => {
        const source = doc.querySelector(sel);
        const target = document.querySelector(sel);
        if (source && target) target.replaceWith(source);
      });
    }

    const bubbleHtml = sections['cart-icon-bubble'];
    if (bubbleHtml) {
      const doc = new DOMParser().parseFromString(bubbleHtml, 'text/html');
      const source = doc.querySelector('.shopify-section');
      const target = document.getElementById('cart-icon-bubble');
      if (source && target) target.innerHTML = source.innerHTML;
    }

    const cartPageHtml = sections['main-cart-items'];
    if (cartPageHtml) {
      const doc = new DOMParser().parseFromString(cartPageHtml, 'text/html');
      const source = doc.querySelector('.js-contents');
      const target = document.querySelector('#main-cart-items .js-contents');
      if (source && target) target.innerHTML = source.innerHTML;
    }

    document.dispatchEvent(new CustomEvent('cart:refresh'));
    if (window.__runRewardsLast) window.__runRewardsLast();
  }

  async function refreshSectionsFromServer() {
    try {
      const sections = await fetchSections();
      applySections(sections);
    } catch (err) {
      console.error('[cart-checkout-guard] section refresh failed', err);
    }
  }

  /* ---------- Layer 1: drawer-open / page-load sync ---------- */

  function readRenderedCartTotal() {
    /* BSS bakes data-cart-total-price into the rendered subtotal block.
       Falls back to the cart-drawer-items live count when not available. */
    const el = document.querySelector('.bss-b2b-cart-vat-subtotal[data-cart-total-price]');
    if (el) {
      const v = parseInt(el.getAttribute('data-cart-total-price'), 10);
      if (!isNaN(v)) return v;
    }
    return null;
  }

  function readRenderedLineCount() {
    /* Count actual server-rendered cart rows (exclude placeholder rows
       injected by cart-rewards which have .cart-item--reward-placeholder). */
    const rows = document.querySelectorAll(
      'cart-drawer-items .cart-item:not(.cart-item--reward-placeholder), #main-cart-items .cart-item:not(.cart-item--reward-placeholder)'
    );
    /* The selector above counts both drawer + cart page; if both render the
       same items we still want a single count, so pick whichever container
       exists. */
    const drawerCount = document.querySelectorAll(
      'cart-drawer-items .cart-item:not(.cart-item--reward-placeholder)'
    ).length;
    if (drawerCount > 0) return drawerCount;
    const pageCount = document.querySelectorAll(
      '#main-cart-items .cart-item:not(.cart-item--reward-placeholder)'
    ).length;
    return pageCount;
  }

  let _layer1InFlight = false;
  async function syncIfStale() {
    if (_layer1InFlight) return;
    if (window.__cartRewardsSyncBusy) return; /* let cart-rewards finish first */
    _layer1InFlight = true;
    try {
      const cart = await fetchLiveCart();
      const rendered = readRenderedCartTotal();
      const renderedLines = readRenderedLineCount();
      const liveTotal = typeof cart.total_price === 'number' ? cart.total_price : null;
      const liveLines = (cart.items || []).length;

      const totalMismatch = rendered !== null && liveTotal !== null && rendered !== liveTotal;
      const lineMismatch = renderedLines > 0 && liveLines !== renderedLines;

      if (totalMismatch || lineMismatch) {
        console.warn('[cart-checkout-guard] stale drawer detected', {
          renderedTotal: rendered,
          liveTotal,
          renderedLines,
          liveLines,
        });
        await refreshSectionsFromServer();
      }
    } catch (err) {
      /* Non-fatal */
    } finally {
      _layer1InFlight = false;
    }
  }

  /* Run once on initial load (after defer scripts have executed). */
  if (document.readyState === 'complete') {
    setTimeout(syncIfStale, 100);
  } else {
    window.addEventListener('load', () => setTimeout(syncIfStale, 100), { once: true });
  }

  /* Run every time the cart drawer is opened. The drawer toggles `.active`
     on its host element; a small DOM mutation observer is the cheapest way
     to hook this without modifying cart-drawer.js. */
  const drawer = document.querySelector('cart-drawer');
  if (drawer) {
    let wasActive = drawer.classList.contains('active');
    const obs = new MutationObserver(() => {
      const isActive = drawer.classList.contains('active');
      if (isActive && !wasActive) {
        syncIfStale();
      }
      wasActive = isActive;
    });
    obs.observe(drawer, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------- Layer 2: pre-checkout sync ---------- */

  function setButtonLoading(button, loading) {
    if (!button) return;
    button.disabled = !!loading;
    button.classList.toggle('loading', !!loading);
    if (loading) {
      button.dataset.guardOriginalText = button.dataset.guardOriginalText || button.textContent.trim();
      button.textContent = 'Updating cart…';
    } else if (button.dataset.guardOriginalText) {
      button.textContent = button.dataset.guardOriginalText;
    }
  }

  /* ---------- Layer 2: pre-checkout sync ----------
   * Disabled: Layer 1 (drawer-open sync) plus Layer 3 (BLOY total correction)
   * keep the form in sync without blocking checkout. The previous click
   * intercept could prevent submission if /cart.js was momentarily slow,
   * which the user reported as a checkout blocker. Leaving the helpers
   * (fetchLiveCart, refreshSectionsFromServer) in place because Layers 1
   * and 3 still use them.
   */

  /* ---------- Layer 3: overwrite stale total injected by BLOY app ----------
   *
   * The BLOY loyalty app (cart.bloy.js) injects a bare <span> child into
   * <p class="totals__total-value"> with a CACHED total computed from a
   * previous cart state. That cached span survives our section refresh
   * because BLOY re-injects it on every cart-drawer mutation.
   *
   * We intercept it: cache the most-recent /cart.js total, then watch
   * .totals__total-value for any childList/characterData mutation. When the
   * displayed text doesn't match the live total, overwrite it.
   */

  const moneyFormat =
    (window.Shopify && window.Shopify.currency && window.Shopify.currency.active === 'USD'
      ? '${{amount}}'
      : null) ||
    (window.theme && window.theme.moneyFormat) ||
    '${{amount}}';

  function formatMoney(cents) {
    if (typeof cents !== 'number' || isNaN(cents)) return null;
    if (window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      try {
        return window.Shopify.formatMoney(cents, moneyFormat);
      } catch (e) {
        /* fall through */
      }
    }
    const value = (cents / 100).toFixed(2);
    return moneyFormat.replace(/\{\{\s*amount(?:_no_decimals)?\s*\}\}/, value);
  }

  let _liveTotalCents = null;

  function totalElements() {
    return document.querySelectorAll('.totals__total-value');
  }

  function correctTotalElements() {
    if (_liveTotalCents === null) return;
    const expected = formatMoney(_liveTotalCents);
    if (!expected) return;
    totalElements().forEach((el) => {
      /* Strip any wrapper spans BLOY injects and force the correct text. */
      const current = (el.textContent || '').trim();
      if (current === expected) return;
      /* Only overwrite if the displayed value actually differs in numeric
         meaning (avoids fighting Shopify formatting differences). */
      const currentDigits = current.replace(/[^0-9.]/g, '');
      const expectedDigits = expected.replace(/[^0-9.]/g, '');
      if (currentDigits === expectedDigits) return;
      console.warn('[cart-checkout-guard] correcting stale total', {
        was: current,
        now: expected,
      });
      el.textContent = expected;
    });
  }

  /* Wrap fetchLiveCart so every call updates the cached cents. */
  const _origFetchLiveCart = fetchLiveCart;
  // eslint-disable-next-line no-func-assign
  fetchLiveCart = async function () {
    const cart = await _origFetchLiveCart();
    if (cart && typeof cart.total_price === 'number') {
      _liveTotalCents = cart.total_price;
      /* Defer to next tick so any in-progress section render finishes first. */
      setTimeout(correctTotalElements, 0);
    }
    return cart;
  };

  /* Also poll /cart.js when the drawer opens so we have a fresh number even
     if no other code path has fetched recently. The drawer-open observer
     above already calls syncIfStale which calls fetchLiveCart, so this is
     just a belt-and-braces immediate refresh on first interaction. */

  /* Watch the totals element(s) for any mutation by BLOY (or anything else)
     and re-apply the correct value. */
  function attachTotalWatchers() {
    totalElements().forEach((el) => {
      if (el.__guardWatched) return;
      el.__guardWatched = true;
      const obs = new MutationObserver(() => {
        correctTotalElements();
      });
      obs.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* The total element gets replaced when sections refresh, so re-attach
     watchers whenever the cart-drawer subtree mutates. */
  function installFooterObserver() {
    const drawerEl = document.querySelector('cart-drawer');
    const cartPageEl = document.getElementById('main-cart-footer');
    [drawerEl, cartPageEl].forEach((root) => {
      if (!root || root.__guardFooterWatched) return;
      root.__guardFooterWatched = true;
      const obs = new MutationObserver(() => {
        attachTotalWatchers();
        correctTotalElements();
      });
      obs.observe(root, { childList: true, subtree: true });
    });
  }

  function bootLayer3() {
    attachTotalWatchers();
    installFooterObserver();
    /* Prime the cache once on load. */
    fetchLiveCart().catch(() => {});
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(bootLayer3, 0);
  } else {
    document.addEventListener('DOMContentLoaded', bootLayer3, { once: true });
  }
})();

