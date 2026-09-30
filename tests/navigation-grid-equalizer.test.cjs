const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const equalizer = require('../assets/navigation-grid-equalizer.js');

function textCard(label) {
  return `
    <li class="navigation-grid__block">
      <a class="navigation-grid__card navigation-grid__card--text-only" href="#${label}">
        <span class="navigation-grid__card-content"><span class="navigation-grid__title">${label}</span></span>
      </a>
    </li>
  `;
}

function imageCard(label) {
  return `
    <li class="navigation-grid__block">
      <a class="navigation-grid__card" href="#${label}">
        <span class="navigation-grid__media"><img class="navigation-grid__media-image" alt="" /></span>
        <span class="navigation-grid__card-content"><span class="navigation-grid__title">${label}</span></span>
      </a>
    </li>
  `;
}

function createHarness(sectionId, cardsHtml) {
  const dom = new JSDOM(`
    <div id="shopify-section-${sectionId}">
      <div class="navigation-grid">
        <ul class="navigation-grid__list" role="list">${cardsHtml}</ul>
      </div>
    </div>
  `, {
    url: 'https://example.test',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  window.ResizeObserver = undefined;

  const section = window.document.getElementById(`shopify-section-${sectionId}`);
  return { dom, window, document: window.document, section };
}

function makeRect(height) {
  return {
    height,
    width: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  };
}

function bindNaturalHeights(cards, valuesRef) {
  cards.forEach((card, index) => {
    card.getBoundingClientRect = () => {
      const applied = Number.parseFloat(card.style.minHeight);
      const natural = valuesRef.values[index] || 0;
      if (Number.isFinite(applied)) {
        return makeRect(Math.max(applied, natural));
      }
      return makeRect(natural);
    };
  });
}

function assertGroupMinHeight(cards, expectedPx) {
  cards.forEach((card) => {
    assert.equal(card.style.minHeight, `${expectedPx}px`);
  });
}

test('all text-only cards receive the same equalized height', () => {
  const harness = createHarness('text-only', [
    textCard('SHOP ALL'),
    textCard('CHAINS BY METAL'),
    textCard('SHOP BY STYLE'),
    textCard('CHAIN SAMPLES & PACKS'),
  ].join(''));

  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card--text-only'));
  const textHeights = { values: [74, 74, 76, 102] };
  bindNaturalHeights(cards, textHeights);

  const result = equalizer.equalizeSection(harness.section);
  assert.equal(result.textOnlyCount, 4);
  assert.equal(result.textOnlyMax, 102);
  assertGroupMinHeight(cards, 102);

  harness.dom.window.close();
});

test('all image cards receive the same equalized height', () => {
  const harness = createHarness('image-only', [
    imageCard('BAR & LINK CHAINS'),
    imageCard('LONG AND SHORT CHAINS'),
    imageCard('ROLO CHAINS'),
  ].join(''));

  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card:not(.navigation-grid__card--text-only)'));
  const imageHeights = { values: [248, 276, 252] };
  bindNaturalHeights(cards, imageHeights);

  const result = equalizer.equalizeSection(harness.section);
  assert.equal(result.imageCount, 3);
  assert.equal(result.imageMax, 276);
  assertGroupMinHeight(cards, 276);

  harness.dom.window.close();
});

test('image and text-only groups are equalized independently', () => {
  const harness = createHarness('mixed', [
    imageCard('BAR & LINK CHAINS'),
    textCard('SHOP ALL'),
    imageCard('LONG AND SHORT CHAINS'),
    textCard('CHAIN SAMPLES & PACKS'),
  ].join(''));

  const imageCards = Array.from(harness.section.querySelectorAll('.navigation-grid__card:not(.navigation-grid__card--text-only)'));
  const textCards = Array.from(harness.section.querySelectorAll('.navigation-grid__card--text-only'));

  bindNaturalHeights(imageCards, { values: [240, 266] });
  bindNaturalHeights(textCards, { values: [72, 98] });

  equalizer.equalizeSection(harness.section);

  assertGroupMinHeight(imageCards, 266);
  assertGroupMinHeight(textCards, 98);

  harness.dom.window.close();
});

test('two navigation grid sections equalize independently', () => {
  const dom = new JSDOM(`
    <div id="shopify-section-A">
      <div class="navigation-grid">
        <ul class="navigation-grid__list">
          ${textCard('A1')}
          ${textCard('A2')}
        </ul>
      </div>
    </div>
    <div id="shopify-section-B">
      <div class="navigation-grid">
        <ul class="navigation-grid__list">
          ${textCard('B1')}
          ${textCard('B2')}
        </ul>
      </div>
    </div>
  `, { url: 'https://example.test', pretendToBeVisual: true });

  const { window } = dom;
  window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  window.ResizeObserver = undefined;

  const sectionA = window.document.getElementById('shopify-section-A');
  const sectionB = window.document.getElementById('shopify-section-B');

  const cardsA = Array.from(sectionA.querySelectorAll('.navigation-grid__card--text-only'));
  const cardsB = Array.from(sectionB.querySelectorAll('.navigation-grid__card--text-only'));

  bindNaturalHeights(cardsA, { values: [70, 95] });
  bindNaturalHeights(cardsB, { values: [62, 78] });

  equalizer.initAllNavigationGridEqualizers(window.document);

  assertGroupMinHeight(cardsA, 95);
  assertGroupMinHeight(cardsB, 78);

  dom.window.close();
});

test('recalculation clears old min-height before measuring', () => {
  const harness = createHarness('recalc-clear', [textCard('ONE'), textCard('TWO')].join(''));
  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card--text-only'));

  const heights = { values: [120, 100] };
  bindNaturalHeights(cards, heights);

  equalizer.equalizeSection(harness.section);
  assertGroupMinHeight(cards, 120);

  heights.values = [80, 60];
  equalizer.equalizeSection(harness.section);
  assertGroupMinHeight(cards, 80);

  harness.dom.window.close();
});

test('resize triggers recalculation', () => {
  const harness = createHarness('resize', [textCard('ONE'), textCard('TWO')].join(''));
  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card--text-only'));
  const heights = { values: [78, 92] };
  bindNaturalHeights(cards, heights);

  const cleanup = equalizer.initNavigationGridEqualizer(harness.section, {
    window: harness.window,
    document: harness.document,
  });

  assertGroupMinHeight(cards, 92);

  heights.values = [114, 103];
  harness.window.dispatchEvent(new harness.window.Event('resize'));

  assertGroupMinHeight(cards, 114);

  cleanup();
  harness.dom.window.close();
});

test('shopify section lifecycle event triggers recalculation', () => {
  const harness = createHarness('lifecycle', [textCard('ONE'), textCard('TWO')].join(''));
  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card--text-only'));
  const heights = { values: [86, 101] };
  bindNaturalHeights(cards, heights);

  const cleanup = equalizer.initNavigationGridEqualizer(harness.section, {
    window: harness.window,
    document: harness.document,
  });

  assertGroupMinHeight(cards, 101);

  heights.values = [130, 108];
  harness.document.dispatchEvent(new harness.window.CustomEvent('shopify:section:load', {
    detail: { sectionId: 'lifecycle' },
  }));

  assertGroupMinHeight(cards, 130);

  cleanup();
  harness.dom.window.close();
});

test('image load event triggers recalculation for image cards', () => {
  const harness = createHarness('image-load', [imageCard('ONE'), imageCard('TWO')].join(''));
  const cards = Array.from(harness.section.querySelectorAll('.navigation-grid__card:not(.navigation-grid__card--text-only)'));
  const images = Array.from(harness.section.querySelectorAll('.navigation-grid__media-image'));
  const heights = { values: [220, 220] };
  bindNaturalHeights(cards, heights);

  const cleanup = equalizer.initNavigationGridEqualizer(harness.section, {
    window: harness.window,
    document: harness.document,
  });

  assertGroupMinHeight(cards, 220);

  heights.values = [260, 230];
  images[0].dispatchEvent(new harness.window.Event('load'));

  assertGroupMinHeight(cards, 260);

  cleanup();
  harness.dom.window.close();
});
