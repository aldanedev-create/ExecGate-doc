/* Logiq Documentation — main.js
 *
 * Defines window.logiqDocs so Alpine can find it regardless of
 * load order. All potentially-failing code is wrapped so a single
 * failure does not prevent the app from starting.
 */

console.log('[logiq] main.js loading');

// Configure marked. Wrapped because different marked versions accept
// different options; a bad option should not crash the whole app.
try {
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      gfm: true,
      breaks: false,
    });
    console.log('[logiq] marked configured, version:', marked.defaults ? 'ok' : 'unknown');
  } else {
    console.warn('[logiq] marked not loaded — markdown rendering disabled');
  }
} catch (e) {
  console.warn('[logiq] marked.setOptions failed:', e);
}

// Define the app as an EXPLICIT global. Using `window.logiqDocs = function`
// guarantees it is on the global scope when Alpine evaluates `x-data`.
window.logiqDocs = function () {
  return {
    // --- Loaded from bundle ---
    bundle: null,
    navigation: [],
    content: {},
    version: '',

    // --- UI state ---
    currentPath: '',
    searchQuery: '',
    filteredNavigation: [],
    loading: true,
    error: null,

    // --- Persisted ---
    darkMode: Alpine.$persist(false).as('logiq-dark'),
    openSections: Alpine.$persist([]).as('logiq-open-sections'),
    mobileSidebarOpen: false,

    // --- Computed ---
    get totalPages() {
      return this.navigation.reduce((n, s) => n + s.pages.length, 0);
    },

    get breadcrumbs() {
      if (!this.currentPath) return [];
      const parts = [];
      for (const section of this.navigation) {
        const page = section.pages.find(p => p.path === this.currentPath);
        if (page) {
          if (section.name !== 'Overview') parts.push(section.name);
          parts.push(page.title);
          break;
        }
      }
      return parts.length ? parts : [this.currentPath];
    },

    get currentHtml() {
      const md = this.content[this.currentPath];
      if (!md) return '<p>Page not found.</p>';
      return this.renderMarkdown(md);
    },

    get prevPage() {
      return this.siblingPage(-1);
    },

    get nextPage() {
      return this.siblingPage(+1);
    },

    // --- Lifecycle ---
    async init() {
      console.log('[logiq] init() running');
      try {
        const res = await fetch('docs-bundle.json', { cache: 'no-cache' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} — could not load docs-bundle.json`);
        }
        this.bundle = await res.json();
        this.navigation = this.bundle.navigation || [];
        this.content = this.bundle.content || {};
        this.version = this.bundle.version || '';
        this.filteredNavigation = this.navigation;

        const firstSection = this.navigation[0]?.name;
        if (firstSection && !this.openSections.includes(firstSection)) {
          this.openSections = [...this.openSections, firstSection];
        }

        this.loading = false;
        this.handleHash();
        window.addEventListener('hashchange', () => this.handleHash());
        console.log('[logiq] loaded', this.totalPages, 'pages');
      } catch (e) {
        console.error('[logiq] init failed:', e);
        this.error = e.message;
        this.loading = false;
      }
    },

    // --- Navigation ---
    handleHash() {
      const path = window.location.hash.replace(/^#/, '') || this.firstPagePath();
      if (!path) return;
      if (this.currentPath === path) return;
      this.currentPath = path;
      this.openSectionFor(path);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },

    navigateTo(path) {
      this.mobileSidebarOpen = false;
      if (window.location.hash === '#' + path) {
        this.handleHash();
      } else {
        window.location.hash = path;
      }
    },

    firstPagePath() {
      return this.navigation[0]?.pages[0]?.path || '';
    },

    openSectionFor(path) {
      for (const section of this.navigation) {
        if (section.pages.some(p => p.path === path)) {
          if (!this.openSections.includes(section.name)) {
            this.openSections = [...this.openSections, section.name];
          }
          return;
        }
      }
    },

    toggleSection(name) {
      this.openSections = this.openSections.includes(name)
        ? this.openSections.filter(s => s !== name)
        : [...this.openSections, name];
    },

    siblingPage(delta) {
      const flat = this.navigation.flatMap(s => s.pages);
      const idx = flat.findIndex(p => p.path === this.currentPath);
      if (idx === -1) return null;
      return flat[idx + delta] || null;
    },

    // --- Search ---
    filterNav() {
      const q = this.searchQuery.toLowerCase().trim();
      if (!q) {
        this.filteredNavigation = this.navigation;
        return;
      }
      this.filteredNavigation = this.navigation
        .map(section => ({
          name: section.name,
          pages: section.pages.filter(p =>
            p.title.toLowerCase().includes(q) ||
            p.path.toLowerCase().includes(q) ||
            (this.content[p.path] || '').toLowerCase().includes(q)
          ),
        }))
        .filter(section => section.pages.length > 0);
    },

    // --- Rendering ---
    renderMarkdown(md) {
      if (typeof marked === 'undefined') {
        return '<pre>' + md.replace(/</g, '&lt;') + '</pre>';
      }
      let html = marked.parse(md);

      // Rewrite internal .md links to hash links
      html = html.replace(
        /href="([^"]+?)\.md(#[^"]*)?"/g,
        (match, href, anchor) => {
          let path = href.replace(/^\.\.\//, '').replace(/^\.\//, '');
          path = path.replace(/^\/+/, '');
          return `href="#${path}${anchor || ''}"`;
        }
      );

      return html;
    },

    highlightCode() {
      if (typeof hljs === 'undefined') return;
      document.querySelectorAll('.content pre code').forEach(block => {
        if (!block.dataset.highlighted) {
          try {
            hljs.highlightElement(block);
            block.dataset.highlighted = 'true';
          } catch (e) {
            // Ignore highlighting errors — content still displays
          }
        }
      });
    },

    // --- UI ---
    toggleDarkMode() {
      this.darkMode = !this.darkMode;
    },
  };
};

console.log('[logiq] main.js loaded. window.logiqDocs =', typeof window.logiqDocs);