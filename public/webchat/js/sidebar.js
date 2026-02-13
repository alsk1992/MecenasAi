/**
 * Sidebar — tabs (chats, cases, documents, deadlines), session list,
 * search, profile popover
 */
import { Storage } from './storage.js';

export class Sidebar {
  constructor(sidebarEl) {
    this.sidebarEl = sidebarEl;
    this.listEl = sidebarEl.querySelector('.session-list');
    this.searchEl = sidebarEl.querySelector('.sidebar-search-input');
    this.sessions = [];
    this.activeSessionId = null;
    this.activeTab = 'chats';

    // Callbacks
    this.onSelect = null;
    this.onDelete = null;
    this.onRename = null;
    this.onCaseClick = null;
    this.onDocumentClick = null;
    this.onDeadlineClick = null;
    this.onNewCase = null;
    this.onNewDeadline = null;

    // Cached API data
    this._cases = [];
    this._documents = [];
    this._deadlines = [];

    // Default expanded on desktop, collapsed on mobile
    const saved = Storage.get('sidebarExpanded');
    if (saved !== null) {
      this._expanded = saved === 'true';
    } else {
      this._expanded = window.innerWidth > 768;
    }
    if (this._expanded) {
      this.sidebarEl.classList.add('expanded');
    }

    // Search filters within active tab
    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        this._renderActiveTab();
      });
    }

    // Tab switching (rail icon buttons)
    this.sidebarEl.querySelectorAll('.rail-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (this.activeTab === tab && this._expanded) {
          // Clicking active tab again collapses panel
          this.toggle();
        } else {
          this.switchTab(tab);
          if (!this._expanded) this.toggle();
        }
      });
    });

    // Profile popover toggle
    const profileBar = this.sidebarEl.querySelector('#sidebar-profile');
    const popover = this.sidebarEl.querySelector('#profile-popover');
    if (profileBar && popover) {
      profileBar.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.toggle('visible');
      });
      // Close popover when clicking outside
      document.addEventListener('click', (e) => {
        if (!popover.contains(e.target) && !profileBar.contains(e.target)) {
          popover.classList.remove('visible');
        }
      });
    }

    // Rail profile button (bottom of icon rail)
    const railProfileBtn = this.sidebarEl.querySelector('#rail-profile-btn');
    if (railProfileBtn && popover) {
      railProfileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this._expanded) this.toggle();
        popover.classList.toggle('visible');
      });
    }

    // Help link
    const helpItem = this.sidebarEl.querySelector('#popover-help');
    if (helpItem) {
      helpItem.addEventListener('click', () => {
        window.open('https://github.com/alsk1992/MecenasAi', '_blank');
        popover?.classList.remove('visible');
      });
    }

    // Settings panel
    const settingsItem = this.sidebarEl.querySelector('#popover-settings');
    if (settingsItem) {
      settingsItem.addEventListener('click', () => {
        popover?.classList.remove('visible');
        this._openSettings();
      });
    }
    const settingsBack = this.sidebarEl.querySelector('#settings-back');
    if (settingsBack) {
      settingsBack.addEventListener('click', () => this._closeSettings());
    }
    const settingsSave = this.sidebarEl.querySelector('#settings-save');
    if (settingsSave) {
      settingsSave.addEventListener('click', () => this._saveSettings());
    }
    this._settingsDirty = {};

    // Language select
    const langSelect = this.sidebarEl.querySelector('#language-select');
    if (langSelect) {
      const savedLang = Storage.get('webchat_language') || 'pl-PL';
      langSelect.value = savedLang;
      langSelect.addEventListener('change', () => {
        Storage.set('webchat_language', langSelect.value);
        this.onLanguageChange?.(langSelect.value);
      });
    }

    // Quick action buttons in tab headers
    const newCaseBtn = this.sidebarEl.querySelector('#new-case-btn');
    if (newCaseBtn) {
      newCaseBtn.addEventListener('click', () => this.onNewCase?.());
    }
    const newDeadlineBtn = this.sidebarEl.querySelector('#new-deadline-btn');
    if (newDeadlineBtn) {
      newDeadlineBtn.addEventListener('click', () => this.onNewDeadline?.());
    }

    // Context menu (right-click on sessions)
    this._contextMenu = null;
    document.addEventListener('click', () => this._hideContextMenu());
  }

  switchTab(tab) {
    if (tab === this.activeTab) return;
    this.activeTab = tab;

    // Update rail buttons
    this.sidebarEl.querySelectorAll('.rail-btn[data-tab]').forEach(btn => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Update panels
    this.sidebarEl.querySelectorAll('.sidebar-tab-content').forEach(panel => {
      panel.classList.toggle('active', panel.dataset.panel === tab);
    });

    // Update search placeholder
    if (this.searchEl) {
      const placeholders = {
        chats: 'Szukaj rozmów...',
        cases: 'Szukaj spraw...',
        documents: 'Szukaj dokumentów...',
        deadlines: 'Szukaj terminów...',
      };
      this.searchEl.placeholder = placeholders[tab] || 'Szukaj...';
    }

    // Fetch data when switching to API-backed tabs
    if (tab === 'cases') this._fetchCases();
    else if (tab === 'documents') this._fetchDocuments();
    else if (tab === 'deadlines') this._fetchDeadlines();

    this._renderActiveTab();
  }

  _renderActiveTab() {
    const filter = this.searchEl?.value?.toLowerCase() || undefined;
    switch (this.activeTab) {
      case 'chats': this._renderSessions(filter); break;
      case 'cases': this._renderCases(filter); break;
      case 'documents': this._renderDocuments(filter); break;
      case 'deadlines': this._renderDeadlines(filter); break;
    }
  }

  async loadSessions() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '<div class="session-loading"><div class="skeleton-line"></div><div class="skeleton-line short"></div><div class="skeleton-line"></div></div>';
    try {
      const userId = Storage.get('userId') || '';
      const r = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(userId)}`);
      if (!r.ok) { this.listEl.innerHTML = ''; return; }
      const data = await r.json();
      this.sessions = data.sessions || [];
      this._renderWithCurrentFilter();
    } catch {
      this.listEl.innerHTML = '';
    }
  }

  addSession(session) {
    this.sessions = [session, ...this.sessions.filter(s => s.id !== session.id)];
    this._renderWithCurrentFilter();
  }

  updateSession(id, updates) {
    const s = this.sessions.find(s => s.id === id);
    if (s) Object.assign(s, updates);
    this._renderWithCurrentFilter();
  }

  removeSession(id) {
    this.sessions = this.sessions.filter(s => s.id !== id);
    this._renderWithCurrentFilter();
  }

  _renderWithCurrentFilter() {
    const filter = this.searchEl?.value?.toLowerCase() || undefined;
    this._renderSessions(filter);
  }

  setActive(sessionId) {
    this.activeSessionId = sessionId;
    if (this.listEl) {
      this.listEl.querySelectorAll('.session-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === sessionId);
      });
    }
  }

  toggle() {
    this._expanded = !this._expanded;
    this.sidebarEl.classList.toggle('expanded', this._expanded);
    Storage.set('sidebarExpanded', this._expanded ? 'true' : 'false');
    // Hide popover when collapsing
    if (!this._expanded) {
      const popover = this.sidebarEl.querySelector('#profile-popover');
      popover?.classList.remove('visible');
    }
  }

  get collapsed() { return !this._expanded; }

  // ─── Sessions (Chats tab) ───

  _startRename(item, titleSpan, session) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = session.title || session.lastMessage || 'Nowa rozmowa';
    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const newTitle = input.value.trim();
      if (save && newTitle && newTitle !== (session.title || session.lastMessage || 'Nowa rozmowa')) {
        session.title = newTitle;
        this.onRename?.(session.id, newTitle);
      }
      const newSpan = document.createElement('span');
      newSpan.className = 'session-title';
      newSpan.textContent = session.title || session.lastMessage || 'Nowa rozmowa';
      input.replaceWith(newSpan);
      item.title = newSpan.textContent;
      newSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._startRename(item, newSpan, session);
      });
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  _renderSessions(filter) {
    if (!this.listEl) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const lastWeek = new Date(today.getTime() - 7 * 86400000);

    const groups = [
      ['Dzisiaj', []],
      ['Wczoraj', []],
      ['Ostatnie 7 dni', []],
      ['Starsze', []],
    ];

    for (const s of this.sessions) {
      const title = s.title || s.lastMessage || 'Nowa rozmowa';
      if (filter && !title.toLowerCase().includes(filter)) continue;

      const d = new Date(s.updatedAt);
      if (d >= today) groups[0][1].push(s);
      else if (d >= yesterday) groups[1][1].push(s);
      else if (d >= lastWeek) groups[2][1].push(s);
      else groups[3][1].push(s);
    }

    const frag = document.createDocumentFragment();
    let hasItems = false;

    for (const [label, items] of groups) {
      if (!items.length) continue;
      hasItems = true;

      const group = document.createElement('div');
      group.className = 'session-group';

      const groupLabel = document.createElement('div');
      groupLabel.className = 'session-group-label';
      groupLabel.textContent = label;
      group.appendChild(groupLabel);

      for (const s of items) {
        const title = s.title || s.lastMessage || 'Nowa rozmowa';
        const isActive = s.id === this.activeSessionId;

        const item = document.createElement('div');
        item.className = 'session-item' + (isActive ? ' active' : '');
        item.dataset.id = s.id;
        item.title = title;
        item.setAttribute('role', 'listitem');

        const titleSpan = document.createElement('span');
        titleSpan.className = 'session-title';
        titleSpan.textContent = title;
        item.appendChild(titleSpan);

        const delBtn = document.createElement('button');
        delBtn.className = 'session-delete';
        delBtn.dataset.id = s.id;
        delBtn.title = 'Usuń';
        delBtn.innerHTML = '&times;';
        item.appendChild(delBtn);

        // Click handlers
        item.addEventListener('click', (e) => {
          if (e.target.closest('.session-delete')) return;
          if (e.target.closest('.session-rename-input')) return;
          this.onSelect?.(s.id);
        });
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onDelete?.(s.id);
        });
        titleSpan.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          this._startRename(item, titleSpan, s);
        });

        group.appendChild(item);
      }

      frag.appendChild(group);
    }

    if (!hasItems) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = filter ? `Brak wyników dla "${filter}"` : 'Brak rozmów';
      frag.appendChild(empty);
    }

    const scrollTop = this.listEl.scrollTop;
    this.listEl.innerHTML = '';
    this.listEl.appendChild(frag);
    this.listEl.scrollTop = scrollTop;
  }

  // ─── Context Menu ───

  _hideContextMenu() {
    if (this._contextMenu) {
      this._contextMenu.remove();
      this._contextMenu = null;
    }
  }

  // ─── Cases (Sprawy tab) ───

  async _fetchCases() {
    try {
      const r = await fetch('/api/cases');
      if (!r.ok) {
        this._showListError('cases-list', 'Nie udało się załadować spraw.');
        return;
      }
      this._cases = await r.json();
      this._renderActiveTab();
    } catch {
      this._showListError('cases-list', 'Brak połączenia z serwerem.');
    }
  }

  _renderCases(filter) {
    const listEl = this.sidebarEl.querySelector('.cases-list');
    if (!listEl) return;

    const frag = document.createDocumentFragment();
    const filtered = filter
      ? this._cases.filter(c =>
          (c.title || '').toLowerCase().includes(filter) ||
          (c.sygnatura || '').toLowerCase().includes(filter) ||
          (c.court || '').toLowerCase().includes(filter))
      : this._cases;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = filter ? `Brak spraw dla "${filter}"` : 'Brak spraw. Napisz "Utwórz nową sprawę" w czacie.';
      frag.appendChild(empty);
      listEl.innerHTML = '';
      listEl.appendChild(frag);
      return;
    }

    // Group by status
    const statusLabels = {
      'nowa': 'Nowe',
      'w_toku': 'W toku',
      'zakonczona': 'Zakończone',
      'zawieszona': 'Zawieszone',
    };
    const groups = {};
    for (const c of filtered) {
      const status = c.status || 'nowa';
      if (!groups[status]) groups[status] = [];
      groups[status].push(c);
    }

    const statusOrder = ['w_toku', 'nowa', 'zawieszona', 'zakonczona'];
    for (const status of statusOrder) {
      const items = groups[status];
      if (!items?.length) continue;

      const group = document.createElement('div');
      group.className = 'session-group';

      const label = document.createElement('div');
      label.className = 'session-group-label';
      label.textContent = statusLabels[status] || status;
      group.appendChild(label);

      for (const c of items) {
        const item = document.createElement('div');
        item.className = 'session-item case-item';
        item.dataset.id = c.id;

        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = c.title;
        item.appendChild(title);

        if (c.sygnatura) {
          const sig = document.createElement('span');
          sig.className = 'case-sygnatura';
          sig.textContent = c.sygnatura;
          item.appendChild(sig);
        }

        item.addEventListener('click', () => {
          this.onCaseClick?.(c);
        });

        group.appendChild(item);
      }

      frag.appendChild(group);
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  // ─── Documents (Dokumenty tab) ───

  async _fetchDocuments() {
    try {
      const r = await fetch('/api/documents');
      if (!r.ok) {
        this._showListError('documents-list', 'Nie udało się załadować dokumentów.');
        return;
      }
      this._documents = await r.json();
      this._renderActiveTab();
    } catch {
      this._showListError('documents-list', 'Brak połączenia z serwerem.');
    }
  }

  _renderDocuments(filter) {
    const listEl = this.sidebarEl.querySelector('.documents-list');
    if (!listEl) return;

    const frag = document.createDocumentFragment();
    const filtered = filter
      ? this._documents.filter(d =>
          (d.title || '').toLowerCase().includes(filter) ||
          (d.type || '').toLowerCase().includes(filter))
      : this._documents;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = filter ? `Brak dokumentów dla "${filter}"` : 'Brak dokumentów. Napisz "Napisz pozew" w czacie.';
      frag.appendChild(empty);
      listEl.innerHTML = '';
      listEl.appendChild(frag);
      return;
    }

    // Group by status
    const statusLabels = {
      'szkic': 'Szkice',
      'do_sprawdzenia': 'Do sprawdzenia',
      'zatwierdzony': 'Zatwierdzone',
      'zlozony': 'Złożone',
    };
    const statusIcons = {
      'szkic': '\u270F\uFE0F',
      'do_sprawdzenia': '\uD83D\uDD0D',
      'zatwierdzony': '\u2705',
      'zlozony': '\uD83D\uDCE4',
    };
    const groups = {};
    for (const d of filtered) {
      const status = d.status || 'szkic';
      if (!groups[status]) groups[status] = [];
      groups[status].push(d);
    }

    const statusOrder = ['do_sprawdzenia', 'szkic', 'zatwierdzony', 'zlozony'];
    for (const status of statusOrder) {
      const items = groups[status];
      if (!items?.length) continue;

      const group = document.createElement('div');
      group.className = 'session-group';

      const label = document.createElement('div');
      label.className = 'session-group-label';
      label.textContent = (statusIcons[status] || '') + ' ' + (statusLabels[status] || status);
      group.appendChild(label);

      for (const d of items) {
        const item = document.createElement('div');
        item.className = 'session-item document-item';
        item.dataset.id = d.id;

        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = d.title;
        item.appendChild(title);

        const typeBadge = document.createElement('span');
        typeBadge.className = 'doc-type-badge';
        typeBadge.textContent = (d.type || 'pismo').replace(/_/g, ' ');
        item.appendChild(typeBadge);

        // Approve/Reject buttons for review docs
        if (d.status === 'do_sprawdzenia') {
          const approveBtn = document.createElement('button');
          approveBtn.className = 'doc-action-btn approve';
          approveBtn.title = 'Zatwierdź';
          approveBtn.textContent = '\u2705';
          approveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._approveDocument(d.id, item);
          });
          item.appendChild(approveBtn);

          const rejectBtn = document.createElement('button');
          rejectBtn.className = 'doc-action-btn reject';
          rejectBtn.title = 'Odrzuć (wróć do szkicu)';
          rejectBtn.textContent = '\u274C';
          rejectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._rejectDocument(d.id, item);
          });
          item.appendChild(rejectBtn);
        }

        // Export button for approved/filed docs
        if (d.status === 'zatwierdzony' || d.status === 'zlozony') {
          const exportBtn = document.createElement('button');
          exportBtn.className = 'doc-export-btn';
          exportBtn.title = 'Pobierz DOCX';
          exportBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
          exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.open(`/api/documents/${d.id}/export`, '_blank');
          });
          item.appendChild(exportBtn);
        }

        item.addEventListener('click', () => {
          this.onDocumentClick?.(d);
        });

        group.appendChild(item);
      }

      frag.appendChild(group);
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  // ─── Deadlines (Terminy tab) ───

  async _fetchDeadlines() {
    try {
      const r = await fetch('/api/deadlines?upcoming=true');
      if (!r.ok) {
        this._showListError('deadlines-list', 'Nie udało się załadować terminów.');
        return;
      }
      this._deadlines = await r.json();
      this._renderActiveTab();
    } catch {
      this._showListError('deadlines-list', 'Brak połączenia z serwerem.');
    }
  }

  _renderDeadlines(filter) {
    const listEl = this.sidebarEl.querySelector('.deadlines-list');
    if (!listEl) return;

    const frag = document.createDocumentFragment();
    const filtered = filter
      ? this._deadlines.filter(d =>
          (d.title || '').toLowerCase().includes(filter) ||
          (d.type || '').toLowerCase().includes(filter))
      : this._deadlines;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = filter ? `Brak terminów dla "${filter}"` : 'Brak nadchodzących terminów. Dodaj termin przyciskiem powyżej lub poleceniem w czacie.';
      frag.appendChild(empty);
      listEl.innerHTML = '';
      listEl.appendChild(frag);
      return;
    }

    const now = Date.now();
    const oneDay = 86400000;
    const threeDays = 3 * oneDay;
    const oneWeek = 7 * oneDay;

    // Sort by date ascending
    const sorted = [...filtered].sort((a, b) => a.date - b.date);

    // Group by urgency
    const groups = [
      ['Zaległy', []],
      ['Najbliższe 3 dni', []],
      ['Ten tydzień', []],
      ['Później', []],
    ];

    for (const d of sorted) {
      if (d.completed) continue;
      const diff = d.date - now;
      if (diff < 0) groups[0][1].push(d);
      else if (diff < threeDays) groups[1][1].push(d);
      else if (diff < oneWeek) groups[2][1].push(d);
      else groups[3][1].push(d);
    }

    let hasItems = false;
    for (const [label, items] of groups) {
      if (!items.length) continue;
      hasItems = true;

      const group = document.createElement('div');
      group.className = 'session-group';

      const groupLabel = document.createElement('div');
      groupLabel.className = 'session-group-label';
      groupLabel.textContent = label;
      if (label === 'Zaległy') groupLabel.style.color = 'var(--red, #e94560)';
      group.appendChild(groupLabel);

      for (const d of items) {
        const item = document.createElement('div');
        item.className = 'session-item deadline-item';
        if (label === 'Zaległy') item.classList.add('overdue');
        item.dataset.id = d.id;

        // Completion checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'deadline-checkbox';
        checkbox.title = 'Oznacz jako zrealizowany';
        checkbox.setAttribute('aria-label', 'Oznacz jako zrealizowany');
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
          this._completeDeadline(d.id, item);
        });
        item.appendChild(checkbox);

        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = d.title;
        item.appendChild(title);

        const dateStr = new Date(d.date).toLocaleDateString('pl-PL', {
          day: 'numeric', month: 'short', year: 'numeric',
        });
        const dateBadge = document.createElement('span');
        dateBadge.className = 'deadline-date';
        dateBadge.textContent = dateStr;
        item.appendChild(dateBadge);

        const typeBadge = document.createElement('span');
        typeBadge.className = 'deadline-type-badge';
        typeBadge.textContent = d.type || 'procesowy';
        item.appendChild(typeBadge);

        item.addEventListener('click', () => {
          this.onDeadlineClick?.(d);
        });

        group.appendChild(item);
      }

      frag.appendChild(group);
    }

    if (!hasItems) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'Brak nadchodzących terminów. Dodaj termin przyciskiem powyżej lub poleceniem w czacie.';
      frag.appendChild(empty);
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  // ── Settings Panel ──

  async _openSettings() {
    const panel = this.sidebarEl.querySelector('#settings-panel');
    if (!panel) return;
    panel.classList.add('visible');

    const body = panel.querySelector('#settings-body');
    body.innerHTML = '<div class="settings-loading">Ładowanie...</div>';

    try {
      const token = Storage.get('webchat_token') || '';
      const r = await fetch('/api/config/env', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error('Failed to load');
      const data = await r.json();
      this._renderSettings(data.schema);
    } catch (err) {
      body.innerHTML = '<div class="settings-error">Nie udało się załadować ustawień.</div>';
    }
  }

  _closeSettings() {
    const panel = this.sidebarEl.querySelector('#settings-panel');
    panel?.classList.remove('visible');
    this._settingsDirty = {};
    const banner = this.sidebarEl.querySelector('#settings-restart-banner');
    if (banner) banner.classList.remove('visible');
    const saveBtn = this.sidebarEl.querySelector('#settings-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Zapisz zmiany';
    }
  }

  _renderSettings(schema) {
    const body = this.sidebarEl.querySelector('#settings-body');
    if (!body) return;
    body.innerHTML = '';
    this._settingsDirty = {};

    const frag = document.createDocumentFragment();

    for (const cat of schema) {
      const section = document.createElement('div');
      section.className = 'settings-category';

      const label = document.createElement('div');
      label.className = 'settings-category-label';
      label.textContent = cat.category;
      section.appendChild(label);

      for (const v of cat.vars) {
        const field = document.createElement('div');
        field.className = 'settings-field';

        // Header: label + status badge
        const header = document.createElement('div');
        header.className = 'settings-field-header';

        const labelEl = document.createElement('label');
        labelEl.className = 'settings-field-label';
        labelEl.textContent = v.label;
        if (v.required) {
          const req = document.createElement('span');
          req.className = 'settings-required';
          req.textContent = ' *';
          labelEl.appendChild(req);
        }
        header.appendChild(labelEl);

        const status = document.createElement('span');
        status.className = 'settings-field-status ' + (v.set ? 'set' : 'unset');
        status.textContent = v.set ? 'Ustawiono' : 'Brak';
        header.appendChild(status);
        field.appendChild(header);

        // Env var name + help link
        const envName = document.createElement('div');
        envName.className = 'settings-env-name';
        envName.textContent = v.key;
        if (v.helpUrl) {
          const link = document.createElement('a');
          link.href = v.helpUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          link.className = 'settings-help-link';
          link.textContent = 'Pobierz klucz';
          envName.appendChild(document.createTextNode(' '));
          envName.appendChild(link);
        }
        field.appendChild(envName);

        // Input
        const input = document.createElement('input');
        input.className = 'settings-input';
        input.type = v.secret ? 'password' : 'text';
        input.placeholder = v.set ? v.masked : 'Nie skonfigurowano';
        input.dataset.key = v.key;
        input.addEventListener('input', () => {
          const val = input.value.trim();
          if (val) {
            this._settingsDirty[v.key] = val;
          } else {
            delete this._settingsDirty[v.key];
          }
          const saveBtn = this.sidebarEl.querySelector('#settings-save');
          if (saveBtn) {
            saveBtn.disabled = Object.keys(this._settingsDirty).length === 0;
            saveBtn.textContent = 'Zapisz zmiany';
          }
        });
        field.appendChild(input);

        section.appendChild(field);
      }

      frag.appendChild(section);
    }

    body.appendChild(frag);
  }

  async _approveDocument(id, itemEl) {
    try {
      const r = await fetch(`/api/documents/${encodeURIComponent(id)}/approve`, { method: 'POST' });
      if (!r.ok) {
        this._showListError('documents-list', 'Nie udało się zatwierdzić dokumentu.');
        return;
      }
      itemEl.style.opacity = '0.4';
      setTimeout(() => this._fetchDocuments(), 600);
    } catch {
      this._showListError('documents-list', 'Brak połączenia z serwerem.');
    }
  }

  async _rejectDocument(id, itemEl) {
    try {
      const r = await fetch(`/api/documents/${encodeURIComponent(id)}/reject`, { method: 'POST' });
      if (!r.ok) {
        this._showListError('documents-list', 'Nie udało się odrzucić dokumentu.');
        return;
      }
      itemEl.style.opacity = '0.4';
      setTimeout(() => this._fetchDocuments(), 600);
    } catch {
      this._showListError('documents-list', 'Brak połączenia z serwerem.');
    }
  }

  async _completeDeadline(id, itemEl) {
    try {
      const r = await fetch(`/api/deadlines/${encodeURIComponent(id)}/complete`, { method: 'POST' });
      if (!r.ok) {
        this._showListError('deadlines-list', 'Nie udało się oznaczyć terminu.');
        return;
      }
      // Animate removal
      itemEl.style.opacity = '0.4';
      itemEl.style.textDecoration = 'line-through';
      setTimeout(() => {
        this._fetchDeadlines();
      }, 600);
    } catch {
      this._showListError('deadlines-list', 'Brak połączenia z serwerem.');
    }
  }

  _showListError(listClass, message) {
    const listEl = this.sidebarEl.querySelector(`.${listClass}`);
    if (!listEl) return;
    const err = document.createElement('div');
    err.className = 'sidebar-error';
    err.textContent = message;
    listEl.innerHTML = '';
    listEl.appendChild(err);
  }

  async _saveSettings() {
    if (Object.keys(this._settingsDirty).length === 0) return;

    const saveBtn = this.sidebarEl.querySelector('#settings-save');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Zapisywanie...';
    }

    try {
      const token = Storage.get('webchat_token') || '';
      const r = await fetch('/api/config/env', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ vars: this._settingsDirty }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || 'Save failed');
      }

      const data = await r.json();

      if (data.restartRequired) {
        const banner = this.sidebarEl.querySelector('#settings-restart-banner');
        if (banner) banner.classList.add('visible');
      }

      // Refresh panel to show updated statuses
      this._settingsDirty = {};
      await this._openSettings();

      if (saveBtn) saveBtn.textContent = 'Zapisano!';
      setTimeout(() => {
        if (saveBtn) {
          saveBtn.textContent = 'Zapisz zmiany';
          saveBtn.disabled = true;
        }
      }, 2000);
    } catch (err) {
      if (saveBtn) {
        saveBtn.textContent = 'Błąd — spróbuj ponownie';
        saveBtn.disabled = false;
        setTimeout(() => {
          if (saveBtn) saveBtn.textContent = 'Zapisz zmiany';
        }, 3000);
      }
    }
  }
}
