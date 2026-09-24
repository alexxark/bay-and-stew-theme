if (!customElements.get('quick-add-bulk')) {
  customElements.define(
    'quick-add-bulk',
    class QuickAddBulk extends BulkAdd {
      constructor() {
        super();
        this.quantity = this.querySelector('quantity-input');

        const debouncedOnChange = debounce((event) => {
          if (parseInt(event.target.value) === 0) {
            this.startQueue(event.target.dataset.index, parseInt(event.target.value));
          } else {
            this.validateQuantity(event);
          }
        }, ON_CHANGE_DEBOUNCE_TIMER);

        this.addEventListener('change', debouncedOnChange.bind(this));
        this.listenForActiveInput();
        this.listenForKeydown();
        this.lastActiveInputId = null;
        const pageParams = new URLSearchParams(window.location.search);
        window.pageNumber = decodeURIComponent(pageParams.get('page') || '');
        void this.syncPriceStateAfterRender('constructor');
      }

      connectedCallback() {
        this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
          if (
            event.source === 'quick-add' ||
            (event.cartData.items && !event.cartData.items.some((item) => item.id === parseInt(this.dataset.index))) ||
            (event.cartData.variant_id && !(event.cartData.variant_id === parseInt(this.dataset.index)))
          ) {
            return;
          }
          // If its another section that made the update
          this.onCartUpdate().then(() => {
            this.listenForActiveInput();
            this.listenForKeydown();
          });
        });
        void this.syncPriceStateAfterRender('connected');
      }

      disconnectedCallback() {
        if (this.cartUpdateUnsubscriber) {
          this.cartUpdateUnsubscriber();
        }
      }

      getInput() {
        return this.querySelector('quantity-input input');
      }

      selectProgressBar() {
        return this.querySelector('.progress-bar-container');
      }

      listenForActiveInput() {
        if (!this.classList.contains('hidden')) {
          this.getInput().addEventListener('focusin', (event) => event.target.select());
        }
        this.isEnterPressed = false;
      }

      listenForKeydown() {
        this.getInput().addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            this.getInput().blur();
            this.isEnterPressed = true;
          }
        });
      }

      cleanErrorMessageOnType(event) {
        event.target.addEventListener(
          'keypress',
          () => {
            event.target.setCustomValidity('');
          },
          { once: true }
        );
      }

      onCartUpdate() {
        return new Promise((resolve, reject) => {
          fetch(`${this.getSectionsUrl()}?section_id=${this.closest('.collection').dataset.id}`)
            .then((response) => response.text())
            .then((responseText) => {
              const html = new DOMParser().parseFromString(responseText, 'text/html');
              const sourceQty = html.querySelector(
                `#quick-add-bulk-${this.dataset.id}-${this.closest('.collection').dataset.id}`
              );
              if (sourceQty) {
                this.innerHTML = sourceQty.innerHTML;
              }
              this.syncPriceStateAfterRender('onCartUpdate').finally(resolve);
            })
            .catch((e) => {
              console.error(e);
              reject(e);
            });
        });
      }

      getPriceStateTargets() {
        return this.querySelectorAll('[bss-b2b-product-price], [bss-b2b-variant-price]');
      }

      syncPriceStateAfterRender(reason = 'quick-add-bulk-render') {
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
            console.warn('[quick-add-bulk] fail-open price reveal', reason);
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

      updateMultipleQty(items) {
        this.selectProgressBar().classList.remove('hidden');

        this.applyVariantUpdatesWithLineIdentity(items)
          .then((result) => {
            if (!result.ok) return;
            return this.onCartUpdate().then(() => {
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'quick-add',
                cartData: result.cartData || {},
              });
            });
          })
          .catch(() => {
            // Commented out for now and will be fixed when BE issue is done https://github.com/Shopify/shopify/issues/440605
            // e.target.setCustomValidity(error);
            // e.target.reportValidity();
            // this.resetQuantityInput(ids[index]);
            // this.selectProgressBar().classList.add('hidden');
            // e.target.select();
            // this.cleanErrorMessageOnType(e);
          })
          .finally(() => {
            this.selectProgressBar().classList.add('hidden');
            this.requestStarted = false;
          });
      }

      getSectionsToRender() {
        return [
          {
            id: `quick-add-bulk-${this.dataset.id}-${this.closest('.collection-quick-add-bulk').dataset.id}`,
            section: this.closest('.collection-quick-add-bulk').dataset.id,
            selector: `#quick-add-bulk-${this.dataset.id}-${this.closest('.collection-quick-add-bulk').dataset.id}`,
          },
          {
            id: 'cart-icon-bubble',
            section: 'cart-icon-bubble',
            selector: '.shopify-section',
          },
          {
            id: 'CartDrawer',
            selector: '#CartDrawer',
            section: 'cart-drawer',
          },
        ];
      }

      renderSections(parsedState, ids) {
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
            elementToReplace.innerHTML = this.getSectionInnerHTML(
              parsedState.sections[section.section],
              section.selector
            );
          }
        });

        if (this.isEnterPressed) {
          this.querySelector(`#Quantity-${this.lastActiveInputId}`).select();
        }

        this.listenForActiveInput();
        this.listenForKeydown();
      }
    }
  );
}
