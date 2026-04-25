/**
 * Bay & Stew — Favorites
 *
 * Cross-device favorites:
 *   - localStorage acts as a fast cache.
 *   - When a customer is logged in, the list is bootstrapped from a customer
 *     metafield rendered server-side (see theme.liquid -> #bs-favorites-bootstrap).
 *   - Changes are written through to a sync endpoint defined by the
 *     <meta name="bs-favorites-endpoint"> tag (default: /apps/favorites).
 *     Wire that to a Shopify App Proxy backed by a small serverless function
 *     that updates customer.metafields.favorites.handles via the Admin API.
 *
 * Required Shopify admin setup:
 *   1. Settings → Custom data → Customers → Add definition:
 *        namespace+key:  favorites.handles
 *        type:           list.single_line_text_field
 *        access:         storefront read enabled
 *   2. Apps → Develop apps (or your existing app) → App Proxy:
 *        subpath prefix: apps
 *        subpath:        favorites
 *        proxy URL:      https://your-worker.example.com/favorites
 *      Your worker handles GET (returns list) and PUT/POST (replaces list)
 *      and uses Admin API customerUpdate to write the metafield.
 *
 * The system requires a logged-in customer. When a non-authenticated visitor
 * tries to favorite a product, a sign-in modal is shown.
 */
(function () {
  'use strict';

  const GUEST_KEY = 'bs:favorites:guest';
  const STORAGE_PREFIX = 'bs:favorites:';
  const EVENT_CHANGED = 'bs:favorites:changed';
  const SYNC_DEBOUNCE_MS = 600;

  function getCustomerId() {
    const meta = document.querySelector('meta[name="bs-customer-id"]');
    const id = meta && meta.getAttribute('content');
    return id && id.trim() !== '' ? id.trim() : null;
  }

  function getSyncEndpoint() {
    const meta = document.querySelector('meta[name="bs-favorites-endpoint"]');
    const url = meta && meta.getAttribute('content');
    return url && url.trim() !== '' ? url.trim() : null;
  }

  function getStorageKey() {
    const id = getCustomerId();
    return id ? STORAGE_PREFIX + id : GUEST_KEY;
  }

  function readBootstrap() {
    const node = document.getElementById('bs-favorites-bootstrap');
    if (!node) return null;
    const text = (node.textContent || '').trim();
    if (!text) return null;
    try {
      let parsed = JSON.parse(text);
      // Shopify sometimes returns list metafields as a JSON-encoded string
      // (e.g. "[\"handle-a\",\"handle-b\"]"). Decode a second time if needed.
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { /* leave as-is */ }
      }
      return Array.isArray(parsed) ? parsed.filter((h) => typeof h === 'string') : null;
    } catch (e) {
      return null;
    }
  }

  function readAll() {
    try {
      const raw = localStorage.getItem(getStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocal(list) {
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(list));
    } catch (e) {
      /* storage full / disabled — ignore */
    }
  }

  function writeAll(list, options) {
    options = options || {};
    writeLocal(list);
    document.dispatchEvent(new CustomEvent(EVENT_CHANGED, { detail: { favorites: list } }));
    if (!options.skipSync) scheduleSync(list);
  }

  // ---------- Server sync (write-through) ----------
  let syncTimer = null;
  let lastSyncedJson = null;

  function scheduleSync(list) {
    if (!getCustomerId() || !getSyncEndpoint()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => pushToServer(list), SYNC_DEBOUNCE_MS);
  }

  function pushToServer(list) {
    const endpoint = getSyncEndpoint();
    if (!endpoint || !getCustomerId()) return Promise.resolve();
    const payload = JSON.stringify({ handles: list });
    if (payload === lastSyncedJson) return Promise.resolve();
    return fetch(endpoint, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload,
    })
      .then((r) => {
        if (r.ok) lastSyncedJson = payload;
      })
      .catch(() => {
        /* offline / endpoint down — local cache still holds the change */
      });
  }

  function pullFromServer() {
    const endpoint = getSyncEndpoint();
    if (!endpoint || !getCustomerId()) return Promise.resolve(null);
    return fetch(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body) return null;
        const list = Array.isArray(body) ? body : body.handles;
        return Array.isArray(list) ? list : null;
      })
      .catch(() => null);
  }

  function mergeLists(a, b) {
    const out = [];
    const seen = Object.create(null);
    (a || []).concat(b || []).forEach((h) => {
      if (typeof h === 'string' && h && !seen[h]) {
        seen[h] = true;
        out.push(h);
      }
    });
    return out;
  }

  // Bootstrap on load.
  //
  // For a logged-in customer the server (metafield) is the authoritative
  // source of truth. Otherwise a deletion made on Device A would be
  // resurrected on Device B because B's stale cache would merge back in.
  //
  // Algorithm:
  //   1. Trust the Liquid-rendered bootstrap list (no network round-trip).
  //   2. Special case: if the server is empty AND local has items, the local
  //      list is treated as a one-time guest-import — push it up to seed.
  //   3. Always re-pull from the endpoint shortly after to catch changes
  //      made on another device after this page started rendering.
  function hydrate() {
    if (!getCustomerId()) return;
    const local = readAll();
    const bootstrap = readBootstrap();

    if (bootstrap && bootstrap.length) {
      // Server has data → server wins. Replace local cache (do NOT merge).
      if (JSON.stringify(local) !== JSON.stringify(bootstrap)) {
        writeAll(bootstrap, { skipSync: true });
      }
      lastSyncedJson = JSON.stringify({ handles: bootstrap });
    } else if (bootstrap && bootstrap.length === 0 && local.length === 0) {
      // Both sides empty — nothing to do.
      lastSyncedJson = JSON.stringify({ handles: [] });
    } else if (local.length && getSyncEndpoint()) {
      // Server is empty but local has items (e.g. items added while logged out
      // on this device). Seed the server one-time so cross-device works going
      // forward.
      scheduleSync(local);
    }

    // Pull fresh in case the bootstrap is stale (e.g. another device updated
    // the metafield after this page started rendering). Server wins again.
    if (getSyncEndpoint()) {
      pullFromServer().then((serverList) => {
        if (!serverList) return;
        const current = readAll();
        if (JSON.stringify(serverList) !== JSON.stringify(current)) {
          writeAll(serverList, { skipSync: true });
          lastSyncedJson = JSON.stringify({ handles: serverList });
        }
      });
    }
  }

  function has(handle) {
    return readAll().indexOf(handle) !== -1;
  }

  function add(handle) {
    const list = readAll();
    if (list.indexOf(handle) === -1) {
      list.push(handle);
      writeAll(list);
    }
  }

  function remove(handle) {
    const list = readAll().filter((h) => h !== handle);
    writeAll(list);
  }

  function toggle(handle) {
    if (has(handle)) {
      remove(handle);
      return false;
    }
    add(handle);
    return true;
  }

  // ---------- Sign-in modal ----------
  let modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'bs-favorite-modal';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-hidden', 'true');
    modalEl.innerHTML = `
      <div class="bs-favorite-modal__overlay" data-bs-favorite-close></div>
      <div class="bs-favorite-modal__panel">
        <button type="button" class="bs-favorite-modal__close" aria-label="Close" data-bs-favorite-close>&times;</button>
        <h2 class="bs-favorite-modal__title">Sign in to favorite</h2>
        <p class="bs-favorite-modal__text">Please sign in to your account to save items to your favorites.</p>
        <div class="bs-favorite-modal__actions">
          <a class="button button--primary" data-bs-favorite-login>Sign in</a>
          <button type="button" class="button button--secondary" data-bs-favorite-close>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-bs-favorite-close]')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
    return modalEl;
  }

  function openSignInModal() {
    const m = ensureModal();
    const loginUrl =
      (document.querySelector('meta[name="bs-login-url"]') || {}).content || '/account/login';
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    const link = m.querySelector('[data-bs-favorite-login]');
    link.href = loginUrl + (loginUrl.indexOf('?') === -1 ? '?' : '&') + 'checkout_url=' + returnTo;
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('is-open');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  // ---------- Heart toggle button wiring ----------
  function syncButton(btn) {
    const handle = btn.getAttribute('data-product-handle');
    if (!handle) return;
    const active = has(handle);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    const label = active ? 'Remove from favorites' : 'Add to favorites';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  function syncAllButtons() {
    document.querySelectorAll('[data-bs-favorite-toggle]').forEach(syncButton);
  }

  function handleClick(e) {
    const btn = e.target.closest('[data-bs-favorite-toggle]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (!getCustomerId()) {
      openSignInModal();
      return;
    }
    const handle = btn.getAttribute('data-product-handle');
    if (!handle) return;
    toggle(handle);
    syncButton(btn);
  }

  document.addEventListener('click', handleClick);
  document.addEventListener(EVENT_CHANGED, syncAllButtons);
  document.addEventListener('DOMContentLoaded', () => {
    hydrate();
    syncAllButtons();
  });
  if (document.readyState !== 'loading') {
    hydrate();
    syncAllButtons();
  }

  // ---------- Favorites page rendering ----------
  const productCache = {};

  function fetchProduct(handle) {
    if (productCache[handle]) return Promise.resolve(productCache[handle]);
    return fetch('/products/' + encodeURIComponent(handle) + '.js', {
      headers: { Accept: 'application/json' },
    })
      .then((r) => {
        if (!r.ok) throw new Error('not found');
        return r.json();
      })
      .then((p) => {
        productCache[handle] = p;
        return p;
      });
  }

  function formatMoney(cents) {
    const fmt = (window.Shopify && Shopify.formatMoney) || null;
    if (fmt && window.theme && window.theme.moneyFormat) {
      try {
        return fmt(cents, window.theme.moneyFormat);
      } catch (e) {
        /* fall through */
      }
    }
    return '$' + (cents / 100).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Server-rendered inventory map (handle -> variantId -> {tracked, qty}).
  // Storefront product JSON omits inventory_quantity, so we rely on this.
  let __invMap = null;
  function getInventoryMap() {
    if (__invMap) return __invMap;
    const node = document.querySelector('script[data-bs-favorites-inventory]');
    if (!node) { __invMap = {}; return __invMap; }
    try { __invMap = JSON.parse(node.textContent || '{}'); }
    catch (e) { __invMap = {}; }
    return __invMap;
  }
  function getVariantInventory(handle, variantId) {
    const map = getInventoryMap();
    const p = map && map[handle];
    if (!p) return null;
    return p[variantId] || null;
  }

  // Live cart map: variantId -> quantity already in cart. Used to subtract
  // from the inventory cap so users can't add more than what's left.
  let __cartMap = {};
  function loadCartMap() {
    return fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((c) => {
        const next = {};
        (c.items || []).forEach((i) => {
          next[i.id] = (next[i.id] || 0) + i.quantity;
        });
        __cartMap = next;
        return __cartMap;
      })
      .catch(() => {
        __cartMap = {};
        return __cartMap;
      });
  }
  function getCartQty(variantId) {
    return (__cartMap && __cartMap[variantId]) || 0;
  }

  function buildVariantRow(variant, productHandle) {
    const sold = !variant.available;
    // Prefer server-rendered inventory (Liquid). Fall back to product JSON
    // when present. If neither tells us the count, leave open-ended so we
    // don't accidentally clamp to 0 and brick the plus button.
    const inv = getVariantInventory(productHandle, variant.id);
    let invMax = null;
    if (inv && inv.tracked) {
      invMax = Math.max(0, parseInt(inv.qty, 10) || 0);
    } else if (
      variant.inventory_management === 'shopify' &&
      variant.inventory_policy !== 'continue' &&
      typeof variant.inventory_quantity === 'number'
    ) {
      invMax = Math.max(0, variant.inventory_quantity);
    }
    // Subtract whatever the customer already has in their cart for this
    // variant so the qty cap reflects what they can still add.
    const inCart = getCartQty(variant.id);
    const remaining = invMax !== null ? Math.max(0, invMax - inCart) : null;
    const maxedOut = invMax !== null && remaining === 0 && inCart > 0;
    const maxAttr =
      remaining !== null
        ? ' max="' + remaining + '" data-inventory-max="' + remaining + '"'
        : '';

    let control;
    if (sold) {
      control = '<span class="bs-fav-variant__sold-out">Sold out</span>';
    } else if (maxedOut) {
      control = '<span class="bs-fav-variant__sold-out" title="You already have the maximum quantity in your cart.">Max in cart</span>';
    } else {
      control =
        '<div class="bs-fav-variant__control">' +
          '<div class="bs-fav-qty" data-qty>' +
            '<button type="button" data-qty-step="-1" aria-label="Decrease">−</button>' +
            '<input type="number" min="0" step="1" value="0"' + maxAttr +
              ' aria-label="Quantity for ' + escapeHtml(variant.title) + '">' +
            '<button type="button" data-qty-step="1" aria-label="Increase">+</button>' +
          '</div>' +
          '<span class="bs-fav-variant__warning" role="status" aria-live="polite" hidden></span>' +
        '</div>';
    }

    return (
      '<div class="bs-fav-variant" data-variant-id="' + variant.id + '">' +
        '<div class="bs-fav-variant__label">' +
          '<span class="bs-fav-variant__name">' + escapeHtml(variant.title) + '</span>' +
          '<span class="bs-fav-variant__price">' + formatMoney(variant.price) + '</span>' +
        '</div>' +
        control +
      '</div>'
    );
  }

  function buildItemElement(product) {
    const li = document.createElement('li');
    li.className = 'bs-fav-item';
    li.setAttribute('data-handle', product.handle);
    const img = product.featured_image
      ? '<img src="' + product.featured_image + '" alt="' + escapeHtml(product.title) + '" loading="lazy">'
      : '';
    li.innerHTML =
      '<div class="bs-fav-item__media"><a href="' + product.url + '">' + img + '</a></div>' +
      '<div class="bs-fav-item__body">' +
        '<button type="button" class="bs-fav-item__remove" data-fav-remove>Remove from favorites</button>' +
        '<h2 class="bs-fav-item__title"><a href="' + product.url + '">' + escapeHtml(product.title) + '</a></h2>' +
        '<div class="bs-fav-item__variants">' +
          product.variants.map((v) => buildVariantRow(v, product.handle)).join('') +
        '</div>' +
        '<div class="bs-fav-item__actions">' +
          '<button type="button" class="button button--primary bs-fav-item__add" data-fav-add>Add to cart</button>' +
        '</div>' +
        '<p class="bs-fav-item__status" hidden></p>' +
      '</div>';
    return li;
  }

  function setStatus(itemEl, message, kind) {
    const status = itemEl.querySelector('.bs-fav-item__status');
    if (!status) return;
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-success', kind === 'success');
  }

  function collectItems(itemEl) {
    const rows = itemEl.querySelectorAll('.bs-fav-variant[data-variant-id]');
    const items = [];
    rows.forEach((row) => {
      const input = row.querySelector('input[type="number"]');
      if (!input) return;
      const qty = parseInt(input.value, 10);
      if (qty > 0) {
        items.push({ id: parseInt(row.getAttribute('data-variant-id'), 10), quantity: qty });
      }
    });
    return items;
  }

  function addItemsToCart(items) {
    return fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: items }),
    }).then((r) => {
      if (!r.ok) return r.json().then((err) => Promise.reject(err));
      return r.json();
    });
  }

  function fetchCartSections(sectionIds) {
    const url = '/?sections=' + sectionIds.join(',');
    return fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json());
  }

  function refreshCartUI() {
    const cartDrawer = document.querySelector('cart-drawer');
    if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
      const sections = cartDrawer.getSectionsToRender().map((s) => s.id);
      return fetchCartSections(sections).then((sectionMap) => {
        cartDrawer.renderContents({ sections: sectionMap });
        // Mirror what product-form.js does: drop the is-empty class on the
        // host element once items have been added, otherwise CSS hides the
        // drawer header / items area.
        if (cartDrawer.classList.contains('is-empty')) {
          cartDrawer.classList.remove('is-empty');
        }
        const inner = cartDrawer.querySelector('.drawer__inner');
        if (inner && inner.classList.contains('is-empty')) {
          inner.classList.remove('is-empty');
        }
      });
    }

    const cartNotification = document.querySelector('cart-notification');
    if (cartNotification && typeof cartNotification.renderContents === 'function') {
      const sections = cartNotification.getSectionsToRender().map((s) => s.id);
      return fetchCartSections(sections).then((sectionMap) => {
        cartNotification.renderContents({ sections: sectionMap });
      });
    }

    // Fallback: at minimum, refresh the cart icon bubble.
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

  function clampQty(input) {
    let v = parseInt(input.value, 10);
    if (isNaN(v) || v < 0) v = 0;
    const max = parseInt(input.max, 10);
    let clamped = false;
    if (!isNaN(max) && v > max) {
      v = max;
      clamped = true;
    }
    input.value = v;
    if (clamped) flashQtyWarning(input, max);
  }

  function flashQtyWarning(input, max) {
    const row = input.closest('.bs-fav-variant');
    if (!row) return;
    const warn = row.querySelector('.bs-fav-variant__warning');
    if (!warn) return;
    warn.textContent =
      max > 0 ? 'Only ' + max + ' more available' : 'Max quantity reached';
    warn.hidden = false;
    // Force reflow so the transition plays even on rapid clicks.
    // eslint-disable-next-line no-unused-expressions
    warn.offsetHeight;
    warn.classList.add('is-visible');
    if (warn._t) clearTimeout(warn._t);
    warn._t = setTimeout(() => {
      warn.classList.remove('is-visible');
      // Hide after fade-out completes.
      setTimeout(() => {
        if (!warn.classList.contains('is-visible')) warn.hidden = true;
      }, 250);
    }, 2200);
  }

  function attachItemHandlers(itemEl) {
    itemEl.addEventListener('input', (e) => {
      if (e.target.matches('.bs-fav-qty input')) clampQty(e.target);
    });
    itemEl.addEventListener('click', (e) => {
      const step = e.target.closest('[data-qty-step]');
      if (step) {
        const input = step.parentElement.querySelector('input');
        const dir = parseInt(step.getAttribute('data-qty-step'), 10);
        const current = parseInt(input.value, 10) || 0;
        const max = parseInt(input.max, 10);
        // If pressing + while already at the inventory cap, surface the
        // warning ourselves — clampQty would be a no-op.
        if (dir > 0 && !isNaN(max) && current >= max) {
          flashQtyWarning(input, max);
          return;
        }
        const next = Math.max(0, current + dir);
        input.value = next;
        clampQty(input);
        return;
      }
      if (e.target.closest('[data-fav-remove]')) {
        const handle = itemEl.getAttribute('data-handle');
        remove(handle);
        itemEl.remove();
        const root = document.querySelector('[data-bs-favorites-root]');
        if (root && readAll().length === 0) renderFavoritesPage();
        return;
      }
      const addBtn = e.target.closest('[data-fav-add]');
      if (addBtn) {
        const items = collectItems(itemEl);
        if (items.length === 0) {
          setStatus(itemEl, 'Set a quantity above 0 first.', 'error');
          return;
        }
        addBtn.disabled = true;
        setStatus(itemEl, 'Adding to cart…', null);
        addItemsToCart(items)
          .then(() => {
            setStatus(itemEl, 'Added to cart.', 'success');
            itemEl.querySelectorAll('input[type="number"]').forEach((i) => (i.value = 0));
            // Refresh both the drawer and our local cart map, then re-render
            // the favorites list so updated caps + "Max in cart" badges show.
            return Promise.all([refreshCartUI(), loadCartMap()]).then(() => {
              renderFavoritesPage();
            });
          })
          .catch((err) => {
            setStatus(itemEl, (err && err.description) || 'Could not add to cart.', 'error');
          })
          .finally(() => {
            addBtn.disabled = false;
          });
      }
    });
  }

  function renderFavoritesPage() {
    const root = document.querySelector('[data-bs-favorites-root]');
    if (!root) return;
    const handles = readAll();
    if (handles.length === 0) {
      root.innerHTML =
        '<div class="bs-favorites__empty"><p>You haven\'t favorited anything yet.</p></div>';
      return;
    }
    root.innerHTML = '<ul class="bs-favorites__list"></ul>';
    const list = root.querySelector('.bs-favorites__list');
    // Refresh the cart map first so inventory caps subtract what's already
    // in the cart and "Max in cart" badges render correctly.
    loadCartMap().then(() => {
      handles.forEach((handle) => {
        fetchProduct(handle)
          .then((product) => {
            const el = buildItemElement(product);
            attachItemHandlers(el);
            list.appendChild(el);
          })
          .catch(() => {
            /* product missing — silently skip and clean storage */
            remove(handle);
          });
      });
    });
  }

  function initFavoritesPageIfPresent() {
    const page = document.querySelector('[data-bs-favorites-page]');
    if (!page) return;
    if (page.getAttribute('data-logged-in') !== 'true') return;
    renderFavoritesPage();
    // Re-render on any external change (e.g. server pull bringing new items).
    document.addEventListener(EVENT_CHANGED, () => {
      renderFavoritesPage();
    });
  }

  document.addEventListener('DOMContentLoaded', initFavoritesPageIfPresent);
  if (document.readyState !== 'loading') initFavoritesPageIfPresent();

  // ---------- Public API ----------
  window.BSFavorites = {
    list: readAll,
    has: has,
    add: add,
    remove: remove,
    toggle: toggle,
    isLoggedIn: () => !!getCustomerId(),
    openSignInModal: openSignInModal,
    EVENT_CHANGED: EVENT_CHANGED,
  };
})();
