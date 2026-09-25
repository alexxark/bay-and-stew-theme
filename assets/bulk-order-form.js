(function () {
  const DEBUG_KEY = 'bulkOrderDebug';
  const DEFAULT_MONEY_FORMAT = '${{amount}}';

  function toInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeQuantityMax(min, step, max) {
    if (max === null) return null;

    const safeStep = step > 0 ? step : 1;
    if (max < min) return max;

    const distanceFromMin = max - min;
    const stepsFromMin = Math.floor(distanceFromMin / safeStep);
    return min + stepsFromMin * safeStep;
  }

  function debugEnabled() {
    try {
      return window.localStorage?.getItem(DEBUG_KEY) === '1';
    } catch (_error) {
      return false;
    }
  }

  function debugLog(stage, payload) {
    if (!debugEnabled()) return;
    console.info('[bulk-order-debug]', stage, payload);
  }

  function getRoutes() {
    const root = window.Shopify?.routes?.root || '/';
    return {
      cartJson: root + 'cart.js',
      cartChange: (window.routes && window.routes.cart_change_url) || root + 'cart/change.js',
      cartUpdate: (window.routes && window.routes.cart_update_url) || root + 'cart/update.js',
    };
  }

  function pickActiveVolumeRule(volumeRules, productTags) {
    const safeRules = Array.isArray(volumeRules) ? volumeRules : [];
    const tagSet = new Set((Array.isArray(productTags) ? productTags : []).map((tag) => String(tag).toLowerCase()));
    return safeRules.find((rule) => {
      const ruleTag = String(rule?.tag || '').toLowerCase();
      return ruleTag && tagSet.has(ruleTag);
    }) || null;
  }

  function getTierQuantityForLookup(projectedTotal, tiers) {
    const normalizedProjectedTotal = Math.max(0, toInt(projectedTotal) || 0);
    if (normalizedProjectedTotal > 0) return normalizedProjectedTotal;

    const tierMins = (Array.isArray(tiers) ? tiers : [])
      .map((tier) => toInt(tier?.from))
      .filter((value) => value !== null && value > 0);
    if (!tierMins.length) return 1;

    return Math.min.apply(null, tierMins);
  }

  function findVolumePercentForQuantity(tiers, quantity) {
    const lookupQuantity = Math.max(0, toInt(quantity) || 0);
    const safeTiers = Array.isArray(tiers) ? tiers : [];

    const matchedTier = safeTiers.find((tier) => {
      const from = toFiniteNumber(tier?.from, 0);
      const to = (tier?.to == null || tier.to === '') ? Infinity : toFiniteNumber(tier.to, Infinity);
      return lookupQuantity >= from && lookupQuantity <= to;
    });

    return matchedTier ? toFiniteNumber(matchedTier.percent, 0) : 0;
  }

  function fallbackFormatMoney(cents, moneyFormat) {
    const format = moneyFormat || DEFAULT_MONEY_FORMAT;
    const placeholderRegex = /\{\{\s*(\w+)\s*\}\}/;
    const number = toFiniteNumber(cents, 0);

    const withDelimiters = (value, precision = 2, thousands = ',', decimal = '.') => {
      const parsed = toFiniteNumber(value, 0);
      const parts = (parsed / 100.0).toFixed(precision).split('.');
      parts[0] = parts[0].replace(/(\d)(?=(\d\d\d)+(?!\d))/g, `$1${thousands}`);
      return parts.join(decimal);
    };

    const match = format.match(placeholderRegex);
    const placeholder = match ? match[1] : 'amount';
    let value;

    switch (placeholder) {
      case 'amount_no_decimals':
        value = withDelimiters(number, 0);
        break;
      case 'amount_with_comma_separator':
        value = withDelimiters(number, 2, '.', ',');
        break;
      case 'amount_no_decimals_with_comma_separator':
        value = withDelimiters(number, 0, '.', ',');
        break;
      default:
        value = withDelimiters(number, 2);
        break;
    }

    return format.replace(placeholderRegex, value);
  }

  function formatMoney(cents, moneyFormat) {
    const normalizedCents = Math.round(toFiniteNumber(cents, 0));
    const format = moneyFormat || DEFAULT_MONEY_FORMAT;
    const shopifyFormatter = window.Shopify && typeof window.Shopify.formatMoney === 'function'
      ? window.Shopify.formatMoney
      : null;

    if (shopifyFormatter) {
      try {
        return String(shopifyFormatter(normalizedCents, format));
      } catch (_error) {
        // Fall through to local formatter.
      }
    }

    return fallbackFormatMoney(normalizedCents, format);
  }

  function setPriceContent(priceElement, formattedMoney) {
    const output = String(formattedMoney || '');

    if (!/[<>]/.test(output)) {
      priceElement.textContent = output;
      return;
    }

    const template = document.createElement('template');
    template.innerHTML = output;
    template.content.querySelectorAll('script').forEach((node) => node.remove());

    const hasElementNodes = Array.from(template.content.childNodes)
      .some((node) => node.nodeType === Node.ELEMENT_NODE);

    if (!hasElementNodes) {
      priceElement.textContent = output;
      return;
    }

    priceElement.replaceChildren();
    priceElement.append(template.content);
  }

  function markPricesPending(priceElements) {
    if (!priceElements || !priceElements.length) return;

    if (window.BSPriceState) {
      window.BSPriceState.setPending(priceElements, {
        busy: false,
        watchdogMs: 1000,
        onTimeout: () => {
          console.warn('[bulk-order] local price pending fail-open');
        },
      });
      return;
    }

    priceElements.forEach((priceElement) => {
      priceElement.dataset.priceState = 'pending';
    });
  }

  function markPricesReady(priceElements) {
    if (!priceElements || !priceElements.length) return;

    if (window.BSPriceState) {
      window.BSPriceState.setReady(priceElements, { clearBusy: true });
      return;
    }

    priceElements.forEach((priceElement) => {
      priceElement.dataset.priceState = 'ready';
    });
  }

  function readPricingConfig(root) {
    const fallback = {
      basePercent: 0,
      productTags: [],
      volumeRules: [],
      moneyFormat: DEFAULT_MONEY_FORMAT,
    };

    if (!root) return fallback;

    const directConfigId = String(root.dataset.pricingConfigId || '').trim();
    const derivedSectionId = String(root.id || '').startsWith('BulkOrderForm-')
      ? String(root.id).slice('BulkOrderForm-'.length)
      : '';
    const derivedConfigId = derivedSectionId ? `BulkOrderForm-Config-${derivedSectionId}` : '';

    const configElement = (directConfigId && document.getElementById(directConfigId))
      || (derivedConfigId && document.getElementById(derivedConfigId))
      || root.parentElement?.querySelector('script[type="application/json"][id^="BulkOrderForm-Config-"]')
      || null;

    if (!configElement) return fallback;

    try {
      const parsed = JSON.parse(configElement.textContent || '{}');
      return {
        basePercent: toFiniteNumber(parsed.basePercent, 0),
        productTags: Array.isArray(parsed.productTags) ? parsed.productTags : [],
        volumeRules: Array.isArray(parsed.volumeRules) ? parsed.volumeRules : [],
        moneyFormat: parsed.moneyFormat || DEFAULT_MONEY_FORMAT,
      };
    } catch (error) {
      console.warn('[bulk-order] Invalid pricing config JSON; falling back to base prices.', error);
      return fallback;
    }
  }

  function buildPricingContext(root) {
    const config = readPricingConfig(root);
    const activeRule = pickActiveVolumeRule(config.volumeRules, config.productTags);

    return {
      basePercent: toFiniteNumber(config.basePercent, 0),
      tiers: Array.isArray(activeRule?.tiers) ? activeRule.tiers : [],
      moneyFormat: config.moneyFormat || DEFAULT_MONEY_FORMAT,
      activeRuleTag: String(activeRule?.tag || ''),
    };
  }

  function computePreviewUnitPriceCents(originalPriceCents, pricingContext, projectedTotal) {
    const basePercent = toFiniteNumber(pricingContext?.basePercent, 0);
    const tiers = Array.isArray(pricingContext?.tiers) ? pricingContext.tiers : [];
    const tierLookupQuantity = getTierQuantityForLookup(projectedTotal, tiers);
    const volumePercent = findVolumePercentForQuantity(tiers, tierLookupQuantity);

    const baseMultiplier = 1 - (basePercent / 100);
    const volumeMultiplier = 1 - (volumePercent / 100);

    return toFiniteNumber(originalPriceCents, 0) * baseMultiplier * volumeMultiplier;
  }

  function getAllRowInputs(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.bulk-order-form__row .quantity__input'));
  }

  function getAggregateCurrentCartQuantity(root) {
    return getAllRowInputs(root).reduce((total, input) => {
      const row = input.closest('.bulk-order-form__row');
      const currentCartQuantity = Math.max(0, toInt(input?.dataset?.cartQuantity) ?? toInt(row?.dataset?.cartQuantity) ?? 0);
      return total + currentCartQuantity;
    }, 0);
  }

  function getAggregatePendingAddQuantity(root) {
    return getAllRowInputs(root).reduce((total, input) => {
      const pendingAddQuantity = Math.max(0, toInt(input?.value) || 0);
      return total + pendingAddQuantity;
    }, 0);
  }

  function getAggregateProjectedQuantity(root) {
    const aggregateCurrentCartQuantity = getAggregateCurrentCartQuantity(root);
    const aggregatePendingAddQuantity = getAggregatePendingAddQuantity(root);

    return {
      aggregateCurrentCartQuantity,
      aggregatePendingAddQuantity,
      aggregateProjectedQuantity: aggregateCurrentCartQuantity + aggregatePendingAddQuantity,
    };
  }

  function updateRowPrice(row, input, pricingContext, aggregatePricingState) {
    const priceElement = row?.querySelector('.price[data-original-price]');
    if (!priceElement) return;

    const originalPrice = toInt(priceElement.dataset.originalPrice);
    if (originalPrice === null) return;

    const aggregateCurrentCartQuantity = Math.max(0, toInt(aggregatePricingState?.aggregateCurrentCartQuantity) || 0);
    const aggregatePendingAddQuantity = Math.max(0, toInt(aggregatePricingState?.aggregatePendingAddQuantity) || 0);
    const aggregateProjectedQuantity = Math.max(0, toInt(aggregatePricingState?.aggregateProjectedQuantity) || 0);

    const previewCents = computePreviewUnitPriceCents(originalPrice, pricingContext, aggregateProjectedQuantity);

    priceElement.dataset.previewCents = String(Math.round(previewCents));
    priceElement.dataset.aggregateCurrentCartQuantity = String(aggregateCurrentCartQuantity);
    priceElement.dataset.aggregatePendingAddQuantity = String(aggregatePendingAddQuantity);
    priceElement.dataset.projectedTotal = String(aggregateProjectedQuantity);

    const formattedMoney = formatMoney(previewCents, pricingContext?.moneyFormat);
    setPriceContent(priceElement, formattedMoney);
  }

  function refreshAllPrices(root, pricingContext) {
    if (!root) return;

    const priceElements = Array.from(root.querySelectorAll('.price[data-original-price]'));
    if (!priceElements.length) return;

    const aggregatePricingState = getAggregateProjectedQuantity(root);

    markPricesPending(priceElements);
    try {
      root.querySelectorAll('.bulk-order-form__row').forEach((row) => {
        const input = row.querySelector('.quantity__input');
        if (!input) return;
        updateRowPrice(row, input, pricingContext, aggregatePricingState);
      });
    } finally {
      markPricesReady(priceElements);
    }
  }

  function resolveRules(input, row, cartQuantityOverride) {
    const min = toInt(input?.dataset?.min) ?? toInt(input?.min) ?? 0;
    const step = toInt(input?.step) ?? 1;
    const maxTotalCandidates = [
      toInt(row?.dataset?.maxTotal),
      toInt(input?.dataset?.quantityRuleMax),
      toInt(input?.dataset?.inventoryMax),
    ].filter((value) => value !== null);

    const maxTotal = normalizeQuantityMax(
      min,
      step,
      maxTotalCandidates.length ? Math.min.apply(null, maxTotalCandidates) : null
    );
    const currentCartTotal = cartQuantityOverride ?? toInt(input?.dataset?.cartQuantity) ?? toInt(row?.dataset?.cartQuantity) ?? 0;
    const maxAddableRaw = maxTotal === null ? null : Math.max(0, maxTotal - currentCartTotal);
    const maxAddable = maxAddableRaw === null ? null : normalizeQuantityMax(min, step, maxAddableRaw);

    return {
      min,
      step,
      max: maxAddable,
      maxTotal,
      currentCartTotal,
    };
  }

  function normalizeTarget(target, rules) {
    let safeTarget = Number.isFinite(Number(target)) ? Math.floor(Number(target)) : 0;
    if (safeTarget <= 0) return 0;

    const min = Number.isFinite(rules.min) ? rules.min : 0;
    const step = Number.isFinite(rules.step) && rules.step > 0 ? rules.step : 1;

    if (safeTarget < min) {
      safeTarget = min;
    }

    safeTarget = min + Math.floor((safeTarget - min) / step) * step;

    if (rules.max !== null) {
      safeTarget = Math.min(safeTarget, rules.max);
    }

    return Math.max(0, safeTarget);
  }

  function setInputValue(input, value) {
    const safeValue = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
    input.value = String(safeValue);
    input.setAttribute('value', String(safeValue));
  }

  function isRowSoldOut(row) {
    const availableRaw = String(row?.dataset?.variantAvailable || '').toLowerCase();
    const inventoryManagement = String(row?.dataset?.inventoryManagement || '').toLowerCase();
    const inventoryPolicy = String(row?.dataset?.inventoryPolicy || '').toLowerCase();
    const inventoryQuantity = toInt(row?.dataset?.inventoryQuantity) ?? 0;

    if (availableRaw === 'false') {
      return true;
    }

    return inventoryManagement === 'shopify' && inventoryPolicy !== 'continue' && inventoryQuantity <= 0;
  }

  function setButtonState(button, disabled, softDisable) {
    if (!button) return;
    button.classList.toggle('disabled', disabled);
    if (disabled && softDisable) {
      button.removeAttribute('disabled');
      button.disabled = false;
    } else {
      button.toggleAttribute('disabled', disabled);
    }
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function updateButtonState(input, row, rulesOverride) {
    const rules = rulesOverride || resolveRules(input, row);
    const quantity = toInt(input.value) || 0;
    const minusButton = input.parentElement?.querySelector(".quantity__button[name='minus']");
    const plusButton = input.parentElement?.querySelector(".quantity__button[name='plus']");

    setButtonState(minusButton, quantity <= 0, false);
    setButtonState(plusButton, rules.max !== null && quantity >= rules.max, true);
  }

  function flashQuantityWarning(input, max) {
    const quantity = input.closest('.quantity');
    if (!quantity) return;

    let warning = quantity.querySelector('.quantity__warning');
    if (!warning) {
      warning = document.createElement('span');
      warning.className = 'quantity__warning';
      warning.setAttribute('role', 'status');
      warning.setAttribute('aria-live', 'polite');
      warning.hidden = true;
      quantity.appendChild(warning);
    }

    warning.textContent = max > 0 ? `Only ${max} available` : 'Max quantity reached';
    warning.hidden = false;
    warning.offsetHeight;
    warning.classList.add('is-visible');
    if (warning._timer) clearTimeout(warning._timer);
    warning._timer = setTimeout(() => {
      warning.classList.remove('is-visible');
      setTimeout(() => {
        if (warning && !warning.classList.contains('is-visible')) warning.hidden = true;
      }, 250);
    }, 2200);
  }

  function syncRowState(row, input, cartQuantityOverride) {
    const rules = resolveRules(input, row, cartQuantityOverride);
    const currentCartTotal = rules.currentCartTotal;
    const soldOut = isRowSoldOut(row);

    row.dataset.cartQuantity = String(currentCartTotal);
    input.dataset.cartQuantity = String(currentCartTotal);

    const inCartCounter = row.querySelector('[data-bulk-cart-quantity]');
    const inCartNote = row.querySelector('[data-bulk-in-cart-note]');
    if (inCartCounter) {
      inCartCounter.textContent = String(currentCartTotal);
    }

    if (rules.max !== null) {
      input.max = String(rules.max);
      input.dataset.max = String(rules.max);
      row.dataset.addableMax = String(rules.max);
    } else {
      input.removeAttribute('max');
      delete input.dataset.max;
      delete row.dataset.addableMax;
    }

    const maxInCart = !soldOut && rules.max !== null && rules.max <= 0;
    const quantityCell = row.querySelector('.bulk-order-form__cell-quantity');
    const quantityShell = row.querySelector('.bulk-order-form__quantity-shell');
    const quantityControl = row.querySelector('[data-bulk-quantity-control]');
    const maxNote = row.querySelector('[data-bulk-max-note]');
    const soldOutNote = row.querySelector('[data-bulk-sold-out-note]');
    if (quantityCell) {
      quantityCell.classList.toggle('bulk-order-form__cell-quantity--sold-out', soldOut);
    }
    if (quantityShell) {
      quantityShell.classList.toggle('bulk-order-form__quantity-shell--sold-out', soldOut);
    }
    if (quantityControl) {
      quantityControl.classList.toggle('hidden', soldOut || maxInCart);
    }
    if (maxNote) {
      maxNote.classList.toggle('hidden', !maxInCart);
    }
    if (inCartNote) {
      inCartNote.classList.toggle('hidden', soldOut);
    }
    if (soldOutNote) {
      soldOutNote.classList.toggle('hidden', !soldOut);
    }

    if (soldOut || maxInCart) {
      setInputValue(input, 0);
    }

    if (soldOut) {
      const minusButton = input.parentElement?.querySelector(".quantity__button[name='minus']");
      const plusButton = input.parentElement?.querySelector(".quantity__button[name='plus']");
      setButtonState(minusButton, true, false);
      setButtonState(plusButton, true, true);
      return {
        ...rules,
        soldOut,
        maxInCart,
      };
    }

    updateButtonState(input, row, rules);
    return {
      ...rules,
      soldOut,
      maxInCart,
    };
  }

  function clampInput(input, row, sourceEvent) {
    const rules = syncRowState(row, input);
    const rawValue = toInt(input.value);
    const requestedAddQuantity = rawValue ?? 0;
    let safeAddQuantity = requestedAddQuantity;

    if (rules.soldOut) {
      safeAddQuantity = 0;
    } else if (safeAddQuantity > 0) {
      safeAddQuantity = normalizeTarget(safeAddQuantity, rules);
    }

    if (input.dataset.inventorySyncPending === 'true' && safeAddQuantity > 0) {
      safeAddQuantity = 0;
    }

    if (rules.max !== null && safeAddQuantity > rules.max) {
      safeAddQuantity = rules.max;
    }

    safeAddQuantity = Math.max(0, safeAddQuantity);
    setInputValue(input, safeAddQuantity);

    updateButtonState(input, row, rules);

    if (!rules.soldOut && rules.max !== null && requestedAddQuantity > rules.max) {
      flashQuantityWarning(input, rules.max);
    }

    debugLog('interaction', {
      sourceEvent,
      variantId: row?.dataset?.variantId,
      inputValue: input.value,
      inputAttributeValue: input.getAttribute('value'),
      inputMin: input.min,
      inputMax: input.max,
      inputStep: input.step,
      datasetCartQuantity: input.dataset.cartQuantity,
      datasetMax: input.dataset.max,
      datasetInventoryMax: input.dataset.inventoryMax,
      datasetInventorySyncPending: input.dataset.inventorySyncPending,
      resolvedMin: rules.min,
      resolvedIncrement: rules.step,
      resolvedMax: rules.max,
      rowSoldOut: rules.soldOut,
      currentCartTotal: rules.currentCartTotal,
      requestedAddQuantity,
      addQuantity: safeAddQuantity,
      targetTotal: rules.currentCartTotal + safeAddQuantity,
    });

    return {
      rules,
      addQuantity: safeAddQuantity,
      currentCartTotal: rules.currentCartTotal,
      targetTotal: rules.currentCartTotal + safeAddQuantity,
    };
  }

  function cartTotalsByVariant(cartData) {
    const totals = new Map();
    (cartData?.items || []).forEach((item) => {
      const variantId = String(item?.variant_id || '');
      if (!variantId) return;
      const qty = Number(item?.quantity) || 0;
      totals.set(variantId, (totals.get(variantId) || 0) + qty);
    });
    return totals;
  }

  function buildPlan(cartItems, updatesByVariant) {
    const planner = window.BSCartLineIdentity?.buildLineAwareUpdatePlan;
    if (typeof planner === 'function') {
      return planner(cartItems || [], updatesByVariant || {});
    }

    return {
      lineUpdates: [],
      variantUpdates: updatesByVariant || {},
      conflicts: [],
    };
  }

  function setFormMessage(form, message, isError) {
    const messageElement = form.querySelector('.bulk-order-form__success-message');
    if (!messageElement) return;

    messageElement.textContent = message || '';
    messageElement.classList.toggle('hidden', !message);
    messageElement.classList.toggle('bulk-order-form__success-message--error', !!isError);
  }

  function syncRowsFromCart(root, form, cartData, pricingContext) {
    const totals = cartTotalsByVariant(cartData);
    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const variantId = String(row.dataset.variantId || '');
      if (!variantId) return;

      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const nextCartTotal = totals.get(variantId) ?? (toInt(input.dataset.cartQuantity) || 0);
      syncRowState(row, input, nextCartTotal);
      setInputValue(input, 0);
      updateButtonState(input, row);
    });

    refreshAllPrices(root, pricingContext);
  }

  async function fetchCartState(routes) {
    const cartResponse = await fetch(routes.cartJson, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!cartResponse.ok) {
      throw new Error('Unable to read cart state. Please try again.');
    }
    return cartResponse.json();
  }

  async function submitBulkOrder(root, form, pricingContext) {
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton?.classList.add('loading');
    submitButton?.setAttribute('aria-disabled', 'true');
    if (submitButton) submitButton.disabled = true;
    setFormMessage(form, '', false);

    const routes = getRoutes();
    const cartData = await fetchCartState(routes);
    const totals = cartTotalsByVariant(cartData);

    const updatesByVariant = {};
    const diagnostics = [];

    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const variantId = String(row.dataset.variantId || '');
      if (!variantId) return;

      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const currentCartTotal = totals.get(variantId) ?? (toInt(input.dataset.cartQuantity) || 0);
      syncRowState(row, input, currentCartTotal);

      const clamped = clampInput(input, row, 'submit-preflight');
      const targetTotal = clamped.targetTotal;

      diagnostics.push({
        variantId,
        currentTotal: currentCartTotal,
        addQuantity: clamped.addQuantity,
        targetTotal,
        resolvedMax: clamped.rules.max,
        resolvedMaxTotal: clamped.rules.maxTotal,
        resolvedMin: clamped.rules.min,
        resolvedIncrement: clamped.rules.step,
      });

      if (targetTotal !== currentCartTotal) {
        updatesByVariant[variantId] = targetTotal;
      }
    });

    debugLog('mutation-boundary', diagnostics);

    if (!Object.keys(updatesByVariant).length) {
      setFormMessage(form, 'No quantities selected.', false);
      return;
    }

    const plan = buildPlan(cartData.items || [], updatesByVariant);
    if (plan.conflicts && plan.conflicts.length) {
      throw new Error('Some quantities belong to customized cart lines. Update those lines from the cart page.');
    }

    const requestBase = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
    };

    for (const update of plan.lineUpdates || []) {
      const payload = { id: update.id, quantity: update.quantity };
      debugLog('request', {
        endpoint: routes.cartChange,
        payload,
        variantId: update.variantId,
        currentTotal: diagnostics.find((item) => item.variantId === String(update.variantId))?.currentTotal,
        targetTotal: update.quantity,
      });
      const response = await fetch(routes.cartChange, {
        ...requestBase,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.description || body.message || 'Unable to update cart line.');
      }
    }

    if (plan.variantUpdates && Object.keys(plan.variantUpdates).length) {
      const payload = { updates: plan.variantUpdates };
      Object.entries(plan.variantUpdates).forEach(([variantId, quantity]) => {
        const rowDiagnostic = diagnostics.find((item) => item.variantId === String(variantId));
        debugLog('request', {
          endpoint: routes.cartUpdate,
          payload: { updates: { [variantId]: quantity } },
          variantId,
          currentTotal: rowDiagnostic?.currentTotal,
          targetTotal: quantity,
          resolvedMax: rowDiagnostic?.resolvedMax,
        });
      });

      const response = await fetch(routes.cartUpdate, {
        ...requestBase,
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.description || body.message || 'Unable to update cart.');
      }
    }

    const updatedCartData = window.BSCartUI?.refresh
      ? await window.BSCartUI.refresh()
      : await fetchCartState(routes);
    syncRowsFromCart(root, form, updatedCartData, pricingContext);

    const cartDrawer = document.querySelector('cart-drawer');
    if (cartDrawer?.open && !cartDrawer.classList.contains('active')) {
      cartDrawer.setActiveElement?.(document.activeElement);
      cartDrawer.open();
    }
  }

  function initBulkOrderForm(root) {
    if (!root || root.dataset.bulkOrderInitialized === 'true') return;

    const form = root.querySelector('.bulk-order-form__form');
    if (!form) return;

    const pricingContext = buildPricingContext(root);

    root.dataset.bulkOrderInitialized = 'true';

    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const initialCartQuantity = toInt(input.dataset.cartQuantity) ?? 0;
      syncRowState(row, input, initialCartQuantity);
      setInputValue(input, 0);
      clampInput(input, row, 'init');
    });
    refreshAllPrices(root, pricingContext);

    form.addEventListener('click', (event) => {
      const button = event.target.closest('.quantity__button');
      if (!button) return;

      const quantityContainer = button.closest('.quantity');
      const row = button.closest('.bulk-order-form__row');
      const input = quantityContainer?.querySelector('.quantity__input');
      if (!input || !row) return;

      event.preventDefault();

      const rules = syncRowState(row, input);
      const currentValue = toInt(input.value) || 0;
      let nextValue = currentValue;

      if (button.name === 'plus') {
        if (rules.max !== null && currentValue >= rules.max) {
          flashQuantityWarning(input, rules.max);
          updateButtonState(input, row, rules);
          return;
        }
        if (currentValue === 0 && rules.min > 0) {
          nextValue = rules.min;
        } else {
          nextValue = currentValue + Math.max(rules.step, 1);
        }
      } else {
        nextValue = Math.max(0, currentValue - Math.max(rules.step, 1));
      }

      input.value = String(nextValue);
      clampInput(input, row, button.name === 'plus' ? 'plus' : 'minus');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    form.addEventListener('change', (event) => {
      const input = event.target;
      if (!input.classList.contains('quantity__input')) return;

      const row = input.closest('.bulk-order-form__row');
      if (!row) return;
      clampInput(input, row, 'manual-change');
      refreshAllPrices(root, pricingContext);
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.__bulkOrderSubmitPromise = submitBulkOrder(root, form, pricingContext)
        .catch((error) => {
          setFormMessage(form, error.message || 'Unable to update cart.', true);
        })
        .finally(() => {
          const submitButton = form.querySelector('button[type="submit"]');
          submitButton?.classList.remove('loading');
          submitButton?.removeAttribute('aria-disabled');
          if (submitButton) submitButton.disabled = false;
        });
    });
  }

  function initAll() {
    document.querySelectorAll('.bulk-order-form').forEach((root) => initBulkOrderForm(root));
  }

  document.addEventListener('DOMContentLoaded', initAll);

  window.BSBulkOrderForm = {
    initBulkOrderForm,
    __testing: {
      pickActiveVolumeRule,
      getTierQuantityForLookup,
      findVolumePercentForQuantity,
      computePreviewUnitPriceCents,
      formatMoney,
      setPriceContent,
      getAggregateCurrentCartQuantity,
      getAggregatePendingAddQuantity,
      getAggregateProjectedQuantity,
      buildPricingContext,
    },
  };
})();
