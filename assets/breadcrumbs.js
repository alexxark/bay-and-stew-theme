(function() {
  var COLLECTION_STATE_DEBUG = window.COLLECTION_STATE_DEBUG === true;
  var STORAGE_PREFIX = 'bs:collection-state:v1:';
  var PRODUCT_CONTEXT_KEY = 'bs:product-collection-context:v1';
  var ACTIVE_PRODUCT_CONTEXT_KEY = 'bs:active-product-context:v1';
  var RETURN_INTENT_KEY = 'bs:collection-return-intent:v1';
  var PRODUCT_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  var ACTIVE_PRODUCT_CONTEXT_MAX_AGE_MS = 60 * 60 * 1000;
  var RETURN_INTENT_MAX_AGE_MS = 45 * 60 * 1000;

  function debugLog(message, payload) {
    if (!COLLECTION_STATE_DEBUG) return;
    if (typeof payload === 'undefined') {
      console.info('[Collection State] ' + message);
    } else {
      console.info('[Collection State] ' + message, payload);
    }
  }

  function breadcrumbLog(message, payload) {
    if (!COLLECTION_STATE_DEBUG) return;
    if (typeof payload === 'undefined') {
      console.info('[Breadcrumbs] ' + message);
    } else {
      console.info('[Breadcrumbs] ' + message, payload);
    }
  }

  function safeParseJSON(raw, fallback) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function readSessionItem(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeSessionItem(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function removeSessionItem(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function normalizeProductPath(urlString) {
    if (!urlString) return '';
    try {
      var parsed = new URL(urlString, window.location.origin);
      return parsed.pathname.replace(/\/+$/, '') || parsed.pathname;
    } catch (error) {
      return '';
    }
  }

  function normalizeCollectionUrl(urlString) {
    if (!urlString) return '';
    try {
      var parsed = new URL(urlString, window.location.origin);
      var params = new URLSearchParams(parsed.search);
      params.sort();
      var sortedSearch = params.toString();
      return parsed.pathname + (sortedSearch ? '?' + sortedSearch : '');
    } catch (error) {
      return '';
    }
  }

  function readContextMap() {
    var parsed = safeParseJSON(readSessionItem(PRODUCT_CONTEXT_KEY), {});
    if (!parsed || typeof parsed !== 'object') return {};

    var now = Date.now();
    var changed = false;
    Object.keys(parsed).forEach(function(key) {
      var item = parsed[key];
      if (!item || !item.timestamp || now - item.timestamp > PRODUCT_CONTEXT_MAX_AGE_MS) {
        delete parsed[key];
        changed = true;
      }
    });

    if (changed) {
      writeSessionItem(PRODUCT_CONTEXT_KEY, JSON.stringify(parsed));
    }

    return parsed;
  }

  function isCollectionUrl(urlString) {
    if (!urlString) return false;
    try {
      var parsed = new URL(urlString, window.location.origin);
      return parsed.origin === window.location.origin && /^\/collections\//.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function readActiveProductContext() {
    var parsed = safeParseJSON(readSessionItem(ACTIVE_PRODUCT_CONTEXT_KEY), null);
    if (!parsed || typeof parsed !== 'object') return null;

    var timestamp = Number(parsed.timestamp || 0);
    if (!timestamp || Date.now() - timestamp > ACTIVE_PRODUCT_CONTEXT_MAX_AGE_MS) {
      removeSessionItem(ACTIVE_PRODUCT_CONTEXT_KEY);
      return null;
    }

    if (!parsed.productPath || !isCollectionUrl(parsed.collectionUrl)) return null;
    return parsed;
  }

  function getCollectionReferrerUrl() {
    if (!document.referrer) return '';
    try {
      var ref = new URL(document.referrer);
      if (ref.origin !== window.location.origin) return '';
      if (!/^\/collections\//.test(ref.pathname)) return '';
      return normalizeCollectionUrl(ref.pathname + ref.search);
    } catch (error) {
      return '';
    }
  }

  function resolveCollectionContext(productPath) {
    var activeContext = readActiveProductContext();
    if (activeContext && normalizeProductPath(activeContext.productPath) === productPath) {
      return {
        collectionUrl: normalizeCollectionUrl(activeContext.collectionUrl),
        collectionTitle: activeContext.collectionTitle || '',
        source: 'active'
      };
    }

    var referrerCollectionUrl = getCollectionReferrerUrl();
    if (!referrerCollectionUrl) {
      return null;
    }

    var contextMap = readContextMap();
    var mapped = contextMap[productPath];
    if (mapped && isCollectionUrl(mapped.collectionUrl)) {
      var mappedUrl = normalizeCollectionUrl(mapped.collectionUrl);
      var mappedPath = mappedUrl.split('?')[0];
      var refPath = referrerCollectionUrl.split('?')[0];
      if (mappedPath === refPath) {
        return {
          collectionUrl: mappedUrl,
          collectionTitle: mapped.collectionTitle || '',
          source: 'map'
        };
      }
    }

    return {
      collectionUrl: referrerCollectionUrl,
      collectionTitle: '',
      source: 'referrer'
    };
  }

  function setBreadcrumbReturnIntent(collectionUrl, collectionTitle, productPath) {
    if (!collectionUrl) return;

    var normalizedCollectionUrl = normalizeCollectionUrl(collectionUrl);
    if (!normalizedCollectionUrl) return;

    writeSessionItem(
      RETURN_INTENT_KEY,
      JSON.stringify({
        collectionKey: STORAGE_PREFIX + normalizedCollectionUrl,
        collectionUrl: normalizedCollectionUrl,
        collectionTitle: collectionTitle || '',
        productPath: productPath || '',
        mode: 'breadcrumb',
        timestamp: Date.now()
      })
    );
  }

  function canUseHistoryBackForCollectionReturn(collectionUrl, productPath) {
    if (!collectionUrl || window.history.length < 2) return false;

    var normalizedTargetUrl = normalizeCollectionUrl(collectionUrl);
    if (!normalizedTargetUrl) return false;

    var referrerCollectionUrl = getCollectionReferrerUrl();
    if (!referrerCollectionUrl || referrerCollectionUrl !== normalizedTargetUrl) {
      return false;
    }

    var activeContext = readActiveProductContext();
    if (activeContext) {
      var activeProductPath = normalizeProductPath(activeContext.productPath || '');
      var activeCollectionUrl = normalizeCollectionUrl(activeContext.collectionUrl || '');
      if (activeProductPath && activeProductPath !== productPath) return false;
      if (activeCollectionUrl && activeCollectionUrl !== normalizedTargetUrl) return false;
    }

    return true;
  }

  function pruneReturnIntent() {
    var intent = safeParseJSON(readSessionItem(RETURN_INTENT_KEY), null);
    if (!intent || typeof intent !== 'object') return;

    var timestamp = Number(intent.timestamp || 0);
    if (!timestamp || Date.now() - timestamp > RETURN_INTENT_MAX_AGE_MS) {
      removeSessionItem(RETURN_INTENT_KEY);
    }
  }

  function updateProductBreadcrumb(nav) {
    var productPath = normalizeProductPath(nav.getAttribute('data-product-path'));
    if (!productPath) return;

    var context = resolveCollectionContext(productPath);
    if (!context || !isCollectionUrl(context.collectionUrl)) return;

    var collectionItem = nav.querySelector('[data-breadcrumb-collection-item]');
    var collectionLink = nav.querySelector('[data-breadcrumb-collection-link]');
    if (!collectionItem || !collectionLink) return;

    collectionLink.setAttribute('href', context.collectionUrl);
    if (context.collectionTitle) {
      collectionLink.textContent = context.collectionTitle;
    }
    collectionItem.hidden = false;

    collectionLink.addEventListener('click', function(event) {
      var targetCollectionUrl = collectionLink.getAttribute('href');
      setBreadcrumbReturnIntent(targetCollectionUrl, collectionLink.textContent, productPath);

      if (canUseHistoryBackForCollectionReturn(targetCollectionUrl, productPath)) {
        breadcrumbLog('Attempting history back for collection return');
        event.preventDefault();
        window.history.back();
        return;
      }

      breadcrumbLog('History back not safe, using href');
      breadcrumbLog('Breadcrumb return using fresh collection restore');
    });
  }

  function initBreadcrumbs() {
    pruneReturnIntent();
    document.querySelectorAll('[data-breadcrumb-type="product"]').forEach(function(nav) {
      updateProductBreadcrumb(nav);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBreadcrumbs);
  } else {
    initBreadcrumbs();
  }
})();
