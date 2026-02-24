class CartDrawer extends HTMLElement {
  constructor() {
    super();

    this.addEventListener('keyup', (evt) => evt.code === 'Escape' && this.close());
    this.querySelector('#CartDrawer-Overlay').addEventListener('click', this.close.bind(this));
    this.setHeaderCartIconAccessibility();
  }

  setHeaderCartIconAccessibility() {
    const cartLink = document.querySelector('#cart-icon-bubble');
    if (!cartLink) return;

    cartLink.setAttribute('role', 'button');
    cartLink.setAttribute('aria-haspopup', 'dialog');
    cartLink.addEventListener('click', (event) => {
      event.preventDefault();
      this.open(cartLink);
    });
    cartLink.addEventListener('keydown', (event) => {
      if (event.code.toUpperCase() === 'SPACE') {
        event.preventDefault();
        this.open(cartLink);
      }
    });
  }

  open(triggeredBy) {
    if (triggeredBy) this.setActiveElement(triggeredBy);
    const cartDrawerNote = this.querySelector('[id^="Details-"] summary');
    if (cartDrawerNote && !cartDrawerNote.hasAttribute('role')) this.setSummaryAccessibility(cartDrawerNote);
    // here the animation doesn't seem to always get triggered. A timeout seem to help
    setTimeout(() => {
      this.classList.add('animate', 'active');
    });

    this.addEventListener(
      'transitionend',
      () => {
        const containerToTrapFocusOn = this.classList.contains('is-empty')
          ? this.querySelector('.drawer__inner-empty')
          : document.getElementById('CartDrawer');
        const focusElement = this.querySelector('.drawer__inner') || this.querySelector('.drawer__close');
        trapFocus(containerToTrapFocusOn, focusElement);
      },
      { once: true }
    );

    document.body.classList.add('overflow-hidden');
    if (window.__runRewardsLast) window.__runRewardsLast();
  }

  close() {
    this.classList.remove('active');
    removeTrapFocus(this.activeElement);
    document.body.classList.remove('overflow-hidden');
  }

  setSummaryAccessibility(cartDrawerNote) {
    cartDrawerNote.setAttribute('role', 'button');
    cartDrawerNote.setAttribute('aria-expanded', 'false');

    if (cartDrawerNote.nextElementSibling.getAttribute('id')) {
      cartDrawerNote.setAttribute('aria-controls', cartDrawerNote.nextElementSibling.id);
    }

    cartDrawerNote.addEventListener('click', (event) => {
      event.currentTarget.setAttribute('aria-expanded', !event.currentTarget.closest('details').hasAttribute('open'));
    });

    cartDrawerNote.parentElement.addEventListener('keyup', onKeyUpEscape);
  }

  renderContents(parsedState) {
    this.querySelector('.drawer__inner').classList.contains('is-empty') &&
      this.querySelector('.drawer__inner').classList.remove('is-empty');
    this.productId = parsedState.id;
    this.getSectionsToRender().forEach((section) => {
      const sectionElement = section.selector
        ? document.querySelector(section.selector)
        : document.getElementById(section.id);

      if (!sectionElement) return;
      sectionElement.innerHTML = this.getSectionInnerHTML(parsedState.sections[section.id], section.selector);
    });

    if (window.__runRewardsLast) window.__runRewardsLast();

    setTimeout(() => {
      this.querySelector('#CartDrawer-Overlay').addEventListener('click', this.close.bind(this));
      this.open();
    });
  }

  getSectionInnerHTML(html, selector = '.shopify-section') {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector).innerHTML;
  }

  getSectionsToRender() {
    return [
      {
        id: 'cart-drawer',
        selector: '#CartDrawer',
      },
      {
        id: 'cart-icon-bubble',
      },
    ];
  }

  getSectionDOM(html, selector = '.shopify-section') {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector);
  }

  setActiveElement(element) {
    this.activeElement = element;
  }
}

customElements.define('cart-drawer', CartDrawer);

class CartDrawerItems extends CartItems {
  getSectionsToRender() {
    return [
      {
        id: 'CartDrawer',
        section: 'cart-drawer',
        selector: '.drawer__inner',
      },
      {
        id: 'cart-icon-bubble',
        section: 'cart-icon-bubble',
        selector: '.shopify-section',
      },
    ];
  }
}

customElements.define('cart-drawer-items', CartDrawerItems);

/* === Robust "run last" for BLOY (handles late async redraws) === */
(function () {
  // Fire a small burst of refreshes over ~3.3s so late scripts can't overtake us
  const BURST_SCHEDULE_MS = [0, 120, 500, 1500, 3200];

  function refreshBloy() {
    if (window.BLOY?.widgets?.refresh) { try { BLOY.widgets.refresh(); } catch(e){} }
    if (window.Bloy?.refresh)          { try { Bloy.refresh(); } catch(e){} }
    document.dispatchEvent(new Event('rewards:refreshed'));
  }

  function runBurst() {
    // clear any in-flight burst
    (runBurst._ids || []).forEach(id => clearTimeout(id));
    runBurst._ids = BURST_SCHEDULE_MS.map(ms =>
      setTimeout(() => {
        // double-rAF to be strictly post-layout & after sync mutations
        requestAnimationFrame(() => requestAnimationFrame(refreshBloy));
      }, ms)
    );
  }

  // Expose a global hook for theme code
  window.__runRewardsLast = runBurst;

  /* ---------- Triggers ---------- */

  // 1) Immediately when the drawer re-renders (Dawn replaces HTML)
  document.addEventListener('DOMContentLoaded', runBurst);
  document.addEventListener('cart:refresh', runBurst);
  document.addEventListener('cart:updated', runBurst);
  document.addEventListener('rewards:refreshed', () => {}); // no-op; keeps listeners consistent

  // 2) Observe the drawer DOM; retrigger if BSS touches price/tax nodes late
  const attachObservers = () => {
    const drawer = document.querySelector('cart-drawer');
    if (!drawer) return;
    const inner = drawer.querySelector('.drawer__inner');
    if (!inner) return;

    const priceLike = (node) =>
      node?.nodeType === 1 && (
        node.matches?.('[bss-b2b-*], [bss-b2b-cart-item-key], [bss-b2b-final-line-price], [bss-b2b-cart-total-price], .bss-b2b-qb-table') ||
        node.closest?.('[bss-b2b-*], .bss-b2b-qb-table')
      );

    const mo = new MutationObserver((mutList) => {
      // If anything that *looks like* BSS pricing DOM changes, run another burst
      for (const m of mutList) {
        if (priceLike(m.target)) { runBurst(); break; }
        if (m.addedNodes) for (const n of m.addedNodes) { if (priceLike(n)) { runBurst(); break; } }
        if (m.removedNodes) for (const n of m.removedNodes) { if (priceLike(n)) { runBurst(); break; } }
      }
    });

    mo.observe(inner, { childList: true, subtree: true, attributes: true, characterData: false });
  };
  document.addEventListener('DOMContentLoaded', attachObservers);
  document.addEventListener('shopify:section:load', attachObservers);

  // 3) Patch fetch & XHR: whenever /cart/*.js finishes, run a burst
  const scheduleIfCartUrl = (url) => /\/cart\/(add|change|update|clear)\.js/.test(url || '');
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await _fetch(input, init);
    try { const url = typeof input === 'string' ? input : input.url; if (scheduleIfCartUrl(url)) runBurst(); } catch {}
    return res;
  };
  const _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__isCart = scheduleIfCartUrl(String(u)); return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => { if (this.__isCart) runBurst(); });
    return _send.apply(this, arguments);
  };

  // 4) If BLOY fires its own pub/sub (from your console dump), respond too
  ['bloy:toggle-rewards-modal','bloy:show-popup-toast','bloy:substract-points']
    .forEach(evt => window.addEventListener(evt, runBurst));
})();
