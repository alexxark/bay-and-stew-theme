/**
 * Blog search - live client-side filter for the main-blog section.
 *
 * Filters the currently paginated article cards by matching the user's query
 * against each article's title, tags, excerpt, and author (data attributes
 * rendered by sections/main-blog.liquid).
 *
 * When the input is cleared, the original layout (including pagination)
 * is restored. When no articles on the current page match, a message with a
 * link to Shopify's full-site article search is shown so the shopper can
 * broaden their search beyond the current page.
 */
class BlogSearch extends HTMLElement {
  constructor() {
    super();

    this.input = this.querySelector('[data-blog-search-input]');
    this.clearButton = this.querySelector('[data-blog-search-clear]');
    this.status = this.querySelector('[data-blog-search-status]');
    this.form = this.querySelector('form');

    const container = this.closest('.main-blog') || document;
    this.articlesGrid = container.querySelector('[data-blog-articles]');
    this.articles = this.articlesGrid
      ? Array.from(this.articlesGrid.querySelectorAll('[data-blog-article]'))
      : [];
    this.pagination = container.querySelector('[data-blog-pagination]');

    this.searchIndex = this.articles.map((el) => ({
      element: el,
      haystack: [
        el.dataset.articleTitle,
        el.dataset.articleTags,
        el.dataset.articleExcerpt,
        el.dataset.articleAuthor,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    }));

    this.debouncedFilter = this.debounce(this.filter.bind(this), 120);
  }

  connectedCallback() {
    if (!this.input) return;

    this.input.addEventListener('input', this.debouncedFilter);
    this.input.addEventListener('search', this.debouncedFilter);

    if (this.form) {
      this.form.addEventListener('submit', this.onSubmit.bind(this));
    }

    if (this.clearButton) {
      this.clearButton.addEventListener('click', this.clear.bind(this));
    }
  }

  onSubmit(event) {
    // Allow the browser to navigate to /search when the query cannot be
    // satisfied by the current page. If we have local matches, keep the user
    // on the blog page and just filter in place.
    const query = this.input.value.trim();
    if (!query) {
      event.preventDefault();
      return;
    }
    const matches = this.countMatches(query);
    if (matches > 0) {
      event.preventDefault();
      this.filter();
    }
  }

  clear() {
    this.input.value = '';
    this.filter();
    this.input.focus();
  }

  countMatches(query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.searchIndex.length;
    return this.searchIndex.filter((entry) => entry.haystack.includes(needle)).length;
  }

  filter() {
    const query = this.input.value.trim().toLowerCase();
    const hasQuery = query.length > 0;

    if (this.clearButton) {
      this.clearButton.hidden = !hasQuery;
    }

    if (!hasQuery) {
      // Reset: show everything, restore pagination, clear status.
      this.searchIndex.forEach((entry) => {
        entry.element.hidden = false;
      });
      if (this.pagination) this.pagination.hidden = false;
      if (this.status) {
        this.status.hidden = true;
        this.status.textContent = '';
      }
      return;
    }

    let visibleCount = 0;
    this.searchIndex.forEach((entry) => {
      const matches = entry.haystack.includes(query);
      entry.element.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    // Hide pagination while filtering since it applies to the full result set,
    // not to filtered results.
    if (this.pagination) this.pagination.hidden = true;

    if (this.status) {
      this.status.hidden = false;
      if (visibleCount === 0) {
        const searchUrl = this.buildFullSearchUrl(query);
        this.status.innerHTML = `No articles on this page match &ldquo;<strong></strong>&rdquo;. <a href="${searchUrl}">Search all articles</a>.`;
        // Safely inject the query text.
        this.status.querySelector('strong').textContent = this.input.value.trim();
      } else {
        const label = visibleCount === 1 ? 'article' : 'articles';
        this.status.textContent = `${visibleCount} ${label} found on this page.`;
      }
    }
  }

  buildFullSearchUrl(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'article',
      'options[prefix]': 'last',
    });
    const base = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
    const root = base.endsWith('/') ? base : `${base}/`;
    return `${root}search?${params.toString()}`;
  }

  debounce(fn, wait) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }
}

if (!customElements.get('blog-search')) {
  customElements.define('blog-search', BlogSearch);
}
