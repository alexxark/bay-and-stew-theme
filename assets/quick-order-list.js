if (!customElements.get('quick-order-list-remove-button')) {
  customElements.define(
    'quick-order-list-remove-button',
    class QuickOrderListRemoveButton extends BulkAdd {
      constructor() {
        super();
        this.addEventListener('click', (event) => {
          event.preventDefault();
          this.startQueue(this.dataset.index, 0);
        });
      }
    }
  );
}

if (!customElements.get('quick-order-list-remove-all-button')) {
  customElements.define(
    'quick-order-list-remove-all-button',
    class QuickOrderListRemoveAllButton extends HTMLElement {
      constructor() {
        super();
        this.quickOrderList = this.closest('quick-order-list');
        const allVariants = this.quickOrderList.querySelectorAll('[data-quantity-variant-id]');
        const items = {};
        let hasVariantsInCart = false;

        allVariants.forEach((variant) => {
          const cartQty = parseInt(variant.dataset.cartQuantity);
          if (cartQty > 0) {
            hasVariantsInCart = true;
            items[parseInt(variant.dataset.quantityVariantId)] = 0;
          }
        });

        if (!hasVariantsInCart) {
          this.classList.add('hidden');
        }

        this.actions = {
          confirm: 'confirm',
          remove: 'remove',
          cancel: 'cancel',
        };

        this.addEventListener('click', (event) => {
          event.preventDefault();
          if (this.dataset.action === this.actions.confirm) {
            this.toggleConfirmation(false, true);
          } else if (this.dataset.action === this.actions.remove) {
            this.quickOrderList.updateMultipleQty(items);
            this.toggleConfirmation(true, false);
          } else if (this.dataset.action === this.actions.cancel) {
            this.toggleConfirmation(true, false);
          }
        });
      }

      toggleConfirmation(showConfirmation, showInfo) {
        this.quickOrderList
          .querySelector('.quick-order-list-total__confirmation')
          .classList.toggle('hidden', showConfirmation);
        this.quickOrderList.querySelector('.quick-order-list-total__info').classList.toggle('hidden', showInfo);
      }
    }
  );
}

if (!customElements.get('quick-order-list')) {
  customElements.define(
    'quick-order-list',
    class QuickOrderList extends BulkAdd {
      constructor() {
        super();
        this.cart = document.querySelector('cart-drawer');
        this.quickOrderListId = `${this.dataset.section}-${this.dataset.productId}`;
        this.sectionId = this.dataset.section;
        this.quantityMetadataCache = null;
        this.quantityMetadataCacheAt = 0;
        this.quantityMetadataPromise = null;
        this.quantityMetadataTtlMs = 15000;
        this.defineInputsAndQuickOrderTable();

        this.variantItemStatusElement = document.getElementById('shopping-cart-variant-item-status');
        const form = this.querySelector('form');
        this.inputFieldHeight = this.querySelector('.variant-item__quantity-wrapper').offsetHeight;
        this.isListInsideModal = document.querySelector('.quick-add-bulk');
        this.stickyHeaderElement = document.querySelector('sticky-header');
        this.getTableHead();
        this.getTotalBar();

        if (this.stickyHeaderElement) {
          this.stickyHeader = {
            height: this.stickyHeaderElement.offsetHeight,
            type: `${this.stickyHeaderElement.getAttribute('data-sticky-type')}`,
          };
        }

        if (this.getTotalBar()) {
          this.totalBarPosition = window.innerHeight - this.getTotalBar().offsetHeight;

          window.addEventListener('resize', () => {
            this.totalBarPosition = window.innerHeight - this.getTotalBar().offsetHeight;
            this.stickyHeader.height = this.stickyHeaderElement ? this.stickyHeaderElement.offsetHeight : 0;
          });
        }

        const pageParams = new URLSearchParams(window.location.search);
        window.pageNumber = decodeURIComponent(pageParams.get('page') || '');
        form.addEventListener('submit', this.onSubmit.bind(this));
        this.addMultipleDebounce();
        void this.syncPriceStateAfterRender('constructor');
      }

      cartUpdateUnsubscriber = undefined;

      onSubmit(event) {
        event.preventDefault();
      }

      connectedCallback() {
        this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
          const variantIds = [];
          this.querySelectorAll('.variant-item').forEach((item) => {
            variantIds.push(parseInt(item.dataset.variantId));
          });
          if (
            event.source === this.quickOrderListId ||
            !event.cartData.items?.some((element) => variantIds.includes(element.variant_id))
          ) {
            return;
          }
          // If its another section that made the update
          this.refresh().then(() => {
            this.defineInputsAndQuickOrderTable();
            this.addMultipleDebounce();
          });
        });
        void this.syncPriceStateAfterRender('connected');
      }

      disconnectedCallback() {
        this.cartUpdateUnsubscriber?.();
      }

      defineInputsAndQuickOrderTable() {
        this.allInputsArray = Array.from(this.querySelectorAll('input[type="number"]'));
        this.quickOrderListTable = this.querySelector('.quick-order-list__table');
        this.quickOrderListTable.addEventListener('focusin', this.switchVariants.bind(this));
        this.syncQuantityInputState();
        this.syncQuantityCapsFromServer();
      }

      syncQuantityInputState() {
        this.querySelectorAll('quantity-input').forEach((quantityElement) => {
          quantityElement.syncResolvedMax?.();
          quantityElement.validateQtyRules?.();
        });
      }

      buildInventoryMetadataUrls() {
        const origin = window.location.origin;
        const root = window.Shopify?.routes?.root || '/';
        let productPath = this.dataset.url || window.location.pathname;

        if (root && root !== '/') {
          const rootNoSlash = root.endsWith('/') ? root.slice(0, -1) : root;
          if (!productPath.startsWith(rootNoSlash + '/')) {
            productPath = `${rootNoSlash}${productPath.startsWith('/') ? productPath : `/${productPath}`}`;
          }
        }

        const sectionCandidates = ['quick-order-inventory-metadata', this.sectionId || this.dataset.section].filter(
          Boolean
        );

        return Array.from(new Set(sectionCandidates)).map((sectionId) => {
          const url = new URL(productPath, origin);
          url.searchParams.set('section_id', sectionId);
          return url.toString();
        });
      }

      parseInventoryMetadataFromHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const script = doc.querySelector('[data-quick-order-inventory-metadata]');
        if (!script?.textContent) return null;

        try {
          const parsed = JSON.parse(script.textContent);
          if (!parsed || typeof parsed !== 'object' || typeof parsed.variants !== 'object') return null;
          return parsed;
        } catch (_error) {
          return null;
        }
      }

      isQuantityMetadataFresh() {
        return !!this.quantityMetadataCache && Date.now() - this.quantityMetadataCacheAt < this.quantityMetadataTtlMs;
      }

      fetchQuantityMetadata(force = false) {
        if (!force && this.isQuantityMetadataFresh()) {
          return Promise.resolve(this.quantityMetadataCache);
        }

        if (this.quantityMetadataPromise) {
          return this.quantityMetadataPromise;
        }

        this.quantityMetadataPromise = (async () => {
          const urls = this.buildInventoryMetadataUrls();

          for (const url of urls) {
            try {
              const response = await fetch(url, {
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { Accept: 'text/html' },
              });
              if (!response.ok) continue;
              const html = await response.text();
              const metadata = this.parseInventoryMetadataFromHtml(html);
              if (!metadata) continue;

              this.quantityMetadataCache = metadata;
              this.quantityMetadataCacheAt = Date.now();
              return metadata;
            } catch (_error) {
              // Try next URL candidate.
            }
          }

          return null;
        })().finally(() => {
          this.quantityMetadataPromise = null;
        });

        return this.quantityMetadataPromise;
      }

      syncQuantityCapsFromServer() {
        const inputs = Array.from(this.querySelectorAll('quantity-input .quantity__input[data-quantity-variant-id]'));
        if (!inputs.length) return Promise.resolve(false);

        const entries = inputs
          .map((input) => {
            const variantId = parseInt(input.dataset.quantityVariantId, 10);
            if (!Number.isFinite(variantId)) return null;
            const quantityElement = input.closest('quantity-input');
            if (!quantityElement) return null;
            const plusButton = quantityElement.querySelector(".quantity__button[name='plus']");
            return { input, variantId, quantityElement, plusButton };
          })
          .filter(Boolean);
        if (!entries.length) return Promise.resolve(false);

        const markPending = ({ input, plusButton }) => {
          input.dataset.inventorySyncPending = 'true';
          if (plusButton) {
            plusButton.toggleAttribute('disabled', true);
            plusButton.setAttribute('aria-disabled', 'true');
            plusButton.setAttribute('title', 'Checking availability...');
          }
        };

        const clearPending = ({ input, plusButton }) => {
          delete input.dataset.inventorySyncPending;
          if (plusButton) {
            plusButton.removeAttribute('title');
          }
        };

        entries.forEach(markPending);

        return this.fetchQuantityMetadata().then((metadata) => {
          if (!metadata?.variants) return false;

          let appliedAny = false;
          entries.forEach((entry) => {
            const { input, variantId, quantityElement } = entry;
            if (!input.isConnected) return;

            const variant = metadata.variants[String(variantId)];
            if (!variant) return;
            appliedAny = true;

            clearPending(entry);

            const tracked = variant.inventory_management === 'shopify' && variant.inventory_policy !== 'continue';
            if (tracked) {
              const inventoryMax = Math.max(parseInt(variant.inventory_quantity, 10) || 0, 0);
              input.dataset.inventoryMax = String(inventoryMax);
            } else {
              delete input.dataset.inventoryMax;
            }

            const quantityRule = variant.quantity_rule || {};
            if (quantityRule.max === null || quantityRule.max === undefined || quantityRule.max === '') {
              delete input.dataset.quantityRuleMax;
            } else {
              input.dataset.quantityRuleMax = String(quantityRule.max);
            }
            if (quantityRule.min !== null && quantityRule.min !== undefined && quantityRule.min !== '') {
              input.dataset.min = String(quantityRule.min);
            }
            if (quantityRule.increment !== null && quantityRule.increment !== undefined && quantityRule.increment !== '') {
              input.step = String(quantityRule.increment);
            }

            const cartQuantity = Math.max(parseInt(variant.cart_quantity, 10) || 0, 0);
            input.dataset.cartQuantity = String(cartQuantity);
            input.value = String(cartQuantity);

            quantityElement.syncResolvedMax?.();
            const rules = this.getInputRules(input);
            const normalizedValue = parseInt(input.value, 10);
            if (Number.isFinite(normalizedValue) && rules.max !== null && normalizedValue > rules.max) {
              input.value = String(rules.max);
            }

            if (rules.max !== null) {
              input.dataset.remainingAddable = String(Math.max(rules.max - cartQuantity, 0));
            } else {
              delete input.dataset.remainingAddable;
            }

            quantityElement.validateQtyRules?.();
          });

          return appliedAny;
        });
      }

      getPriceStateTargets() {
        return this.querySelectorAll(
          '[data-price-surface="quick-order-variant-total"], [data-price-surface="quick-order-total"]'
        );
      }

      syncPriceStateAfterRender(reason = 'quick-order-render') {
        if (!window.BSPriceState) return Promise.resolve(false);
        const targets = this.getPriceStateTargets();
        if (!targets.length) return Promise.resolve(false);

        const expectBss = window.BSPriceState.isBssRuntimePresent();
        if (!expectBss) {
          window.BSPriceState.setReady(targets, { clearBusy: true });
          return Promise.resolve(false);
        }

        const watchdogMs = 1400;
        window.BSPriceState.setPending(targets, {
          busy: false,
          watchdogMs,
          onTimeout: () => {
            console.warn('[quick-order] fail-open price reveal', reason);
          },
        });
        window.BSPriceState.triggerBssRefresh(this);

        return window.BSPriceState
          .waitForBssReady({
            root: this,
            timeoutMs: watchdogMs,
            readySelector: '[bss-b2b-product-active], [bss-b2b-cart-price-active]',
            attributeFilter: ['bss-b2b-product-active', 'bss-b2b-cart-price-active'],
            resolveOnEvent: true,
          })
          .finally(() => {
            window.BSPriceState.setReady(targets, { clearBusy: true });
          });
      }

      onChange(event) {
        const inputValue = parseInt(event.target.value);
        this.cleanErrorMessageOnType(event);
        if (inputValue == 0) {
          this.startQueue(event.target.dataset.index, inputValue);
        } else {
          this.validateQuantity(event);
        }
      }

      cleanErrorMessageOnType(event) {
        event.target.addEventListener('keydown', () => {
          event.target.setCustomValidity(' ');
          event.target.reportValidity();
        });
      }

      validateInput(target) {
        const rules = this.getInputRules(target);
        const inputValue = parseInt(target.value, 10);
        const isStepped = inputValue >= rules.min && (inputValue - rules.min) % rules.step == 0;
        if (target.max) {
          return (
            inputValue == 0 ||
            (inputValue >= rules.min &&
              inputValue <= rules.max &&
              isStepped)
          );
        } else {
          return (
            inputValue == 0 ||
            (inputValue >= rules.min &&
              isStepped)
          );
        }
      }

      reconcileAuthoritativeQuantities(requestedItems, cartData) {
        if (!cartData || !Array.isArray(cartData.items)) return;

        Object.entries(requestedItems || {}).forEach(([variantId, requestedQuantity]) => {
          const requested = parseInt(requestedQuantity, 10);
          if (!Number.isFinite(requested) || requested <= 0) return;

          const variantIdInt = parseInt(variantId, 10);
          if (!Number.isFinite(variantIdInt)) return;

          const actual = cartData.items.reduce((sum, item) => {
            if (parseInt(item.variant_id, 10) !== variantIdInt) return sum;
            return sum + (Number(item.quantity) || 0);
          }, 0);

          if (actual !== requested) {
            this.updateError(actual, variantIdInt);
          }
        });
      }

      refresh() {
        return new Promise((resolve, reject) => {
          fetch(`${this.getSectionsUrl()}?section_id=${this.sectionId}`)
            .then((response) => response.text())
            .then((responseText) => {
              const html = new DOMParser().parseFromString(responseText, 'text/html');
              const sourceQty = html.querySelector(`#${this.quickOrderListId}`);
              if (sourceQty) {
                this.innerHTML = sourceQty.innerHTML;
              }
              this.syncPriceStateAfterRender('refresh').finally(resolve);
            })
            .catch((e) => {
              console.error(e);
              reject(e);
            });
        });
      }

      getSectionsToRender() {
        return [
          {
            id: this.quickOrderListId,
            section: document.getElementById(this.quickOrderListId).dataset.section,
            selector: `#${this.quickOrderListId} .js-contents`,
          },
          {
            id: 'cart-icon-bubble',
            section: 'cart-icon-bubble',
            selector: '.shopify-section',
          },
          {
            id: `quick-order-list-live-region-text-${this.dataset.productId}`,
            section: 'cart-live-region-text',
            selector: '.shopify-section',
          },
          {
            id: `quick-order-list-total-${this.dataset.productId}-${this.dataset.section}`,
            section: document.getElementById(this.quickOrderListId).dataset.section,
            selector: `#${this.quickOrderListId} .quick-order-list__total`,
          },
          {
            id: 'CartDrawer',
            selector: '#CartDrawer',
            section: 'cart-drawer',
          },
        ];
      }

      addMultipleDebounce() {
        this.querySelectorAll('quantity-input').forEach((qty) => {
          const debouncedOnChange = debounce((event) => {
            this.onChange(event);
          }, 100);
          qty.addEventListener('change', debouncedOnChange.bind(this));
        });
      }

      renderSections(parsedState, ids) {
        this.ids.push(ids);
        const intersection = this.queue.filter((element) => ids.includes(element.id));
        if (intersection.length !== 0) return;

        this.getSectionsToRender().forEach((section) => {
          if (['cart-drawer', 'cart-icon-bubble', 'cart-live-region-text', 'main-cart-items', 'main-cart-footer'].includes(section.section)) return;
          const sectionElement = document.getElementById(section.id);
          if (
            sectionElement &&
            sectionElement.parentElement &&
            sectionElement.parentElement.classList.contains('drawer')
          ) {
            parsedState.items.length > 0
              ? sectionElement.parentElement.classList.remove('is-empty')
              : sectionElement.parentElement.classList.add('is-empty');
            setTimeout(() => {
              document.querySelector('#CartDrawer-Overlay').addEventListener('click', this.cart.close.bind(this.cart));
            });
          }
          const elementToReplace =
            sectionElement && sectionElement.querySelector(section.selector)
              ? sectionElement.querySelector(section.selector)
              : sectionElement;
          if (elementToReplace) {
            if (section.selector === `#${this.quickOrderListId} .js-contents` && this.ids.length > 0) {
              this.ids.flat().forEach((i) => {
                elementToReplace.querySelector(`#Variant-${i}`).innerHTML = this.getSectionInnerHTML(
                  parsedState.sections[section.section],
                  `#Variant-${i}`
                );
              });
            } else {
              elementToReplace.innerHTML = this.getSectionInnerHTML(
                parsedState.sections[section.section],
                section.selector
              );
            }
          }
        });
        this.defineInputsAndQuickOrderTable();
        this.addMultipleDebounce();
        this.ids = [];
        void this.syncPriceStateAfterRender('renderSections');
      }

      getTableHead() {
        return document.querySelector('.quick-order-list__table thead');
      }

      getTotalBar() {
        return this.querySelector('.quick-order-list__total');
      }

      scrollQuickOrderListTable() {
        const inputTopBorder = this.variantListInput.getBoundingClientRect().top;
        const inputBottomBorder = this.variantListInput.getBoundingClientRect().bottom;

        if (this.isListInsideModal) {
          const totalBarCrossesInput = inputBottomBorder > this.getTotalBar().getBoundingClientRect().top;
          const tableHeadCrossesInput = inputTopBorder < this.getTableHead().getBoundingClientRect().bottom;

          if (totalBarCrossesInput || tableHeadCrossesInput) {
            this.scrollToCenter();
          }
        } else {
          const stickyHeaderBottomBorder =
            this.stickyHeaderElement && this.stickyHeaderElement.getBoundingClientRect().bottom;
          const totalBarCrossesInput = inputBottomBorder > this.totalBarPosition;
          const inputOutsideOfViewPort = inputBottomBorder < this.inputFieldHeight;
          const stickyHeaderCrossesInput =
            this.stickyHeaderElement &&
            this.stickyHeader.type !== 'on-scroll-up' &&
            this.stickyHeader.height > inputTopBorder;
          const stickyHeaderScrollupCrossesInput =
            this.stickyHeaderElement &&
            this.stickyHeader.type === 'on-scroll-up' &&
            this.stickyHeader.height > inputTopBorder &&
            stickyHeaderBottomBorder > 0;

          if (
            totalBarCrossesInput ||
            inputOutsideOfViewPort ||
            stickyHeaderCrossesInput ||
            stickyHeaderScrollupCrossesInput
          ) {
            this.scrollToCenter();
          }
        }
      }

      scrollToCenter() {
        this.variantListInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }

      switchVariants(event) {
        if (event.target.tagName !== 'INPUT') {
          return;
        }

        this.variantListInput = event.target;
        this.variantListInput.select();
        if (this.allInputsArray.length !== 1) {
          this.variantListInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.target.blur();
              if (this.validateInput(e.target)) {
                const currentIndex = this.allInputsArray.indexOf(e.target);
                this.lastKey = e.shiftKey;
                if (!e.shiftKey) {
                  const nextIndex = currentIndex + 1;
                  const nextVariant = this.allInputsArray[nextIndex] || this.allInputsArray[0];
                  nextVariant.select();
                } else {
                  const previousIndex = currentIndex - 1;
                  const previousVariant =
                    this.allInputsArray[previousIndex] || this.allInputsArray[this.allInputsArray.length - 1];
                  this.lastElement = previousVariant.dataset.index;
                  previousVariant.select();
                }
              }
            }
          });

          this.scrollQuickOrderListTable();
        } else {
          this.variantListInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.target.blur();
            }
          });
        }
      }

      updateMultipleQty(items) {
        this.querySelector('.variant-remove-total .loading__spinner')?.classList.remove('hidden');

        this.updateMessage();
        this.setErrorMessage();

        this.applyVariantUpdatesWithLineIdentity(items)
          .then((result) => {
            if (!result.ok) {
              this.setErrorMessage('Some quantities belong to customized cart lines. Update those lines from the cart page.');
              return;
            }

            return this.refresh().then(() => {
              this.defineInputsAndQuickOrderTable();
              this.addMultipleDebounce();
              this.ids = [];
              this.reconcileAuthoritativeQuantities(items, result.cartData);
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: this.quickOrderListId,
                cartData: result.cartData || {},
              });
            });
          })
          .catch(() => {
            this.setErrorMessage(window.cartStrings.error);
          })
          .finally(() => {
            this.querySelector('.variant-remove-total .loading__spinner')?.classList.add('hidden');
            this.requestStarted = false;
          });
      }

      setErrorMessage(message = null) {
        this.errorMessageTemplate =
          this.errorMessageTemplate ??
          document.getElementById(`QuickOrderListErrorTemplate-${this.dataset.productId}`).cloneNode(true);
        const errorElements = document.querySelectorAll('.quick-order-list-error');

        errorElements.forEach((errorElement) => {
          errorElement.innerHTML = '';
          if (!message) return;
          const updatedMessageElement = this.errorMessageTemplate.cloneNode(true);
          updatedMessageElement.content.querySelector('.quick-order-list-error-message').innerText = message;
          errorElement.appendChild(updatedMessageElement.content);
        });
      }

      updateMessage(quantity = null) {
        const messages = this.querySelectorAll('.quick-order-list__message-text');
        const icons = this.querySelectorAll('.quick-order-list__message-icon');

        if (quantity === null || isNaN(quantity)) {
          messages.forEach((message) => (message.innerHTML = ''));
          icons.forEach((icon) => icon.classList.add('hidden'));
          return;
        }

        const isQuantityNegative = quantity < 0;
        const absQuantity = Math.abs(quantity);

        const textTemplate = isQuantityNegative
          ? absQuantity === 1
            ? window.quickOrderListStrings.itemRemoved
            : window.quickOrderListStrings.itemsRemoved
          : quantity === 1
          ? window.quickOrderListStrings.itemAdded
          : window.quickOrderListStrings.itemsAdded;

        messages.forEach((msg) => (msg.innerHTML = textTemplate.replace('[quantity]', absQuantity)));

        if (!isQuantityNegative) {
          icons.forEach((i) => i.classList.remove('hidden'));
        }
      }

      updateError(updatedValue, id) {
        let message = '';
        if (typeof updatedValue === 'undefined') {
          message = window.cartStrings.error;
        } else {
          message = window.cartStrings.quantityError.replace('[quantity]', updatedValue);
        }
        this.updateLiveRegions(id, message);
      }

      cleanErrors(id) {
        // this.querySelectorAll('.desktop-row-error').forEach((error) => error.classList.add('hidden'));
        // this.querySelectorAll(`.variant-item__error-text`).forEach((error) => error.innerHTML = '');
      }

      updateLiveRegions(id, message) {
        const variantItemErrorDesktop = document.getElementById(`Quick-order-list-item-error-desktop-${id}`);
        const variantItemErrorMobile = document.getElementById(`Quick-order-list-item-error-mobile-${id}`);
        if (variantItemErrorDesktop) {
          variantItemErrorDesktop.querySelector('.variant-item__error-text').innerHTML = message;
          variantItemErrorDesktop.closest('tr').classList.remove('hidden');
        }
        if (variantItemErrorMobile)
          variantItemErrorMobile.querySelector('.variant-item__error-text').innerHTML = message;

        this.variantItemStatusElement.setAttribute('aria-hidden', true);

        const cartStatus = document.getElementById('quick-order-list-live-region-text');
        cartStatus.setAttribute('aria-hidden', false);

        setTimeout(() => {
          cartStatus.setAttribute('aria-hidden', true);
        }, 1000);
      }

      toggleLoading(id, enable) {
        const quickOrderListItems = this.querySelectorAll(`#Variant-${id} .loading__spinner`);
        const quickOrderListItem = this.querySelector(`#Variant-${id}`);

        if (enable) {
          quickOrderListItem.classList.add('quick-order-list__container--disabled');
          [...quickOrderListItems].forEach((overlay) => overlay.classList.remove('hidden'));
          this.variantItemStatusElement.setAttribute('aria-hidden', false);
        } else {
          quickOrderListItem.classList.remove('quick-order-list__container--disabled');
          quickOrderListItems.forEach((overlay) => overlay.classList.add('hidden'));
        }
      }
    }
  );
}
