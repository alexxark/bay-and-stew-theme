const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const cartWith = (items) => ({ items, item_count: items.reduce((total, item) => total + item.quantity, 0) });
const line = (variant, quantity, properties = {}) => ({
  id: variant, variant_id: variant, product_id: Math.floor(Number(variant) / 2), quantity, properties,
});

function priceHarness(fetch = async () => { throw new Error('Unexpected fetch'); }) {
  let implementation;
  const listeners = new Map();
  const errors = [];
  vm.runInNewContext(source('assets/price-per-item.js'), {
    HTMLElement: class {},
    customElements: { get() {}, define(name, component) { implementation = component; } },
    subscribe(event, listener) { listeners.set(event, listener); return () => {}; },
    PUB_SUB_EVENTS: { cartUpdate: 'cart', variantChange: 'variant' },
    window: { Shopify: { routes: { root: '/en/' } } },
    fetch,
    console: { error: (...args) => errors.push(args) },
  });
  const element = Object.create(implementation.prototype);
  element.variantId = '1000';
  element.cartRequestVersion = 0;
  element.updatePricePerItem = (quantity) => { element.actualQuantity = quantity; };
  element.connectedCallback();
  return { element, errors, update: listeners.get('cart') };
}

for (const customer of ['logged-out retail', 'logged-in retail', 'B2B']) {
  test(`variant tier quantities aggregate property-split lines for ${customer}`, async () => {
    const harness = priceHarness();
    for (const items of [
      [line(1000, 5)],
      [line(1000, 1, { text: 'one' }), line('1000', 4, { text: 'two' })],
      Array.from({ length: 5 }, (_, index) => line(1000, 1, { text: String(index) })),
    ]) {
      await harness.update({ cartData: cartWith([...items, line(1001, 99)]) });
      assert.equal(harness.element.actualQuantity, 5);
    }
    await harness.update({ cartData: cartWith([]) });
    assert.equal(harness.element.actualQuantity, 0);
  });
}

test('34-line regression: all 30 variants use their complete quantity', async () => {
  const items = Array.from({ length: 30 }, (_, index) => line(1000 + index, 1));
  items.push(...items.slice(0, 4).map((item) => ({ ...item, quantity: 4, properties: { engraving: 'test' } })));
  const harness = priceHarness();
  for (const item of items.slice(0, 30)) {
    harness.element.variantId = String(item.variant_id);
    await harness.update({ cartData: cartWith(items) });
    assert.equal(harness.element.actualQuantity, item.variant_id < 1004 ? 5 : 1, `variant ${item.variant_id}`);
  }
});

test('partial add response fetches the full cart instead of using the added line quantity', async () => {
  const harness = priceHarness(async (url) => {
    assert.equal(url, '/en/cart.js');
    return { ok: true, json: async () => cartWith([line(1000, 1), line(1000, 4)]) };
  });
  await harness.update({ cartData: line(1000, 1) });
  assert.equal(harness.element.actualQuantity, 5);
});

test('late full-cart reads cannot overwrite a newer quantity', async () => {
  let resolve;
  const harness = priceHarness(() => new Promise((done) => { resolve = done; }));
  const pending = harness.update({ cartData: line(1000, 1) });
  await harness.update({ cartData: cartWith([line(1000, 2)]) });
  resolve({ ok: true, json: async () => cartWith([line(1000, 5)]) });
  await pending;
  assert.equal(harness.element.actualQuantity, 2);
});

test('failed cart reads preserve the previous quantity display', async () => {
  const harness = priceHarness(async () => ({ ok: false, status: 503 }));
  harness.element.actualQuantity = 4;
  await harness.update({ cartData: line(1000, 1) });
  assert.equal(harness.element.actualQuantity, 4);
  assert.equal(harness.errors.length, 1);
});

function restoreHarness(responses = [], customerId = 'retail', storage = new Map()) {
  const requests = [];
  const events = [];
  const errors = [];
  const document = {
    readyState: 'loading',
    addEventListener() {},
    dispatchEvent(event) { events.push(event.type); },
    querySelector(selector) {
      const value = selector.includes('bs-customer-id') ? customerId : selector.includes('bs-cart-endpoint') ? '/apps/growth/cart' : null;
      return value ? { getAttribute: () => value } : null;
    },
  };
  const context = {
    document, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type) { this.type = type; } },
    XMLHttpRequest: class { open() {} send() {} },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert(response, `Unexpected request: ${url}`);
      return response;
    },
    addEventListener() {},
    Shopify: { routes: { root: '/' } },
  };
  context.window = context;
  vm.runInNewContext(source('assets/persistent-cart.js').replace('  function init() {', '  window.testRestore = restoreSnapshot;\n  function init() {'), context);
  return { restore: context.testRestore, requests, events, errors, storage };
}

const jsonResponse = (data) => ({ ok: true, json: async () => data });
const snapshot = (extra = {}) => ({ updated_at: 2, source_token: 'other', items: [line(1000, 5, { engraving: 'test' })], ...extra });

for (const customer of ['retail', 'B2B']) {
  test(`restore preserves nonempty ${customer} carts without any request`, async () => {
    const harness = restoreHarness([], customer);
    await harness.restore(snapshot(), cartWith([line(9999, 2)]));
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.storage.size, 0);
  });
  test(`validated empty ${customer} cart restores without clearing`, async () => {
    const harness = restoreHarness([jsonResponse(cartWith([])), jsonResponse({}), jsonResponse(cartWith(snapshot().items))], customer);
    await harness.restore(snapshot(), cartWith([]));
    assert.deepEqual(harness.requests.map((request) => request.url), ['/cart.js', '/cart/add.js', '/cart.js']);
    assert.equal(harness.storage.get(`bs:cart-snapshot:last-applied:${customer}`), '2');
    assert.equal(harness.errors.length, 0);
  });
}

test('logged-out customers never restore customer snapshots', async () => {
  const harness = restoreHarness([], null);
  await harness.restore(snapshot(), cartWith([]));
  assert.equal(harness.requests.length, 0);
});

for (const failure of [{ ok: false, status: 422 }, new Error('Network disconnected')]) {
  test(`failed cart/add preserves state and never acknowledges restoration: ${failure.status || failure.message}`, async () => {
    const storage = new Map();
    const harness = restoreHarness([jsonResponse(cartWith([])), failure], 'retail', storage);
    await harness.restore(snapshot(), cartWith([]));
    assert.equal(storage.has('bs:cart-snapshot:last-applied:retail'), false);
    assert.equal(harness.events.includes('cart:restore-error'), true);
    assert.equal(harness.requests.some((request) => request.url.includes('/clear')), false);
    const reloaded = restoreHarness([], 'retail', storage);
    await reloaded.restore(snapshot(), cartWith([]));
    assert.equal(reloaded.requests.length, 0, 'uncertain attempts must not be repeated automatically');
  });
}

test('incomplete add success is not acknowledged or cleared', async () => {
  const harness = restoreHarness([jsonResponse(cartWith([])), jsonResponse({}), jsonResponse(cartWith([line(1000, 1)]))]);
  await harness.restore(snapshot(), cartWith([]));
  assert.equal(harness.storage.has('bs:cart-snapshot:last-applied:retail'), false);
  assert.equal(harness.errors.length, 1);
});

test('failed metadata update does not acknowledge restoration or undo restored items', async () => {
  const harness = restoreHarness([jsonResponse(cartWith([])), jsonResponse({}), jsonResponse(cartWith(snapshot().items)), { ok: false, status: 500 }]);
  await harness.restore(snapshot({ note: 'saved note' }), cartWith([]));
  assert.equal(harness.storage.has('bs:cart-snapshot:last-applied:retail'), false);
  assert.equal(harness.requests.at(-1).url, '/cart/update.js');
});

test('cart filled during restoration preflight is preserved', async () => {
  const harness = restoreHarness([jsonResponse(cartWith([line(9999, 2)]))]);
  await harness.restore(snapshot(), cartWith([]));
  assert.deepEqual(harness.requests.map((request) => request.url), ['/cart.js']);
});

test('invalid, empty or unknown-state restoration performs no mutations', async () => {
  const harness = restoreHarness();
  await harness.restore(snapshot({ items: [line(1000, -1)] }), cartWith([]));
  await harness.restore(snapshot({ items: [] }), cartWith([]));
  await harness.restore(snapshot(), null);
  assert.equal(harness.requests.length, 0);
});

function favoritesHarness(customer = 'B2B') {
  const dom = new JSDOM(`<meta name="bs-customer-id" content="${customer}">`, { url: 'https://example.test/en/pages/favorites', runScripts: 'outside-only' });
  const window = dom.window;
  window.Shopify = { routes: { root: '/en/' } };
  window.console.warn = () => {};
  window.fetch = async () => { throw new Error('Unexpected fetch'); };
  window.eval(source('assets/favorites.js').replace('  // ---------- Public API ----------', '  window.testFavorites = { buildPriceHtml, loadProductInventory, getVariantInventory };\n  // ---------- Public API ----------'));
  return { dom, window, api: window.testFavorites };
}

for (const customer of ['', 'retail', 'B2B']) {
  test(`favorites never substitute public prices for a missing quote (${customer || 'guest'})`, () => {
    const harness = favoritesHarness(customer);
    const output = harness.api.buildPriceHtml({ id: 1000, price: 700, compare_at_price: 1000 }, 'missing-product');
    assert(output.includes('data-price-state="unavailable"'));
    assert(!output.includes('$7') && !output.includes('$10'));
    harness.dom.window.close();
  });
}

test('favorites inventory has no 20-product bootstrap boundary and follows variant pagination', async () => {
  const harness = favoritesHarness();
  const requests = [];
  harness.window.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const handle = parsed.pathname.split('/').at(-1);
    const second = parsed.searchParams.has('page');
    return { ok: true, text: async () => `<script data-bs-favorites-product>${JSON.stringify({
      handle, variants: { [second ? '1001' : '1000']: { tracked: true, qty: second ? 6 : 5 } },
      next_url: second ? null : `?page=2`,
    })}</script>` };
  };
  for (let index = 0; index < 34; index++) {
    const handle = `product-${index}`;
    await harness.api.loadProductInventory(handle);
    assert.equal(harness.api.getVariantInventory(handle, 1000).qty, 5);
    assert.equal(harness.api.getVariantInventory(handle, 1001).qty, 6);
  }
  assert.equal(requests.length, 68);
  assert(requests.every((url) => url.searchParams.get('section_id') === 'favorites-product-data'));
  assert(!source('sections/main-favorites.liquid').includes('all_products'));
  assert(!source('sections/favorites-product-data.liquid').includes('all_products'));
  harness.dom.window.close();
});

test('incomplete inventory response discards partial data and does not change price state', async () => {
  const harness = favoritesHarness();
  harness.window.fetch = async () => ({ ok: false, status: 429 });
  await harness.api.loadProductInventory('missing-product');
  assert.equal(harness.api.getVariantInventory('missing-product', 1000), null);
  assert(harness.api.buildPriceHtml().includes('data-price-state="unavailable"'));
  harness.dom.window.close();
});

function cartUIHarness(options = {}) {
  const { bssFailOpenMs, retailFailOpenMs, b2bSafeFallbackMs, debugCollect } = options;
  const dom = new JSDOM(`
    <cart-drawer><div id="CartDrawer"><div class="drawer__inner">old drawer</div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div></cart-drawer>
    <div id="cart-icon-bubble">old count</div>
    <cart-items><div id="main-cart-items" data-id="main-cart-items"><div class="js-contents">old lines</div></div></cart-items>
    <div id="main-cart-footer" data-id="main-cart-footer"><div class="js-contents"><span class="totals__total-value">old total</span></div></div>
    <div id="cart-live-region-text" data-estimated-total-label="New estimated total">old accessible total</div>
    <cart-rewards data-rewards-price-state="ready"><p data-rewards-message>Spend $0.00 more</p></cart-rewards>
    <div id="cart-errors"></div>
  `, { url: 'https://example.test/en/cart', runScripts: 'outside-only' });
  const window = dom.window;
  window.Shopify = { routes: { root: '/en/' } };
  const published = [];
  window.PUB_SUB_EVENTS = { cartUpdate: 'cart' };
  window.publish = (event, data) => published.push(data);
  window.console.error = () => {};
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);
  const requests = [];
  let handler;
  window.fetch = (url, options) => { requests.push({ url, options }); return handler(url, options); };
  if (Number.isFinite(bssFailOpenMs)) window.__BSPriceFailOpenMs = bssFailOpenMs;
  if (Number.isFinite(retailFailOpenMs)) window.__BSPriceRetailFailOpenMs = retailFailOpenMs;
  if (Number.isFinite(b2bSafeFallbackMs)) window.__BSPriceB2BSafeFallbackMs = b2bSafeFallbackMs;
  if (debugCollect) window.__BSPriceDebugCollect = true;
  window.eval(source('assets/price-state.js'));
  window.eval(source('assets/cart-checkout-guard.js'));
  return { dom, window, requests, published, warnings, setHandler: (next) => { handler = next; } };
}

function cartSections(value) {
  return {
    'cart-drawer': `<div id="CartDrawer"><div class="drawer__inner"><span bss-b2b-final-line-price>${value}</span></div></div>`,
    'cart-icon-bubble': `<div class="shopify-section">${value}</div>`,
    'main-cart-items': `<div class="js-contents"><span bss-b2b-final-line-price>${value}</span></div>`,
    'main-cart-footer': `<div class="js-contents"><span class="totals__total-value">${value}</span></div>`,
    'cart-live-region-text': `<div class="shopify-section">${value}</div>`,
  };
}

function b2bCandidateSections(value) {
  return {
    ...cartSections(value),
    'cart-drawer': `<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value" data-bss-payable-candidate="true">${value}</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total" data-bss-payable-candidate="true"></p></div>`,
    'main-cart-footer': `<div class="js-contents"><p class="totals__total-value" data-bss-payable-candidate="true">${value}</p></div>`,
    'cart-live-region-text': `<div class="shopify-section">New estimated total: ${value}</div>`,
  };
}

test('shared cart refresh replaces drawer, full cart, footer and accessible totals without recalculating money', async () => {
  const harness = cartUIHarness();
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5)]) : cartSections('$3.00 supplied by server')));
  await Promise.all([harness.window.BSCartUI.refresh(), harness.window.BSCartUI.refresh()]);
  assert.equal(harness.requests.length, 2, 'concurrent refresh requests must coalesce');
  for (const selector of ['#CartDrawer', '#main-cart-items', '#main-cart-footer', '#cart-live-region-text']) {
    assert(harness.window.document.querySelector(selector).textContent.includes('$3.00 supplied by server'));
  }
  assert.equal(harness.published.length, 1);
  assert.equal(harness.published[0].sectionsRendered, true);
  const total = harness.window.document.querySelector('.totals__total-value');
  total.textContent = 'BSS adjusted amount';
  await Promise.resolve();
  assert.equal(total.textContent, 'BSS adjusted amount', 'theme must not overwrite externally adjusted prices');
  harness.dom.window.close();
});

test('BSS payable subtotal replaces native estimated totals and emits payable-total updates', async () => {
  const harness = cartUIHarness();
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2147, item_count: 5, items: [line(1000, 5)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };
  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 native'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 native</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 native</p></div>',
    }));
  await harness.window.BSCartUI.refresh();
  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['BSS $21.47', 'BSS $21.47']);
  assert.equal(harness.window.document.querySelector('#cart-live-region-text').textContent, 'New estimated total: BSS $21.47');
  assert.equal(harness.window.document.querySelector('#CartDrawer-LiveRegionText').textContent, 'New estimated total: BSS $21.47');
  assert.equal(payableEvents.length, 1);
  assert.equal(payableEvents[0].cents, 2147);
  harness.dom.window.close();
});

test('retail fallback keeps Shopify subtotal and live region text when BSS payable is unavailable', async () => {
  const harness = cartUIHarness();
  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 USD</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $44.84 USD</div>',
    }));
  await harness.window.BSCartUI.refresh();
  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['$44.84 USD', '$44.84 USD']);
  assert.equal(harness.window.document.querySelector('#cart-live-region-text').textContent, 'New estimated total: $44.84 USD');
  assert.equal(payableEvents.length, 0);
  harness.dom.window.close();
});

test('B2B unresolved payable timeout falls back to nonnumeric checkout text', async () => {
  const harness = cartUIHarness({ bssFailOpenMs: 20, retailFailOpenMs: 20, b2bSafeFallbackMs: 20 });
  const failOpenEvents = [];
  harness.window.document.addEventListener('cart:payable-fail-open', (event) => failOpenEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value" data-bss-payable-candidate="true">$44.84 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total" data-bss-payable-candidate="true"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value" data-bss-payable-candidate="true">$44.84 USD</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $44.84 USD</div>',
    }));

  await harness.window.BSCartUI.refresh();
  assert(Array.from(harness.window.document.querySelectorAll('.totals__total-value')).every((node) => node.dataset.priceState === 'pending'));
  await new Promise((resolve) => harness.window.setTimeout(resolve, 50));

  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['Calculated at checkout', 'Calculated at checkout']);
  assert(Array.from(harness.window.document.querySelectorAll('.totals__total-value')).every((node) => node.dataset.priceState === 'ready'));
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'fallback');
  assert.equal(harness.window.document.querySelector('cart-rewards').dataset.rewardsPriceState, 'fallback');
  assert.equal(harness.window.document.querySelector('[data-rewards-message]').textContent, 'Calculated at checkout');
  assert.equal(failOpenEvents.length, 1);
  assert.equal(failOpenEvents[0].mode, 'bss');
  harness.dom.window.close();
});

test('replacement subtotal insertion inherits pending lock from root before node-level pending is reapplied', async () => {
  const harness = cartUIHarness();
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2512, item_count: 1, items: [line(1000, 1)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  const footerContainer = harness.window.document.querySelector('#main-cart-footer .js-contents');
  const descriptor = Object.getOwnPropertyDescriptor(harness.window.Element.prototype, 'innerHTML');
  const insertionProbe = { rootStateAtInsert: '', insertedHtml: '' };
  Object.defineProperty(footerContainer, 'innerHTML', {
    configurable: true,
    get() {
      return descriptor.get.call(this);
    },
    set(value) {
      insertionProbe.rootStateAtInsert = harness.window.document.documentElement.dataset.cartPricingState || '';
      insertionProbe.insertedHtml = value;
      descriptor.set.call(this, value);
    },
  });

  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$60.20 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total" data-bss-payable-candidate="true"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $60.20 USD</div>',
    }));

  await harness.window.BSCartUI.refresh();

  assert.equal(insertionProbe.rootStateAtInsert, 'pending');
  assert(insertionProbe.insertedHtml.includes('$60.20 USD'));
  assert.equal(insertionProbe.insertedHtml.includes('data-price-state="pending"'), false);
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert(Array.from(harness.window.document.querySelectorAll('.totals__total-value')).every((node) => node.dataset.priceState === 'pending'));
  harness.dom.window.close();
});

test('6020 seed remains pending through section replacement until matching 2512 BSS snapshot is accepted', async () => {
  const harness = cartUIHarness();
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2512, item_count: 1, items: [line(1000, 1)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  const payableEvents = [];
  const revealStates = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => {
    payableEvents.push(event.detail);
    const rewardsMessage = harness.window.document.querySelector('[data-rewards-message]');
    rewardsMessage.textContent = `Spend $${(event.detail.cents / 100).toFixed(2)} more`;
    revealStates.push(harness.window.document.documentElement.dataset.cartPricingState || '');
  });

  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$60.20 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total" data-bss-payable-candidate="true"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $60.20 USD</div>',
    }));

  await harness.window.BSCartUI.refresh();

  const staleTotals = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert.deepEqual(staleTotals.map((node) => node.textContent), ['$60.20 USD', '$60.20 USD']);
  assert(staleTotals.every((node) => node.dataset.priceState === 'pending'));
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.equal(harness.window.document.querySelector('cart-rewards').dataset.rewardsPriceState, 'pending');

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 2512, item_count: 5, items: [line(1000, 5)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  const readyTotals = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert.deepEqual(readyTotals.map((node) => node.textContent), ['BSS $25.12 USD', 'BSS $25.12 USD']);
  assert(readyTotals.every((node) => node.dataset.priceState === 'ready'));
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  assert.equal(harness.window.document.querySelector('cart-rewards').dataset.rewardsPriceState, 'ready');
  assert.equal(harness.window.document.querySelector('[data-rewards-message]').textContent, 'Spend $25.12 more');
  assert.deepEqual(revealStates, ['pending']);
  assert.deepEqual(payableEvents.map((detail) => detail.cents), [2512]);
  assert.equal(readyTotals.some((node) => node.textContent.includes('$60.20') && node.dataset.priceState === 'ready'), false);

  harness.dom.window.close();
});

test('slow B2B updates stay pending and avoid numeric fail-open until payable snapshot matches', async () => {
  const harness = cartUIHarness({ bssFailOpenMs: 20, b2bSafeFallbackMs: 120 });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2512, item_count: 1, items: [line(1000, 1)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  const failOpenEvents = [];
  harness.window.document.addEventListener('cart:payable-fail-open', (event) => failOpenEvents.push(event.detail));

  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$60.20 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total" data-bss-payable-candidate="true"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value" data-bss-payable-candidate="true">$60.20 USD</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $60.20 USD</div>',
    }));

  await harness.window.BSCartUI.refresh();
  await new Promise((resolve) => harness.window.setTimeout(resolve, 35));

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.deepEqual(Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent), ['$60.20 USD', '$60.20 USD']);
  assert.equal(failOpenEvents.length, 0);

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 2512, item_count: 5, items: [line(1000, 5)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['BSS $25.12 USD', 'BSS $25.12 USD']);
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  assert.equal(failOpenEvents.length, 0);

  harness.dom.window.close();
});

test('old BSS signal cannot transition a newer in-flight generation to ready', async () => {
  const harness = cartUIHarness({ debugCollect: true });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 10160, item_count: 10, items: [line(1000, 10)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  let phase = 'initial';
  let releaseMutationCart;
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    if (url.includes('cart.js')) {
      if (phase === 'initial') return jsonResponse({ ...cartWith([line(1000, 10)]), currency: 'USD' });
      if (phase === 'mutation') {
        return new Promise((resolve) => {
          releaseMutationCart = () => resolve(jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' }));
        });
      }
      return jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' });
    }
    return jsonResponse(phase === 'initial' ? b2bCandidateSections('$101.60 USD') : b2bCandidateSections('$111.76 USD'));
  });

  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');

  phase = 'mutation';
  await harness.window.fetch('/en/cart/change.js', { method: 'POST' });
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));
  await Promise.resolve();

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  const earlyRejections = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'ready-attempt-rejected' && entry.reason === 'awaiting-shopify-snapshot'
  );
  assert(earlyRejections.length >= 1);

  releaseMutationCart();
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 11234, item_count: 11, items: [line(1000, 11)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['BSS $112.34 USD', 'BSS $112.34 USD']);
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');

  const generationStarts = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'generation:start' && entry.reason === 'cart-fetch-mutation'
  );
  const mutationGeneration = generationStarts.at(-1).generation;
  const finishZeroIndex = harness.window.__bsPricingTrace.findIndex((entry) =>
    entry.eventName === 'mutation:finish'
    && entry.reason === 'cart-fetch-mutation-complete'
    && entry.pendingMutations === 0
    && entry.generation === mutationGeneration
  );
  const snapshotIndex = harness.window.__bsPricingTrace.findIndex((entry) =>
    entry.eventName === 'generation:snapshot' && entry.generation === mutationGeneration
  );
  assert(finishZeroIndex !== -1);
  assert(snapshotIndex !== -1);
  assert(finishZeroIndex < snapshotIndex);

  const stateSequence = harness.window.__bsPricingTrace
    .filter((entry) => entry.eventName === 'state:root' && entry.generation === mutationGeneration)
    .map((entry) => entry.nextState);
  const readyPositions = stateSequence
    .map((state, index) => ({ state, index }))
    .filter((row) => row.state === 'ready')
    .map((row) => row.index);
  assert.equal(readyPositions.length, 1);
  assert.equal(readyPositions[0], stateSequence.length - 1);

  harness.dom.window.close();
});

test('module-loaded signal before snapshot bind cannot close the active generation', async () => {
  const harness = cartUIHarness({ debugCollect: true });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 10160, item_count: 10, items: [line(1000, 10)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));

  let phase = 'initial';
  let releaseMutationCart;
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    if (url.includes('cart.js')) {
      if (phase === 'initial') return jsonResponse({ ...cartWith([line(1000, 10)]), currency: 'USD' });
      if (phase === 'mutation') {
        return new Promise((resolve) => {
          releaseMutationCart = () => resolve(jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' }));
        });
      }
      return jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' });
    }
    return jsonResponse(phase === 'initial' ? b2bCandidateSections('$101.60 USD') : b2bCandidateSections('$111.76 USD'));
  });

  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  payableEvents.length = 0;

  phase = 'mutation';
  await harness.window.fetch('/en/cart/change.js', { method: 'POST' });
  await Promise.resolve();
  await Promise.resolve();

  const mutationGenerationStart = harness.window.__bsPricingTrace
    .filter((entry) => entry.eventName === 'generation:start' && entry.reason === 'cart-fetch-mutation')
    .at(-1);
  assert(mutationGenerationStart);
  const mutationGeneration = mutationGenerationStart.generation;

  harness.window.dispatchEvent(new harness.window.Event('bss_b2b:module:loaded'));
  await Promise.resolve();

  assert.equal(typeof releaseMutationCart, 'function');
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.equal(payableEvents.length, 0);

  const moduleLoadedRejections = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'ready-attempt-rejected'
    && entry.eventSource === 'bss_b2b:module:loaded'
    && entry.generation === mutationGeneration
  );
  assert(moduleLoadedRejections.length >= 1);
  assert(moduleLoadedRejections.some((entry) => entry.reason === 'awaiting-shopify-snapshot'));

  const preBindReadyEvents = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'state:ready' && entry.generation === mutationGeneration
  );
  assert.equal(preBindReadyEvents.length, 0);
  assert.equal(harness.window.__bsPricingTrace.some((entry) =>
    entry.eventName === 'generation:clear' && entry.generation === mutationGeneration
  ), false);

  releaseMutationCart();
  await harness.window.BSCartUI.refresh();

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.equal(payableEvents.length, 0);

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 11234, item_count: 11, items: [line(1000, 11)] };
  harness.window.dispatchEvent(new harness.window.Event('bss_b2b:module:loaded'));

  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['BSS $112.34 USD', 'BSS $112.34 USD']);
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  assert.equal(payableEvents.length, 1);
  assert.equal(payableEvents[0].cents, 11234);

  const stateRoots = harness.window.__bsPricingTrace.filter((entry) => entry.eventName === 'state:root');
  const mutationStartTraceIndex = harness.window.__bsPricingTrace.findIndex((entry) =>
    entry.eventName === 'generation:start' && entry.generation === mutationGeneration
  );
  assert(mutationStartTraceIndex >= 0);
  assert(stateRoots.some((entry) => entry.nextState === 'ready' && entry.generation < mutationGeneration));

  const postMutationReadyRoots = harness.window.__bsPricingTrace.filter((entry, index) =>
    index >= mutationStartTraceIndex
    && entry.eventName === 'state:root'
    && entry.nextState === 'ready'
  );
  assert.equal(postMutationReadyRoots.length, 1);
  assert.equal(postMutationReadyRoots[0].generation, mutationGeneration);

  const mutationGenerationStates = stateRoots
    .filter((entry) => entry.generation === mutationGeneration)
    .map((entry) => entry.nextState);
  const mutationReadyIndexes = mutationGenerationStates
    .map((state, index) => ({ state, index }))
    .filter((entry) => entry.state === 'ready')
    .map((entry) => entry.index);
  assert(mutationGenerationStates.includes('pending'));
  assert.equal(mutationReadyIndexes.length, 1);
  assert.equal(mutationReadyIndexes[0], mutationGenerationStates.length - 1);

  harness.dom.window.close();
});

test('attribute mutation signal before snapshot bind cannot close the active generation', async () => {
  const harness = cartUIHarness({ debugCollect: true });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 10160, item_count: 10, items: [line(1000, 10)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));

  let phase = 'initial';
  let releaseMutationCart;
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    if (url.includes('cart.js')) {
      if (phase === 'initial') return jsonResponse({ ...cartWith([line(1000, 10)]), currency: 'USD' });
      if (phase === 'mutation') {
        return new Promise((resolve) => {
          releaseMutationCart = () => resolve(jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' }));
        });
      }
      return jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' });
    }
    return jsonResponse(phase === 'initial' ? b2bCandidateSections('$101.60 USD') : b2bCandidateSections('$111.76 USD'));
  });

  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  payableEvents.length = 0;

  phase = 'mutation';
  await harness.window.fetch('/en/cart/change.js', { method: 'POST' });
  await Promise.resolve();
  await Promise.resolve();

  const mutationGenerationStart = harness.window.__bsPricingTrace
    .filter((entry) => entry.eventName === 'generation:start' && entry.reason === 'cart-fetch-mutation')
    .at(-1);
  assert(mutationGenerationStart);
  const mutationGeneration = mutationGenerationStart.generation;

  harness.window.document.documentElement.setAttribute('bss-b2b-cart-price-active', 'seed-1');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(typeof releaseMutationCart, 'function');
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.equal(payableEvents.length, 0);

  const attributeRejections = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'ready-attempt-rejected'
    && entry.eventSource === 'bss-b2b-cart-price-active'
    && entry.generation === mutationGeneration
  );
  assert(attributeRejections.length >= 1);
  assert(attributeRejections.some((entry) => entry.reason === 'awaiting-shopify-snapshot'));

  const preBindReadyEvents = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'state:ready' && entry.generation === mutationGeneration
  );
  assert.equal(preBindReadyEvents.length, 0);
  assert.equal(harness.window.__bsPricingTrace.some((entry) =>
    entry.eventName === 'generation:clear' && entry.generation === mutationGeneration
  ), false);

  releaseMutationCart();
  await harness.window.BSCartUI.refresh();

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');
  assert.equal(payableEvents.length, 0);

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 11234, item_count: 11, items: [line(1000, 11)] };
  harness.window.document.documentElement.setAttribute('bss-b2b-cart-price-active', 'seed-2');
  await Promise.resolve();
  await Promise.resolve();

  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['BSS $112.34 USD', 'BSS $112.34 USD']);
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');
  assert.equal(payableEvents.length, 1);
  assert.equal(payableEvents[0].cents, 11234);

  const stateRoots = harness.window.__bsPricingTrace.filter((entry) => entry.eventName === 'state:root');
  const mutationStartTraceIndex = harness.window.__bsPricingTrace.findIndex((entry) =>
    entry.eventName === 'generation:start' && entry.generation === mutationGeneration
  );
  assert(mutationStartTraceIndex >= 0);
  assert(stateRoots.some((entry) => entry.nextState === 'ready' && entry.generation < mutationGeneration));

  const postMutationReadyRoots = harness.window.__bsPricingTrace.filter((entry, index) =>
    index >= mutationStartTraceIndex
    && entry.eventName === 'state:root'
    && entry.nextState === 'ready'
  );
  assert.equal(postMutationReadyRoots.length, 1);
  assert.equal(postMutationReadyRoots[0].generation, mutationGeneration);

  const mutationGenerationStates = stateRoots
    .filter((entry) => entry.generation === mutationGeneration)
    .map((entry) => entry.nextState);
  const mutationReadyIndexes = mutationGenerationStates
    .map((state, index) => ({ state, index }))
    .filter((entry) => entry.state === 'ready')
    .map((entry) => entry.index);
  assert(mutationGenerationStates.includes('pending'));
  assert.equal(mutationReadyIndexes.length, 1);
  assert.equal(mutationReadyIndexes[0], mutationGenerationStates.length - 1);

  harness.dom.window.close();
});

test('internal batched follow-up cart mutations stay in the same generation without intermediate ready', async () => {
  const harness = cartUIHarness({ debugCollect: true });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 10160, item_count: 10, items: [line(1000, 10)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  let phase = 'initial';
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    if (url.includes('cart.js')) {
      if (phase === 'initial') return jsonResponse({ ...cartWith([line(1000, 10)]), currency: 'USD' });
      return jsonResponse({ ...cartWith([line(1000, 11)]), currency: 'USD' });
    }
    return jsonResponse(phase === 'initial' ? b2bCandidateSections('$101.60 USD') : b2bCandidateSections('$111.76 USD'));
  });

  await harness.window.BSCartUI.refresh();
  phase = 'mutation';

  await harness.window.fetch('/en/cart/change.js', { method: 'POST' });
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');

  const finishBatch = harness.window.BSCartUI.beginBatch();
  await harness.window.fetch('/en/cart/update.js', { method: 'POST' });
  finishBatch();
  await harness.window.BSCartUI.refresh();

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 11234, item_count: 11, items: [line(1000, 11)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');

  const mutationStarts = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'generation:start' && entry.reason === 'cart-fetch-mutation'
  );
  assert.equal(mutationStarts.length, 1);

  const mutationGeneration = mutationStarts[0].generation;
  const generationReadies = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'state:ready' && entry.generation === mutationGeneration
  );
  assert.equal(generationReadies.length, 1);

  harness.dom.window.close();
});

test('rapid quantity updates supersede older generations and only latest generation can become ready', async () => {
  const harness = cartUIHarness({ debugCollect: true });
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 10160, item_count: 10, items: [line(1000, 10)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };

  let latestQty = 10;
  let phase = 'initial';
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') {
      latestQty += 1;
      return jsonResponse({});
    }

    if (url.includes('cart.js')) {
      return jsonResponse({ ...cartWith([line(1000, latestQty)]), currency: 'USD' });
    }

    const value = `$${(latestQty * 10.16).toFixed(2)} USD`;
    return jsonResponse(phase === 'initial' ? b2bCandidateSections('$101.60 USD') : b2bCandidateSections(value));
  });

  await harness.window.BSCartUI.refresh();
  phase = 'mutation';

  await Promise.all([
    harness.window.fetch('/en/cart/change.js', { method: 'POST' }),
    harness.window.fetch('/en/cart/change.js', { method: 'POST' }),
    harness.window.fetch('/en/cart/change.js', { method: 'POST' }),
  ]);

  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'pending');

  harness.window.BSS_B2B.shopData.cart = {
    bss_b2b_total_price: 13108,
    item_count: latestQty,
    items: [line(1000, latestQty)],
  };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  assert.equal(harness.window.document.documentElement.dataset.cartPricingState, 'ready');

  const starts = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'generation:start' && entry.reason === 'cart-fetch-mutation'
  );
  assert(starts.length >= 3);
  const latestGeneration = Math.max(...starts.map((entry) => entry.generation));

  const readyEvents = harness.window.__bsPricingTrace.filter((entry) =>
    entry.eventName === 'state:ready' && starts.some((start) => start.generation === entry.generation)
  );
  assert.equal(readyEvents.length, 1);
  assert.equal(readyEvents[0].generation, latestGeneration);

  harness.dom.window.close();
});

test('BSS payable zero is treated as valid and synchronizes visible totals and live region', async () => {
  const harness = cartUIHarness();
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 0, item_count: 5, items: [line(1000, 5)] } },
    formatMoney: () => '$0.00',
  };
  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 USD</p></div>',
    }));
  await harness.window.BSCartUI.refresh();
  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['$0.00 USD', '$0.00 USD']);
  assert(Array.from(harness.window.document.querySelectorAll('.totals__total-value')).every((node) => node.dataset.priceState === 'ready'));
  assert.equal(harness.window.document.querySelector('#cart-live-region-text').textContent, 'New estimated total: $0.00 USD');
  assert.equal(payableEvents.length, 1);
  assert.equal(payableEvents[0].cents, 0);
  harness.dom.window.close();
});

test('stale BSS payable subtotal is ignored until BSS cart snapshot matches current cart', async () => {
  const harness = cartUIHarness();
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2147, item_count: 9, items: [line(1000, 9)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };
  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 native'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 native</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 native</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $44.84 native</div>',
    }));

  await harness.window.BSCartUI.refresh();
  const totalsAfterRefresh = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totalsAfterRefresh, ['$44.84 native', '$44.84 native']);
  const subtotalNodesWhileStale = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert(subtotalNodesWhileStale.every((node) => node.dataset.priceState === 'pending'));
  assert.equal(payableEvents.length, 0);

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 3650, item_count: 5, items: [line(1000, 5)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  const totalsAfterBss = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totalsAfterBss, ['BSS $36.50', 'BSS $36.50']);
  const subtotalNodesReady = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert(subtotalNodesReady.every((node) => node.dataset.priceState === 'ready'));
  assert.equal(harness.window.document.querySelector('#cart-live-region-text').textContent, 'New estimated total: BSS $36.50');
  assert.deepEqual(payableEvents.map((detail) => detail.cents), [3650]);
  harness.dom.window.close();
});

test('cart subtotal stays pending on 44.84 seed until matching BSS 21.47 becomes ready', async () => {
  const harness = cartUIHarness();
  harness.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2147, item_count: 1, items: [line(1000, 1)] } },
    formatMoney: (cents) => `BSS $${(cents / 100).toFixed(2)}`,
  };
  const payableEvents = [];
  harness.window.document.addEventListener('cart:payable-total', (event) => payableEvents.push(event.detail));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 seed'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 seed</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 seed</p></div>',
      'cart-live-region-text': '<div class="shopify-section">New estimated total: $44.84 seed</div>',
    }));

  await harness.window.BSCartUI.refresh();
  const whileStale = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert.deepEqual(whileStale.map((node) => node.textContent), ['$44.84 seed', '$44.84 seed']);
  assert(whileStale.every((node) => node.dataset.priceState === 'pending'));
  assert.equal(payableEvents.length, 0);

  harness.window.BSS_B2B.shopData.cart = { bss_b2b_total_price: 2147, item_count: 5, items: [line(1000, 5)] };
  harness.window.document.dispatchEvent(new harness.window.Event('bss_b2b:CustomCartUpdate'));

  const afterReady = Array.from(harness.window.document.querySelectorAll('.totals__total-value'));
  assert.deepEqual(afterReady.map((node) => node.textContent), ['BSS $21.47', 'BSS $21.47']);
  assert(afterReady.every((node) => node.dataset.priceState === 'ready'));
  assert.deepEqual(payableEvents.map((detail) => detail.cents), [2147]);
  harness.dom.window.close();
});

test('BSS payable formatting preserves currency code when native subtotal includes one', async () => {
  const harness = cartUIHarness();
  harness.window.BSS_B2B = {
    shopData: { cart: { bss_b2b_total_price: 2147, item_count: 5, items: [line(1000, 5)] } },
    formatMoney: () => '$21.47',
  };
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js')
    ? { ...cartWith([line(1000, 5)]), currency: 'USD' }
    : {
      ...cartSections('$44.84 USD'),
      'cart-drawer': '<div id="CartDrawer"><div class="cart-drawer__footer"><div class="totals"><p class="totals__total-value">$44.84 USD</p></div></div><p id="CartDrawer-LiveRegionText" data-estimated-total-label="New estimated total"></p></div>',
      'main-cart-footer': '<div class="js-contents"><p class="totals__total-value">$44.84 USD</p></div>',
    }));
  await harness.window.BSCartUI.refresh();
  const totals = Array.from(harness.window.document.querySelectorAll('.totals__total-value')).map((node) => node.textContent);
  assert.deepEqual(totals, ['$21.47 USD', '$21.47 USD']);
  assert.equal(harness.window.document.querySelector('#cart-live-region-text').textContent, 'New estimated total: $21.47 USD');
  harness.dom.window.close();
});

test('successful add with a null optional footer still renders the valid drawer', async () => {
  const harness = cartUIHarness();
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({ items: [line(2000, 1)] });
    return jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5), line(2000, 1)]) : { ...cartSections('new product'), 'main-cart-footer': null });
  });
  const added = await harness.window.fetch('/en/cart/add.js', { method: 'POST', body: JSON.stringify({ items: [{ id: 2000, quantity: 1 }] }) });
  assert.equal(added.ok, true);
  const cart = await harness.window.BSCartUI.refresh();
  assert.equal(cart.items[1].variant_id, 2000);
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'new product');
  assert.equal(harness.window.document.querySelector('#main-cart-footer').textContent, 'old total');
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
  assert.equal(harness.published.length, 1);
  harness.dom.window.close();
});

test('a cart mutation invalidates in-flight sections and triggers one current complete render', async () => {
  const harness = cartUIHarness();
  let releaseSections;
  let sectionReads = 0;
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(1000, 5)]));
    sectionReads++;
    if (sectionReads === 1) return new Promise((resolve) => { releaseSections = resolve; });
    return jsonResponse(cartSections('current'));
  });
  const refresh = harness.window.BSCartUI.refresh();
  await Promise.resolve();
  await harness.window.fetch('/en/cart/change.js', { method: 'POST' });
  releaseSections(jsonResponse(cartSections('stale')));
  await refresh;
  assert.equal(sectionReads, 2);
  assert.equal(harness.window.document.querySelector('#main-cart-footer').textContent, 'current');
  assert.equal(harness.published.length, 1);
  harness.dom.window.close();
});

function installCartItems(harness) {
  const window = harness.window;
  window.routes = { cart_change_url: '/en/cart/change.js', cart_url: '/en/cart' };
  window.cartStrings = { error: 'Cart update failed', quantityError: 'Only [quantity] available' };
  window.fetchConfig = () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
  window.debounce = (listener) => listener;
  window.ON_CHANGE_DEBOUNCE_TIMER = 0;
  window.subscribe = () => () => {};
  window.eval(source('assets/cart.js'));
  window.CartItems = window.customElements.get('cart-items');
  const element = window.document.querySelector('cart-items');
  element.querySelector('.js-contents').innerHTML = '<div id="CartItem-1" data-cart-item-key="1000:custom"><input id="Quantity-1" value="4"></div>';
  return element;
}

test('quantity changes target the full line key and refresh both cart surfaces', async () => {
  const harness = cartUIHarness();
  const element = installCartItems(harness);
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { id: '1000:custom', quantity: 5 });
      return jsonResponse(cartWith([line(1000, 5)]));
    }
    return jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5)]) : cartSections('server final price'));
  });
  await element.updateQuantity(1, 5);
  assert.equal(harness.window.document.querySelector('#main-cart-footer').textContent, 'server final price');
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'server final price');
  assert.equal(harness.published.length, 1);
  harness.dom.window.close();
});

test('failed cart/change reports failure without applying an error response as cart state', async () => {
  const harness = cartUIHarness();
  const element = installCartItems(harness);
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return { ok: false, json: async () => ({ status: 422, description: 'Unavailable quantity' }) };
    return jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 4)]) : cartSections('unchanged server price'));
  });
  await element.updateQuantity(1, 5);
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, 'Unavailable quantity');
  assert.equal(harness.published.at(-1).cartData.item_count, 4);
  harness.dom.window.close();
});

test('a restoration or rewards batch delays rendering until all mutations finish', async () => {
  const harness = cartUIHarness();
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({});
    return jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5)]) : cartSections('complete batch'));
  });
  const finish = harness.window.BSCartUI.beginBatch();
  await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
  const refresh = harness.window.BSCartUI.refresh();
  await Promise.resolve();
  assert.equal(harness.requests.length, 1);
  await harness.window.fetch('/en/cart/update.js', { method: 'POST' });
  assert.equal(harness.published.length, 0);
  finish();
  await refresh;
  assert.equal(harness.published.length, 1);
  assert.equal(harness.window.document.querySelector('#main-cart-footer').textContent, 'complete batch');
  harness.dom.window.close();
});

test('rewards script compiles and uses authoritative cart renders, not placeholder row updates', () => {
  const rewards = source('snippets/cart-rewards.liquid');
  const script = rewards.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert(!script.includes('this._hideOrShowGiftRows('));
  assert(script.includes("document.addEventListener('cart:rendered'"));
  assert(script.includes("document.addEventListener('cart:payable-total'"));
  assert(script.includes("document.addEventListener('cart:payable-fallback'"));
  assert(script.includes('window.BSCartUI?.beginBatch()'));
});

test('rewards totals prefer BSS payable subtotal when available', () => {
  const script = source('snippets/cart-rewards.liquid').match(/<script>([\s\S]*?)<\/script>/)[1];
  let implementation;
  const context = {
    HTMLElement: class {},
    customElements: { get() {}, define(name, component) { implementation = component; } },
    BSS_B2B: { shopData: { cart: { bss_b2b_total_price: 2147 } } },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const element = Object.create(implementation.prototype);
  const total = element._calculateTotal({
    items: [{ requires_shipping: true, final_line_price: 4484 }],
    cart_level_discount_applications: [{ total_allocated_amount: 100 }],
  });
  assert.equal(total, 2147);
});

test('rewards totals fall back to Shopify cart fields when BSS payable data is unavailable', () => {
  const script = source('snippets/cart-rewards.liquid').match(/<script>([\s\S]*?)<\/script>/)[1];
  let implementation;
  const context = {
    HTMLElement: class {},
    customElements: { get() {}, define(name, component) { implementation = component; } },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const element = Object.create(implementation.prototype);
  const total = element._calculateTotal({
    items: [{ requires_shipping: true, final_line_price: 4484 }],
    cart_level_discount_applications: [{ total_allocated_amount: 100 }],
  });
  assert.equal(total, 4384);
});

test('a settled reward gift does not trigger another render batch', async () => {
  const script = source('snippets/cart-rewards.liquid').match(/<script>([\s\S]*?)<\/script>/)[1];
  let implementation;
  let batches = 0;
  const context = {
    HTMLElement: class {},
    customElements: { get() {}, define(name, component) { implementation = component; } },
    BSCartUI: { beginBatch: () => { batches++; return () => {}; } },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const element = Object.create(implementation.prototype);
  element.querySelectorAll = () => [{ dataset: { variantId: '1000', threshold: '3500' } }];
  element._pendingGiftAdds = new Set();
  await element._syncGifts(cartWith([{ ...line(1000, 1), key: '1000:gift', properties: { __reward_gift_variant: '1000' } }]), 5000);
  assert.equal(batches, 0);
});

test('gift rows preserve positional form quantities without changing BSS markers', () => {
  for (const file of ['snippets/cart-drawer.liquid', 'sections/main-cart-items.liquid']) {
    const gift = source(file).split('{%- if is_reward_gift -%}')[1].split('{%- continue -%}')[0];
    assert(gift.includes('<input type="hidden" name="updates[]" value="{{ item.quantity }}">'));
  }
});

test('actual drawer renderContents ignores old response sections and keeps overlay behavior', async () => {
  const harness = cartUIHarness();
  installCartItems(harness);
  const window = harness.window;
  window.document.querySelector('#CartDrawer').insertAdjacentHTML('afterbegin', '<div id="CartDrawer-Overlay"></div>');
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.removeTrapFocus = () => {};
  window.trapFocus = () => {};
  window.eval(source('assets/cart-drawer.js'));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5)]) : {
    ...cartSections('latest'),
    'cart-drawer': '<div id="CartDrawer"><div id="CartDrawer-Overlay"></div><div class="drawer__inner">latest</div></div>',
  }));
  const drawer = window.document.querySelector('cart-drawer');
  await drawer.renderContents({ id: 1000, sections: cartSections('stale') });
  assert.equal(window.document.querySelector('#CartDrawer').textContent, 'latest');
  assert.equal(window.document.querySelector('#main-cart-footer').textContent, 'latest');
  let closed = false;
  drawer.close = () => { closed = true; };
  window.document.querySelector('#CartDrawer-Overlay').click();
  assert.equal(closed, true);
  harness.dom.window.close();
});

test('all supplied server line prices survive a 34-line full cart and drawer refresh', async () => {
  const harness = cartUIHarness();
  const items = Array.from({ length: 34 }, (_, index) => ({ ...line(1000 + index % 30, index % 3 + 1), key: `line-${index}`, final_price: 300 + index, original_price: 700 + index }));
  const lineMarkup = items.map((item) => `<div data-key="${item.key}" data-variant="${item.variant_id}" data-quantity="${item.quantity}"><s>${item.original_price}</s><strong>${item.final_price}</strong></div>`).join('');
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith(items) : {
    ...cartSections('server subtotal'),
    'cart-drawer': `<div id="CartDrawer">${lineMarkup}</div>`,
    'main-cart-items': `<div class="js-contents">${lineMarkup}</div>`,
  }));
  await harness.window.BSCartUI.refresh();
  for (const selector of ['#CartDrawer', '#main-cart-items']) {
    const container = harness.window.document.querySelector(selector);
    for (const item of items) {
      const row = container.querySelector(`[data-key="${item.key}"]`);
      assert.equal(row.dataset.variant, String(item.variant_id));
      assert.equal(row.dataset.quantity, String(item.quantity));
      assert.equal(row.querySelector('strong').textContent, String(item.final_price));
    }
  }
  harness.dom.window.close();
});

for (const operation of ['add', 'update']) {
  test(`failed gift ${operation} is not retried by replacement rewards elements for the same cart`, async () => {
    const script = source('snippets/cart-rewards.liquid').match(/<script>([\s\S]*?)<\/script>/)[1];
    let implementation;
    let requests = 0;
    let finished = 0;
    const context = {
      HTMLElement: class {},
      customElements: { get() {}, define(name, component) { implementation = component; } },
      Shopify: { routes: { root: '/en/' } },
      fetch: async () => { requests++; return { ok: false, status: 422 }; },
      BSCartUI: { beginBatch: () => () => { finished++; } },
    };
    context.window = context;
    vm.runInNewContext(script, context);
    const cart = cartWith(operation === 'add' ? [line(2000, 1)] : [{ ...line(1000, 2), key: '1000:gift', properties: { __reward_gift_variant: '1000' } }]);
    const createElement = () => {
      const element = Object.create(implementation.prototype);
      element.querySelectorAll = () => [{ dataset: { variantId: '1000', threshold: '3500' } }];
      element._pendingGiftAdds = new Set();
      return element;
    };
    await assert.rejects(createElement()._syncGifts(cart, 5000), /HTTP 422/);
    await createElement()._syncGifts(cart, 5000);
    assert.equal(requests, 1);
    assert.equal(finished, 1);
    assert.equal(context.__cartRewardsSyncBusy, false);
  });
}

test('empty-to-populated transitions update checkout availability and drawer focus bindings', async () => {
  const harness = cartUIHarness();
  const window = harness.window;
  window.document.querySelector('#main-cart-footer').insertAdjacentHTML('beforeend', '<button id="checkout" disabled>Checkout</button>');
  window.document.querySelector('cart-drawer').classList.add('active');
  let count = 0;
  const trapped = [];
  window.trapFocus = (container) => { trapped.push(container); };
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith(count ? [line(1000, count)] : []) : {
    ...cartSections('server totals'),
    'cart-drawer': '<div id="CartDrawer"><div class="drawer__inner-empty"><button class="drawer__close">Close</button></div></div>',
  }));
  await window.BSCartUI.refresh();
  assert.equal(window.document.querySelector('#checkout').disabled, true);
  assert.equal(window.document.querySelector('cart-items').classList.contains('is-empty'), true);
  count = 5;
  await window.BSCartUI.refresh({ force: true });
  assert.equal(window.document.querySelector('#checkout').disabled, false);
  assert.equal(window.document.querySelector('cart-items').classList.contains('is-empty'), false);
  assert.equal(trapped.length, 2);
  assert.equal(trapped[0].isConnected, false);
  assert.equal(trapped[1], window.document.querySelector('#CartDrawer'));
  harness.dom.window.close();
});

test('a failed drawer quantity change remains visible after the recovery render', async () => {
  const harness = cartUIHarness();
  installCartItems(harness);
  const window = harness.window;
  window.customElements.define('cart-drawer-items', class extends window.CartItems {});
  window.document.querySelector('#CartDrawer').innerHTML = '<cart-drawer-items><div id="CartDrawer-Item-1" data-cart-item-key="1000:drawer"><input id="Drawer-quantity-1" value="4"></div></cart-drawer-items><div id="CartDrawer-CartErrors"></div>';
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return { ok: false, json: async () => ({ status: 422, description: 'Unavailable quantity' }) };
    return jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 4)]) : {
      ...cartSections('unchanged server price'),
      'cart-drawer': '<div id="CartDrawer"><cart-drawer-items></cart-drawer-items><div id="CartDrawer-CartErrors"></div></div>',
    });
  });
  await window.document.querySelector('cart-drawer-items').updateQuantity(1, 5);
  assert.equal(window.document.querySelector('#CartDrawer-CartErrors').textContent, 'Unavailable quantity');
  assert.equal(window.document.querySelector('#cart-errors').textContent, '');
  assert.equal(harness.published.at(-1).cartData.item_count, 4);
  harness.dom.window.close();
});

test('cart notification preserves the coordinated cart count while showing the added product', async () => {
  const harness = cartUIHarness();
  const window = harness.window;
  window.document.body.insertAdjacentHTML('beforeend', '<cart-notification><div id="cart-notification"><div id="cart-notification-product"></div><div id="cart-notification-button"></div></div></cart-notification>');
  window.eval(source('assets/cart-notification.js'));
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith([line(1000, 5)]) : cartSections('current count')));
  await window.BSCartUI.refresh();
  window.document.querySelector('cart-notification').renderContents({
    key: '1000:added',
    sections: {
      'cart-notification-product': '<div id="cart-notification-product-1000:added">Added product</div>',
      'cart-notification-button': '<div class="shopify-section">View cart</div>',
      'cart-icon-bubble': '<div class="shopify-section">stale count</div>',
    },
  });
  assert.equal(window.document.querySelector('#cart-icon-bubble').textContent, 'current count');
  assert.equal(window.document.querySelector('#cart-notification-product').textContent, 'Added product');
  assert.equal(window.document.querySelector('#cart-notification').classList.contains('active'), true);
  harness.dom.window.close();
});

for (const optionalHTML of [undefined, '<div class="shopify-section">No subtotal block configured</div>']) {
  test(`successful add skips an optional ${optionalHTML === undefined ? 'omitted section' : 'missing HTML selector'}`, async () => {
    const harness = cartUIHarness();
    harness.setHandler(async (url, options) => {
      if (options?.method === 'POST') return jsonResponse({ items: [line(2000, 2)] });
      return jsonResponse(url.includes('cart.js') ? cartWith([line(2000, 2)]) : { ...cartSections('added'), 'main-cart-footer': optionalHTML });
    });
    await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
    await harness.window.BSCartUI.refresh();
    assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'added');
    assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
    assert.equal(harness.requests.length, 3, 'optional fragments do not trigger retries');
    harness.dom.window.close();
  });
}

test('successful add skips a DOM target removed while sections are being fetched', async () => {
  const harness = cartUIHarness();
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({ items: [line(2000, 1)] });
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(2000, 1)]));
    harness.window.document.querySelector('#main-cart-footer').remove();
    return jsonResponse(cartSections('new product'));
  });
  await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'new product');
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
  harness.dom.window.close();
});

test('product-page refresh requests only mounted drawer and count sections', async () => {
  const harness = cartUIHarness();
  for (const selector of ['cart-items', '#main-cart-footer', '#cart-live-region-text']) harness.window.document.querySelector(selector).remove();
  harness.setHandler(async (url) => {
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(2000, 1)]));
    assert.equal(new URL(url).searchParams.get('sections'), 'cart-drawer,cart-icon-bubble');
    return jsonResponse(cartSections('product page add'));
  });
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'product page add');
  harness.dom.window.close();
});

test('full-cart refresh uses configured instance IDs, including footer blocks', async () => {
  const harness = cartUIHarness();
  harness.window.document.querySelector('#main-cart-items').dataset.id = 'template--123__items';
  harness.window.document.querySelector('#main-cart-footer').dataset.id = 'template--123__footer';
  harness.setHandler(async (url) => {
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(2000, 1)]));
    const requested = new URL(url).searchParams.get('sections').split(',');
    assert(requested.includes('template--123__footer'));
    assert(!requested.includes('main-cart-footer'));
    return jsonResponse({ ...cartSections('instance'), 'template--123__items': '<div class="js-contents">items</div>', 'template--123__footer': '<div class="js-contents">configured subtotal</div>' });
  });
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#main-cart-footer').textContent, 'configured subtotal');
  harness.dom.window.close();
});

for (const failure of ['HTTP 500', 'network', 'invalid JSON', 'null drawer', 'missing drawer selector']) {
  test(`valid cart recovers from ${failure} with one clean drawer fetch`, async () => {
    const harness = cartUIHarness();
    let sectionReads = 0;
    harness.setHandler(async (url, options) => {
      if (options?.method === 'POST') return jsonResponse({ items: [line(2000, 1)] });
      if (url.includes('cart.js')) return jsonResponse(cartWith([line(2000, 1)]));
      sectionReads++;
      if (sectionReads === 1) {
        if (failure === 'HTTP 500') return { ok: false, status: 500 };
        if (failure === 'network') throw new Error('Disconnected');
        if (failure === 'invalid JSON') return { ok: true, json: async () => { throw new SyntaxError('Not JSON'); } };
        return jsonResponse({ ...cartSections('other sections'), 'cart-drawer': failure === 'null drawer' ? null : '<div>No drawer</div>' });
      }
      assert.equal(new URL(url).searchParams.get('sections'), 'cart-drawer');
      return jsonResponse({ 'cart-drawer': '<div id="CartDrawer">recovered new line<div id="CartDrawer-CartErrors"></div></div>' });
    });
    await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
    const cart = await harness.window.BSCartUI.refresh();
    assert.equal(cart.item_count, 1);
    assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'recovered new line');
    assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
    assert.equal(sectionReads, 2);
    assert.equal(harness.published.length, 1);
    harness.dom.window.close();
  });
}

test('two failed drawer reads preserve valid cart state, stop retrying and allow a later explicit recovery', async () => {
  const harness = cartUIHarness();
  harness.window.document.querySelector('#cart-errors').textContent = 'Cart could not be refreshed. Please refresh the page to review your cart.';
  let sectionReads = 0;
  let recover = false;
  harness.setHandler(async (url) => {
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(2000, 1)]));
    sectionReads++;
    return jsonResponse(recover ? cartSections('recovered') : { 'cart-drawer': null });
  });
  const cart = await harness.window.BSCartUI.refresh();
  assert.equal(cart.items[0].variant_id, 2000);
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
  assert.equal(harness.window.document.querySelector('#CartDrawer').dataset.cartRenderState, 'stale');
  await harness.window.BSCartUI.refresh();
  assert.equal(sectionReads, 2, 'no unbounded or coalesced-caller retries');
  recover = true;
  await harness.window.BSCartUI.refresh({ force: true });
  assert.equal(sectionReads, 3);
  assert.equal(harness.window.document.querySelector('#CartDrawer').dataset.cartRenderState, undefined);
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'recovered');
  harness.dom.window.close();
});

test('valid-cart refresh clears its own error but preserves a real mutation error', async () => {
  const harness = cartUIHarness();
  harness.window.document.querySelector('#cart-errors').textContent = 'Only 4 available';
  harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith([line(2000, 1)]) : { ...cartSections('valid'), 'cart-drawer': null }));
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, 'Only 4 available');
  harness.dom.window.close();
});

test('unknown cart state still reports a refresh error and clears it after a valid read', async () => {
  const harness = cartUIHarness();
  let available = false;
  harness.setHandler(async (url) => url.includes('cart.js') && !available ? { ok: false, status: 503 } : jsonResponse(url.includes('cart.js') ? cartWith([line(2000, 1)]) : cartSections('valid')));
  await harness.window.BSCartUI.refresh().catch(harness.window.BSCartUI.reportError);
  assert(harness.window.document.querySelector('#cart-errors').textContent.includes('Cart could not be refreshed'));
  available = true;
  await harness.window.BSCartUI.refresh();
  assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
  harness.dom.window.close();
});

test('full page reload and header drawer opening do not recreate a secondary-fragment error', async () => {
  for (const reload of [false, true]) {
    const harness = cartUIHarness();
    const window = harness.window;
    installCartItems(harness);
    window.document.querySelector('#CartDrawer').insertAdjacentHTML('afterbegin', '<div id="CartDrawer-Overlay"></div>');
    window.requestAnimationFrame = () => 0;
    window.eval(source('assets/cart-drawer.js'));
    if (reload) window.document.querySelector('#cart-errors').textContent = 'Cart could not be refreshed. Please refresh the page to review your cart.';
    harness.setHandler(async (url) => jsonResponse(url.includes('cart.js') ? cartWith([line(2000, 1)]) : { ...cartSections('existing valid cart'), 'cart-icon-bubble': null }));
    window.document.querySelector('#cart-icon-bubble').click();
    await window.BSCartUI.refresh();
    assert.equal(window.document.querySelector('#CartDrawer').textContent, 'existing valid cart');
    assert.equal(window.document.querySelector('#cart-errors').textContent, '');
    harness.dom.window.close();
  }
});

test('delayed BSS-style price markup and throwing display callbacks do not fail a confirmed cart', async () => {
  const harness = cartUIHarness();
  const window = harness.window;
  window.document.querySelector('cart-drawer').setSummaryAccessibility = () => { throw new TypeError('Markup not ready'); };
  window.publish = () => { throw new TypeError('App subscriber not ready'); };
  let initializePrices;
  window.document.addEventListener('cart:rendered', () => {
    initializePrices = () => {
      window.document.querySelector('[bss-b2b-cart-item-key]').innerHTML = '<span bss-b2b-final-line-price>App supplied wholesale price</span>';
    };
  });
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({ items: [line(2000, 1)] });
    return jsonResponse(url.includes('cart.js') ? cartWith([line(2000, 1)]) : { ...cartSections('native'), 'cart-drawer': '<div id="CartDrawer"><div bss-b2b-cart-item-key="2000:b2b"></div><details id="Details-CartDrawer"><summary>Note</summary></details></div>' });
  });
  await window.fetch('/en/cart/add.js', { method: 'POST' });
  await window.BSCartUI.refresh();
  assert.equal(window.document.querySelector('#cart-errors').textContent, '');
  assert.equal(typeof initializePrices, 'function');
  initializePrices();
  await window.BSCartUI.refresh();
  assert.equal(window.document.querySelector('[bss-b2b-final-line-price]').textContent, 'App supplied wholesale price');
  assert.equal(window.document.querySelector('#cart-errors').textContent, '');
  harness.dom.window.close();
});

test('consecutive adds, split variants, selling plans, quantity changes and removal render in a 35-line cart', async () => {
  const harness = cartUIHarness();
  const items = Array.from({ length: 30 }, (_, index) => ({ ...line(1000 + index, 1), key: `line-${index}`, original_price: 800, final_price: 400, original_line_price: 800, final_line_price: 400, discounts: [], discount_allocations: [] }));
  const additions = [
    { ...line(3000, 1), product_type: 'Wholesale' },
    { ...line(3001, 1), product_type: 'Retail', final_price: 800 },
    line(1000, 2, { 'Custom Text': 'separate line', __reward_gift_variant: '', BSS: 'fixture', BLOY: 'fixture' }),
    { ...line(3002, 1), selling_plan_allocation: { selling_plan: { id: 9000 } } },
    line(3003, 3),
  ];
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') {
      const request = JSON.parse(options.body);
      if (url.includes('/add.js')) {
        const item = { ...items[0], ...request, key: `new-${items.length}` };
        items.push(item);
        return { ...jsonResponse({ items: [item], sections: { 'cart-icon-bubble': null } }), status: 200 };
      }
      const index = items.findIndex(item => item.key === request.id);
      if (request.quantity === 0) items.splice(index, 1);
      else items[index].quantity = request.quantity;
      return jsonResponse(cartWith(items));
    }
    if (url.includes('cart.js')) return jsonResponse(cartWith(items));
    const html = items.map(item => `<div data-key="${item.key}" data-quantity="${item.quantity}" data-variant="${item.variant_id}"><span>${item.final_price}</span></div>`).join('');
    return jsonResponse({ ...cartSections('cart totals'), 'cart-icon-bubble': null, 'cart-drawer': `<div id="CartDrawer">${html}</div>`, 'main-cart-items': `<div class="js-contents">${html}</div>` });
  });
  for (const added of additions) {
    const response = await harness.window.fetch('/en/cart/add.js', { method: 'POST', body: JSON.stringify(added) });
    assert.equal(response.status, 200);
    await harness.window.BSCartUI.refresh();
    assert.equal(harness.window.document.querySelector('#CartDrawer').children.length, items.length);
    assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
  }
  assert.equal(items.length, 35);
  for (const selector of ['#CartDrawer', '#main-cart-items']) {
    for (const item of items) {
      const row = harness.window.document.querySelector(`${selector} [data-key="${item.key}"]`);
      assert.equal(row.dataset.quantity, String(item.quantity));
      assert.equal(row.dataset.variant, String(item.variant_id));
      assert.equal(row.textContent, String(item.final_price));
    }
  }
  const key = items.at(-1).key;
  for (const quantity of [5, 0]) {
    await harness.window.fetch('/en/cart/change.js', { method: 'POST', body: JSON.stringify({ id: key, quantity }) });
    await harness.window.BSCartUI.refresh();
    const row = harness.window.document.querySelector(`#CartDrawer [data-key="${key}"]`);
    assert.equal(row?.dataset.quantity, quantity ? String(quantity) : undefined);
  }
  harness.dom.window.close();
});

test('a new mutation during drawer recovery invalidates that recovery response', async () => {
  const harness = cartUIHarness();
  let releaseRecovery;
  let recoveryStarted;
  const started = new Promise(resolve => { recoveryStarted = resolve; });
  let sectionReads = 0;
  harness.setHandler(async (url, options) => {
    if (options?.method === 'POST') return jsonResponse({ items: [line(3000, 1)] });
    if (url.includes('cart.js')) return jsonResponse(cartWith([line(3000, 1)]));
    sectionReads++;
    if (sectionReads === 1) return jsonResponse({ 'cart-drawer': null });
    if (sectionReads === 2) return new Promise(resolve => { releaseRecovery = resolve; recoveryStarted(); });
    return jsonResponse(cartSections('latest add'));
  });
  const refresh = harness.window.BSCartUI.refresh();
  await started;
  await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
  releaseRecovery(jsonResponse(cartSections('outdated recovery')));
  await refresh;
  assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'latest add');
  assert.equal(harness.published.length, 1);
  harness.dom.window.close();
});

test('Shopify cart route content negotiation returns sections rather than cart JSON after add and reload', async () => {
  for (const afterAdd of [true, false]) {
    const harness = cartUIHarness();
    const cart = cartWith([line(2000, 1)]);
    harness.setHandler(async (url, options) => {
      if (options?.method === 'POST') return jsonResponse({ items: cart.items, sections: cartSections('bundled drawer') });
      if (url.includes('cart.js')) {
        assert.equal(options.headers.Accept, 'application/json');
        return jsonResponse(cart);
      }
      if (options.headers?.Accept === 'application/json') return jsonResponse(cart);
      return jsonResponse(cartSections('section-rendered drawer'));
    });
    if (afterAdd) await harness.window.fetch('/en/cart/add.js', { method: 'POST' });
    await harness.window.BSCartUI.refresh({ force: !afterAdd });
    assert.equal(harness.window.document.querySelector('#CartDrawer').textContent, 'section-rendered drawer');
    assert.equal(harness.warnings.length, 0);
    assert.equal(harness.requests.filter(request => request.url.includes('?sections=')).length, 1);
    assert.equal(harness.window.document.querySelector('#cart-errors').textContent, '');
    harness.dom.window.close();
  }
});

test('quick order payable totals use final_line_price fields', () => {
  const quickOrder = source('snippets/quick-order-list.liquid');
  const quickOrderRow = source('snippets/quick-order-list-row.liquid');

  assert(quickOrder.includes("sum: 'final_line_price'"));
  assert(!quickOrder.includes("sum: 'original_line_price'"));

  const finalMatches = quickOrderRow.match(/sum: 'final_line_price'/g) || [];
  const originalMatches = quickOrderRow.match(/sum: 'original_line_price'/g) || [];
  assert.equal(finalMatches.length, 2);
  assert.equal(originalMatches.length, 0);
});

test('quick-order rerenders use pending/ready lifecycle with BSS signals and fail-open fallback', () => {
  const quickOrderScript = source('assets/quick-order-list.js');
  const quickOrderTemplate = source('snippets/quick-order-list.liquid');
  const quickOrderRow = source('snippets/quick-order-list-row.liquid');

  assert(quickOrderScript.includes('syncPriceStateAfterRender'));
  assert(quickOrderScript.includes('window.BSPriceState.setPending'));
  assert(quickOrderScript.includes('window.BSPriceState.triggerBssRefresh'));
  assert(quickOrderScript.includes('.waitForBssReady({'));
  assert(quickOrderScript.includes('window.BSPriceState.setReady'));

  assert(quickOrderTemplate.includes('data-price-surface="quick-order-total"'));
  assert(quickOrderRow.includes('data-price-surface="quick-order-variant-total"'));
});

test('quick-add modal injection uses pending-before-exposure and BSS-ready reveal', () => {
  const quickAddScript = source('assets/quick-add.js');
  const productInfoScript = source('assets/product-info.js');

  assert(quickAddScript.includes('syncBssPriceState'));
  assert(quickAddScript.includes('window.BSPriceState.setPending'));
  assert(quickAddScript.includes('window.BSPriceState.triggerBssRefresh'));
  assert(quickAddScript.includes('.waitForBssReady({'));
  assert(quickAddScript.includes('window.BSPriceState.setReady'));

  assert(productInfoScript.includes('syncQuickAddPriceState'));
  assert(productInfoScript.includes('if (this.closest(\'quick-add-modal\'))'));
});

test('quick-add-bulk rerenders use pending/ready BSS lifecycle', () => {
  const quickAddBulkScript = source('assets/quick-add-bulk.js');

  assert(quickAddBulkScript.includes('syncPriceStateAfterRender'));
  assert(quickAddBulkScript.includes('window.BSPriceState.setPending'));
  assert(quickAddBulkScript.includes('window.BSPriceState.triggerBssRefresh'));
  assert(quickAddBulkScript.includes('.waitForBssReady({'));
  assert(quickAddBulkScript.includes('window.BSPriceState.setReady'));
});

function loadQuantityRuleResolver() {
  const block = source('assets/global.js').match(
    /function parseQuantityValue\(value\) \{[\s\S]*?function resolveQuantityRules\(input\) \{[\s\S]*?\n\}/
  );
  assert(block, 'Expected parseQuantityValue/resolveQuantityRules helpers in assets/global.js');
  const context = {};
  vm.runInNewContext(`${block[0]}\nthis.testResolveQuantityRules = resolveQuantityRules;`, context);
  return context.testResolveQuantityRules;
}

function loadBulkAddClassForValidation() {
  const resolverBlock = source('assets/global.js').match(
    /function parseQuantityValue\(value\) \{[\s\S]*?function resolveQuantityRules\(input\) \{[\s\S]*?\n\}/
  );
  const bulkAddBlock = source('assets/global.js').match(
    /class BulkAdd extends HTMLElement \{[\s\S]*?if \(!customElements\.get\('bulk-add'\)\) \{[\s\S]*?\n\}/
  );

  assert(resolverBlock, 'Expected quantity resolver block in assets/global.js');
  assert(bulkAddBlock, 'Expected BulkAdd class block in assets/global.js');

  let BulkAddCtor;
  const context = {
    HTMLElement: class {},
    customElements: {
      get() {},
      define(name, ctor) {
        if (name === 'bulk-add') BulkAddCtor = ctor;
      },
    },
    window: {
      quickOrderListStrings: {
        min_error: 'min [min]',
        max_error: 'max [max]',
        step_error: 'step [step]',
      },
    },
  };

  vm.runInNewContext(`${resolverBlock[0]}\n${bulkAddBlock[0]}`, context);
  assert(BulkAddCtor, 'Expected bulk-add custom element registration');
  return BulkAddCtor;
}

function loadQuantityInputClassForValidation() {
  const resolverBlock = source('assets/global.js').match(
    /function parseQuantityValue\(value\) \{[\s\S]*?function resolveQuantityRules\(input\) \{[\s\S]*?\n\}/
  );
  const quantityInputBlock = source('assets/global.js').match(
    /class QuantityInput extends HTMLElement \{[\s\S]*?customElements\.define\('quantity-input', QuantityInput\);/
  );

  assert(resolverBlock, 'Expected quantity resolver block in assets/global.js');
  assert(quantityInputBlock, 'Expected QuantityInput class block in assets/global.js');

  const context = {
    HTMLElement: class {},
    customElements: {
      get() {},
      define() {},
    },
    subscribe: () => () => {},
    PUB_SUB_EVENTS: { quantityUpdate: 'quantityUpdate' },
    Event: class {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = !!options.bubbles;
      }
    },
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(`${resolverBlock[0]}\n${quantityInputBlock[0]}\nthis.testQuantityInput = QuantityInput;`, context);
  assert(context.testQuantityInput, 'Expected QuantityInput class export');
  return context.testQuantityInput;
}

function createBulkAddValidationHarness() {
  const BulkAdd = loadBulkAddClassForValidation();
  const element = new BulkAdd();
  const queued = [];
  const messages = [];

  element.startQueue = (id, quantity) => queued.push({ id, quantity });
  element.resetQuantityInput = () => {};

  const buildEvent = ({
    value,
    min,
    step,
    quantityRuleMax = null,
    inventoryMax = null,
    cartQuantity = null,
    quantityInputHost = null,
    index = '1000',
  }) => {
    const dataset = { index, min: String(min) };
    if (quantityRuleMax !== null) dataset.quantityRuleMax = String(quantityRuleMax);
    if (inventoryMax !== null) dataset.inventoryMax = String(inventoryMax);
    if (cartQuantity !== null) dataset.cartQuantity = String(cartQuantity);

    return {
      target: {
        value: String(value),
        max: '',
        min: '0',
        step: String(step),
        dataset,
        closest: () => quantityInputHost,
        setCustomValidity: (message) => messages.push(message),
        reportValidity: () => {},
        select: () => {},
      },
    };
  };

  return { element, queued, messages, buildEvent };
}

function createQuantityButton(name) {
  return {
    name,
    _attrs: {},
    classList: {
      _set: new Set(),
      toggle(className, enabled) {
        if (enabled) this._set.add(className);
        else this._set.delete(className);
      },
      contains(className) {
        return this._set.has(className);
      },
      add(className) {
        this._set.add(className);
      },
      remove(className) {
        this._set.delete(className);
      },
    },
    toggleAttribute(name, enabled) {
      if (enabled) {
        this._attrs[name] = '';
      } else {
        delete this._attrs[name];
      }
      if (name === 'disabled') this.disabled = !!enabled;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    getAttribute(name) {
      return this._attrs[name];
    },
    closest(selector) {
      return selector === `button[name="${this.name}"]` ? this : null;
    },
  };
}

function createQuantityInputHarness({ value, min, step, max = '', quantityRuleMax = null, inventoryMax = null }) {
  const QuantityInput = loadQuantityInputClassForValidation();
  const plus = createQuantityButton('plus');
  const minus = createQuantityButton('minus');

  let dispatched = 0;
  const input = {
    value: String(value),
    min: '0',
    max: String(max),
    step: String(step),
    dataset: { min: String(min) },
    dispatchEvent: () => {
      dispatched += 1;
    },
    stepUp: () => {
      input.value = String((parseInt(input.value, 10) || 0) + parseInt(input.step, 10));
    },
    stepDown: () => {
      input.value = String((parseInt(input.value, 10) || 0) - parseInt(input.step, 10));
    },
  };
  if (quantityRuleMax !== null) input.dataset.quantityRuleMax = String(quantityRuleMax);
  if (inventoryMax !== null) input.dataset.inventoryMax = String(inventoryMax);

  let warnings = 0;
  const component = {
    input,
    changeEvent: { type: 'change' },
    querySelector(selector) {
      if (selector === ".quantity__button[name='plus']") return plus;
      if (selector === ".quantity__button[name='minus']") return minus;
      return null;
    },
    flashMaxWarning() {
      warnings += 1;
    },
  };

  component.syncResolvedMax = QuantityInput.prototype.syncResolvedMax;
  component.validateQtyRules = QuantityInput.prototype.validateQtyRules;
  component.clampToMax = QuantityInput.prototype.clampToMax;

  return {
    QuantityInput,
    component,
    input,
    plus,
    minus,
    getDispatched: () => dispatched,
    getWarnings: () => warnings,
  };
}

test('effective max normalizes to valid increment under tracked inventory caps (5/5/18 -> 15)', () => {
  const resolveRules = loadQuantityRuleResolver();

  const tracked = resolveRules({
    dataset: { min: '5', inventoryMax: '18' },
    min: '0',
    max: '',
    step: '5',
  });

  assert.equal(tracked.min, 5);
  assert.equal(tracked.step, 5);
  assert.equal(tracked.max, 15);
});

test('bulk add over-max manual attempt clamps to 15 for 5/5/18 instead of raw inventory 18', () => {
  const harness = createBulkAddValidationHarness();

  const event = harness.buildEvent({ value: 50, min: 5, step: 5, inventoryMax: 18 });
  harness.element.validateQuantity(event);

  assert.equal(event.target.value, 15);
  assert.equal(event.target.max, '15');
  assert.deepEqual(harness.queued, [{ id: '1000', quantity: 15 }]);
  assert.equal(harness.messages[0], '');
});

test('quick-order initial render at max disables plus with aria-disabled parity', () => {
  const harness = createQuantityInputHarness({ value: 22, min: 1, step: 1, inventoryMax: 22 });

  harness.QuantityInput.prototype.connectedCallback.call(harness.component);

  assert.equal(harness.input.value, '22');
  assert.equal(harness.input.max, '22');
  assert.equal(harness.plus.disabled, true);
  assert.equal(harness.plus.getAttribute('aria-disabled'), 'true');
});

test('quantity-input plus button at normalized max does not increment or dispatch mutation-driving change', () => {
  const harness = createQuantityInputHarness({ value: 15, min: 5, step: 5, inventoryMax: 18 });

  harness.QuantityInput.prototype.connectedCallback.call(harness.component);

  harness.QuantityInput.prototype.onButtonClick.call(harness.component, {
    preventDefault() {},
    target: harness.plus,
  });

  assert.equal(harness.input.value, '15');
  assert.equal(harness.input.max, '15');
  assert.equal(harness.getDispatched(), 0);
  assert.equal(harness.getWarnings(), 1);
  assert.equal(harness.plus.disabled, true);
  assert.equal(harness.plus.getAttribute('aria-disabled'), 'true');
});

test('quick-order boundary transition 21 -> 22 disables plus, 22 -> 21 re-enables plus', () => {
  const harness = createQuantityInputHarness({ value: 21, min: 1, step: 1, inventoryMax: 22 });

  harness.QuantityInput.prototype.connectedCallback.call(harness.component);
  assert.equal(harness.plus.disabled, false);

  harness.QuantityInput.prototype.onButtonClick.call(harness.component, {
    preventDefault() {},
    target: harness.plus,
  });

  assert.equal(harness.input.value, '22');
  assert.equal(harness.plus.disabled, true);
  assert.equal(harness.getDispatched(), 1);

  harness.QuantityInput.prototype.onButtonClick.call(harness.component, {
    preventDefault() {},
    target: harness.minus,
  });

  assert.equal(harness.input.value, '21');
  assert.equal(harness.plus.disabled, false);
  assert.equal(harness.getDispatched(), 2);
});

test('effective max uses min-offset increment math for min=3 increment=4 inventory=20 (max 19)', () => {
  const resolveRules = loadQuantityRuleResolver();

  const tracked = resolveRules({
    dataset: { min: '3', inventoryMax: '20' },
    min: '0',
    max: '',
    step: '4',
  });

  assert.equal(tracked.min, 3);
  assert.equal(tracked.step, 4);
  assert.equal(tracked.max, 19);
});

test('bulk add over-max manual attempt clamps to 19 for min=3 increment=4 inventory=20', () => {
  const harness = createBulkAddValidationHarness();

  const event = harness.buildEvent({ value: 999, min: 3, step: 4, inventoryMax: 20 });
  harness.element.validateQuantity(event);

  assert.equal(event.target.value, 19);
  assert.equal(event.target.max, '19');
  assert.deepEqual(harness.queued, [{ id: '1000', quantity: 19 }]);
  assert.equal(harness.messages[0], '');
});

test('manual over-max entry resolves to max, disables plus, and avoids browser validity popup path', () => {
  const harness = createBulkAddValidationHarness();
  const quantityInputHost = { flashed: 0, synced: 0 };
  let reportValidityCalls = 0;

  const event = harness.buildEvent({
    value: 50,
    min: 1,
    step: 1,
    inventoryMax: 22,
    cartQuantity: 0,
    quantityInputHost: {
      flashMaxWarning: () => {
        quantityInputHost.flashed += 1;
      },
      validateQtyRules: () => {
        quantityInputHost.synced += 1;
      },
    },
  });
  event.target.reportValidity = () => {
    reportValidityCalls += 1;
  };

  harness.element.validateQuantity(event);

  assert.equal(event.target.value, 22);
  assert.equal(event.target.max, '22');
  assert.equal(quantityInputHost.flashed, 1);
  assert.equal(quantityInputHost.synced, 1);
  assert.equal(reportValidityCalls, 0);
  assert.deepEqual(harness.queued, [{ id: '1000', quantity: 22 }]);
});

test('known at-max overage correction does not queue redundant mutation when cart already equals max', () => {
  const harness = createBulkAddValidationHarness();

  const event = harness.buildEvent({
    value: 23,
    min: 1,
    step: 1,
    inventoryMax: 22,
    cartQuantity: 22,
  });

  harness.element.validateQuantity(event);

  assert.equal(event.target.value, 22);
  assert.equal(harness.queued.length, 0);
});

test('quantity_rule.max stricter than inventory still wins after increment normalization', () => {
  const resolveRules = loadQuantityRuleResolver();

  const tracked = resolveRules({
    dataset: { min: '5', quantityRuleMax: '20', inventoryMax: '50' },
    min: '0',
    max: '',
    step: '5',
  });

  assert.equal(tracked.max, 20);
});

test('continue-selling remains uncapped by inventory when no quantity_rule.max is present', () => {
  const resolveRules = loadQuantityRuleResolver();

  const continueSelling = resolveRules({
    dataset: { min: '3' },
    min: '0',
    max: '',
    step: '4',
  });

  assert.equal(continueSelling.min, 3);
  assert.equal(continueSelling.step, 4);
  assert.equal(continueSelling.max, null);
});

test('continue-selling still respects quantity_rule.max and increment progression when provided', () => {
  const harness = createBulkAddValidationHarness();

  const event = harness.buildEvent({ value: 999, min: 3, step: 4, quantityRuleMax: 20 });
  harness.element.validateQuantity(event);

  assert.equal(event.target.value, 19);
  assert.equal(event.target.max, '19');
  assert.deepEqual(harness.queued, [{ id: '1000', quantity: 19 }]);
  assert.equal(harness.messages[0], '');
});

test('quantity resolver preserves continue-selling uncapped behavior when no max source is present', () => {
  const resolveRules = loadQuantityRuleResolver();

  const continueSelling = resolveRules({
    dataset: { min: '1' },
    min: '0',
    max: '',
    step: '1',
  });
  assert.equal(continueSelling.min, 1);
  assert.equal(continueSelling.max, null);
});

test('bulk add rejects invalid negative, blank, decimal-step, and non-number manual inputs', () => {
  const harness = createBulkAddValidationHarness();
  const makeEvent = (value, extras = {}) => harness.buildEvent({
    value,
    min: 5,
    step: 5,
    quantityRuleMax: 20,
    ...extras,
  });

  for (const value of ['-1', '', '7.3', 'abc']) {
    harness.element.validateQuantity(makeEvent(value));
  }

  assert.equal(harness.queued.length, 0);
  assert(harness.messages.includes('min 5'));
  assert(harness.messages.filter((message) => message === 'step 5').length >= 2);
});

test('quick-order script reconciles server-authoritative quantity adjustments after mutation', () => {
  const quickOrderScript = source('assets/quick-order-list.js');

  assert(quickOrderScript.includes('reconcileAuthoritativeQuantities(requestedItems, cartData)'));
  assert(quickOrderScript.includes('this.reconcileAuthoritativeQuantities(items, result.cartData);'));
  assert(quickOrderScript.includes('this.updateError(actual, variantIdInt);'));
});

test('quick-order rerender path re-syncs quantity-input state for disabled-button parity', () => {
  const quickOrderScript = source('assets/quick-order-list.js');

  assert(quickOrderScript.includes('syncQuantityInputState()'));
  assert(quickOrderScript.includes('quantityElement.syncResolvedMax?.();'));
  assert(quickOrderScript.includes('quantityElement.validateQtyRules?.();'));
});

test('custom bulk-order local pricing uses pending -> local calculate -> ready lifecycle', () => {
  const mainProduct = source('sections/main-product.liquid');

  assert(mainProduct.includes('data-price-surface="bulk-order-local-price"'));
  assert(mainProduct.includes('data-price-state="pending"'));
  assert(mainProduct.includes('const markPricesPending = () =>'));
  assert(mainProduct.includes('const markPricesReady = () =>'));
  assert(mainProduct.includes('markPricesPending();'));
  assert(mainProduct.includes('markPricesReady();'));
});

function saveForLaterHarness(options = {}) {
  const { customer = 'retail', fetchImpl } = options;
  const dom = new JSDOM(`
    <meta name="bs-customer-id" content="${customer}">
    <meta name="bs-saveforlater-endpoint" content="/apps/growth/saved-for-later">
    <meta name="bs-login-url" content="/account/login">
  `, { url: 'https://example.test/en/cart', runScripts: 'outside-only' });

  const window = dom.window;
  const requests = [];

  window.Shopify = {
    routes: { root: '/en/' },
    formatMoney: (cents) => `$${(cents / 100).toFixed(2)}`,
  };
  window.theme = { moneyFormat: '${{amount}}' };
  window.BSCartUI = {
    beginBatch: () => () => {},
    refresh: async () => ({ items: [] }),
    reportError: () => {},
  };
  window.console.error = () => {};
  window.console.warn = () => {};
  window.console.log = () => {};

  window.fetch = async (url, init = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    if (fetchImpl) return fetchImpl(request);
    if (request.url.includes('/cart.js')) return { ok: true, json: async () => ({ items: [], item_count: 0 }) };
    if (request.url.includes('/products/')) return { ok: true, json: async () => ({ variants: [] }) };
    return { ok: true, json: async () => ({}) };
  };

  const instrumented = source('assets/save-for-later.js')
    .replace("document.addEventListener('DOMContentLoaded', init);", "window.__sflInit = init;")
    .replace("if (document.readyState !== 'loading') init();", '')
    .replace(
      '  window.BSSavedForLater = {',
      '  window.testSFL = { save, readAll, writeAll, remove, itemIdentityKey, buildCartAddItem, addItemsToCart, validateCartInventoryOnLoad, encodeEntry, decodeEntry, encodeList, rehydrateFromEncoded, mergeServerHydratedWithLocalMetadata };\n  window.BSSavedForLater = {'
    );
  window.eval(instrumented);

  return { dom, window, api: window.testSFL, requests };
}

test('save-for-later keeps separate items for same variant with different Custom Text properties', () => {
  const harness = saveForLaterHarness();

  harness.api.save({ variantId: 1000, productHandle: 'chain', quantity: 1, properties: { 'Custom Text': 'ALEX' } });
  harness.api.save({ variantId: 1000, productHandle: 'chain', quantity: 1, properties: { 'Custom Text': 'SAM' } });

  const saved = harness.api.readAll();
  assert.equal(saved.length, 2);
  assert.notEqual(harness.api.itemIdentityKey(saved[0]), harness.api.itemIdentityKey(saved[1]));
  assert.equal(harness.api.encodeList(saved).length, 0);
  harness.dom.window.close();
});

test('save-for-later keeps separate items for same variant with different selling plans', () => {
  const harness = saveForLaterHarness();

  harness.api.save({ variantId: 1000, productHandle: 'chain', quantity: 1, sellingPlanId: 111 });
  harness.api.save({ variantId: 1000, productHandle: 'chain', quantity: 1, sellingPlanId: 222 });

  const saved = harness.api.readAll();
  assert.equal(saved.length, 2);
  assert.notEqual(harness.api.itemIdentityKey(saved[0]), harness.api.itemIdentityKey(saved[1]));
  assert.equal(harness.api.encodeList(saved).length, 0);
  harness.dom.window.close();
});

test('save-for-later legacy wire format encodes and decodes simple items', () => {
  const harness = saveForLaterHarness();

  const encoded = harness.api.encodeEntry({ variantId: 1000, productHandle: 'Chain', quantity: 2 });
  assert.equal(encoded, '1000|2|chain');

  const decoded = harness.api.decodeEntry(encoded);
  assert.equal(decoded.variantId, 1000);
  assert.equal(decoded.quantity, 2);
  assert.equal(decoded.productHandle, 'chain');
  assert.equal(Object.keys(decoded.properties || {}).length, 0);
  assert.equal(decoded.sellingPlanId, null);
  harness.dom.window.close();
});

test('save-for-later excludes metadata-bearing items from legacy server serialization', () => {
  const harness = saveForLaterHarness();

  assert.equal(
    harness.api.encodeEntry({ variantId: 1000, productHandle: 'chain', quantity: 1, properties: { engraving: 'A' } }),
    null
  );
  assert.equal(
    harness.api.encodeEntry({ variantId: 1000, productHandle: 'chain', quantity: 1, sellingPlanId: 777 }),
    null
  );
  assert.equal(
    harness.api.encodeEntry({ variantId: 1000, productHandle: 'chain', quantity: 1, properties: { engraving: 'A' }, sellingPlanId: 777 }),
    null
  );
  harness.dom.window.close();
});

test('save-for-later preserves Unicode and special-property values locally while keeping them out of legacy sync', () => {
  const harness = saveForLaterHarness();

  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 1,
    properties: {
      message: 'Cafe "special" & snowman ☃',
      owner: "O'Neil",
      empty: '',
    },
  });

  const saved = harness.api.readAll()[0];
  assert.equal(saved.properties.message, 'Cafe "special" & snowman ☃');
  assert.equal(saved.properties.owner, "O'Neil");
  assert.equal(saved.properties.empty, undefined);
  assert.equal(harness.api.encodeList(harness.api.readAll()).length, 0);
  harness.dom.window.close();
});

test('save-for-later merges quantities only when full line identity matches', () => {
  const harness = saveForLaterHarness();

  const item = {
    variantId: 1000,
    productHandle: 'chain',
    quantity: 1,
    properties: { engraving: 'A' },
    sellingPlanId: 333,
  };

  harness.api.save(item);
  harness.api.save({ ...item, quantity: 2 });

  const saved = harness.api.readAll();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].quantity, 3);
  assert.equal(harness.api.encodeList(saved).length, 0);
  harness.dom.window.close();
});

test('save-for-later restore payload preserves private underscore properties', () => {
  const harness = saveForLaterHarness();
  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 1,
    properties: { _bundle: 'abc123', engraving: 'ALEX' },
  });

  const saved = harness.api.readAll()[0];
  const payload = harness.api.buildCartAddItem(saved, saved.quantity);
  assert.equal(payload.properties._bundle, 'abc123');
  assert.equal(payload.properties.engraving, 'ALEX');
  harness.dom.window.close();
});

test('save-for-later restore payload preserves personalized properties', () => {
  const harness = saveForLaterHarness();
  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 2,
    properties: { 'Custom Text': 'ALEX' },
  });

  const saved = harness.api.readAll()[0];
  const payload = harness.api.buildCartAddItem(saved, saved.quantity);
  assert.equal(payload.properties['Custom Text'], 'ALEX');
  assert.equal(payload.quantity, 2);
  harness.dom.window.close();
});

test('save-for-later restore payload preserves selling plan identity', () => {
  const harness = saveForLaterHarness();
  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 1,
    sellingPlanId: 777,
  });

  const saved = harness.api.readAll()[0];
  const payload = harness.api.buildCartAddItem(saved, saved.quantity);
  assert.equal(payload.selling_plan, 777);
  harness.dom.window.close();
});

test('save-for-later cart/add payload never sends client-side price fields', async () => {
  const harness = saveForLaterHarness({
    fetchImpl: async (request) => {
      if (request.url.includes('/cart/add.js')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ items: [] }) };
    },
  });

  const lineItem = harness.api.buildCartAddItem({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 3,
    properties: { engraving: 'ALEX' },
    sellingPlanId: 444,
    price: 99999,
    compareAt: 123456,
  }, 3);

  await harness.api.addItemsToCart([lineItem]);

  const request = harness.requests.find((entry) => entry.url.includes('/cart/add.js'));
  const body = JSON.parse(request.init.body);
  assert.equal(body.items[0].price, undefined);
  assert.equal(body.items[0].compareAt, undefined);
  assert.equal(body.items[0].final_price, undefined);
  assert.deepEqual(body.items[0].properties, { engraving: 'ALEX' });
  assert.equal(body.items[0].selling_plan, 444);
  harness.dom.window.close();
});

test('save-for-later inventory correction uses line keys instead of variant update maps', async () => {
  const harness = saveForLaterHarness({
    fetchImpl: async (request) => {
      if (request.url.includes('/cart.js')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { key: 'line-a', variant_id: 1000, quantity: 5, handle: 'chain' },
              { key: 'line-b', variant_id: 1000, quantity: 2, handle: 'chain' },
            ],
          }),
        };
      }
      if (request.url.includes('/products/chain.js')) {
        return {
          ok: true,
          json: async () => ({
            variants: [{ id: 1000, inventory_management: 'shopify', inventory_policy: 'deny', inventory_quantity: 1 }],
          }),
        };
      }
      if (request.url.includes('/cart/change.js')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });

  await harness.api.validateCartInventoryOnLoad();

  const changeCalls = harness.requests.filter((request) => request.url.includes('/cart/change.js'));
  const updateCalls = harness.requests.filter((request) => request.url.includes('/cart/update.js'));
  assert.equal(changeCalls.length, 2);
  assert.equal(updateCalls.length, 0);
  assert.deepEqual(
    changeCalls.map((request) => JSON.parse(request.init.body)),
    [
      { id: 'line-a', quantity: 1 },
      { id: 'line-b', quantity: 0 },
    ]
  );
  harness.dom.window.close();
});

test('save-for-later server hydration preserves distinct local metadata identities for same-variant legacy rows', async () => {
  const harness = saveForLaterHarness();

  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 1,
    properties: { engraving: 'A' },
  });
  harness.api.save({
    variantId: 1000,
    productHandle: 'chain',
    quantity: 2,
    properties: { engraving: 'B' },
  });

  const local = harness.api.readAll();
  const hydrated = await harness.api.rehydrateFromEncoded(['1000|1|chain', '1000|2|chain']);
  const merged = harness.api.mergeServerHydratedWithLocalMetadata(hydrated, local);

  assert.equal(merged.length, 3);
  const engravings = merged
    .map((item) => item.properties && item.properties.engraving)
    .filter(Boolean)
    .sort();
  assert.equal(engravings[0], 'A');
  assert.equal(engravings[1], 'B');

  const simple = merged.find((item) => !item.properties || Object.keys(item.properties).length === 0);
  assert(simple);
  assert.equal(simple.quantity, 3);
  harness.dom.window.close();
});

test('save-for-later mixed legacy and metadata records do not collapse on lossy-backend fallback', async () => {
  const harness = saveForLaterHarness();

  harness.api.writeAll([
    { variantId: 1000, productHandle: 'chain', quantity: 1, title: 'Legacy' },
    { variantId: 1000, productHandle: 'chain', quantity: 1, properties: { engraving: 'A' }, title: 'Custom A' },
    { variantId: 1000, productHandle: 'chain', quantity: 2, properties: { engraving: 'B' }, title: 'Custom B' },
  ], { skipSync: true });

  const local = harness.api.readAll();
  const encoded = harness.api.encodeList(local);
  assert.equal(encoded.length, 1);
  assert.equal(encoded[0], '1000|1|chain');

  const hydrated = await harness.api.rehydrateFromEncoded(encoded);
  const merged = harness.api.mergeServerHydratedWithLocalMetadata(hydrated, local);

  assert.equal(merged.length, 3);
  const identities = merged.map((item) => harness.api.itemIdentityKey(item));
  assert.equal(new Set(identities).size, 3);
  harness.dom.window.close();
});

function loadLineIdentityPlanner() {
  const block = source('assets/global.js').match(/function cartRootPath\(\) \{[\s\S]*?window\.BSCartLineIdentity = \{[\s\S]*?\};/);
  assert(block, 'Expected line identity helper block in assets/global.js');
  const context = { window: {} };
  vm.runInNewContext(block[0], context);
  return context.window.BSCartLineIdentity.buildLineAwareUpdatePlan;
}

test('bulk line-identity planner flags ambiguous split variants', () => {
  const planner = loadLineIdentityPlanner();
  const plan = planner(
    [
      { variant_id: 1000, key: 'line-a', quantity: 1, properties: { 'Custom Text': 'A' } },
      { variant_id: 1000, key: 'line-b', quantity: 1, properties: { 'Custom Text': 'B' } },
    ],
    { 1000: 3 }
  );

  assert.equal(plan.lineUpdates.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].variantId, '1000');
});

test('bulk line-identity planner preserves simple one-line behavior', () => {
  const planner = loadLineIdentityPlanner();
  const plan = planner([{ variant_id: 1000, key: 'line-a', quantity: 1, properties: {} }], { 1000: 4 });

  assert.equal(plan.conflicts.length, 0);
  assert.equal(Object.keys(plan.variantUpdates).length, 0);
  assert.equal(plan.lineUpdates.length, 1);
  assert.equal(plan.lineUpdates[0].id, 'line-a');
  assert.equal(plan.lineUpdates[0].quantity, 4);
  assert.equal(plan.lineUpdates[0].variantId, '1000');
});

test('bulk line-identity planner can adjust base line without mutating customized lines', () => {
  const planner = loadLineIdentityPlanner();
  const plan = planner(
    [
      { variant_id: 1000, key: 'line-base', quantity: 2, properties: {} },
      { variant_id: 1000, key: 'line-custom', quantity: 1, properties: { engraving: 'A' } },
    ],
    { 1000: 5 }
  );

  assert.equal(plan.conflicts.length, 0);
  assert.equal(Object.keys(plan.variantUpdates).length, 0);
  assert.equal(plan.lineUpdates.length, 1);
  assert.equal(plan.lineUpdates[0].id, 'line-base');
  assert.equal(plan.lineUpdates[0].quantity, 4);
  assert.equal(plan.lineUpdates[0].variantId, '1000');
});

test('quick-order and quick-add use line-identity-safe mutation path', () => {
  assert(source('assets/quick-order-list.js').includes('applyVariantUpdatesWithLineIdentity'));
  assert(source('assets/quick-add-bulk.js').includes('applyVariantUpdatesWithLineIdentity'));
});