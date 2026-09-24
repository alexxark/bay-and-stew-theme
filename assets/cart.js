class CartRemoveButton extends HTMLElement {
  constructor() {
    super();

    this.addEventListener('click', (event) => {
      event.preventDefault();
      const cartItems = this.closest('cart-items') || this.closest('cart-drawer-items');
      cartItems.updateQuantity(this.dataset.index, 0);
    });
  }
}

customElements.define('cart-remove-button', CartRemoveButton);

class CartItems extends HTMLElement {
  constructor() {
    super();
    this.lineItemStatusElement =
      document.getElementById('shopping-cart-line-item-status') || document.getElementById('CartDrawer-LineItemStatus');

    const debouncedOnChange = debounce((event) => {
      this.onChange(event);
    }, ON_CHANGE_DEBOUNCE_TIMER);

    this.addEventListener('change', debouncedOnChange.bind(this));
  }

  cartUpdateUnsubscriber = undefined;

  connectedCallback() {
    this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
      if (event.sectionsRendered) {
        return;
      }
      this.onCartUpdate();
    });
  }

  disconnectedCallback() {
    if (this.cartUpdateUnsubscriber) {
      this.cartUpdateUnsubscriber();
    }
  }

  resetQuantityInput(id) {
    const input = this.querySelector(`#Quantity-${id}, #Drawer-quantity-${id}`);
    if (!input) return;
    input.value = input.getAttribute('value');
    this.isEnterPressed = false;
  }

  setInlineQuantityMessage(index, message) {
    const lineItemError =
      document.getElementById(`Line-item-error-${index}`) || document.getElementById(`CartDrawer-LineItemError-${index}`);
    if (!lineItemError) return;

    const errorText = lineItemError.querySelector('.cart-item__error-text');
    if (!errorText) return;
    errorText.textContent = message || '';
  }

  validateQuantity(event) {
    const input = event.target;
    const index = input.dataset.index;
    const previousQuantity = parseInt(input.getAttribute('value'), 10);
    const min = parseInt(input.dataset.min, 10) || 0;
    const step = parseInt(input.step, 10) || 1;
    const max = input.max === '' ? null : parseInt(input.max, 10);
    let nextQuantity = parseInt(input.value, 10);
    let message = '';

    if (Number.isNaN(nextQuantity) || nextQuantity < 0) {
      nextQuantity = 0;
    }

    if (nextQuantity > 0 && nextQuantity < min) {
      nextQuantity = min;
      message = window.quickOrderListStrings.min_error.replace('[min]', min);
    }

    if (nextQuantity > 0 && (nextQuantity - min) % step !== 0) {
      nextQuantity = min + Math.floor((nextQuantity - min) / step) * step;
      if (nextQuantity < min) {
        nextQuantity = min;
      }
      message = window.quickOrderListStrings.step_error.replace('[step]', step);
    }

    if (max !== null && nextQuantity > max) {
      nextQuantity = max;
      message = `Only ${max} available`;
      input.closest('quantity-input')?.flashMaxWarning?.(max);
    }

    input.value = String(nextQuantity);
    input.closest('quantity-input')?.validateQtyRules?.();
    this.setInlineQuantityMessage(index, message);

    if (Number.isFinite(previousQuantity) && previousQuantity === nextQuantity) {
      return;
    }

    this.updateQuantity(
      index,
      nextQuantity,
      document.activeElement.getAttribute('name'),
      input.dataset.quantityVariantId
    );
  }

  onChange(event) {
    this.validateQuantity(event);
  }

  onCartUpdate() {
    return window.BSCartUI.refresh().catch(window.BSCartUI.reportError);
  }

  getSectionsToRender() {
    return [
      {
        id: 'main-cart-items',
        section: document.getElementById('main-cart-items').dataset.id,
        selector: '.js-contents',
      },
      {
        id: 'cart-icon-bubble',
        section: 'cart-icon-bubble',
        selector: '.shopify-section',
      },
      {
        id: 'cart-live-region-text',
        section: 'cart-live-region-text',
        selector: '.shopify-section',
      },
      {
        id: 'main-cart-footer',
        section: document.getElementById('main-cart-footer').dataset.id,
        selector: '.js-contents',
      },
    ];
  }

  async updateQuantity(line, quantity, name, variantId) {
    const isDrawer = this.tagName === 'CART-DRAWER-ITEMS';
    const quantityElement = this.querySelector(`#Quantity-${line}, #Drawer-quantity-${line}`);
    const row = this.querySelector(`#CartItem-${line}, #CartDrawer-Item-${line}`);
    this.enableLoading(line);
    const body = JSON.stringify({
      ...(row?.dataset.cartItemKey ? { id: row.dataset.cartItemKey } : { line }),
      quantity,
    });
    try {
      const response = await fetch(`${routes.cart_change_url}`, { ...fetchConfig(), body });
      const parsedState = await response.json();
      if (!response.ok || parsedState.errors || parsedState.status >= 400) {
        throw new Error(parsedState.description || parsedState.errors || window.cartStrings.error);
      }
      const cart = await window.BSCartUI.refresh();
      const updatedValue = parsedState.items?.[line - 1]?.quantity;
      const message = quantity > 0 && updatedValue !== undefined && updatedValue !== Number(quantity)
        ? window.cartStrings.quantityError.replace('[quantity]', updatedValue) : '';
      this.lineItemStatusElement = document.getElementById('shopping-cart-line-item-status') || document.getElementById('CartDrawer-LineItemStatus');
      this.updateLiveRegions(line, message);
      const lineItem = document.getElementById(`CartItem-${line}`) || document.getElementById(`CartDrawer-Item-${line}`);
      const focusInput = name && lineItem?.querySelector(`[name="${name}"]`);
      if (focusInput) focusInput.focus();
      return cart;
    } catch (error) {
      await window.BSCartUI.refresh().catch(window.BSCartUI.reportError);
      if (quantityElement?.isConnected) quantityElement.value = quantityElement.getAttribute('value');
      const errors = document.getElementById(isDrawer ? 'CartDrawer-CartErrors' : 'cart-errors');
      if (errors) errors.textContent = error.message || window.cartStrings.error;
    } finally {
      this.disableLoading(line);
    }
  }

  updateLiveRegions(line, message) {
    const lineItemError =
      document.getElementById(`Line-item-error-${line}`) || document.getElementById(`CartDrawer-LineItemError-${line}`);
    if (lineItemError) lineItemError.querySelector('.cart-item__error-text').textContent = message;

    this.lineItemStatusElement?.setAttribute('aria-hidden', true);

    const cartStatus =
      document.getElementById('cart-live-region-text') || document.getElementById('CartDrawer-LiveRegionText');
    const cartPricingPending = document.documentElement?.dataset.cartPricingState === 'pending';
    if (!cartStatus || cartPricingPending || cartStatus.getAttribute('aria-busy') === 'true' || cartStatus.dataset.priceState === 'pending') {
      return;
    }
    cartStatus?.setAttribute('aria-hidden', false);

    setTimeout(() => {
      cartStatus?.setAttribute('aria-hidden', true);
    }, 1000);
  }

  getSectionInnerHTML(html, selector) {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector).innerHTML;
  }

  enableLoading(line) {
    const mainCartItems = this;
    mainCartItems.classList.add('cart__items--disabled');

    const cartItemElements = this.querySelectorAll(`#CartItem-${line} .loading__spinner`);
    const cartDrawerItemElements = this.querySelectorAll(`#CartDrawer-Item-${line} .loading__spinner`);

    [...cartItemElements, ...cartDrawerItemElements].forEach((overlay) => overlay.classList.remove('hidden'));

    document.activeElement.blur();
    this.lineItemStatusElement?.setAttribute('aria-hidden', false);
  }

  disableLoading(line) {
    document.querySelectorAll('cart-items, cart-drawer-items').forEach((element) => element.classList.remove('cart__items--disabled'));

    const cartItemElements = this.querySelectorAll(`#CartItem-${line} .loading__spinner`);
    const cartDrawerItemElements = this.querySelectorAll(`#CartDrawer-Item-${line} .loading__spinner`);

    cartItemElements.forEach((overlay) => overlay.classList.add('hidden'));
    cartDrawerItemElements.forEach((overlay) => overlay.classList.add('hidden'));
  }
}

customElements.define('cart-items', CartItems);

if (!customElements.get('cart-note')) {
  customElements.define(
    'cart-note',
    class CartNote extends HTMLElement {
      constructor() {
        super();

        this.addEventListener(
          'input',
          debounce((event) => {
            const body = JSON.stringify({ note: event.target.value });
            fetch(`${routes.cart_update_url}`, { ...fetchConfig(), ...{ body } });
          }, ON_CHANGE_DEBOUNCE_TIMER)
        );
      }
    }
  );
}
