(() => {
  const SECTION_SELECTOR = '[id^="shopify-section-"]';
  const GRID_SELECTOR = '.navigation-grid';
  const LIST_SELECTOR = '.navigation-grid__list';
  const CARD_SELECTOR = '.navigation-grid__card';
  const PLACEHOLDER_CLASS = 'navigation-grid__card--placeholder';
  const TEXT_ONLY_CLASS = 'navigation-grid__card--text-only';
  const IMAGE_SELECTOR = '.navigation-grid__media-image';

  const sectionIdFromElement = (sectionElement) => {
    if (!sectionElement || !sectionElement.id) return '';
    return sectionElement.id.startsWith('shopify-section-')
      ? sectionElement.id.slice('shopify-section-'.length)
      : '';
  };

  const asArray = (value) => Array.prototype.slice.call(value || []);

  const getCards = (sectionElement) =>
    asArray(sectionElement.querySelectorAll(`${GRID_SELECTOR} ${CARD_SELECTOR}`)).filter(
      (card) => !card.classList.contains(PLACEHOLDER_CLASS)
    );

  const splitCardGroups = (sectionElement) => {
    const imageCards = [];
    const textOnlyCards = [];

    getCards(sectionElement).forEach((card) => {
      if (card.classList.contains(TEXT_ONLY_CLASS)) {
        textOnlyCards.push(card);
      } else {
        imageCards.push(card);
      }
    });

    return { imageCards, textOnlyCards };
  };

  const clearEqualizedHeight = (cards) => {
    cards.forEach((card) => {
      card.style.minHeight = '';
    });
  };

  const maxNaturalHeight = (cards) => {
    let maxHeight = 0;
    cards.forEach((card) => {
      const height = card.getBoundingClientRect().height;
      if (height > maxHeight) maxHeight = height;
    });
    return Math.ceil(maxHeight);
  };

  const applyEqualizedHeight = (cards, height) => {
    if (!height) return;
    const value = `${height}px`;
    cards.forEach((card) => {
      card.style.minHeight = value;
    });
  };

  const equalizeCardGroup = (cards) => {
    clearEqualizedHeight(cards);
    const height = maxNaturalHeight(cards);
    applyEqualizedHeight(cards, height);
    return height;
  };

  const equalizeSection = (sectionElement) => {
    if (!sectionElement) {
      return { imageMax: 0, textOnlyMax: 0, imageCount: 0, textOnlyCount: 0 };
    }

    const { imageCards, textOnlyCards } = splitCardGroups(sectionElement);
    const imageMax = equalizeCardGroup(imageCards);
    const textOnlyMax = equalizeCardGroup(textOnlyCards);

    return {
      imageMax,
      textOnlyMax,
      imageCount: imageCards.length,
      textOnlyCount: textOnlyCards.length,
    };
  };

  const eventTargetsSection = (event, sectionElement) => {
    if (!event || !sectionElement) return false;

    const sectionId = sectionIdFromElement(sectionElement);
    if (event.detail && event.detail.sectionId) {
      return event.detail.sectionId === sectionId;
    }

    if (event.target && typeof event.target.closest === 'function') {
      const matched = event.target.closest(SECTION_SELECTOR);
      return matched === sectionElement;
    }

    return false;
  };

  const bindImageLoadListeners = (sectionElement, onImageEvent) => {
    asArray(sectionElement.querySelectorAll(`${GRID_SELECTOR} ${IMAGE_SELECTOR}`)).forEach((image) => {
      if (image.dataset.navigationGridEqBound === 'true') return;
      image.dataset.navigationGridEqBound = 'true';
      image.addEventListener('load', onImageEvent);
      image.addEventListener('error', onImageEvent);
    });
  };

  const initNavigationGridEqualizer = (sectionElement, options = {}) => {
    if (!sectionElement) return () => {};
    if (sectionElement.dataset.navigationGridEqualizer === 'true') {
      return sectionElement.__navigationGridEqualizerCleanup || (() => {});
    }

    const windowRef = options.window || window;
    const documentRef = options.document || document;
    const listElement = sectionElement.querySelector(LIST_SELECTOR);
    const gridElement = sectionElement.querySelector(GRID_SELECTOR);

    if (!listElement || !gridElement) return () => {};

    sectionElement.dataset.navigationGridEqualizer = 'true';

    let animationFrame = 0;
    let resizeObserver;
    let mutationObserver;

    const requestEqualize = () => {
      if (animationFrame) windowRef.cancelAnimationFrame(animationFrame);
      animationFrame = windowRef.requestAnimationFrame(() => {
        animationFrame = 0;
        equalizeSection(sectionElement);
      });
    };

    const handleImageEvent = () => requestEqualize();
    bindImageLoadListeners(sectionElement, handleImageEvent);

    if (windowRef.ResizeObserver) {
      resizeObserver = new windowRef.ResizeObserver(() => requestEqualize());
      resizeObserver.observe(gridElement);
    } else {
      windowRef.addEventListener('resize', requestEqualize);
    }

    mutationObserver = new windowRef.MutationObserver(() => {
      bindImageLoadListeners(sectionElement, handleImageEvent);
      requestEqualize();
    });
    mutationObserver.observe(listElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    const documentEvents = [
      'shopify:section:load',
      'shopify:section:reorder',
      'shopify:block:select',
      'shopify:block:deselect',
      'shopify:block:reorder',
    ];

    const handleDocumentEvent = (event) => {
      if (eventTargetsSection(event, sectionElement)) {
        requestEqualize();
      }
    };

    documentEvents.forEach((eventName) => {
      documentRef.addEventListener(eventName, handleDocumentEvent);
    });

    windowRef.addEventListener('load', requestEqualize);
    requestEqualize();

    const cleanup = () => {
      if (animationFrame) windowRef.cancelAnimationFrame(animationFrame);

      documentEvents.forEach((eventName) => {
        documentRef.removeEventListener(eventName, handleDocumentEvent);
      });

      windowRef.removeEventListener('load', requestEqualize);

      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        windowRef.removeEventListener('resize', requestEqualize);
      }

      if (mutationObserver) mutationObserver.disconnect();

      asArray(sectionElement.querySelectorAll(`${GRID_SELECTOR} ${IMAGE_SELECTOR}`)).forEach((image) => {
        if (image.dataset.navigationGridEqBound === 'true') {
          image.removeEventListener('load', handleImageEvent);
          image.removeEventListener('error', handleImageEvent);
          delete image.dataset.navigationGridEqBound;
        }
      });

      const { imageCards, textOnlyCards } = splitCardGroups(sectionElement);
      clearEqualizedHeight(imageCards);
      clearEqualizedHeight(textOnlyCards);

      delete sectionElement.dataset.navigationGridEqualizer;
      delete sectionElement.__navigationGridEqualizerCleanup;
    };

    sectionElement.__navigationGridEqualizerCleanup = cleanup;
    return cleanup;
  };

  const initAllNavigationGridEqualizers = (root = document) => {
    asArray(root.querySelectorAll(`${SECTION_SELECTOR} ${GRID_SELECTOR}`)).forEach((grid) => {
      const sectionElement = grid.closest(SECTION_SELECTOR);
      initNavigationGridEqualizer(sectionElement, {
        window: root.defaultView || window,
        document: root,
      });
    });
  };

  const api = {
    splitCardGroups,
    clearEqualizedHeight,
    equalizeCardGroup,
    equalizeSection,
    initNavigationGridEqualizer,
    initAllNavigationGridEqualizers,
    eventTargetsSection,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  window.NavigationGridEqualizer = api;

  if (!window.__navigationGridEqualizerBootstrapped) {
    window.__navigationGridEqualizerBootstrapped = true;

    const initDocument = () => initAllNavigationGridEqualizers(document);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDocument, { once: true });
    } else {
      initDocument();
    }

    document.addEventListener('shopify:section:load', (event) => {
      const sectionId = event.detail && event.detail.sectionId;
      if (!sectionId) return;
      const sectionElement = document.getElementById(`shopify-section-${sectionId}`);
      if (sectionElement) {
        initNavigationGridEqualizer(sectionElement);
      }
    });

    document.addEventListener('shopify:section:unload', (event) => {
      const sectionId = event.detail && event.detail.sectionId;
      const fallbackSection = event.target && typeof event.target.closest === 'function'
        ? event.target.closest(SECTION_SELECTOR)
        : null;
      const sectionElement = sectionId
        ? document.getElementById(`shopify-section-${sectionId}`)
        : fallbackSection;

      if (sectionElement && sectionElement.__navigationGridEqualizerCleanup) {
        sectionElement.__navigationGridEqualizerCleanup();
      }
    });
  }
})();
