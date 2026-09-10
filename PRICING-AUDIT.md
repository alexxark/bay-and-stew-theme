# Pricing Audit, Theme Remediation, and Promotion Gate

Audit date: 2026-09-10. Scope: this repository and isolated local reproductions. No live cart mutations, orders, app configuration changes, or deployments were performed.

## Decision

**No theme-only promotion has been implemented. Authoritative promotion configuration remains blocked on BSS/Shopify verification.** This repository is a customized Dawn theme, not Prestige, according to [config/settings_schema.json](config/settings_schema.json). It contains no Shopify app project, Discount Function, Cart Transform, or backend pricing service implementation. The remediation now includes a local regression suite.

BSS B2B Solution is enabled in [config/settings_data.json](config/settings_data.json). Its app embed implementation, pricing rules, checkout handler, and server-side integrations are not included. The code establishes storefront integration, but cannot establish whether this store's BSS configuration uses native discounts, Functions, draft orders, or another checkout mechanism. Comments claiming checkout accuracy are not evidence of the actual engine.

The follow-up implements the confirmed theme-side quantity, lookup, restoration and rendering repairs below. It adds no promotion settings, eligibility rule, fixed-$3 calculation, catalog-price change, checkout interception or promotional UI. These changes are local and have not been deployed. BSS Volume Pricing remains a candidate authoritative engine, not a verified integration.

## Fixed

| Finding / Surface | Implemented repair |
| --- | --- |
| P1: native variant quantity | [assets/price-per-item.js](assets/price-per-item.js) sums **every** matching variant line, normalizing numeric/string IDs. Partial add responses trigger a complete cart read; request versions reject late responses. The existing native tier renderer is retained. |
| P2: favorites lookup | [sections/main-favorites.liquid](sections/main-favorites.liquid) no longer uses `all_products` or hidden BSS price markup. [sections/favorites-product-data.liquid](sections/favorites-product-data.liquid) renders inventory in the actual product/customer context, paginating variants by 250 and returning a next-page URL. [assets/favorites.js](assets/favorites.js) follows every inventory page, rejects invalid/repeated URLs, and commits a product's inventory only after completion. Product loading uses four workers; failed products remain saved. |
| P2: unverified favorites prices | Favorites now displays **Price available in cart**, with an explicit unavailable state, for all accounts. No public product price, hidden wholesale markup or cached apparent quote is substituted. This deliberately removes retail prices here too: the repository has no trustworthy BSS eligibility/quote-completion contract. Product JSON remains product/variant metadata, not a price authority. |
| P5/P8: complete cart rendering | [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js) now exposes the render-only `window.BSCartUI`. It tracks observed fetch/XHR mutations, coalesces refreshes, discards responses invalidated by newer mutations, and validates all requested sections before changing the DOM. It refreshes the drawer, full-cart items, footer subtotal/allocations, header count and accessible totals when present. Missing sections leave all previous sections intact and report an error. |
| P5/P8: one rendering owner | [assets/cart.js](assets/cart.js), [assets/cart-drawer.js](assets/cart-drawer.js), favorites, saved-for-later and persistent-cart delegate shared cart sections to the coordinator. Native quick-add/order-list rendering skips those shared sections; product-form avoids publishing incomplete add state as a completed cart render. Full-cart checkout availability and drawer overlay, summary and focus bindings are renewed after replacement. No displayed-money parsing, global subtotal copying or inferred BSS total remains in the former guard. |
| P6: restoration | [assets/persistent-cart.js](assets/persistent-cart.js) restores **only a freshly checked empty cart**. It never clears the current cart. It validates all snapshot entries, preserves properties/plans, checks add/update HTTP responses, verifies restored identities and quantities, and only then acknowledges the snapshot. Existing note/attribute values take precedence. Snapshot pushes pause during restoration or an uncertain outcome; failed proxy saves are not acknowledged. A per-customer attempt marker prevents automatic replay of the same attempted snapshot after reload. |
| P7/P11: rewards and form integrity | [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid) consumes completed full-cart renders, rejects outdated async exclusion/bootstrap work, and batches actual gift mutations. It no longer removes real rows or inserts fake gift rows ahead of Shopify. Failed gift operations are checked and are not automatically repeated for the same cart-state signature after replacement. No-op syncs do not start another render. Both cart templates now include hidden `updates[]` inputs for real gift rows. Existing BLOY refresh calls are coalesced to one animation frame instead of timer bursts. |

**Property and plan scope:** native Liquid already uses `cart | item_count_for_variant`; the repaired JavaScript matches that variant-level quantity rule, including lines split by different properties or selling plans. It does not merge or rewrite those lines. This does **not** establish BSS's own property/plan grouping rules or promotion eligibility. Cart quantity edits target the full line key where available, retaining the native line-index fallback.

**Rendering contract:** `BSCartUI.refresh()` returns the current completed render, while `{ force: true }` requests a fresh read. `beginBatch()` returns an idempotent release function for a multi-request mutation flow. Completed renders emit `cart:rendered` with the full cart and Dawn `cartUpdate` with `sectionsRendered: true`. This is a theme rendering completion signal, **not BSS pricing completion**. Incoming `cart:refresh`/`cart:updated` events force a read. Shopify supplies all rendered unit prices, line prices, discounts and totals; no new effective-price calculation exists here.

## Verified

Run `npm ci` then `npm test`. [tests/pricing-cart.test.cjs](tests/pricing-cart.test.cjs) executes actual assets with Node VM/jsdom and mocked Shopify responses. **39 tests pass.** jsdom is a development-only dependency and is not loaded by the storefront.

| Local check | Result and limit |
| --- | --- |
| One line quantity 5; two lines 1 + 4 with different properties; five separate one-unit lines | All pass quantity 5 to the existing native tier renderer, with unrelated variants excluded. Numeric/string IDs and empty-cart transitions are covered. Account-labeled repetitions exercise the same account-independent quantity code, not authenticated BSS sessions. |
| Original 34-line fixture | All 30 variants checked: variants 1000-1003 now aggregate to 5 instead of 1; the remaining 26 stay at 1. 15 product IDs and 46 total units. No quantity-line cutoff. |
| Separate 34-line DOM fixture | Every full key, variant ID, quantity and supplied final-price value survives rendering in **both** drawer and full cart. Original/final mock markup is preserved without money arithmetic. Prices are supplied fixtures, not live BSS quotes. |
| Favorites beyond 20 products | 34 handles and two inventory pages per product complete successfully. Missing/incomplete inventory discards partial data. Missing customer price never becomes a public-price fallback, including guest/retail/B2B-labeled harness cases. Existing favorites-page access remains customer-gated. |
| Cart add/change and stale responses | Partial adds fetch complete cart data; late reads cannot replace newer quantity state. Shared refreshes coalesce and mutation-invalidated sections are discarded. Missing footer response applies no partial replacement. |
| Failed quantity changes | Full cart and drawer retain actual returned cart state and show the request error after the recovery render. No failed response is rendered as a successful cart. |
| Restoration success/failure | Guest skips, nonempty-cart preservation, valid empty restores, invalid snapshots, cart filled during preflight, HTTP 422/network add failure, incomplete restored quantities and metadata-update failure are covered. No clear or failure acknowledgment; same attempted snapshot is not replayed automatically. |
| Rewards | Batch completion, no-op sync, failed gift add/update across replacement elements, absence of placeholder mutations, script parsing and gift hidden quantity fields pass. Real automatic-gift entitlement is not verified. |
| Drawer lifecycle | Actual `CartDrawer.renderContents` ignores stale bundled sections and opens after the coordinator refresh; overlay close behavior, empty-to-populated checkout availability and fresh focus containers are covered in jsdom. |
| Alternate cart notification | [assets/cart-notification.js](assets/cart-notification.js) retains its product confirmation but no longer overwrites the coordinated header count with stale bundled HTML. The actual component passes this regression. |
| JavaScript/editor checks | Modified JavaScript assets pass `node --check`; editor diagnostics report no errors in touched files. |
| Shopify Theme Check | Ran `npx --yes @shopify/cli@3 theme check --output json` on the working tree and an archived `HEAD` baseline. Both report **483 errors and 152 warnings**. Comparison by file/check/severity/message finds **zero new diagnostics**. The new favorites section and edited favorites/rewards/drawer Liquid have no diagnostics. Main-cart-items retains its pre-existing missing translation error and two `card_product` warnings. The whole theme is not lint-clean. |

No live storefront carts, app requests, authenticated customer sessions, browser viewport screenshots, checkout sessions or orders were exercised. No backend-price or checkout-price acceptance test has passed. These tests verify theme behavior and propagation of supplied data, not the correctness of supplied prices. Native quick-order/bulk and saved-item end-to-end interactions, real section pagination and BLOY reinitialization still need staging QA.

## Unresolved

### BSS Markers and Runtime

The duplicate `bss-b2b-final-line-price` markers on crossed-out original amounts and current final amounts in [snippets/cart-drawer.liquid](snippets/cart-drawer.liquid) and [sections/main-cart-items.liquid](sections/main-cart-items.liquid) are **unchanged**. Only gift quantity inputs changed in these templates. BSS VAT snippets, including [snippets/bss-b2b-tax-cart-line-item.liquid](snippets/bss-b2b-tax-cart-line-item.liquid), also remain unchanged.

The local snippets emit Shopify original/final values, full item keys and VAT bootstrap spans. The repository contains no implementation of the BSS price-marker consumer, documented original-price marker, or verified completion API. Collection-grid code invokes possible BSS refresh globals but does not define them. A removed rewards comment asserted hidden nodes were summed; a comment is not runtime evidence. It cannot be determined here whether the real BSS script queries the original node, final node, responsive duplicates, VAT descendants, or more than one cart container.

**Required evidence before changing markers:** capture the installed app's selector/read/write behavior for discounted and undiscounted lines on desktop/mobile, with drawer and full cart both present; obtain the vendor's marker and refresh contract; verify full-key grouping and totals. Do not guess a replacement attribute or remove vendor-required markup. P3 is a confirmed duplicate-marker observation with unverified impact, not a proven cause of mischarged orders.

### Remaining Risks

- P4: the existing custom bulk-order percentage calculator remains independent of BSS. P10: BSS search-feed pagination and the PJ collection lookup remain unchanged. P12: out-of-scope BSS IDs and P13: badge/tag eligibility mismatches remain pending a verified app contract. P14: bulk/PJ rounding and currency behavior still need work; only the old guard's money parsing/copying was removed.
- P9: saved-for-later still drops properties/selling plans and uses variant-oriented inventory correction/stored prices. This pass replaces its shared-cart renderer, not its saved-item data model. Native bulk mutation identity still needs property/plan coverage.
- P1: unrelated variant-change subscriptions and unusual native-volume markup remain separate coverage gaps; this pass repairs complete-cart quantity aggregation, not every product-component event scope.
- P7: real gift rows still label themselves FREE from a client property. The theme does not grant a discount; BSS/Shopify must validate gift pricing and entitlement. Existing reward spend arithmetic with mixed shipping/nonshipping lines is unchanged.
- BSS-adjusted display readiness, BLOY callbacks and Wholesale Gorilla activity remain unknown. No guessed BSS reinitialization hook was added. External replacements of fetch, cross-tab activity and remote app mutations may not be observed; this is not an atomic server cart transaction.
- Restoration intentionally favors preserving current contents over automatic merging/retrying. An uncertain attempt blocks snapshot pushes for that page session; a persisted marker suppresses automatic replay after reload. There is no retry/merge UI. AJAX cannot atomically compare-and-add across tabs or protect concurrent metadata edits. This is not a cross-device transaction guarantee.
- Favorites inventory is complete only when all requested pages succeed. Product/variant listing still relies on Shopify product JSON and needs high-variant and market/customer-context staging tests. Missing inventory does not turn into a trusted stock count; Shopify enforces the add. Verified favorites price display remains unavailable pending a documented customer quote source.
- Theme Check's 483 baseline errors and 152 warnings are outside this focused remediation. There is still no established cause of the reported order-level missing discounts; retain the per-line BSS/order investigation below.

## Promotion Readiness

**Conditionally display-ready for prices supplied by Shopify; not promotion-enabled or checkout-verified.** Existing native rows already render `original_price`/`final_price`, `original_line_price`/`final_line_price`, line allocations and cart-level discounts/totals. The shared refresh preserves those server-rendered values across both cart surfaces. A backend-fixed unit price or native discount should therefore travel through the repaired render path without a new theme calculator, subject to live QA.

If BSS changes only storefront HTML or a later checkout, those values are not automatically reflected in Shopify cart JSON/sections. Correct BSS processing after replacement, duplicate-marker interpretation and checkout reconciliation must be established before claiming display readiness for that mode. No $3 price, promotion threshold, collection setting, new progress indicator, catalog override or competing promotion engine was added.

The intended `Promo > B2B > Retail` priority remains a **backend requirement**, not implemented theme logic. Confirm BSS Volume Pricing supports collection-wide quantity aggregation, all eligible units at $3 for quantities >=5, preservation of unrelated B2B pricing, below-$3 baselines, Markets and other-discount compatibility. Otherwise a supported backend change is required. The historical proposed architecture below is a design constraint, not a deployment instruction.

### Staging Acceptance

1. Use authorized guest, retail and B2B sessions. Verify one line quantity 5, two property-split lines, five distinct lines, mixed variants/plans and a 34+ line cart in drawer and full cart; inspect every line and allocation, not only the subtotal.
2. Exercise 4 -> 5 -> 4 and 10 -> 2, removals, bulk/favorites/saved-item adds, gift changes, restoration, empty/nonempty transitions and reloads. Confirm actual customer prices and full-cart/footer agreement after each settled mutation.
3. Simulate failed add/change/update, incomplete section results and restoration failures. Confirm visible errors, no cart clearing, no acknowledgment/retry loop and successful later recovery on an explicit new action.
4. Check desktop/mobile and both layouts with BSS/BLOY loaded, including original/final markers and app readiness after replacement. Test large favorites lists and products beyond one variant page.
5. Only after BSS/backend promotion configuration is authorized, compare normal, direct and accelerated checkout with cart prices and an authorized test order, including noneligible B2B lines and competing discounts. No unexplained per-line mismatch is acceptable.

## Historical Audit Baseline

**The remaining inventory, P1-P14 evidence, reproduction results and proposed work describe the original pre-remediation audit.** Read the Fixed/Verified/Unresolved sections above for current status; do not interpret the old failures or proposed repairs below as a claim that all remain unchanged. File links point to the current files, whose implementation may now differ from that baseline.

### Pricing Architecture at Audit Time

```text
Shopify catalog / market / customer context
    -> Liquid product and variant prices, native quantity breaks
    -> Dawn price markup and BSS product/variant hooks
    -> externally loaded BSS storefront processing and VAT markup
    -> Shopify cart add/change/update requests
    -> Shopify cart prices and section-rendered HTML
    -> BSS rendering + BLOY + theme cart observers / refreshes
    -> cart form / accelerated checkout / direct checkout
    -> external BSS checkout integration, if applicable [unverified]
    -> Shopify checkout and order amounts [charging authority]
```

| Surface | Observed source and authority |
| --- | --- |
| Original product price | Shopify supplies `variant.price`, product price ranges, compare-at prices, and native quantity breaks. There is no catalog-price writer here. Values may already be contextual to Markets or native B2B catalogs; a Liquid price is not proof of a universal retail baseline. Catalog configuration is outside the repository. |
| Retail / logged out / logged-in retail | [snippets/price.liquid](snippets/price.liquid) renders the selected variant or product minimum/range. BSS Lock can hide access/prices. External app behavior for these customers must be verified separately. |
| B2B storefront | The same Liquid baseline carries `bss-b2b-product-id`, `bss-b2b-variant-id`, and price attributes. BSS code supplied by the app can replace the display. BSS eligibility and its actual price calculation are not present. Native Shopify quantity breaks are a separate input, not necessarily BSS rules. |
| Cards versus PDP | Most cards and the PDP share the `price` snippet, but cards normally use product-level pricing, while the PDP uses a selected variant. BSS collection VAT and PDP VAT are different integrations. Bulk order, favorites, saved items, and the PJ calculator are exceptions to a shared renderer. |
| Variant changes | `ProductInfo.handleUpdateProductInfo` fetches Shopify HTML and replaces price, volume, and variant UI. External BSS must process the replacement. This is not a backend price update. |
| Native cart | Shopify handles mutations. Normal rows render `original_price` / `final_price` and `original_line_price` / `final_line_price`; footer renders `cart.total_price`. BSS markup is added around these values. AJAX requests do not submit an authoritative custom unit price. |
| Drawer versus full cart | Same Shopify source initially, different DOM and refresh paths. Full cart has separate mobile and desktop line-total nodes; the drawer can coexist on the full-cart page. External processors must scope containers and deduplicate line identity correctly. |
| Quantity changes | `CartItems.updateQuantity` submits a one-based line index and quantity, then replaces sections returned by Shopify. Native per-variant quantity UI also runs JavaScript tier selection. BSS reinitialization and other cart mutations are not coordinated by a single completion/version contract. |
| Duplicate variants / properties | Normal cart rows preserve `item.key`; Shopify may split one variant across properties, selling plans, or discount behavior. Native `item_count_for_variant` aggregates variants in Liquid. Some JavaScript instead selects only the first matching line or updates by variant ID. |
| Discounts | Normal cart rows show line-level allocation titles; the footer shows cart-level allocation titles and amounts. Native cart line prices reflect line-level discounts, while cart-level reductions are represented separately in totals. An absent line allocation is not by itself proof of a missing B2B price: a catalog/base price or an external checkout mechanism may not produce that allocation. |
| Checkout / order | Shopify checkout/order is authoritative for what is charged. Theme text and `data-*` values cannot establish that amount. The BSS checkout handoff, discount compatibility, and order-level allocations cannot be verified here. Order history uses Shopify's order line amounts. |

`original_price` is not the same as catalog `compare_at_price`, and neither necessarily identifies an undiscounted retail price in a B2B context. Line-total money should not be reconstructed from rounded displayed unit text. Taxes, duties, shipping, cart-level allocations, and Markets must be reconciled separately.

## Pricing Components

The repository-wide search covered assets, snippets, sections, templates, blocks, layouts, and configuration for money/price fields, discounts, customer tags, B2B/wholesale, cart requests, metafields, selling plans, and price overrides. Matches that are merely labels, marketing copy, or unrelated review metadata are not price authorities.

### Core Rendering and Native Cart

| Files | Role |
| --- | --- |
| [layout/theme.liquid](layout/theme.liquid), [layout/theme.pagefly.liquid](layout/theme.pagefly.liquid) | App injection via `content_for_header`, global scripts, Wholesale Gorilla custom integration, checkout guard. Normal layout also loads persistent-cart, favorites, and saved-item scripts. Layout differences require separate QA. |
| [snippets/price.liquid](snippets/price.liquid), [assets/component-price.css](assets/component-price.css) | Shared native price/sale renderer and styling; BSS identity attributes. No authoritative B2B or promotion calculation. |
| [sections/main-product.liquid](sections/main-product.liquid), [sections/featured-product.liquid](sections/featured-product.liquid), [assets/product-info.js](assets/product-info.js) | Selected-variant price, inventory/quantity rules, section replacement, VAT hooks. Main product also owns independent bulk-order calculation and custom-text properties. |
| [snippets/card-product.liquid](snippets/card-product.liquid), [sections/main-collection-product-grid.liquid](sections/main-collection-product-grid.liquid) | Cards, pagination, hidden prefetch, cached collection HTML, guessed app refresh hooks. |
| [sections/featured-collection.liquid](sections/featured-collection.liquid), [sections/related-products.liquid](sections/related-products.liquid), [sections/mega-collection-display.liquid](sections/mega-collection-display.liquid), [sections/pj-collection-highlight.liquid](sections/pj-collection-highlight.liquid), [sections/collage.liquid](sections/collage.liquid), [sections/main-search.liquid](sections/main-search.liquid), [sections/predictive-search.liquid](sections/predictive-search.liquid) | Card/search display consumers, including BSS visibility checks. Collection/list visibility is also affected in [sections/collection-list.liquid](sections/collection-list.liquid) and [sections/main-list-collections.liquid](sections/main-list-collections.liquid). |
| [snippets/buy-buttons.liquid](snippets/buy-buttons.liquid), [assets/product-form.js](assets/product-form.js), [assets/recipient-form.js](assets/recipient-form.js), [assets/quick-add.js](assets/quick-add.js) | Product forms, properties, gift-card recipient data, quick-add and optional dynamic checkout. `ProductForm.onSubmitHandler` posts FormData and publishes cart updates. |
| [assets/cart.js](assets/cart.js), [assets/cart-drawer.js](assets/cart-drawer.js) | `CartItems.updateQuantity`, `onCartUpdate`, `CartDrawer.renderContents`, drawer opening, section replacement, BLOY refresh bursts and fetch/XHR wrappers. |
| [sections/main-cart-items.liquid](sections/main-cart-items.liquid), [sections/main-cart-footer.liquid](sections/main-cart-footer.liquid), [snippets/cart-drawer.liquid](snippets/cart-drawer.liquid), [sections/cart-drawer.liquid](sections/cart-drawer.liquid), [templates/cart.json](templates/cart.json) | Native line and total prices, line/cart allocations, line identity, cart forms, reward gift exceptions, checkout buttons. |
| [snippets/cart-notification.liquid](snippets/cart-notification.liquid), [assets/cart-notification.js](assets/cart-notification.js), [sections/cart-notification-product.liquid](sections/cart-notification-product.liquid), [sections/cart-notification-button.liquid](sections/cart-notification-button.liquid), [sections/cart-icon-bubble.liquid](sections/cart-icon-bubble.liquid), [sections/cart-live-region-text.liquid](sections/cart-live-region-text.liquid) | Alternative add confirmation, checkout form, cart counts and accessible total announcements. |
| [assets/constants.js](assets/constants.js), [assets/pubsub.js](assets/pubsub.js), [assets/global.js](assets/global.js) | Cart/variant/quantity events, debounce, native quantity and bulk queue infrastructure. |
| [snippets/quick-order-list.liquid](snippets/quick-order-list.liquid), [snippets/quick-order-list-row.liquid](snippets/quick-order-list-row.liquid), [sections/quick-order-list.liquid](sections/quick-order-list.liquid), [assets/quick-order-list.js](assets/quick-order-list.js), [assets/quick-add-bulk.js](assets/quick-add-bulk.js), [assets/price-per-item.js](assets/price-per-item.js), [snippets/quantity-input.liquid](snippets/quantity-input.liquid) | Per-variant bulk quantity updates, native quantity-break displays, `PricePerItem` selection. These are distinct from the custom bulk-order form. |
| [snippets/facets.liquid](snippets/facets.liquid), [snippets/price-facet.liquid](snippets/price-facet.liquid), [assets/facets.js](assets/facets.js) | Shopify price filters and filtered section replacement; no custom checkout price. |
| [sections/main-order.liquid](sections/main-order.liquid), [sections/main-account.liquid](sections/main-account.liquid), [templates/gift_card.liquid](templates/gift_card.liquid) | Shopify order/account totals and gift-card balances, not promotion calculators. |
| [snippets/meta-tags.liquid](snippets/meta-tags.liquid), [snippets/bss-lock-hpogs.liquid](snippets/bss-lock-hpogs.liquid) | Product social/SEO price output and hide-price behavior. Conditional cart pricing must not replace base catalog SEO prices. |

### Apps and Custom Pricing

| Files / Integration | Role |
| --- | --- |
| [config/settings_data.json](config/settings_data.json) | BLOY loyalty and BSS B2B Solution embeds enabled. This is configuration for remote code, not the code itself. Other enabled review, restock, and messaging embeds are not demonstrated pricing engines here. |
| [templates/search.bss.b2b.liquid](templates/search.bss.b2b.liquid), [templates/search.bss.bcp.liquid](templates/search.bss.bcp.liquid), [templates/search.bss.po.liquid](templates/search.bss.po.liquid) | JSON search feeds with product IDs, variant IDs/prices, tags and collection IDs; BCP includes inventory. They supply catalog data, not a per-customer B2B quote. |
| [snippets/bss-b2b-product-vat.liquid](snippets/bss-b2b-product-vat.liquid), [snippets/bss-b2b-collection-item-vat.liquid](snippets/bss-b2b-collection-item-vat.liquid) | Product/variant/collection metadata, empty VAT spans, and per-variant JSON maps. External code supplies displayed VAT/pricing values. |
| [snippets/bss-b2b-tax-cart-item.liquid](snippets/bss-b2b-tax-cart-item.liquid), [snippets/bss-b2b-tax-cart-line-item.liquid](snippets/bss-b2b-tax-cart-line-item.liquid), [snippets/bss-b2b-tax-cart-subtotal.liquid](snippets/bss-b2b-tax-cart-subtotal.liquid) | Cart product IDs, full keys, collection membership, Shopify final unit/line prices and total bootstrap. |
| [snippets/bss-b2b-tax-cart-styles.liquid](snippets/bss-b2b-tax-cart-styles.liquid), [snippets/bss-b2b-collection-item-vat-styles.liquid](snippets/bss-b2b-collection-item-vat-styles.liquid), [snippets/bss-b2b-featured-product-vat-styles.liquid](snippets/bss-b2b-featured-product-vat-styles.liquid) | Broad selectors hide native prices when the BSS tax-display module is enabled. Consumers must not assume hidden prices are authoritative or app processing has finished. |
| [snippets/bss-lock.liquid](snippets/bss-lock.liquid), [snippets/bss-lock-condition.liquid](snippets/bss-lock-condition.liquid), [snippets/bss-lock-content.liquid](snippets/bss-lock-content.liquid), [snippets/bss-lock-content-element.liquid](snippets/bss-lock-content-element.liquid), [snippets/bss-lock-ip.liquid](snippets/bss-lock-ip.liquid), [templates/search.bss.login.liquid](templates/search.bss.login.liquid), [assets/bss-lock-settings.css](assets/bss-lock-settings.css) | BSS Login/Lock visibility and access layer, separate from calculating checkout prices. IP checks call `/apps/bss-b2b-lock/ping`. Associated login/register/passcode/age/newsletter snippets are access UX, not discount engines. |
| [snippets/wsg-custom.liquid](snippets/wsg-custom.liquid), [templates/product.wsg-json.liquid](templates/product.wsg-json.liquid), [sections/wsg-custom-fields.liquid](sections/wsg-custom-fields.liquid), [sections/wsg-registration-settings.liquid](sections/wsg-registration-settings.liquid) | Wholesale Gorilla remnants: still-rendered custom script, proxy-cart styling, conditional hiding of accelerated buttons, catalog JSON and registration configuration. Runtime engine activity is unverified; do not assume uninstalled or active solely from these files. |
| [snippets/bulk-order-volume-rules.liquid](snippets/bulk-order-volume-rules.liquid), [templates/product.bulk-order.json](templates/product.bulk-order.json), [sections/main-product.liquid](sections/main-product.liquid) | Independent theme wholesale percentages and tag-based volume tiers, selected-product form quantity aggregation, displayed price multiplication. |
| [snippets/pj-pricing-calculator.liquid](snippets/pj-pricing-calculator.liquid), [templates/product.chains.json](templates/product.chains.json) | Advisory cost/markup calculator with variant and connector lookup tables. Not a checkout pricing authority. |
| [sections/main-favorites.liquid](sections/main-favorites.liquid), [assets/favorites.js](assets/favorites.js) | Handle-based Liquid inventory/bootstrap pricing, BSS hidden price mirroring, public product JSON fallback, bulk add. |
| [assets/save-for-later.js](assets/save-for-later.js), [assets/persistent-cart.js](assets/persistent-cart.js) | Saved item snapshots, cart removal/restoration, inventory correction, App Proxy synchronization and fetch/XHR wrappers. Proxy implementations are not present. |
| [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid), [assets/component-cart-rewards.css](assets/component-cart-rewards.css), [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js) | Existing spend rewards, gift add/remove and DOM placeholders; guard compares line counts and rewrites totals. No new progress UI is proposed. [assets/gwp-threshold.js](assets/gwp-threshold.js) is empty. |
| [assets/cart-debug-logger.js](assets/cart-debug-logger.js) | Available request/response diagnostic asset. No load reference was found in either layout despite its header claiming it is loaded. It is not a pricing-decision trace. |
| [snippets/customer-status-badge.liquid](snippets/customer-status-badge.liquid), [snippets/cart-account-status.liquid](snippets/cart-account-status.liquid), [sections/header.liquid](sections/header.liquid) | Display-only customer state. Must not be treated as backend authorization. |

### Configuration and Data

- BSS VAT gate: `shop.metaobjects['app--4322869--bss_b2b__shop'].data.modules_enabled` containing `tax_display`. Actual object values and wholesale rules are not exported here. BSS Lock also references app-owned lock metadata, including `app--2811029--bss_lock__metaobject` translations.
- Customer data in the normal layout: `customer.metafields.favorites.handles`, `customer.metafields.saveforlater.handles`, and `customer.metafields.cart.snapshot`; proxies `/apps/growth/favorites`, `/apps/growth/saved-for-later`, `/apps/growth/cart`. These are saved-state inputs, not trusted price overrides.
- Local wholesale form: exact configurable `B2B` customer tag, `discount eligible` product tag, `ready-to-wear` collection handle, and configured percentages. Volume rules are first-match tag rules such as `Tier 1 Chain`, `PO Tier 1`, and `Bay Tier 1`. They are not synchronized BSS configuration.
- Badge detection instead lowercases joined tags and looks for substrings `b2b`, `shop`, or `retail`. Bundle/pack sale badges use product type and `bundles` / percent-containing tags; these labels do not create discounts.
- Rewards: `reward_1_*` through `reward_4_*`, product pickers, `exclude_rewards`, `__reward_gift_variant`, and legacy `__reward_gift`. Current exported settings have shipping thresholds 35 and 500; the configured third gift has a blank threshold. Gift-specific risks below are conditional, not proof they were active on the reported orders.
- Personalization uses `properties[Custom Text]`. Selling-plan allocations render on cart lines and are saved by persistent-cart, but saved-for-later does not preserve the same identity data.
- No custom price metafield, promotion collection reference, Admin GraphQL pricing implementation, discount Function configuration, or collection-promotion backend was found. Product review/PageFly metafields are not evidence of such an engine. Existing Admin automatic/code discounts, catalogs, app rules, and combination settings remain unknown.

## Bugs and Risks

Severity reflects impact when the path is used. A confirmed theme defect is not automatically a confirmed cause of an incorrectly charged order.

| ID / Severity | File and controlling code | Evidence and impact | Recommended correction |
| --- | --- | --- | --- |
| P1 / High, confirmed | [assets/price-per-item.js](assets/price-per-item.js), `connectedCallback` | Full-cart updates use `.find()` and only the first matching variant line's quantity. Add responses also supply only the returned line quantity. Two property-split lines with quantities 1 and 4 are treated as 1, not 5. Reproduced for exactly four variants in a 34-line cart. This affects native tier display; no evidence connects it directly to BSS order calculation. Variant-change subscriptions are also unscoped across instances. | Aggregate every matching line using normalized variant IDs, consume a complete cart snapshot after adds, and scope variant-change events to their product component. Test split lines and multiple components. |
| P2 / High, confirmed design limit | [sections/main-favorites.liquid](sections/main-favorites.liquid), both bootstrap loops; [assets/favorites.js](assets/favorites.js), `buildPriceHtml` | `all_products[handle]` has a 20-unique-handle-per-page limit. Larger lists cannot yield complete inventory/BSS bootstrap data. Missing products fall back to public product prices even for signed-in wholesale customers. Commas depend on the original loop's last item, so skipped/missing trailing products can leave invalid inventory JSON. This is a concrete incomplete lookup path, not proof that BSS checkout uses this map. | Use a paginated, customer-context-aware data/section source and explicitly track completeness. Emit separators only between emitted records. Do not silently substitute retail as an established B2B quote. |
| P3 / High, confirmed markup defect; BSS effect unverified | [snippets/cart-drawer.liquid](snippets/cart-drawer.liquid), [sections/main-cart-items.liquid](sections/main-cart-items.liquid), discounted line totals | Both crossed-out `original_line_price` and current `final_line_price` are marked `bss-b2b-final-line-price`; VAT line snippets are repeated for both. Full cart repeats them for mobile/desktop, and the drawer may also exist. A first-match consumer can read the original amount; a summing consumer can double-count. | Confirm BSS's selector contract, use an original marker for original values, and give each cart rendering scope one canonical final amount per full line key. Verify all allocation-bearing lines. |
| P4 / High, confirmed cosmetic pricing | [sections/main-product.liquid](sections/main-product.liquid), `updateAllPrices`; [snippets/bulk-order-volume-rules.liquid](snippets/bulk-order-volume-rules.liquid) | Independent wholesale and volume percentages multiply `variant.price` and overwrite HTML. They count only current form quantities. The submit handler sends `{id, quantity}` without any supported pricing enforcement. Products with missing/mismatched tags receive different display tiers; app/backend rules can disagree. | Move rule ownership to the authoritative engine and render its quote. Until verified, do not represent these calculations as guaranteed checkout pricing or add another promo multiplier. |
| P5 / High, confirmed stale-state paths | [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js), `syncIfStale`, `readBssTotalText`, `correctTotalElements`; [snippets/bss-b2b-tax-cart-subtotal.liquid](snippets/bss-b2b-tax-cart-subtotal.liquid) | Guard only compares line counts, not keys/quantities/pricing, and skips an empty rendered cart. Same-count quantity or variant changes escape detection. Checkout interception is disabled. Text selectors do not match locally rendered VAT spans; fallback is ordinary Liquid `cart.total_price`, not a proven BSS total. Global first-match subtotal is copied into every native total. | Use a versioned, complete cart snapshot and the documented app completion/quote contract. Scope each container. Remove unsupported claims of authority; do not parse or mirror unrelated DOM totals as money truth. |
| P6 / High, confirmed | [assets/persistent-cart.js](assets/persistent-cart.js), `restoreSnapshot` | Despite the empty-cart-only comment, a newer other-token snapshot clears a nonempty current cart. Clear/add responses are not checked for success; a mocked HTTP 422 add failure still records restoration as applied. Restore can race rewards, user adds, and snapshot pushes, changing quantities and tier eligibility. | Enforce the intended nonempty-cart policy, serialize mutations and pause snapshot pushes during restore, validate all responses, and only acknowledge verified restored state. Preserve current cart on failure through a deliberate recovery policy. |
| P7 / High when gifts enabled, confirmed markup | [sections/main-cart-items.liquid](sections/main-cart-items.liquid), [snippets/cart-drawer.liquid](snippets/cart-drawer.liquid), gift branches; [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid), `_addGift` | Gift rows `continue` without `updates[]`, but native checkout submits a positional quantity array. Missing entries destroy one-to-one line correspondence. Rows claim FREE based on a client property alone; `_addGift` does not create a discount or check response success. Gift price correctness depends on external configuration, not the property. | Preserve full-key or positional form integrity for all lines; render Shopify's actual final price. Validate an authoritative gift entitlement/discount and response success. Test gifts at first/middle/last positions. |
| P8 / High, confirmed refresh gap | [assets/cart.js](assets/cart.js), `onCartUpdate`; [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid), `_refreshDrawer`; [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js), section list | External full-cart refresh only replaces items, not the footer; guard/reward section lists also omit `main-cart-footer`. Native drawer/full-cart components ignore every update with source `cart-items`, including updates originating from the other component. Rows, totals and allocations can disagree after changes. | Refresh all affected cart containers, footer and accessible totals from the same response/version. Distinguish originating component instances; coordinate follow-up gift mutations before accepting a final render. |
| P9 / Medium, confirmed data-loss / identity risk | [assets/save-for-later.js](assets/save-for-later.js), `handleSaveForLaterClick`, inventory validation; [assets/quick-order-list.js](assets/quick-order-list.js), `updateMultipleQty` | Saved items retain price/variant metadata but not line properties or selling plan; restoring can merge or change lines and show stale context prices. Inventory correction compares each line separately and writes updates by variant ID; shared-variant lines are ambiguous. Native bulk updaters are also variant-oriented. Public product JSON generally does not supply the inventory fields this correction expects. | Preserve properties/plan and distinguish saved identity, refresh quotes by current customer/currency, use full current line keys for existing-line mutations, and aggregate inventory demand. Do not assume missing inventory data means unlimited stock. |
| P10 / Medium, confirmed bounds risk | [templates/search.bss.b2b.liquid](templates/search.bss.b2b.liquid), [templates/search.bss.bcp.liquid](templates/search.bss.bcp.liquid), [templates/search.bss.po.liquid](templates/search.bss.po.liquid); [snippets/pj-pricing-calculator.liquid](snippets/pj-pricing-calculator.liquid) | BSS feeds request pagination size 1000, above Shopify's documented maximum 250, and expose no next-page/completeness metadata. Runtime caller pagination is unavailable. PJ connector lookup iterates unpaginated `collections.connectors.products`, subject to Liquid collection limits, not the whole collection. Product-variant maps also need high-variant coverage checks. A 30-line cart alone does not hit a 250-product bound. | Coordinate a supported paginated feed with the app, verify every requested product/variant ID is returned, and paginate catalog lookups. Do not use the PJ map as promotion eligibility. Audit unusually large variant/collection memberships against the live API limits. |
| P11 / Medium, confirmed timing heuristics; checkout impact unverified | [sections/main-collection-product-grid.liquid](sections/main-collection-product-grid.liquid), `prefetchNextPage`, `triggerBSSPriceRefresh`; [assets/cart-drawer.js](assets/cart-drawer.js), `runBurst`; [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid), `_updateExclusion` | Prefetch assumes BSS completion after 800 ms and invokes several possible globals/events without a verified API contract. BLOY gets five delayed refreshes and retriggers on BSS mutations. Rewards performs sequential per-product tag fetches and can finish older async work after newer cart events. Larger carts increase this window. Cart mutations/section fetches have no shared sequencing with app pricing. | Use documented app readiness and completion, cancellation/version checks, and one mutation/render coordinator. Never infer readiness from elapsed milliseconds. Cache/batch non-price metadata without allowing stale responses to win. |
| P12 / Medium, confirmed identity mismatch | [sections/main-cart-items.liquid](sections/main-cart-items.liquid), volume table; [sections/main-product.liquid](sections/main-product.liquid), volume markup | Full-cart volume spans use `card_product.id` and `product.selected_or_first_available_variant.id` instead of `item.product.id` and `item.variant.id`. PDP volume spans also reference out-of-scope `card_product`. These hooks can be blank/wrong for native quantity-break products. | Correct IDs within their owning loops after confirming BSS's requirements; test uncommon variant configurations. Do not confuse product ID with variant ID or use a first variant as line identity. |
| P13 / Medium, confirmed inconsistent eligibility | [snippets/customer-status-badge.liquid](snippets/customer-status-badge.liquid), badge; [sections/main-product.liquid](sections/main-product.liquid), bulk form | Badge matches a lowercase substring; bulk form checks an exact configured tag. A tag containing `b2b` can label a customer wholesale without matching the form or BSS. Actual BSS eligibility is unknown. | Source authorization from the backend's verified eligibility contract. Keep customer-state rendering separate from price selection and use explicit normalized tag equality only where tags are the actual app contract. |
| P14 / Medium, confirmed display risks | [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js), money fallback; [sections/main-product.liquid](sections/main-product.liquid), multiplication; [snippets/pj-pricing-calculator.liquid](snippets/pj-pricing-calculator.liquid), JSON prices | Guard falls back to dollar formatting in both currency branches and strips non-dot numeric punctuation when comparing text. Bulk percentage multiplication can produce fractional cents. PJ converts prices to floating major units and is independent of BSS. Public product/saved-price caches and hardcoded root URLs also need Markets context testing. | Keep authoritative monetary amounts in minor units or exact decimal money types, define rounding once in the backend, use presentment currency formatting, and invalidate context-dependent quotes. PJ should remain an explicitly advisory calculator. |

### Missing-Discount Investigation

There is **no established root cause of the reported order-level missing discounts yet**. P1 reproduces a strikingly similar four-variant failure pattern but is specifically a frontend native-volume display path. P2 supplies a real incomplete customer-price bootstrap, but not a demonstrated BSS checkout lookup. P3/P12 create selective bad DOM inputs; whether the external BSS engine consumes them for checkout needs evidence.

No explicit 26-item or 30-item cutoff was found in native cart rendering or a local authoritative price table. Search feeds distinguish product and variant IDs; JSON object keys are strings, BSS feeds emit numeric variant IDs, and WSG's feed emits string variant IDs. Normalize at integration boundaries, but do not claim numeric precision or ID coercion caused the order issue without affected IDs. Native cart updates use one-based indexes correctly for the current snapshot; concurrent mutations can make that snapshot obsolete.

For each affected order, compare a redacted per-line export against a passing line: product ID, variant ID, properties, selling plan, quantity, collection membership at purchase time, currency, catalog price context, BSS rule/quote, Shopify base/final line amounts, allocations, and checkout route. Capture BSS request product/variant IDs and returned IDs, page/batch boundaries, missing entries, initialization timing, and whether a native or app-generated checkout was used. Confirm explicit rule exclusions, missing tags/data, bundles, automatic/code discount combinations, and pricing below the intended promo price. Membership or rules may have changed since the order.

## Conflicting Pricing Systems

| Competing systems | Observable conflict |
| --- | --- |
| Shopify section HTML versus BSS price replacement | Section refresh reintroduces Shopify baseline while BSS processes later; a displayed wholesale amount is not established until the app completes. |
| Bulk-order percentages versus BSS | Theme independently multiplies catalog price; BSS may select a different rule, quantity scope, or rounding. Submitted cart IDs do not enforce the theme's number. |
| Shopify line discounts versus BSS selectors | Original and final line amounts share final-price markers, especially dangerous only on the subset of discounted lines. |
| BSS / BLOY / checkout guard | BLOY is repeatedly refreshed after BSS writes; the guard then replaces native totals using an unverified first-match BSS-text or Shopify-total fallback. No shared pricing authority controls all three writers. |
| Rewards spend versus external wholesale price | Rewards calculates shippable `final_line_price` minus all cart-level allocated discounts using Shopify's cart. If BSS only changes a later checkout, rewards uses a different spend basis. With mixed shipping/nonshipping items, subtracting the entire cart discount from only the shipping subset also needs correction. |
| Favorites / saved items / PJ calculator versus live cart | Partial bootstrap, stored prices, public JSON, and per-product maps represent different contexts and may not be current wholesale quotes. |
| BSS versus Wholesale Gorilla | Both integration footprints exist; actual simultaneous engine operation is unverified. Confirm installation/ScriptTag state before removing remnants or assuming only one checkout interceptor. |

## Proposed Promo Architecture

### Authority and Configuration

First obtain BSS's current rule export and documented checkout mechanism. Prefer extending that existing authoritative engine **only if it supports the complete contract below**, including native/direct/accelerated checkout and the required authoritative cart result. A draft-order-only rewrite or storefront discount display is not sufficient evidence of compliance.

If BSS cannot support it, use a Shopify app with a supported Discount Function and coordinate the BSS pricing/discount engine for these lines. A Function runs on Shopify's servers, cannot read theme settings as its configuration, and must not assume it sees the result of another Function or can force another app's precedence. Validate available Function APIs and app/plan requirements before scaffolding. A Cart Transform price update is only an alternative after checking plan support, operation availability, existing transforms, selling-plan limitations, and bundle behavior; it is not a drop-in theme feature.

Store one versioned app-owned configuration, projected to Function input configuration/metafields and optionally a read-only storefront metafield. The backend must remain the source of truth. A merchant edits one app UI; do not create independent theme toggles that can disagree with checkout.

| Field | Intended value |
| --- | --- |
| Enabled | Off until staged end-to-end verification is complete |
| Eligible collection | One collection reference/GID selected in the app, not a title/handle/tag convention |
| Minimum eligible quantity | 5 |
| Promotional unit amount | 300 minor units in USD |
| Currency policy | Explicit USD-only or verified Markets conversion policy; never treat 300 minor units as USD in every currency |
| Title | 5 Charms or Connectors for $15 |
| Version | Shared backend/storefront configuration revision |

Use backend product collection membership for the configured collection, for example the supported Function product membership field with configured collection IDs passed as input variables. Verify the actual API schema/version. Do not enumerate a Liquid collection or trust a client line property to decide eligibility. Membership is product-level; the output target must be every applicable cart line ID, preserving variant and property/plan distinctions.

### Explicit Priority

The following is a backend decision contract, **not implemented code**:

```text
eligible_quantity = sum(quantity of EVERY line whose product is in configured collection)
promo_active = enabled AND eligible_quantity >= minimum_quantity

for EVERY cart line:
    if promo_active AND line.product is in configured collection:
        selected_unit_price = 300 USD cents
        pricing_source = promo
    else if authoritative B2B eligibility/rule applies:
        selected_unit_price = authoritative B2B quote
        pricing_source = b2b
    else:
        selected_unit_price = contextual Shopify retail price
        pricing_source = retail
```

For USD, eligible totals are 5 units = 1500 cents, 6 = 1800, 7 = 2100, 10 = 3000, 30 = 9000. All eligible quantities receive the price, not just multiples of five. Below threshold, select normal prices afresh; do not restore a cached previously displayed price. Disabled promotion must also restore normal behavior.

For a discount implementation, compute an exact per-unit reduction from the authoritative applicable baseline to 300 cents and target each line's full quantity. Do not use a fixed $15 discount, percentage approximation, or a five-unit target cap. Preserve noneligible B2B behavior. Product/order discount combination rules must be validated together: automatic selection of the largest discount is not an explicit priority system, and globally disabling discount combinations may remove B2B pricing on unrelated lines.

**Important constraint:** a Discount Function can reduce a price, not increase a lower price to $3. If catalog/B2B/selling-plan pricing is already below $3, exact-$3 precedence requires control of that underlying pricing path or a separately supported price-setting mechanism. Likewise, stacking order/loyalty discounts can reduce a $3 line below $3. Preserving all existing discount behavior and simultaneously guaranteeing exactly $3 may require changing how those rules allocate to promotional versus nonpromotional lines. This decision cannot be hidden in a theme workaround.

### Storefront and Debugging

Keep normal PDP/card/SEO base pricing. Initially render the backend's authoritative cart unit/line prices and native sale/discount styling. No permanent $3 base price, progress bar, popup, additional drawer, or add-more message. Any optional promotion description must come from the same versioned configuration and must not assert an active price before checkout/cart enforcement exists.

Use server-side development logs or an explicit opt-in preview diagnostic. Extend the existing logger only with a disabled-by-default flag and no requests/wrappers/logs installed when off. Do not expose private wholesale rule tables to guests. Useful records: snapshot/config version, full cart line ID/key, string product/variant IDs, currency, quantity, collection membership result, aggregate eligible quantity, contextual retail baseline, verified B2B quote or `unknown`, selected source, selected price, Shopify unit/line amounts and allocations. Never label an inferred DOM price as an actual backend decision. Redact customer identifiers, cart tokens and personal properties before sharing traces.

### Files to Modify After the Gate Opens

| Owning surface | Planned work |
| --- | --- |
| BSS backend or a separate Shopify app repository, not present here | Authoritative rule, configuration UI/storage, collection input, B2B coordination, discount compatibility and Function/integration tests. This is the required first implementation surface. |
| [snippets/cart-drawer.liquid](snippets/cart-drawer.liquid), [sections/main-cart-items.liquid](sections/main-cart-items.liquid), BSS VAT snippets | Correct selector and line identity contracts, gift form integrity, and authoritative price rendering after vendor confirmation. |
| [assets/cart.js](assets/cart.js), [assets/cart-drawer.js](assets/cart-drawer.js), [assets/cart-checkout-guard.js](assets/cart-checkout-guard.js), [snippets/cart-rewards.liquid](snippets/cart-rewards.liquid) | Consistent cart refresh/versioning, full-cart footer coverage, removal of conflicting total rewrites only after BSS/BLOY contracts are understood. |
| [assets/price-per-item.js](assets/price-per-item.js) | Aggregate split variants from complete cart snapshots and scope variant subscriptions. |
| [sections/main-favorites.liquid](sections/main-favorites.liquid), [assets/favorites.js](assets/favorites.js), [assets/save-for-later.js](assets/save-for-later.js), [assets/persistent-cart.js](assets/persistent-cart.js) | Complete quote data, correct line identity, preserved properties/plans, safe restoration and current-context displays. |
| [sections/main-product.liquid](sections/main-product.liquid), [snippets/bulk-order-volume-rules.liquid](snippets/bulk-order-volume-rules.liquid) | Replace independent guaranteed-price calculations with backend quotes, preserving unrelated product UI. |
| [assets/cart-debug-logger.js](assets/cart-debug-logger.js), [layout/theme.liquid](layout/theme.liquid), [layout/theme.pagefly.liquid](layout/theme.pagefly.liquid) | Opt-in, read-only diagnostic only; not an additional pricing engine. |
| [config/settings_schema.json](config/settings_schema.json) | No independent authoritative promo settings. Only optional presentation preferences after backend synchronization exists. |

These are proposed repairs, not a recommendation to change all surfaces blindly or replace the theme. Stage narrowly, validate each owning path, and let app-managed snippets be updated through the vendor where appropriate.

## Original Reproduction Tests

During the initial audit, Node assertions ran in memory against the original source using `node:vm` and mocked DOM/pubsub/network boundaries. No dependencies were installed in that initial phase and no storefront requests were sent. Those assertions verified reproduction of the original defects; current remediation tests and development dependencies are documented in Verified above.

| Check | Actual result |
| --- | --- |
| Large cart against actual `PricePerItem.connectedCallback` | 34 lines, 30 variants, 15 products, 46 total units. First 30 lines contain one unit; four additional lines repeat variants 1000-1003 with quantity 4 and a different `engraving` property/key. Every variant was checked against aggregate line quantity. Exactly four variants were undercounted; the other 26 matched. |
| Both cart templates, gift branch | Asserted absence of `updates[]` in each gift branch and its presence in normal rows. Confirms form-data omission; actual Shopify form-submission outcome was not exercised. |
| Both cart templates, sale branch | Asserted `original_line_price` appears on an element marked `bss-b2b-final-line-price`. BSS consumption was not simulated. |
| Guard versus subtotal snippet | Asserted fallback attribute comes from `cart.total_price` and expected guard text selectors are absent from local subtotal markup. External app-created nodes were not available. |
| Full-cart external refresh | Asserted `onCartUpdate` requests items and omits `main-cart-footer`. |
| Actual `restoreSnapshot` with mocked HTTP failure | A nonempty current cart triggered clear then add; a mocked 422 add still reached successful completion/acknowledgment. |

Large-cart diagnostic details:

| Product ID | Variant ID | Line quantities | Expected aggregate | Actual passed to tier selection |
| --- | --- | --- | --- | --- |
| 2000 | 1000 | 1 + 4 | 5 | 1 |
| 2000 | 1001 | 1 + 4 | 5 | 1 |
| 2001 | 1002 | 1 + 4 | 5 | 1 |
| 2001 | 1003 | 1 + 4 | 5 | 1 |

The fixture had no authoritative collection membership, retail/B2B quote, or checkout price. Those fields are **unknown, not passed**. It does not satisfy the requested promotion's per-line price verification. There was no claim that synthetic expected prices were actual Shopify results.

## Required End-to-End Tests

All tests in this section are **blocked/not run** until the backend, preview storefront, eligible collection and authorized test customers are available.

| Scenario | Required assertion |
| --- | --- |
| 0, 1, 4 eligible units | Normal contextual retail/B2B prices; no promo allocation or lingering override. |
| 5, 6, 7, 10, 30 eligible units | Every eligible unit exactly 300 USD cents; eligible merchandise totals 1500, 1800, 2100, 3000, 9000 cents respectively. |
| One variant quantity 5; five different products; 2 + 2 + 1 | Same threshold and unit-price behavior. |
| Mixed eligible/noneligible cart, either add order | Promo only on eligible products; all others retain normal B2B/retail and approved discount behavior. |
| Logged out, logged-in retail, logged-in B2B | Verify actual backend eligibility, not the badge. Promo wins for B2B on eligible lines only. |
| Different variants of one product; same variant split by properties/plan | Sum all eligible quantities, target every line independently, preserve identity data and supported subscription behavior. |
| Quantity 4 -> 5, 5 -> 4, 10 -> 2; removal, subsequent add; enable -> disable | Immediate authoritative recalculation and clean B2B/retail fallback without stale prices. |
| Drawer, full cart, hard reload, rapid concurrent requests | Same line keys, quantities, allocations and totals; footer and accessible announcements agree after all mutations complete. |
| Direct checkout and accelerated checkout where available | Exact same backend rule without relying on a drawer, click handler, or prior page render. PDP dynamic checkout is disabled in several exported templates, but full-cart additional checkout buttons still exist. |
| Desktop/mobile, normal/PageFly layouts | No hidden extra price nodes consumed as independent lines; correct price display after every rerender. |
| Other discounts, BLOY rewards, bundles, below-$3 base prices, native B2B catalogs, Markets/taxes | Explicit documented compatibility, no unintended stacking below $3, no loss of nonpromo B2B pricing, verified currency/rounding behavior. Unsupported exact-price cases must block rollout. |

### Large-Order Acceptance

Use at least 34 actual Shopify cart lines with eligible and noneligible products, duplicate product IDs, distinct variant IDs, same-variant property splits, quantities greater than one, and B2B-priced merchandise. Include lines near batch boundaries and products with many variants. Repeat for every customer class and quantity transition above; also repeat after direct checkout and an authorized test order.

For **every** cart and order line record: snapshot/version, full line identity, product ID, variant ID, quantity, membership source/result, contextual retail price, verified B2B quote (or explicitly unknown), expected selected unit/line price, actual Shopify unit/line price, discounts/allocations, and currency. Never merge split lines for price assertions. Aggregate only the eligible-quantity threshold. Reconcile line and cart allocations to checkout merchandise totals, separately from tax/shipping. A correct subtotal alone does not pass. Zero unexplained per-line mismatches is the acceptance criterion.

## Manual QA Checklist

- Verify backend configuration revision, collection ID, enabled state, USD/Markets policy and BSS compatibility before enabling the promotion in a preview/staging environment.
- As guest, retail and B2B, test 4/5/6/10/30 units and a mixed cart. Inspect every qualifying line, not just subtotal.
- Split a variant using different properties, add different variants from one product, and repeat 4 -> 5 -> 4 and 10 -> 2 through drawer/full-cart controls.
- Reload and test mobile/desktop, direct checkout and supported accelerated checkout. Confirm an authorized test order's actual line prices/allocations.
- Repeat with discounts, loyalty/gifts and a 34+ line cart; confirm nonpromo B2B behavior and disable-promo fallback. Do not publish with unexplained mismatches.

## What Is Needed to Proceed

1. Access to the BSS rule configuration/export and confirmation of its actual checkout mechanism, supported priority/combination behavior and runtime refresh API. Confirm whether Wholesale Gorilla still runs.
2. The backend/app repository or an approved BSS-supported rule path, plus a preview/staging store and permission for test carts/checkouts. Do not send secrets through chat.
3. The collection reference, presentment-currency policy, and decisions for prices already below $3, order-discount stacking, selling plans and bundles.
4. Redacted affected-order line data and test customer contexts so the order-level missing-discount bug can be distinguished from the confirmed display/quantity defects.

Until those are available, `Promo > B2B > Retail` is a specified backend requirement, not an enforced or verified feature.