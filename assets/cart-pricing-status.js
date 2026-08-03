/*
 * Appends a small pricing-status line ("Retail pricing is active…" /
 * "Wholesale pricing is active…") inside the BLOY Loyalty Rewards widget
 * (".BLOY-cart__rewards"), which the BLOY app injects client-side into the
 * cart drawer and cart page.
 *
 * The status text itself is resolved server-side in Liquid (see
 * snippets/cart-pricing-status.liquid, reusing the theme's existing
 * wholesale/retail condition) and passed down via a data attribute on the
 * nearest stable ancestor (<cart-drawer> or #main-cart-items). This file
 * never reads or writes wholesale logic itself — it only relays the text.
 *
 * BLOY re-renders its widget on cart updates, so a MutationObserver keeps
 * re-attaching the line without modifying any BLOY-owned markup or classes.
 *
 * This file is <script src>'d from both cart-drawer.liquid and
 * main-cart-items.liquid, which can both be present on the same page (e.g.
 * the /cart page when cart_type is "drawer"). The guard below ensures the
 * logic below only ever initializes once per page load.
 */
(function () {
  if (window.__bsPricingStatusInit) return;
  window.__bsPricingStatusInit = true;

  var WIDGET_SELECTOR = '.BLOY-cart__rewards';
  var CONTENT_SELECTOR = '.BLOY-cart__points_content';
  var LINE_CLASS = 'bs-pricing-status';

  function statusTextFor(node) {
    var host = node.closest('[data-bs-pricing-status]');
    return host ? host.getAttribute('data-bs-pricing-status') : '';
  }

  /* Idempotent: safe to call repeatedly for the same widget without ever
     producing more than one .bs-pricing-status line, and re-creates the
     line if BLOY has replaced .BLOY-cart__points_content wholesale. */
  function ensureLine(widget) {
    var content = widget.querySelector(CONTENT_SELECTOR);
    if (!content || content.querySelector('.' + LINE_CLASS)) return;
    var text = statusTextFor(widget);
    if (!text) return;
    var line = document.createElement('div');
    line.className = LINE_CLASS;
    line.textContent = text;
    content.appendChild(line);
  }

  /* Scans the whole document (cheap: a handful of matches at most) so any
     BLOY widget instance is covered, independent of which observed root
     triggered the rescan (handles the drawer + full cart page coexisting). */
  function scan() {
    document.querySelectorAll(WIDGET_SELECTOR).forEach(ensureLine);
  }

  var scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(function () {
      scanQueued = false;
      scan();
    });
  }

  /* Only bother rescanning when a mutation actually touches the BLOY
     widget (or its content node), instead of on every unrelated cart
     mutation (quantity changes, totals, animations, etc.). Mirrors the
     "priceLike" filter pattern already used in cart-drawer.js. */
  function isRelevant(node) {
    return (
      node &&
      node.nodeType === 1 &&
      (node.matches(WIDGET_SELECTOR + ', ' + CONTENT_SELECTOR) ||
        node.querySelector(WIDGET_SELECTOR + ', ' + CONTENT_SELECTOR) ||
        (node.closest && node.closest(WIDGET_SELECTOR)))
    );
  }

  function handleMutations(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (isRelevant(m.target)) {
        scheduleScan();
        return;
      }
      for (var a = 0; a < m.addedNodes.length; a++) {
        if (isRelevant(m.addedNodes[a])) {
          scheduleScan();
          return;
        }
      }
      for (var r = 0; r < m.removedNodes.length; r++) {
        if (isRelevant(m.removedNodes[r])) {
          scheduleScan();
          return;
        }
      }
    }
  }

  var observer = new MutationObserver(handleMutations);
  function observeRoot(root) {
    if (!root || root.__bsPricingStatusObserved) return;
    root.__bsPricingStatusObserved = true;
    observer.observe(root, { childList: true, subtree: true });
  }

  function boot() {
    /* Both roots are observed independently so the drawer widget and the
       full cart page widget are each kept in sync, whichever (or both)
       are present on the page. */
    observeRoot(document.querySelector('cart-drawer'));
    observeRoot(document.getElementById('main-cart-items'));
    scan();
  }

  document.addEventListener('cart:refresh', scheduleScan);
  document.addEventListener('cart:updated', scheduleScan);
  document.addEventListener('shopify:section:load', scheduleScan);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
