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

  function showStaleNotice() {
    const errorContainer =
      document.getElementById('CartDrawer-CartErrors') || document.getElementById('cart-errors');
    if (errorContainer) {
      errorContainer.textContent =
        'Your cart was out of date and has been refreshed. Please review and click Check out again.';
    }
  }

  document.addEventListener(
    'click',
    function (event) {
      const button = getCheckoutButton(event.target);
      if (!button) return;
      if (button.dataset.guardPassed === '1') {
        delete button.dataset.guardPassed;
        return;
      }

      const form =
        button.form ||
        (button.getAttribute('form') ? document.getElementById(button.getAttribute('form')) : null);
      if (!form) return;

      event.preventDefault();
      event.stopPropagation();
      setButtonLoading(button, true);

      const formItemCount = sumFormUpdates(form);

      fetchLiveCart()
        .then((cart) => {
          const liveItemCount = cart && typeof cart.item_count === 'number' ? cart.item_count : null;
          const updatesInputs = form.querySelectorAll('input[name="updates[]"]');
          const liveLineCount = (cart.items || []).length;

          const inSync =
            liveItemCount !== null &&
            formItemCount === liveItemCount &&
            updatesInputs.length === liveLineCount;

          if (inSync) {
            setButtonLoading(button, false);
            button.dataset.guardPassed = '1';
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit(button);
            } else {
              button.click();
            }
            return;
          }

          return refreshSectionsFromServer().finally(() => {
            setButtonLoading(button, false);
            showStaleNotice();
          });
        })
        .catch((err) => {
          console.error('[cart-checkout-guard] verification failed', err);
          setButtonLoading(button, false);
          button.dataset.guardPassed = '1';
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(button);
          } else {
            button.click();
          }
        });
    },
    true /* capture phase */
  );
})();

