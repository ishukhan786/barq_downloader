// BARQ Downloader — Renderer Application Controller
import { $, $$, clear } from './dom.js';
import { formatSpeed } from './format.js';
import { LIST_VIEWS, renderList } from './views/downloads.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { renderAbout } from './views/about.js';
import { renderFeedback } from './views/feedback.js';
import { showAddDownloadDialog } from './views/add-download.js';

class BarqApp {
  constructor() {
    this.api = window.barq;
    this.state = {
      view: 'dashboard',
      search: '',
      info: null,
      stats: {},
      settings: {},
    };
    this.liveStats = new Map();
    this.currentViewInstance = null;
    this.refreshTimer = null;
  }

  async init() {
    if (!this.api) {
      console.error('BARQ API bridge missing');
      return;
    }

    try {
      this.state.info = await this.api.app.getInfo();
      const loadedSettings = await this.api.settings.get();
      this.state.settings = loadedSettings || {};

      this.applyTheme(this.state.settings.theme || 'dark');
      this.updateAppInfoUI();
      this.bindEvents();
      await this.refreshStats();
      await this.refreshBrowserStatus();

      // Read initial hash or default to dashboard
      const initialView = window.location.hash.replace(/^#/, '') || 'dashboard';
      await this.navigate(initialView, false);

      // Periodically refresh stats, bridge status, and current view
      this.refreshTimer = setInterval(() => {
        this.refreshStats();
        this.refreshBrowserStatus();
        if (this.currentViewInstance && typeof this.currentViewInstance.refresh === 'function') {
          this.currentViewInstance.refresh();
        }
      }, 3000);

      // Mark body as ready for tests and smoke check
      document.body.dataset.ready = '1';
    } catch (err) {
      console.error('BARQ initialization failed:', err);
    }
  }

  applyTheme(theme) {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  updateAppInfoUI() {
    const info = this.state.info;
    if (!info) return;

    const dataEl = $('#status-data');
    if (dataEl) dataEl.textContent = `Data: ${info.dataMode}`;

    const verEl = $('#status-version');
    if (verEl) verEl.textContent = `v${info.version}`;

    const engEl = $('#status-engine');
    const engDot = $('#status-engine-dot');
    if (engEl && engDot) {
      engEl.textContent = 'Engine Ready';
      engDot.className = 'dot dot-ok';
    }
  }

  async refreshBrowserStatus() {
    try {
      if (!this.api.browser || !this.api.browser.getStatus) return;
      const res = await this.api.browser.getStatus();
      const pillText = $('#titlebar-extension-text');
      const pill = $('#titlebar-extension-pill');
      const bridgeText = $('#status-bridge-text');

      if (res && res.ok && res.status && res.status.pipeServer && res.status.pipeServer.listening) {
        if (pillText) pillText.textContent = 'Extension Bridge: Ready';
        if (pill) {
          pill.classList.remove('extension-pill-offline');
          pill.classList.add('extension-pill-online');
        }
        if (bridgeText) bridgeText.textContent = 'Extension Pipe Active';
      } else {
        if (pillText) pillText.textContent = 'Extension: Offline';
        if (pill) {
          pill.classList.remove('extension-pill-online');
          pill.classList.add('extension-pill-offline');
        }
        if (bridgeText) bridgeText.textContent = 'Extension Pipe Inactive';
      }
    } catch (err) {
      // Non-critical background status update
    }
  }

  async refreshStats() {
    try {
      const stats = await this.api.stats.get();
      this.state.stats = stats;

      // Update sidebar badges
      for (const [key, val] of Object.entries(stats)) {
        const badge = $(`[data-count="${key}"]`);
        if (badge) {
          badge.textContent = val > 0 ? String(val) : '';
        }
      }

      // Update statusbar
      const spd = $('#status-speed');
      if (spd) spd.textContent = formatSpeed(stats.overallSpeedBps);

      const act = $('#status-active');
      if (act) act.textContent = String(stats.active);
    } catch (err) {
      console.warn('Failed to refresh stats:', err);
    }
  }

  async navigate(viewId, updateHistory = true) {
    if (this.currentViewInstance && typeof this.currentViewInstance.dispose === 'function') {
      this.currentViewInstance.dispose();
      this.currentViewInstance = null;
    }

    const validViews = ['dashboard', 'settings', 'about', 'feedback', ...Object.keys(LIST_VIEWS)];
    const targetView = validViews.includes(viewId) ? viewId : 'dashboard';
    this.state.view = targetView;

    if (updateHistory) {
      window.location.hash = targetView;
    }

    // Update sidebar active state
    for (const btn of $$('[data-nav]')) {
      const isCurrent = btn.dataset.nav === targetView;
      if (isCurrent) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    }

    const main = $('#view');
    clear(main);

    const ctx = {
      api: this.api,
      state: this.state,
      liveStats: this.liveStats,
      refreshStats: () => this.refreshStats(),
      navigate: (v) => this.navigate(v),
      openAddDownload: async (urlPrefill = '') => {
        const record = await showAddDownloadDialog(ctx, urlPrefill);
        if (record) {
          if (this.currentViewInstance && typeof this.currentViewInstance.refresh === 'function') {
            await this.currentViewInstance.refresh();
          }
          await this.refreshStats();
        }
        return record;
      },
      setSearch: (term) => this.setSearch(term),
    };

    if (targetView === 'dashboard') {
      this.currentViewInstance = renderDashboard(main, ctx);
    } else if (targetView === 'settings') {
      this.currentViewInstance = renderSettings(main, ctx);
    } else if (targetView === 'about') {
      this.currentViewInstance = renderAbout(main, ctx);
    } else if (targetView === 'feedback') {
      this.currentViewInstance = renderFeedback(main, ctx);
    } else if (LIST_VIEWS[targetView]) {
      this.currentViewInstance = renderList(main, ctx, targetView);
    }

    main.focus();
  }

  setSearch(term) {
    this.state.search = term;
    const globalInput = $('#global-search');
    if (globalInput && globalInput.value !== term) {
      globalInput.value = term;
    }
    if (this.currentViewInstance && typeof this.currentViewInstance.onSearch === 'function') {
      this.currentViewInstance.onSearch(term);
    }
  }

  toggleSidebar() {
    const isCollapsed = document.body.dataset.sidebar === 'collapsed';
    document.body.dataset.sidebar = isCollapsed ? 'expanded' : 'collapsed';
  }

  async toggleTheme() {
    try {
      const current = this.state.settings.theme || 'dark';
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      this.state.settings.theme = nextTheme;
      this.applyTheme(nextTheme);
      await this.api.settings.update({ theme: nextTheme });
    } catch (err) {
      console.warn('Theme toggle failed:', err);
    }
  }

  bindEvents() {
    // Nav buttons
    for (const btn of $$('[data-nav]')) {
      btn.addEventListener('click', () => {
        this.navigate(btn.dataset.nav);
      });
    }

    // Sidebar collapse toggle
    const sidebarToggle = $('#sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', () => this.toggleSidebar());
    }

    // Theme toggle button
    const themeBtn = $('#theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    // Global add buttons (sidebar & titlebar)
    const openAdd = async () => {
      const record = await showAddDownloadDialog({
        api: this.api,
        state: this.state,
        refreshStats: () => this.refreshStats(),
      });
      if (record) {
        if (this.currentViewInstance && typeof this.currentViewInstance.refresh === 'function') {
          await this.currentViewInstance.refresh();
        }
        await this.refreshStats();
      }
    };

    const addBtn = $('#btn-add');
    if (addBtn) addBtn.addEventListener('click', openAdd);

    const quickAddBtn = $('#btn-quick-add');
    if (quickAddBtn) quickAddBtn.addEventListener('click', openAdd);

    // Global search input
    const globalSearch = $('#global-search');
    if (globalSearch) {
      globalSearch.addEventListener('input', () => {
        this.setSearch(globalSearch.value);
      });
    }

    // Download Engine Live Events
    this.api.downloads.onProgress((payload) => {
      this.liveStats.set(payload.id, payload);
      if (this.currentViewInstance && typeof this.currentViewInstance.onProgress === 'function') {
        this.currentViewInstance.onProgress(payload);
      }
    });

    this.api.downloads.onStateChanged((payload) => {
      this.refreshStats();
      if (this.currentViewInstance && typeof this.currentViewInstance.refresh === 'function') {
        this.currentViewInstance.refresh();
      }
    });

    // Settings listener
    this.api.settings.onChanged((updatedSettings) => {
      this.state.settings = updatedSettings;
      if (updatedSettings.theme) {
        this.applyTheme(updatedSettings.theme);
      }
      if (this.currentViewInstance && typeof this.currentViewInstance.refresh === 'function') {
        this.currentViewInstance.refresh();
      }
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const s = $('#global-search');
        if (s) {
          s.focus();
          s.select();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openAdd();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleSidebar();
      }
    });

    window.addEventListener('hashchange', () => {
      const v = window.location.hash.replace(/^#/, '');
      if (v && v !== this.state.view) {
        this.navigate(v, false);
      }
    });
  }
}

// Instantiate and start
const app = new BarqApp();
app.init();
