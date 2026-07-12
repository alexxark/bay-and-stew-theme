/**
 * Blog search - full-blog live search for the main-blog section.
 *
 * Uses Shopify's predictive-search JSON endpoint to search across ALL articles
 * in the store, then filters results down to the current blog by URL prefix
 * (`/blogs/{blog.handle}/`). This means shoppers can find articles that are
 * not on the currently paginated page.
 *
 * Behaviour:
 *  - Empty input: restores the original paginated article grid + pagination.
 *  - Non-empty input: hides the paginated grid, fetches matching articles, and
 *    renders a lightweight results list (image, title, date, excerpt).
 *  - No matches: shows a link to the full-site article search page.
 *  - Submitting the form (Enter / search button) sends the shopper to the
 *    site-wide search page (`/search?q=...&type=article`) as a fallback.
 */
class BlogSearch extends HTMLElement {
  constructor() {
    super();

    this.input = this.querySelector('[data-blog-search-input]');
    this.clearButton = this.querySelector('[data-blog-search-clear]');
    this.status = this.querySelector('[data-blog-search-status]');
    this.resultsContainer = this.querySelector('[data-blog-search-results]');
    this.form = this.querySelector('form');

    this.blogHandle = this.dataset.blogHandle || '';
    this.searchUrl = this.dataset.searchUrl || '/search/suggest';
    this.searchPageUrl = this.dataset.searchPageUrl || '/search';

    const container = this.closest('.main-blog') || document;
    this.articlesGrid = container.querySelector('[data-blog-articles]');
    this.pagination = container.querySelector('[data-blog-pagination]');

    this.abortController = null;
    this.cache = new Map();
    this.debouncedFetch = this.debounce(this.runSearch.bind(this), 250);
  }

  connectedCallback() {
    if (!this.input) return;

    this.input.addEventListener('input', this.onInput.bind(this));
    this.input.addEventListener('search', this.onInput.bind(this));

    if (this.form) {
      this.form.addEventListener('submit', this.onSubmit.bind(this));
      this.form.addEventListener('reset', this.onReset.bind(this));
    }

    if (this.clearButton) {
      this.clearButton.addEventListener('click', this.onClearClick.bind(this));
    }
  }

  onInput() {
    const query = this.input.value.trim();
    this.toggleClearButton(query.length > 0);

    if (!query) {
      this.reset();
      return;
    }
    this.debouncedFetch(query);
  }

  onSubmit(event) {
    const query = this.input.value.trim();
    if (!query) {
      event.preventDefault();
    }
    // Otherwise, allow the browser to navigate to /search?q=… for the
    // full-site article search page.
  }

  onReset(event) {
    // The theme's native form-reset would refill the query from the URL on
    // page load. Since our field starts empty, just clear it explicitly.
    event.preventDefault();
    this.clear();
  }

  onClearClick(event) {
    event.preventDefault();
    this.clear();
  }

  clear() {
    this.input.value = '';
    this.toggleClearButton(false);
    this.reset();
    this.input.focus();
  }

  toggleClearButton(show) {
    if (!this.clearButton) return;
    this.clearButton.classList.toggle('hidden', !show);
  }

  reset() {
    if (this.articlesGrid) this.articlesGrid.hidden = false;
    if (this.pagination) this.pagination.hidden = false;
    if (this.resultsContainer) {
      this.resultsContainer.hidden = true;
      this.resultsContainer.innerHTML = '';
    }
    if (this.status) {
      this.status.hidden = true;
      this.status.textContent = '';
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  runSearch(query) {
    // Hide the paginated grid + pagination while a search is active.
    if (this.articlesGrid) this.articlesGrid.hidden = true;
    if (this.pagination) this.pagination.hidden = true;

    const cached = this.cache.get(query.toLowerCase());
    if (cached) {
      this.renderResults(query, cached);
      return;
    }

    this.setStatus('Searching...');

    if (this.abortController) this.abortController.abort();
    this.abortController = new AbortController();

    const url = this.buildSuggestUrl(query);

    fetch(url, {
      signal: this.abortController.signal,
      headers: { Accept: 'application/json' },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Search request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        const articles = this.extractArticles(data);
        this.cache.set(query.toLowerCase(), articles);
        this.renderResults(query, articles);
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        console.error('[blog-search]', error);
        this.setStatus('Something went wrong. Please try again.');
      });
  }

  buildSuggestUrl(query) {
    // Shopify's predictive search JSON endpoint. We ask for articles only,
    // capped at 10 per request (the API's max). If the shopper needs more,
    // they can hit Enter to go to the full search page.
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('resources[type]', 'article');
    params.set('resources[limit]', '10');
    params.set('resources[options][unavailable_products]', 'last');
    return `${this.searchUrl}.json?${params.toString()}`;
  }

  extractArticles(data) {
    const results = data && data.resources && data.resources.results;
    const articles = (results && results.articles) || [];
    if (!this.blogHandle) return articles;

    // Restrict to articles in this blog by URL prefix.
    const prefix = `/blogs/${this.blogHandle}/`;
    return articles.filter((article) => {
      if (!article || !article.url) return false;
      try {
        const path = new URL(article.url, window.location.origin).pathname;
        return path.startsWith(prefix);
      } catch (e) {
        return article.url.indexOf(prefix) !== -1;
      }
    });
  }

  renderResults(query, articles) {
    if (!this.resultsContainer) return;

    if (!articles.length) {
      this.resultsContainer.hidden = true;
      this.resultsContainer.innerHTML = '';
      const link = this.buildFullSearchUrl(query);
      const safeQuery = this.escapeHtml(query);
      this.setStatus(
        `No articles in this blog match &ldquo;<strong>${safeQuery}</strong>&rdquo;. <a href="${link}">Search all articles</a>.`,
        true
      );
      return;
    }

    const label = articles.length === 1 ? 'article' : 'articles';
    this.setStatus(`Showing ${articles.length} matching ${label} in this blog.`);

    this.resultsContainer.innerHTML = articles
      .map((article) => this.renderArticleCard(article))
      .join('');
    this.resultsContainer.hidden = false;
  }

  renderArticleCard(article) {
    const title = this.escapeHtml(article.title || '');
    const url = this.escapeAttribute(article.url || '#');
    const summary = this.escapeHtml(this.stripHtml(article.summary_html || article.excerpt || '').trim());
    const author = article.author ? this.escapeHtml(article.author) : '';
    const date = this.formatDate(article.published_at);
    const image = article.image ? this.escapeAttribute(article.image) : '';
    const imageAlt = this.escapeAttribute(article.title || '');

    const meta = [author, date].filter(Boolean).join(' · ');

    return `
      <a class="blog-search__result" href="${url}">
        ${
          image
            ? `<span class="blog-search__result-image"><img src="${image}" alt="${imageAlt}" loading="lazy" width="200" height="200"></span>`
            : ''
        }
        <span class="blog-search__result-body">
          <span class="blog-search__result-title">${title}</span>
          ${meta ? `<span class="blog-search__result-meta">${meta}</span>` : ''}
          ${summary ? `<span class="blog-search__result-summary">${this.truncate(summary, 160)}</span>` : ''}
        </span>
      </a>
    `;
  }

  buildFullSearchUrl(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'article',
      'options[prefix]': 'last',
    });
    return `${this.searchPageUrl}?${params.toString()}`;
  }

  setStatus(message, isHtml = false) {
    if (!this.status) return;
    this.status.hidden = false;
    if (isHtml) {
      this.status.innerHTML = message;
    } else {
      this.status.textContent = message;
    }
  }

  formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch (e) {
      return d.toDateString();
    }
  }

  stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }

  truncate(str, max) {
    if (!str || str.length <= max) return str;
    return `${str.slice(0, max).trimEnd()}…`;
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  escapeAttribute(str) {
    return this.escapeHtml(str);
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
