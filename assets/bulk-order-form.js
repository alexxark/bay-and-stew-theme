(function () {
  const DEBUG_KEY = 'bulkOrderDebug';

  function toInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
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

    row.dataset.cartQuantity = String(currentCartTotal);
    input.dataset.cartQuantity = String(currentCartTotal);

    const inCartCounter = row.querySelector('[data-bulk-cart-quantity]');
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

    const maxInCart = rules.max !== null && rules.max <= 0;
    const quantityControl = row.querySelector('[data-bulk-quantity-control]');
    const maxNote = row.querySelector('[data-bulk-max-note]');
    if (quantityControl) {
      quantityControl.classList.toggle('hidden', maxInCart);
    }
    if (maxNote) {
      maxNote.classList.toggle('hidden', !maxInCart);
    }

    if (maxInCart) {
      setInputValue(input, 0);
    }

    updateButtonState(input, row, rules);
    return rules;
  }

  function clampInput(input, row, sourceEvent) {
    const rules = syncRowState(row, input);
    const rawValue = toInt(input.value);
    const requestedAddQuantity = rawValue ?? 0;
    let safeAddQuantity = requestedAddQuantity;

    if (safeAddQuantity > 0) {
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

    if (rules.max !== null && requestedAddQuantity > rules.max) {
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

  function syncRowsFromCart(form, cartData) {
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

  async function submitBulkOrder(root, form) {
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

    if (window.BSCartUI?.refresh) {
      await window.BSCartUI.refresh();
    }

    const updatedCartData = await fetchCartState(routes);
    syncRowsFromCart(form, updatedCartData);
    setFormMessage(form, 'Added to cart.', false);

    if (window.__bulkOrderSkipRedirect) {
      return;
    }
  }

  function initBulkOrderForm(root) {
    if (!root || root.dataset.bulkOrderInitialized === 'true') return;

    const form = root.querySelector('.bulk-order-form__form');
    if (!form) return;

    root.dataset.bulkOrderInitialized = 'true';

    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const initialCartQuantity = toInt(input.dataset.cartQuantity) ?? 0;
      syncRowState(row, input, initialCartQuantity);
      setInputValue(input, 0);
      clampInput(input, row, 'init');
    });

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
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      form.__bulkOrderSubmitPromise = submitBulkOrder(root, form)
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
  };
})();
