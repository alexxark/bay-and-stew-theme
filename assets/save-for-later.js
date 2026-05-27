/**
 * Bay & Stew — Save for Later
 *
 * Allows customers to save cart items for later without requiring a server
 * sync. Storage is localStorage only (per device / browser).
 *
 * Saved items are separate from Favorites (different key, different namespace).
 *
 * Storage format: array of objects:
 *   {
 *     variantId:     number,
 *     productHandle: string,
 *     title:         string,   // product title
 *     variantTitle:  string,   // variant name (e.g. "Blue / M")
 *     image:         string|null,
 *     url:           string,
 *     quantity:      number,
 *     price:         number,   // in cents
 *     compareAt:     number|null,
 *   }
 *
 * The Save button in the cart uses data attributes written by the Liquid
 * template so no additional fetch is needed at save time.
 */
(function () {
  'use strict';

  const STORAGE_PREFIX = 'bs:saved-later:';
  const GUEST_KEY      = 'bs:saved-later:guest';

  // -----------------------------------------------------------------------
  // Storage helpers
  // -----------------------------------------------------------------------

  function getCustomerId() {
    const meta = document.querySelector('meta[name="bs-customer-id"]');
    const id   = meta && meta.getAttribute('content');
    return id && id.trim() !== '' ? id.trim() : null;
  }

  function getStorageKey() {
    const id = getCustomerId();
    return id ? STORAGE_PREFIX + id : GUEST_KEY;
  }

  function readAll() {
    try {
      const raw    = localStorage.getItem(getStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(list) {
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(list));
    } catch (e) {
      /* storage full / disabled — ignore */
    }
  }

  // -----------------------------------------------------------------------
  // CRUD — save, remove
  // -----------------------------------------------------------------------

  /**
   * Persist a saved item. When the same variantId already exists, increment
   * its stored quantity instead of creating a duplicate row.
   */
  function save(item) {
    const list = readAll();
    const idx  = list.findIndex((s) => s.variantId === item.variantId);
    if (idx !== -1) {
      list[idx].quantity += item.quantity;
    } else {
      list.push(item);
    }
    writeAll(list);
  }

  function remove(variantId) {
    writeAll(readAll().filter((s) => s.variantId !== variantId));
  }

  // -----------------------------------------------------------------------
  // Inventory helpers
  // -----------------------------------------------------------------------

  /**
   * Fetch /products/{handle}.js and return a map of variantId → inventory
   * info: { tracked: bool, qty: number, policy: string }.
   * Returns an empty object on any error so callers can skip the check.
   */
  function fetchProductInventory(handle) {
    if (!handle) return Promise.resolve({});
    return fetch('/products/' + encodeURIComponent(handle) + '.js', {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((product) => {
        if (!product || !product.variants) return {};
        const map = {};
        product.variants.forEach((v) => {
          map[v.id] = {
            tracked: v.inventory_management === 'shopify',
            policy:  v.inventory_policy,
            // inventory_quantity is present in /products/handle.js when
            // inventory_management === 'shopify'. The typeof check avoids
            // treating a missing field as zero.
            qty: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
          };
        });
        return map;
      })
      .catch(() => ({}));
  }

  /**
   * Fetch the current cart and return it as a plain object.
   * Returns null on error.
   */
  function fetchCurrentCart() {
    return fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  /**
   * Sum how many units of a given variantId are already in the cart.
   */
  function getCartQtyForVariant(cart, variantId) {
    if (!cart || !cart.items) return 0;
    return cart.items.reduce((sum, item) => {
      return item.variant_id === variantId ? sum + item.quantity : sum;
    }, 0);
  }

  /**
   * Given a variant's inventory record and the current cart quantity,
   * return how many more units can be added (null = unlimited).
   */
  function computeAvailable(inv, cartQty) {
    if (!inv || !inv.tracked || inv.policy === 'continue' || inv.qty === null) {
      return null; // no inventory restriction
    }
    return Math.max(0, inv.qty - cartQty);
  }

  // -----------------------------------------------------------------------
  // Cart helpers
  // -----------------------------------------------------------------------

  // Sections we need re-rendered after any cart mutation. Keep in sync with
  // CartDrawer.getSectionsToRender() and CartItems.getSectionsToRender().
  const CART_SECTIONS_TO_RENDER = [
    { id: 'cart-drawer',       targetId: 'CartDrawer',           selector: '.drawer__inner' },
    { id: 'cart-icon-bubble',  targetId: 'cart-icon-bubble',     selector: '.shopify-section' },
    { id: 'main-cart-items',   targetId: 'main-cart-items',      selector: '.js-contents'   },
    { id: 'main-cart-footer',  targetId: 'main-cart-footer',     selector: '.js-contents'   },
  ];

  const CART_SECTIONS_PARAM = CART_SECTIONS_TO_RENDER.map((s) => s.id).join(',');

  function addItemsToCart(items) {
    return fetch('/cart/add.js', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        items:        items,
        sections:     CART_SECTIONS_PARAM,
        sections_url: window.location.pathname,
      }),
    }).then((r) => {
      if (!r.ok) return r.json().then((err) => Promise.reject(err));
      return r.json();
    });
  }

  /** Remove a cart line item by its unique key (sets quantity to 0). */
  function removeFromCart(itemKey) {
    return fetch('/cart/change.js', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        id:           itemKey,
        quantity:     0,
        sections:     CART_SECTIONS_PARAM,
        sections_url: window.location.pathname,
      }),
    }).then((r) => {
      if (!r.ok) return r.json().then((err) => Promise.reject(err));
      return r.json();
    });
  }

  function fetchCartSections(sectionIds) {
    return fetch('/?sections=' + sectionIds.join(','), {
      headers: { Accept: 'application/json' },
    }).then((r) => r.json());
  }

  /**
   * Extract the inner HTML of a Liquid-rendered section. Mirrors what
   * Dawn's own cart-drawer.js does so the swap is byte-for-byte equivalent.
   */
  function getSectionInnerHTML(html, selector) {
    if (!html) return '';
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const el  = dom.querySelector(selector || '.shopify-section');
    return el ? el.innerHTML : '';
  }

  /**
   * Apply a parsedState returned from /cart/change.js or /cart/add.js
   * (with sections requested) to the current page atomically.
   *
   * Handles:
   *   - Re-rendering each section's target innerHTML.
   *   - Toggling the `is-empty` class on cart-drawer / cart-items / footer.
   *   - Publishing PUB_SUB_EVENTS.cartUpdate with cartData so the rewards
   *     bar and other listeners refresh from a consistent snapshot.
   *   - Dispatching `cart:refresh` as a fallback for any older listeners.
   */
  function applyCartUpdate(parsedState) {
    if (!parsedState) return;

    // 1. Replace section HTML.
    if (parsedState.sections) {
      CART_SECTIONS_TO_RENDER.forEach(function (section) {
        const html = parsedState.sections[section.id];
        if (!html) return;
        const target = document.getElementById(section.targetId);
        if (!target) return;
        const inner  = target.querySelector(section.selector) || target;
        inner.innerHTML = getSectionInnerHTML(html, section.selector);
      });
    }

    // 2. Toggle is-empty when we know the count (change.js returns it; add.js
    //    doesn't, but added items can never produce item_count=0).
    if (typeof parsedState.item_count === 'number') {
      const isEmpty    = parsedState.item_count === 0;
      const cartDrawer = document.querySelector('cart-drawer');
      const cartItems  = document.querySelector('cart-items');
      const cartFooter = document.getElementById('main-cart-footer');

      if (cartDrawer) cartDrawer.classList.toggle('is-empty', isEmpty);
      if (cartItems)  cartItems.classList.toggle('is-empty', isEmpty);
      if (cartFooter) cartFooter.classList.toggle('is-empty', isEmpty);

      // The new inner HTML from the server already reflects the empty/non-empty
      // state, but make sure the inner wrapper class is in sync as well.
      const inner = cartDrawer && cartDrawer.querySelector('.drawer__inner');
      if (inner) inner.classList.toggle('is-empty', isEmpty);
    } else {
      // add.js — we know cart is non-empty after the add, so drop is-empty.
      const cartDrawer = document.querySelector('cart-drawer');
      if (cartDrawer) {
        cartDrawer.classList.remove('is-empty');
        const inner = cartDrawer.querySelector('.drawer__inner');
        if (inner) inner.classList.remove('is-empty');
      }
    }

    // 3. Notify the rest of the page.
    if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
      publish(PUB_SUB_EVENTS.cartUpdate, {
        source:   'save-for-later',
        cartData: parsedState,
      });
    }
    document.dispatchEvent(new CustomEvent('cart:refresh'));

    // 4. Re-run the rewards burst (BLOY hook) if present.
    if (typeof window.__runRewardsLast === 'function') {
      try { window.__runRewardsLast(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Re-render the cart drawer (or notification popup, or icon bubble) after
   * a cart mutation. Also publishes PUB_SUB_EVENTS.cartUpdate so the cart
   * page's <cart-items> component self-refreshes when the customer is on /cart.
   *
   * Mirrors the exact same approach used in favorites.js so behaviour is
   * consistent across both modules.
   */
  function refreshCartUI() {
    // Notify the theme's own cart components (cart page CartItems, favourites
    // page re-render, etc.) that the cart changed.
    if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
      publish(PUB_SUB_EVENTS.cartUpdate, { source: 'save-for-later' });
    }

    const cartDrawer = document.querySelector('cart-drawer');
    if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
      const sections = cartDrawer.getSectionsToRender().map((s) => s.id);
      return Promise.all([fetchCartSections(sections), fetchCurrentCart()])
        .then(function (results) {
          const sectionMap = results[0];
          const cart       = results[1];
          const isEmpty    = !cart || cart.item_count === 0;

          cartDrawer.renderContents({ sections: sectionMap });

          // The server-rendered section HTML reflects the new cart state,
          // but the outer <cart-drawer> element's `is-empty` class is not
          // re-evaluated by renderContents(). Toggle it ourselves so the
          // empty-cart layout shows when the last item is removed.
          cartDrawer.classList.toggle('is-empty', isEmpty);
          const inner = cartDrawer.querySelector('.drawer__inner');
          if (inner) inner.classList.toggle('is-empty', isEmpty);
        })
        .catch(() => { /* swallow — caller's success path should not flip */ });
    }

    const cartNotification = document.querySelector('cart-notification');
    if (cartNotification && typeof cartNotification.renderContents === 'function') {
      const sections = cartNotification.getSectionsToRender().map((s) => s.id);
      return fetchCartSections(sections)
        .then((sectionMap) => { cartNotification.renderContents({ sections: sectionMap }); })
        .catch(() => {});
    }

    // Fallback: at minimum update the cart icon count bubble.
    return fetchCartSections(['cart-icon-bubble'])
      .then((data) => {
        const bubble = document.getElementById('cart-icon-bubble');
        if (bubble && data['cart-icon-bubble']) {
          bubble.innerHTML = new DOMParser()
            .parseFromString(data['cart-icon-bubble'], 'text/html')
            .querySelector('.shopify-section').innerHTML;
        }
      })
      .catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Toast notification
  // -----------------------------------------------------------------------

  let toastEl    = null;
  let toastTimer = null;

  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'bs-sfl-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 3200);
  }

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------

  function formatMoney(cents) {
    const fmt = window.Shopify && Shopify.formatMoney || null;
    if (fmt && window.theme && window.theme.moneyFormat) {
      try { return fmt(cents, window.theme.moneyFormat); } catch (e) { /* fall through */ }
    }
    return '$' + (cents / 100).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // -----------------------------------------------------------------------
  // Save for Later page — item rendering
  // -----------------------------------------------------------------------

  function buildSavedItemElement(item) {
    const li = document.createElement('li');
    li.className = 'bs-sfl-item';
    li.setAttribute('data-variant-id', item.variantId);

    const imgHtml = item.image
      ? '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.title) + '" loading="lazy">'
      : '<div class="bs-sfl-item__no-image"></div>';

    const isDefaultVariant = !item.variantTitle || item.variantTitle === 'Default Title';

    let priceHtml = '';
    if (item.compareAt && item.compareAt > item.price) {
      priceHtml =
        '<s class="bs-sfl-item__compare">' + formatMoney(item.compareAt) + '</s> ' +
        '<span class="bs-sfl-item__sale">'  + formatMoney(item.price)   + '</span>';
    } else if (item.price) {
      priceHtml = formatMoney(item.price);
    }

    li.innerHTML =
      '<div class="bs-sfl-item__media">' +
        '<a href="' + escapeHtml(item.url) + '">' + imgHtml + '</a>' +
      '</div>' +
      '<div class="bs-sfl-item__body">' +
        '<button type="button" class="bs-sfl-item__remove" data-sfl-remove>Remove</button>' +
        '<h2 class="bs-sfl-item__title">' +
          '<a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>' +
        '</h2>' +
        (isDefaultVariant ? '' : '<p class="bs-sfl-item__variant">' + escapeHtml(item.variantTitle) + '</p>') +
        (priceHtml ? '<p class="bs-sfl-item__price">' + priceHtml + '</p>' : '') +
        '<p class="bs-sfl-item__qty">Quantity: ' + item.quantity + '</p>' +
        '<div class="bs-sfl-item__actions">' +
          // Move to Cart button — may be replaced by markOutOfStock() after
          // async inventory check completes.
          '<button type="button" class="button button--primary bs-sfl-item__move" data-sfl-move>' +
            'Move to Cart' +
          '</button>' +
        '</div>' +
        '<p class="bs-sfl-item__status" hidden></p>' +
      '</div>';

    return li;
  }

  function setStatus(itemEl, message, kind) {
    const status = itemEl.querySelector('.bs-sfl-item__status');
    if (!status) return;
    status.textContent = message || '';
    status.hidden      = !message;
    status.classList.toggle('is-error',   kind === 'error');
    status.classList.toggle('is-success', kind === 'success');
  }

  /**
   * Update the item row to show "Out of stock" instead of the move button.
   * The item stays in the list — only the customer can remove it manually.
   */
  function markOutOfStock(itemEl) {
    const moveBtn = itemEl.querySelector('[data-sfl-move]');
    if (!moveBtn) return;
    moveBtn.disabled    = true;
    moveBtn.textContent = 'Out of stock';
    moveBtn.classList.add('is-out-of-stock');
    itemEl.setAttribute('data-out-of-stock', 'true');
  }

  // -----------------------------------------------------------------------
  // Move to Cart — with inventory check
  // -----------------------------------------------------------------------

  /**
   * Move a saved item back to the cart.
   *
   * Inventory check logic:
   *   1. Fetch /products/{handle}.js to get current variant inventory.
   *   2. Fetch /cart.js to see what's already in the cart for this variant.
   *   3. available = inventoryQty - cartQtyForVariant
   *   4. If available === 0 → mark out-of-stock, do not add.
   *   5. If saved.quantity > available → clamp to available, show partial toast.
   *   6. Add clamped quantity to cart.
   *   7. Remove from Saved for Later regardless (even partial move).
   *   8. Refresh cart UI.
   */
  /**
   * Open the cart drawer if one exists on the page. Safe to call from any
   * context — does nothing if the drawer element isn't present.
   */
  function openCartDrawer() {
    const drawer = document.querySelector('cart-drawer');
    if (drawer && typeof drawer.open === 'function') {
      try { drawer.open(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Pull the first integer out of a Shopify cart error description.
   * Examples handled:
   *   "You can only add 20 of this item to your cart."  → 20
   *   "All 20 are in your cart."                        → 20
   *   "There are only 20 left of Foo."                  → 20
   */
  function parseQtyFromError(err) {
    if (!err) return null;
    const text = (err.description || err.message || '').toString();
    const m    = text.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * Finalise a successful (full or partial) move to cart:
   * remove from SFL, refresh cart UI, open drawer, toast.
   */
  function finishMove(variantId, itemEl, container, addedQty, requestedQty, addResponse) {
    remove(variantId);
    if (itemEl && itemEl.parentNode) itemEl.remove();

    if (addedQty < requestedQty) {
      showToast('Only ' + addedQty + ' ' + (addedQty === 1 ? 'was' : 'were') +
        ' moved to cart due to availability.');
    } else {
      showToast('Item moved to cart.');
    }

    // Prefer the sections from the add.js response (atomic, no race). Fall
    // back to the full re-fetch path if the response didn't include them.
    if (addResponse && addResponse.sections) {
      applyCartUpdate(addResponse);
      openCartDrawer();
    } else {
      Promise.resolve(refreshCartUI()).then(openCartDrawer);
    }

    if (readAll().length === 0 && container) renderSavedForLaterTab(container);
  }

  function executeMoveToCart(variantId, itemEl, moveBtn, container) {
    const saved = readAll().find((s) => s.variantId === variantId);
    if (!saved) return;

    moveBtn.disabled = true;
    setStatus(itemEl, 'Moving to cart…', null);

    // Strategy: capture cart qty for this variant BEFORE the add, attempt
    // the add (Shopify is the source of truth for inventory), then re-fetch
    // the cart and diff to find out how many units were actually added.
    // This works whether Shopify returns 200 (full add) or 422 (rejected).
    fetchCurrentCart()
      .then(function (preCart) {
        const preQty = getCartQtyForVariant(preCart, variantId);

        return addItemsToCart([{ id: variantId, quantity: saved.quantity }])
          .then(
            function (resp) { return { ok: true,  err: null, resp: resp }; },
            function (err)  { return { ok: false, err: err,  resp: null }; }
          )
          .then(function (addResult) {
            // If the first attempt failed, parse the allowed qty from the
            // error message and retry once with the clamped amount.
            if (!addResult.ok) {
              const maxAddable = parseQtyFromError(addResult.err);
              if (maxAddable && maxAddable > 0) {
                return addItemsToCart([{ id: variantId, quantity: maxAddable }])
                  .then(
                    function (resp) { return { ok: true,  err: null, resp: resp }; },
                    function (err)  { return { ok: false, err: err,  resp: null }; }
                  );
              }
            }
            return addResult;
          })
          .then(function (finalResult) {
            // Verify what actually landed in the cart by re-fetching it.
            return fetchCurrentCart().then(function (postCart) {
              const postQty = getCartQtyForVariant(postCart, variantId);
              const added   = Math.max(0, postQty - preQty);
              return { added: added, finalResult: finalResult };
            });
          });
      })
      .then(function (result) {
        const added   = result.added;
        const final   = result.finalResult || {};
        const err     = final.err;
        const addResp = final.resp;

        if (added > 0) {
          // Something was added — success path (full or partial).
          setStatus(itemEl, '', null);
          finishMove(variantId, itemEl, container, added, saved.quantity, addResp);
          return;
        }

        // Nothing was added. Either out of stock or another error.
        const text = ((err && (err.description || err.message)) || '').toString();
        if (/sold\s*out|out of stock|unavailable|cannot find/i.test(text) ||
            parseQtyFromError(err) === 0) {
          markOutOfStock(itemEl);
          setStatus(itemEl, '', null);
        } else {
          setStatus(itemEl, text || 'Could not move to cart.', 'error');
          moveBtn.disabled = false;
        }
      })
      .catch(function (err) {
        // Network failure during pre-fetch.
        setStatus(itemEl, (err && err.description) || 'Could not move to cart.', 'error');
        moveBtn.disabled = false;
      });
  }

  // -----------------------------------------------------------------------
  // Async stock check — updates Move to Cart buttons after render
  // -----------------------------------------------------------------------

  /**
   * After the Saved for Later tab renders, run a background inventory check
   * for all saved items and mark any that are fully out of stock.
   * Deduplicates by product handle to minimise HTTP requests.
   */
  function checkSavedItemsStock(container) {
    const items = readAll();
    if (!items.length) return;

    // Collect unique handles that have a productHandle stored.
    const handles = [];
    items.forEach((item) => {
      if (item.productHandle && !handles.includes(item.productHandle)) {
        handles.push(item.productHandle);
      }
    });
    if (!handles.length) return;

    // Fetch inventory and cart in parallel.
    Promise.all([
      Promise.all(handles.map((h) => fetchProductInventory(h).then((map) => ({ handle: h, map })))),
      fetchCurrentCart(),
    ])
      .then(function (results) {
        const invResults = results[0]; // [{handle, map}, ...]
        const cart       = results[1];

        // Build a flat variantId → inv record from all fetched products.
        const invMap = {};
        invResults.forEach(({ map }) => {
          Object.keys(map).forEach((id) => { invMap[id] = map[id]; });
        });

        // Update each rendered item row.
        items.forEach((item) => {
          const itemEl = container && container.querySelector(
            '.bs-sfl-item[data-variant-id="' + item.variantId + '"]'
          );
          if (!itemEl) return;

          // Skip rows already marked (e.g. by a previous interaction).
          if (itemEl.getAttribute('data-out-of-stock') === 'true') return;

          const inv       = invMap[item.variantId];
          const cartQty   = getCartQtyForVariant(cart, item.variantId);
          const available = computeAvailable(inv, cartQty);

          if (available === 0) markOutOfStock(itemEl);
        });
      })
      .catch(() => { /* non-fatal — buttons stay enabled */ });
  }

  // -----------------------------------------------------------------------
  // Item event handlers
  // -----------------------------------------------------------------------

  function attachItemHandlers(itemEl, container) {
    itemEl.addEventListener('click', function (e) {
      // --- Remove from Saved for Later ---
      if (e.target.closest('[data-sfl-remove]')) {
        const variantId = parseInt(itemEl.getAttribute('data-variant-id'), 10);
        remove(variantId);
        itemEl.remove();
        if (readAll().length === 0) renderSavedForLaterTab(container);
        return;
      }

      // --- Move to Cart ---
      const moveBtn = e.target.closest('[data-sfl-move]');
      if (moveBtn && !moveBtn.disabled) {
        const variantId = parseInt(itemEl.getAttribute('data-variant-id'), 10);
        executeMoveToCart(variantId, itemEl, moveBtn, container);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Render the Saved for Later tab
  // -----------------------------------------------------------------------

  function renderSavedForLaterTab(container) {
    if (!container) container = document.querySelector('[data-bs-sfl-root]');
    if (!container) return;

    const items = readAll();
    if (items.length === 0) {
      container.innerHTML = '<div class="bs-favorites__empty"><p>No items saved for later.</p></div>';
      return;
    }

    container.innerHTML = '<ul class="bs-sfl-list"></ul>';
    const list = container.querySelector('.bs-sfl-list');
    items.forEach((item) => {
      const el = buildSavedItemElement(item);
      attachItemHandlers(el, container);
      list.appendChild(el);
    });

    // Run async inventory check to mark out-of-stock items. This runs after
    // the list is already visible so the tab feels instant.
    checkSavedItemsStock(container);
  }

  // -----------------------------------------------------------------------
  // Sign-in modal (shown when a guest tries to save an item)
  //
  // Reuses the same .bs-favorite-modal CSS classes so no extra styles are
  // needed. Only the heading/body text and data attributes differ.
  // -----------------------------------------------------------------------

  let sflModalEl = null;

  function openSflSignInModal() {
    if (!sflModalEl) {
      sflModalEl = document.createElement('div');
      sflModalEl.className = 'bs-favorite-modal';
      sflModalEl.setAttribute('role', 'dialog');
      sflModalEl.setAttribute('aria-modal', 'true');
      sflModalEl.setAttribute('aria-hidden', 'true');
      sflModalEl.innerHTML =
        '<div class="bs-favorite-modal__overlay" data-bs-sfl-close></div>' +
        '<div class="bs-favorite-modal__panel">' +
          '<button type="button" class="bs-favorite-modal__close" aria-label="Close" data-bs-sfl-close>&times;</button>' +
          '<h2 class="bs-favorite-modal__title">Sign in to save for later</h2>' +
          '<p class="bs-favorite-modal__text">Please sign in to your account to save items for later.</p>' +
          '<div class="bs-favorite-modal__actions">' +
            '<a class="button button--primary" data-bs-sfl-login>Sign in</a>' +
            '<button type="button" class="button button--secondary" data-bs-sfl-close>Cancel</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(sflModalEl);

      sflModalEl.addEventListener('click', function (e) {
        if (e.target.closest('[data-bs-sfl-close]')) closeSflSignInModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeSflSignInModal();
      });
    }

    const loginUrl = (document.querySelector('meta[name="bs-login-url"]') || {}).content || '/account/login';
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    const link     = sflModalEl.querySelector('[data-bs-sfl-login]');
    link.href      = loginUrl + (loginUrl.indexOf('?') === -1 ? '?' : '&') + 'checkout_url=' + returnTo;

    sflModalEl.classList.add('is-open');
    sflModalEl.setAttribute('aria-hidden', 'false');
  }

  function closeSflSignInModal() {
    if (!sflModalEl) return;
    sflModalEl.classList.remove('is-open');
    sflModalEl.setAttribute('aria-hidden', 'true');
  }

  // -----------------------------------------------------------------------
  // Save button handler (wired to cart drawer + main cart page)
  //
  // The Liquid template stamps all needed item data as data-* attributes on
  // the Save button so we never need an extra fetch at save time.
  // -----------------------------------------------------------------------

  function handleSaveForLaterClick(e) {
    const btn = e.target.closest('[data-bs-sfl-save]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();

    // Guests cannot use Save for Later — prompt them to sign in.
    if (!getCustomerId()) {
      openSflSignInModal();
      return;
    }

    const itemKey      = btn.getAttribute('data-item-key');
    const variantId    = parseInt(btn.getAttribute('data-variant-id'), 10);
    const title        = btn.getAttribute('data-title')        || '';
    const variantTitle = btn.getAttribute('data-variant-title') || '';
    const image        = btn.getAttribute('data-image')        || null;
    const url          = btn.getAttribute('data-url')          || '/';
    const quantity     = parseInt(btn.getAttribute('data-quantity'),   10) || 1;
    const price        = parseInt(btn.getAttribute('data-price'),       10) || 0;
    const compareAt    = parseInt(btn.getAttribute('data-compare-at'), 10) || null;
    const handle       = btn.getAttribute('data-product-handle') || '';

    if (!itemKey || !variantId) return;

    // Disable immediately to prevent double-click.
    btn.disabled = true;

    removeFromCart(itemKey)
      .then(function (parsedState) {
        save({
          variantId,
          productHandle: handle,
          title,
          variantTitle,
          image,
          url,
          quantity,
          price,
          compareAt: compareAt && compareAt > price ? compareAt : null,
        });
        showToast('Item saved for later.');

        // Atomically re-render cart UI from the change.js response. This
        // includes the proper empty-state markup when the saved item was
        // the last thing in the cart.
        try { applyCartUpdate(parsedState); } catch (e) { /* swallow */ }
      })
      .catch(function (err) {
        // Cart removal itself failed — re-enable so the customer can retry.
        btn.disabled = false;
        showToast((err && err.description) || 'Could not save item.');
      });
    // btn.disabled intentionally stays true on success: the entire row is
    // removed from the cart when applyCartUpdate() re-renders the section.
  }

  document.addEventListener('click', handleSaveForLaterClick);

  // -----------------------------------------------------------------------
  // Cart inventory validation on page load
  //
  // On every page load we compare cart quantities against live inventory.
  // If any item exceeds available stock we silently correct the cart and
  // notify the customer with a toast. This catches the case where inventory
  // ran out on another device or while the cart was sitting idle.
  // -----------------------------------------------------------------------

  function validateCartInventoryOnLoad() {
    fetchCurrentCart()
      .then(function (cart) {
        if (!cart || !cart.items || cart.items.length === 0) return;

        // Deduplicate product handles to minimise fetch count.
        const handles = [];
        cart.items.forEach(function (item) {
          if (item.handle && !handles.includes(item.handle)) handles.push(item.handle);
        });

        // Fetch all products in parallel.
        return Promise.all(
          handles.map((h) =>
            fetch('/products/' + encodeURIComponent(h) + '.js', {
              headers: { Accept: 'application/json' },
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        ).then(function (products) {
          // Build variantId → { tracked, qty, policy } map from all products.
          const invMap = {};
          products.forEach(function (p) {
            if (!p || !p.variants) return;
            p.variants.forEach(function (v) {
              invMap[v.id] = {
                tracked: v.inventory_management === 'shopify',
                policy:  v.inventory_policy,
                qty:     typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null,
              };
            });
          });

          // Compare each cart item against available inventory.
          // { variantId: newQty } — collected here, applied in one request.
          const updates    = {};
          let hadRemoved   = false;
          let hadReduced   = false;

          cart.items.forEach(function (item) {
            const inv = invMap[item.variant_id];
            // Only act on tracked variants that enforce inventory limits.
            if (!inv || !inv.tracked || inv.policy === 'continue' || inv.qty === null) return;

            const available = Math.max(0, inv.qty);

            if (available === 0) {
              // Fully out of stock — remove from cart.
              updates[item.variant_id] = 0;
              hadRemoved = true;
            } else if (item.quantity > available) {
              // Cart quantity exceeds available — cap it.
              updates[item.variant_id] = available;
              hadReduced = true;
            }
          });

          if (Object.keys(updates).length === 0) return; // nothing to do

          // Apply all quantity corrections in a single request.
          return fetch('/cart/update.js', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body:    JSON.stringify({ updates: updates }),
          })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function () {
              // Notify the customer. Out-of-stock removal takes priority.
              if (hadRemoved) {
                showToast('An out-of-stock item was removed from your cart.');
              } else if (hadReduced) {
                showToast('Some cart quantities were updated due to availability.');
              }
              // Refresh whatever cart UI is currently visible.
              return refreshCartUI();
            })
            .catch(() => { /* silent fail — cart state unchanged */ });
        });
      })
      .catch(() => { /* silent fail on network error */ });
  }

  // -----------------------------------------------------------------------
  // Tab switching on the Favorites / Saved for Later page
  // -----------------------------------------------------------------------

  function initTabs() {
    const tabsEl = document.querySelector('[data-bs-page-tabs]');
    if (!tabsEl) return;

    const tabBtns = tabsEl.querySelectorAll('[data-bs-tab]');
    const panels  = document.querySelectorAll('[data-bs-tab-panel]');

    function activateTab(tabName) {
      tabBtns.forEach(function (btn) {
        const active = btn.getAttribute('data-bs-tab') === tabName;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panels.forEach(function (panel) {
        const active = panel.getAttribute('data-bs-tab-panel') === tabName;
        panel.hidden = !active;
        if (active && tabName === 'saved') {
          renderSavedForLaterTab(panel.querySelector('[data-bs-sfl-root]'));
        }
      });
    }

    tabsEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-bs-tab]');
      if (!btn) return;
      const name = btn.getAttribute('data-bs-tab');
      activateTab(name);
      history.replaceState(null, '', '#' + name);
    });

    // Honour URL hash on load.
    const hash      = (location.hash || '').replace('#', '');
    const validTabs = Array.from(tabBtns).map((b) => b.getAttribute('data-bs-tab'));
    activateTab(validTabs.includes(hash) ? hash : (validTabs[0] || 'favorites'));
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function init() {
    initTabs();
    // Run cart validation after a short idle so it doesn't compete with
    // above-the-fold rendering.
    setTimeout(validateCartInventoryOnLoad, 800);
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  window.BSSavedForLater = {
    save:                    save,
    remove:                  remove,
    readAll:                 readAll,
    showToast:               showToast,
    renderSavedForLaterTab:  renderSavedForLaterTab,
    validateCartInventory:   validateCartInventoryOnLoad,
  };
})();
