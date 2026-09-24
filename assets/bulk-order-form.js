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

  function resolveRules(input, row) {
    const min = toInt(input?.dataset?.min) ?? toInt(input?.min) ?? 0;
    const step = toInt(input?.step) ?? 1;
    const maxCandidates = [
      toInt(input?.max),
      toInt(input?.dataset?.max),
      toInt(input?.dataset?.quantityRuleMax),
      toInt(input?.dataset?.inventoryMax),
      toInt(row?.dataset?.maxTotal),
    ].filter((value) => value !== null);

    return {
      min,
      step,
      max: normalizeQuantityMax(min, step, maxCandidates.length ? Math.min.apply(null, maxCandidates) : null),
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

  function setButtonState(button, disabled) {
    if (!button) return;
    button.classList.toggle('disabled', disabled);
    button.toggleAttribute('disabled', disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function updateButtonState(input, row) {
    const rules = resolveRules(input, row);
    const quantity = toInt(input.value) || 0;
    const minusButton = input.parentElement?.querySelector(".quantity__button[name='minus']");
    const plusButton = input.parentElement?.querySelector(".quantity__button[name='plus']");

    setButtonState(minusButton, quantity <= 0);
    setButtonState(plusButton, rules.max !== null && quantity >= rules.max);
  }

  function clampInput(input, row, sourceEvent) {
    const rules = resolveRules(input, row);
    const raw = toInt(input.value) || 0;
    const currentCartTotal = toInt(input.dataset.cartQuantity) || 0;
    let safeTarget = raw;

    if (safeTarget > 0) {
      safeTarget = normalizeTarget(safeTarget, rules);
    }

    if (input.dataset.inventorySyncPending === 'true' && safeTarget > currentCartTotal) {
      safeTarget = currentCartTotal;
    }

    if (rules.max !== null && safeTarget > rules.max) {
      safeTarget = rules.max;
    }

    safeTarget = Math.max(0, safeTarget);

    input.value = String(safeTarget);
    input.setAttribute('value', String(safeTarget));

    updateButtonState(input, row);

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
      currentCartTotal,
      targetTotal: safeTarget,
    });

    return { rules, target: safeTarget };
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

  async function submitBulkOrder(root, form) {
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton?.classList.add('loading');
    submitButton?.setAttribute('aria-disabled', 'true');
    if (submitButton) submitButton.disabled = true;
    setFormMessage(form, '', false);

    const routes = getRoutes();
    const cartResponse = await fetch(routes.cartJson, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!cartResponse.ok) {
      throw new Error('Unable to read cart state. Please try again.');
    }

    const cartData = await cartResponse.json();
    const totals = cartTotalsByVariant(cartData);

    const updatesByVariant = {};
    const diagnostics = [];

    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const variantId = String(row.dataset.variantId || '');
      if (!variantId) return;

      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const currentCartTotal = totals.get(variantId) ?? (toInt(input.dataset.cartQuantity) || 0);
      input.dataset.cartQuantity = String(currentCartTotal);

      const clamped = clampInput(input, row, 'submit-preflight');
      let targetTotal = clamped.target;

      if (input.dataset.inventorySyncPending === 'true' && targetTotal > currentCartTotal) {
        targetTotal = currentCartTotal;
      }

      if (clamped.rules.max !== null && targetTotal > clamped.rules.max) {
        targetTotal = clamped.rules.max;
      }

      targetTotal = Math.max(0, targetTotal);

      diagnostics.push({
        variantId,
        currentTotal: currentCartTotal,
        targetTotal,
        resolvedMax: clamped.rules.max,
        resolvedMin: clamped.rules.min,
        resolvedIncrement: clamped.rules.step,
      });

      if (targetTotal !== currentCartTotal) {
        updatesByVariant[variantId] = targetTotal;
      }
    });

    debugLog('mutation-boundary', diagnostics);

    if (!Object.keys(updatesByVariant).length) {
      setFormMessage(form, 'No quantity changes to apply.', false);
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

    if (window.__bulkOrderSkipRedirect) {
      return;
    }

    window.location.href = '/cart';
  }

  function initBulkOrderForm(root) {
    if (!root || root.dataset.bulkOrderInitialized === 'true') return;

    const form = root.querySelector('.bulk-order-form__form');
    if (!form) return;

    root.dataset.bulkOrderInitialized = 'true';

    form.querySelectorAll('.bulk-order-form__row').forEach((row) => {
      const input = row.querySelector('.quantity__input');
      if (!input) return;

      const initialCartQuantity = toInt(input.dataset.cartQuantity) ?? toInt(input.value) ?? 0;
      input.dataset.cartQuantity = String(initialCartQuantity);
      input.value = String(initialCartQuantity);
      input.setAttribute('value', String(initialCartQuantity));
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

      const rules = resolveRules(input, row);
      const currentValue = toInt(input.value) || 0;
      let nextValue = currentValue;

      if (button.name === 'plus') {
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
