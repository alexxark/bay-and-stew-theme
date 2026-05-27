/**
 * Bay & Stew — Save for Later
 *
 * Allows customers to save cart items for later without requiring a server
 * sync. Storage is localStorage only (per device / browser).
 *
 * Saved items are separate from Favorites (different key, different tab).
 *
 * Storage format: array of objects:
 *   {
 *     variantId:     number,
 *     productHandle: string,
 *     title:         string,   // product title
 *     variantTitle:  string,   // variant name
 *     image:         string|null,
 *     url:           string,
 *     quantity:      number,
 *     price:         number,   // in cents
 *     compareAt:     number|null,
 *   }
 *
 * The Save button in the cart uses data attributes written by the Liquid
 * template so no additional fetch is required.
 */
(function () {
  'use strict';

  const STORAGE_PREFIX = 'bs:saved-later:';
  const GUEST_KEY = 'bs:saved-later:guest';

  // -----------------------------------------------------------------------
  // Storage helpers
  // -----------------------------------------------------------------------

  function getCustomerId() {
    const meta = document.querySelector('meta[name="bs-customer-id"]');
    const id = meta && meta.getAttribute('content');
    return id && id.trim() !== '' ? id.trim() : null;
  }

  function getStorageKey() {
    const id = getCustomerId();
    return id ? STORAGE_PREFIX + id : GUEST_KEY;
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

  function writeAll(list) {
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(list));
    } catch (e) {
      /* storage full / disabled */
    }
  }

  // -----------------------------------------------------------------------
  // CRUD operations
  // -----------------------------------------------------------------------

  /**
   * Save an item. If the same variantId already exists, merge by incrementing
   * the stored quantity rather than creating a duplicate row.
   */
  function save(item) {
    const list = readAll();
    const idx = list.findIndex((s) => s.variantId === item.variantId);
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
  // Cart helpers (shared with favorites.js pattern)
  // -----------------------------------------------------------------------

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
    return fetch('/?sections=' + sectionIds.join(','), {
      headers: { Accept: 'application/json' },
    }).then((r) => r.json());
  }

  function refreshCartUI() {
    const cartDrawer = document.querySelector('cart-drawer');
    if (cartDrawer && typeof cartDrawer.renderContents === 'function') {
      const sections = cartDrawer.getSectionsToRender().map((s) => s.id);
      return fetchCartSections(sections).then((sectionMap) => {
        cartDrawer.renderContents({ sections: sectionMap });
        if (cartDrawer.classList.contains('is-empty')) cartDrawer.classList.remove('is-empty');
        const inner = cartDrawer.querySelector('.drawer__inner');
        if (inner && inner.classList.contains('is-empty')) inner.classList.remove('is-empty');
      });
    }
    const cartNotification = document.querySelector('cart-notification');
    if (cartNotification && typeof cartNotification.renderContents === 'function') {
      const sections = cartNotification.getSectionsToRender().map((s) => s.id);
      return fetchCartSections(sections).then((sectionMap) => {
        cartNotification.renderContents({ sections: sectionMap });
      });
    }
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

  /**
   * Remove a line item from the cart by its unique key (line item key).
   */
  function removeFromCart(itemKey) {
    return fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id: itemKey, quantity: 0 }),
    }).then((r) => {
      if (!r.ok) return r.json().then((err) => Promise.reject(err));
      return r.json();
    });
  }

  // -----------------------------------------------------------------------
  // Toast notification
  // -----------------------------------------------------------------------

  let toastEl = null;
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
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-visible');
    }, 2800);
  }

  // -----------------------------------------------------------------------
  // Formatting helpers
  // -----------------------------------------------------------------------

  function formatMoney(cents) {
    const fmt = (window.Shopify && Shopify.formatMoney) || null;
    if (fmt && window.theme && window.theme.moneyFormat) {
      try { return fmt(cents, window.theme.moneyFormat); } catch (e) { /* fall through */ }
    }
    return '$' + (cents / 100).toFixed(2);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // -----------------------------------------------------------------------
  // Save for Later page rendering
  // -----------------------------------------------------------------------

  function buildSavedItemElement(item) {
    const li = document.createElement('li');
    li.className = 'bs-sfl-item';
    li.setAttribute('data-variant-id', item.variantId);

    const imgHtml = item.image
      ? '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.title) + '" loading="lazy">'
      : '<div class="bs-sfl-item__no-image"></div>';

    const isDefaultVariant = !item.variantTitle || item.variantTitle === 'Default Title';

    let priceHtml;
    if (item.compareAt && item.compareAt > item.price) {
      priceHtml =
        '<s class="bs-sfl-item__compare">' + formatMoney(item.compareAt) + '</s> ' +
        '<span class="bs-sfl-item__sale">' + formatMoney(item.price) + '</span>';
    } else if (item.price) {
      priceHtml = formatMoney(item.price);
    } else {
      priceHtml = '';
    }

    li.innerHTML =
      '<div class="bs-sfl-item__media">' +
        '<a href="' + escapeHtml(item.url) + '">' + imgHtml + '</a>' +
      '</div>' +
      '<div class="bs-sfl-item__body">' +
        '<button type="button" class="bs-sfl-item__remove" data-sfl-remove>' +
          'Remove' +
        '</button>' +
        '<h2 class="bs-sfl-item__title">' +
          '<a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>' +
        '</h2>' +
        (isDefaultVariant ? '' :
          '<p class="bs-sfl-item__variant">' + escapeHtml(item.variantTitle) + '</p>') +
        (priceHtml ? '<p class="bs-sfl-item__price">' + priceHtml + '</p>' : '') +
        '<p class="bs-sfl-item__qty">Quantity: ' + item.quantity + '</p>' +
        '<div class="bs-sfl-item__actions">' +
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
    status.hidden = !message;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-success', kind === 'success');
  }

  function attachItemHandlers(itemEl, container) {
    itemEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-sfl-remove]')) {
        const variantId = parseInt(itemEl.getAttribute('data-variant-id'), 10);
        remove(variantId);
        itemEl.remove();
        // If the list is now empty, re-render the empty state.
        if (readAll().length === 0) renderSavedForLaterTab(container);
        return;
      }

      const moveBtn = e.target.closest('[data-sfl-move]');
      if (moveBtn) {
        const variantId = parseInt(itemEl.getAttribute('data-variant-id'), 10);
        const items = readAll();
        const saved = items.find((s) => s.variantId === variantId);
        if (!saved) return;

        moveBtn.disabled = true;
        setStatus(itemEl, 'Moving to cart…', null);

        addItemsToCart([{ id: saved.variantId, quantity: saved.quantity }])
          .then(() => {
            remove(variantId);
            itemEl.remove();
            setStatus(itemEl, '', null);
            showToast('Item moved to cart.');
            refreshCartUI();
            if (readAll().length === 0) renderSavedForLaterTab(container);
          })
          .catch((err) => {
            setStatus(itemEl, (err && err.description) || 'Could not move to cart.', 'error');
            moveBtn.disabled = false;
          });
      }
    });
  }

  function renderSavedForLaterTab(container) {
    if (!container) container = document.querySelector('[data-bs-sfl-root]');
    if (!container) return;

    const items = readAll();
    if (items.length === 0) {
      container.innerHTML =
        '<div class="bs-favorites__empty"><p>No items saved for later.</p></div>';
      return;
    }

    container.innerHTML = '<ul class="bs-sfl-list"></ul>';
    const list = container.querySelector('.bs-sfl-list');
    items.forEach((item) => {
      const el = buildSavedItemElement(item);
      attachItemHandlers(el, container);
      list.appendChild(el);
    });
  }

  // -----------------------------------------------------------------------
  // Save button handler (wired to cart drawer + main cart buttons)
  // The Liquid template stamps data-* attributes on the Save button with all
  // the item info needed to populate the saved entry without a fetch.
  // -----------------------------------------------------------------------

  function handleSaveForLaterClick(e) {
    const btn = e.target.closest('[data-bs-sfl-save]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const itemKey    = btn.getAttribute('data-item-key');
    const variantId  = parseInt(btn.getAttribute('data-variant-id'), 10);
    const title      = btn.getAttribute('data-title') || '';
    const variantTitle = btn.getAttribute('data-variant-title') || '';
    const image      = btn.getAttribute('data-image') || null;
    const url        = btn.getAttribute('data-url') || '/';
    const quantity   = parseInt(btn.getAttribute('data-quantity'), 10) || 1;
    const price      = parseInt(btn.getAttribute('data-price'), 10) || 0;
    const compareAt  = parseInt(btn.getAttribute('data-compare-at'), 10) || null;
    const handle     = btn.getAttribute('data-product-handle') || '';

    if (!itemKey || !variantId) return;

    // Disable to prevent double-click.
    btn.disabled = true;

    removeFromCart(itemKey)
      .then(() => {
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
        return refreshCartUI();
      })
      .catch((err) => {
        // Cart removal failed — re-enable the button and surface error.
        btn.disabled = false;
        showToast((err && err.description) || 'Could not save item.');
      });
    // Note: btn.disabled stays true after success because the row is
    // removed from the cart by refreshCartUI() re-rendering it.
  }

  document.addEventListener('click', handleSaveForLaterClick);

  // -----------------------------------------------------------------------
  // Tab switching on the favorites/saved page
  // -----------------------------------------------------------------------

  function initTabs() {
    const tabsEl = document.querySelector('[data-bs-page-tabs]');
    if (!tabsEl) return;

    const tabBtns = tabsEl.querySelectorAll('[data-bs-tab]');
    const panels  = document.querySelectorAll('[data-bs-tab-panel]');

    function activateTab(tabName) {
      tabBtns.forEach((btn) => {
        const active = btn.getAttribute('data-bs-tab') === tabName;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      panels.forEach((panel) => {
        const active = panel.getAttribute('data-bs-tab-panel') === tabName;
        panel.hidden = !active;
        if (active && tabName === 'saved') {
          renderSavedForLaterTab(panel.querySelector('[data-bs-sfl-root]'));
        }
      });
    }

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bs-tab]');
      if (!btn) return;
      const name = btn.getAttribute('data-bs-tab');
      activateTab(name);
      history.replaceState(null, '', '#' + name);
    });

    // Honour URL hash on load.
    const hash = (location.hash || '').replace('#', '');
    const validTabs = Array.from(tabBtns).map((b) => b.getAttribute('data-bs-tab'));
    activateTab(validTabs.includes(hash) ? hash : (validTabs[0] || 'favorites'));
  }

  // -----------------------------------------------------------------------
  // Init
  // -----------------------------------------------------------------------

  function init() {
    initTabs();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  window.BSSavedForLater = {
    save: save,
    remove: remove,
    readAll: readAll,
    showToast: showToast,
    renderSavedForLaterTab: renderSavedForLaterTab,
  };
})();
