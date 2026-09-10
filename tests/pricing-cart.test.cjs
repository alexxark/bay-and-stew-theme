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

function cartUIHarness() {
  const dom = new JSDOM(`
    <cart-drawer><div id="CartDrawer"><div class="drawer__inner">old drawer</div></div></cart-drawer>
    <div id="cart-icon-bubble">old count</div>
    <cart-items><div id="main-cart-items" data-id="main-cart-items"><div class="js-contents">old lines</div></div></cart-items>
    <div id="main-cart-footer" data-id="main-cart-footer"><div class="js-contents"><span class="totals__total-value">old total</span></div></div>
    <div id="cart-live-region-text">old accessible total</div><div id="cart-errors"></div>
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
  assert(script.includes('window.BSCartUI?.beginBatch()'));
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