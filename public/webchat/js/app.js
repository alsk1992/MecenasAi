/**
 * Main controller — wires sidebar, chat, WS, commands
 */
import { Storage } from './storage.js';
import { WSClient } from './ws.js?v=4';
import { Sidebar } from './sidebar.js';
import { Chat } from './chat.js';
import { CommandPalette } from './commands.js';

/** Announce to screen readers via aria-live regions */
function srAnnounce(text, urgent = false) {
  const el = document.getElementById(urgent ? 'sr-alerts' : 'sr-status');
  if (!el) return;
  el.textContent = '';
  // Force reannounce by clearing then setting
  requestAnimationFrame(() => { el.textContent = text; });
}

class App {
  constructor() {
    this.ws = new WSClient();
    this.activeSessionId = null;
    this.userId = null;
  }

  async init() {
    // Resolve userId & token
    const params = new URLSearchParams(location.search);
    const queryToken = params.get('token');
    if (queryToken) {
      Storage.set('webchat_token', queryToken);
      // Strip token from URL to prevent leaking via bookmarks/history
      params.delete('token');
      const clean = params.toString();
      history.replaceState(null, '', location.pathname + (clean ? '?' + clean : ''));
    }
    const token = Storage.get('webchat_token') || '';

    this.userId = Storage.get('userId') || 'web-' + Date.now();
    Storage.set('userId', this.userId);

    // DOM refs
    const sidebarEl = document.querySelector('.sidebar');
    const messagesEl = document.getElementById('messages');
    const typingEl = document.getElementById('typing');
    const welcomeEl = document.getElementById('welcome');
    const inputEl = document.getElementById('input');
    const sendBtnEl = document.getElementById('send-btn');
    const paletteEl = document.getElementById('cmd-palette');
    const statusDot = document.getElementById('status-dot');
    const headerTitle = document.getElementById('header-title');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const newChatBtn = document.getElementById('new-chat-btn');
    const backdropEl = document.querySelector('.sidebar-backdrop');

    // Init components
    this.sidebar = new Sidebar(sidebarEl);
    this.chat = new Chat(messagesEl, typingEl, welcomeEl);
    this.commands = new CommandPalette(paletteEl, inputEl, sendBtnEl);

    // Scroll-to-bottom button
    const scrollBtn = document.getElementById('scroll-bottom');
    messagesEl.addEventListener('scroll', () => {
      const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
      scrollBtn.classList.toggle('visible', !atBottom);
    });
    scrollBtn.addEventListener('click', () => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    });

    // Sidebar callbacks
    this.sidebar.onSelect = (id) => this.switchSession(id);
    this.sidebar.onDelete = (id) => this.deleteSession(id);
    this.sidebar.onRename = (id, title) => {
      const headerTitle = document.getElementById('header-title');
      if (this.activeSessionId === id && headerTitle) {
        headerTitle.textContent = title;
      }
      fetch(`/api/chat/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, userId: this.userId }),
      }).catch(() => {});
    };
    // Case/document/deadline click — send prompt to chat
    this.sidebar.onCaseClick = (c) => {
      const inputEl = document.getElementById('input');
      inputEl.value = `Pokaż szczegóły sprawy: ${c.title}`;
      this._send();
    };
    this.sidebar.onDocumentClick = (d) => {
      const inputEl = document.getElementById('input');
      inputEl.value = `Pokaż dokument: ${d.title}`;
      this._send();
    };
    this.sidebar.onDeadlineClick = (d) => {
      const inputEl = document.getElementById('input');
      inputEl.value = `Pokaż termin: ${d.title}`;
      this._send();
    };
    this.sidebar.onNewCase = () => {
      const inputEl = document.getElementById('input');
      inputEl.value = 'Utwórz nową sprawę';
      inputEl.focus();
    };
    this.sidebar.onNewDeadline = () => {
      const inputEl = document.getElementById('input');
      inputEl.value = 'Dodaj nowy termin';
      inputEl.focus();
    };
    this.sidebar.onNewInvoice = () => {
      const inputEl = document.getElementById('input');
      inputEl.value = 'Utwórz nową fakturę';
      inputEl.focus();
    };

    // Language change — update speech recognition (set later once recognition is created)
    this._recognition = null;
    this.sidebar.onLanguageChange = (lang) => {
      if (this._recognition) this._recognition.lang = lang;
    };

    // Chat edit callback — put text back into input
    this.chat.onEdit = (text) => {
      inputEl.value = text;
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
      sendBtnEl.classList.toggle('active', text.trim().length > 0);
      inputEl.focus();
    };

    newChatBtn?.addEventListener('click', () => this.newChat());

    // Sidebar toggle (shared logic for desktop + mobile buttons)
    const toggleSidebar = () => {
      this.sidebar.toggle();
      backdropEl?.classList.toggle('visible', !this.sidebar.collapsed);
      if (!this.sidebar.collapsed) this.commands.hide();
    };
    sidebarToggle?.addEventListener('click', toggleSidebar);
    const sidebarToggleMobile = document.getElementById('sidebar-toggle-mobile');
    sidebarToggleMobile?.addEventListener('click', toggleSidebar);

    backdropEl?.addEventListener('click', () => {
      if (!this.sidebar.collapsed) {
        this.sidebar.toggle();
        backdropEl.classList.remove('visible');
      }
    });

    // Input handling (textarea auto-resize)
    const autoResize = () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    };

    inputEl.addEventListener('input', () => {
      autoResize();
      sendBtnEl.classList.toggle('active', inputEl.value.trim().length > 0 || !!this._pendingAttachment);
      this.commands.handleInput(inputEl.value);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (this.commands.handleKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    sendBtnEl.addEventListener('click', () => {
      if (this._generating) {
        // Send cancel to server to abort agent processing
        if (this.ws?.connected) {
          this.ws.ws.send(JSON.stringify({ type: 'cancel' }));
        }
        this.chat.hideTyping();
        this._setGenerating(false);
        return;
      }
      this._send();
    });

    // Attachment button + file preview
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const filePreview = document.getElementById('file-preview');
    const filePreviewIcon = filePreview?.querySelector('.file-preview-icon');
    const filePreviewName = filePreview?.querySelector('.file-preview-name');
    const filePreviewRemove = filePreview?.querySelector('.file-preview-remove');

    const showFilePreview = (name, mime) => {
      if (!filePreview) return;
      const icon = mime?.startsWith('image/') ? '\uD83D\uDDBC\uFE0F' :
                   mime === 'application/pdf' ? '\uD83D\uDCC4' :
                   mime?.includes('json') ? '\uD83D\uDCCB' : '\uD83D\uDCCE';
      filePreviewIcon.textContent = icon;
      filePreviewName.textContent = name;
      filePreview.style.display = 'flex';
      attachBtn?.classList.add('has-file');
      sendBtnEl.classList.add('active');
    };

    this._clearFilePreview = () => {
      this._pendingAttachment = null;
      if (filePreview) filePreview.style.display = 'none';
      if (attachBtn) { attachBtn.classList.remove('has-file'); attachBtn.title = 'Attach file'; }
    };

    attachBtn?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
      fileInput?.click();
    });
    filePreviewRemove?.addEventListener('click', () => {
      this._clearFilePreview();
      if (!inputEl.value.trim()) sendBtnEl.classList.remove('active');
    });
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
      if (file.size > MAX_FILE_SIZE) {
        this.chat.addMessage('Plik za duży (maks. 10 MB).', 'system');
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        this._pendingAttachment = {
          filename: file.name,
          mimeType: file.type,
          data: reader.result?.split(',')[1] || '', // base64
        };
        showFilePreview(file.name, file.type);
      };
      reader.onerror = () => {
        this.chat.addMessage('Nie udało się odczytać pliku.', 'system');
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    // Handle drag-and-drop files (prevent browser navigation + attach file)
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && fileInput) {
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change'));
      }
    });

    // Paste image support (Cmd+V / Ctrl+V)
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob || !fileInput) return;
          const dt = new DataTransfer();
          dt.items.add(new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type }));
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change'));
          return;
        }
      }
    });

    // Voice input (Web Speech API)
    const micBtn = document.getElementById('mic-btn');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition && micBtn) {
      const recognition = this._recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = Storage.get('webchat_language') || 'pl-PL';
      let listening = false;
      let textBeforeVoice = '';

      micBtn.addEventListener('click', () => {
        if (listening) {
          recognition.abort();
          return;
        }
        textBeforeVoice = inputEl.value;
        listening = true;
        micBtn.classList.add('listening');
        micBtn.title = 'Stop listening';
        recognition.start();
      });

      recognition.onresult = (e) => {
        let interim = '';
        let final = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const transcript = e.results[i][0].transcript;
          if (e.results[i].isFinal) {
            final += transcript;
          } else {
            interim += transcript;
          }
        }
        const separator = textBeforeVoice && !textBeforeVoice.endsWith(' ') ? ' ' : '';
        inputEl.value = textBeforeVoice + separator + (final || interim);
        autoResize();
        sendBtnEl.classList.toggle('active', inputEl.value.trim().length > 0);
      };

      const stopListening = () => {
        listening = false;
        micBtn.classList.remove('listening');
        micBtn.title = 'Voice input';
      };

      recognition.onend = stopListening;
      recognition.onerror = (e) => {
        stopListening();
        if (e.error !== 'aborted' && e.error !== 'no-speech') {
          console.warn('Speech recognition error:', e.error);
        }
      };
    } else if (micBtn) {
      micBtn.classList.add('unsupported');
    }

    document.addEventListener('click', (e) => {
      if (!paletteEl.contains(e.target) && e.target !== inputEl) {
        this.commands.hide();
      }
    });

    // Welcome chip clicks
    document.querySelectorAll('.welcome-card').forEach(chip => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.dataset.msg;
        this._send();
      });
    });

    // Reconnect banner
    const reconnectBanner = document.getElementById('reconnect-banner');

    // Tab notification state
    this._unreadCount = 0;
    this._originalTitle = document.title;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this._unreadCount > 0) {
        this._unreadCount = 0;
        document.title = this._originalTitle;
      }
    });

    // Time-based greeting + themed subtitle + live market pulse
    const greetingEl = document.getElementById('welcome-greeting');
    const subEl = document.querySelector('.welcome-sub');
    if (greetingEl) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Dzień dobry' : hour < 18 ? 'Dzień dobry' : 'Dobry wieczór';
      greetingEl.textContent = greeting;

      if (subEl) {
        const subs = hour < 12 ? [
          'W czym mogę dziś pomóc?',
          'Gotowy do pracy nad sprawami.',
          'Sprawdźmy terminy i pisma.',
        ] : hour < 18 ? [
          'W czym mogę pomóc?',
          'Pracujemy nad sprawami.',
          'Szukasz przepisu? Zapytaj.',
        ] : [
          'Mecenas czuwa nad Twoimi sprawami.',
          'Potrzebujesz pomocy prawnej?',
          'Przygotujmy dokumenty.',
        ];
        subEl.textContent = subs[Math.floor(Math.random() * subs.length)];
      }
    }

    // Live market pulse
    const pulseEl = document.getElementById('welcome-pulse');
    if (pulseEl) {
      this._loadMarketPulse(pulseEl);
    }

    // Main element ref for welcome-mode
    this._mainEl = document.querySelector('.main');

    // Stop generation
    this._generating = false;
    this._stopSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    this._sendSvg = sendBtnEl.innerHTML;
    this._sendBtn = sendBtnEl;

    // WS handlers
    this.ws.on('open', () => {
      statusDot.className = 'status-dot';
      statusDot.title = 'Authenticating...';
    });

    this.ws.on('close', () => {
      statusDot.className = 'status-dot error';
      statusDot.title = 'Reconnecting...';
      reconnectBanner?.classList.add('visible');
      this.chat.hideTyping();
      this._setGenerating(false);
      srAnnounce('Połączenie utracone. Ponowne łączenie...', true);
    });

    this.ws.on('message', (msg) => {
      this.chat.hideTyping();
      this._setGenerating(false);

      if (msg.type === 'authenticated') {
        statusDot.className = 'status-dot connected';
        statusDot.title = 'Connected';
        reconnectBanner?.classList.remove('visible');
        srAnnounce('Połączono z serwerem.');
        // Send stored privacy mode to server on connect
        if (this._privacyMode && this._privacyMode !== 'auto') {
          this.ws.ws.send(JSON.stringify({ type: 'privacy_mode', mode: this._privacyMode }));
        }
        // Re-fetch messages after reconnect to recover any missed responses
        // Skip if switchSession already loaded history (flag cleared after use)
        if (this.activeSessionId && !this._skipNextRefresh) {
          this._refreshHistory(this.activeSessionId);
        }
        this._skipNextRefresh = false;
      } else if (msg.type === 'switched') {
        // Session switch confirmed
      } else if (msg.type === 'message') {
        this._setWelcomeMode(false);
        this.chat.addBotMessage(msg.text, msg.messageId, msg.attachments);
        srAnnounce('Nowa odpowiedź od Mecenasa.');
        // Refresh sidebar data tabs after bot responds (new docs/cases may have been created)
        if (this.activeSessionId && msg.text) {
          this.sidebar._fetchCases();
          this.sidebar._fetchDocuments();
          this.sidebar._fetchDeadlines();
        }
        if (document.hidden) {
          this._unreadCount++;
          document.title = `(${this._unreadCount}) Nowa wiadomość - Mecenas`;
        }
      } else if (msg.type === 'edit') {
        this.chat.editMessage(msg.messageId, msg.text);
      } else if (msg.type === 'delete') {
        this.chat.deleteMessage(msg.messageId);
      } else if (msg.type === 'reminder') {
        // Deadline reminder notification
        this.chat.addMessage(msg.text, 'system');
        srAnnounce('Przypomnienie o terminie.', true);
        this.sidebar._fetchDeadlines();
        if (document.hidden) {
          this._unreadCount++;
          document.title = `(${this._unreadCount}) Przypomnienie - Mecenas`;
        }
      } else if (msg.type === 'error') {
        if (msg.message === 'Invalid token') {
          const retry = prompt('Authentication required. Enter WebChat token:');
          if (retry) {
            Storage.set('webchat_token', retry);
            location.reload();
          } else {
            this.chat.addMessage('Authentication failed. Set token or pass ?token= in URL.', 'system');
          }
        } else {
          this.chat.addMessage(msg.message, 'system');
        }
      }
    });

    // ── Privacy indicator ──
    this._privacyMode = Storage.get('privacyMode') || 'auto';
    const privacyBtn = document.getElementById('privacy-indicator');
    if (privacyBtn) {
      this._updatePrivacyIndicator();
      privacyBtn.addEventListener('click', () => {
        const modes = ['auto', 'strict', 'off'];
        const idx = modes.indexOf(this._privacyMode);
        this._privacyMode = modes[(idx + 1) % modes.length];
        Storage.set('privacyMode', this._privacyMode);
        this._updatePrivacyIndicator();
        // Send to server
        if (this.ws?.connected) {
          this.ws.ws.send(JSON.stringify({ type: 'privacy_mode', mode: this._privacyMode }));
        }
      });
    }

    // Handle privacy_mode_set from server
    this.ws.on('message', (msg) => {
      if (msg.type === 'privacy_mode_set') {
        this._privacyMode = msg.mode;
        Storage.set('privacyMode', msg.mode);
        this._updatePrivacyIndicator();
      }
    });

    // Handle privacy mode change from settings panel
    document.addEventListener('privacy-mode-change', (e) => {
      this._privacyMode = e.detail.mode;
      this._updatePrivacyIndicator();
      if (this.ws?.connected) {
        this.ws.ws.send(JSON.stringify({ type: 'privacy_mode', mode: this._privacyMode }));
      }
    });

    // Load sessions, then connect
    await this.sidebar.loadSessions();

    const lastSessionId = Storage.get('lastSessionId');
    const hasExisting = this.sidebar.sessions.length > 0;

    if (lastSessionId && this.sidebar.sessions.find(s => s.id === lastSessionId)) {
      await this.switchSession(lastSessionId);
    } else if (hasExisting) {
      await this.switchSession(this.sidebar.sessions[0].id);
    } else {
      // Connect WS without a session — will create one on first message
      this.ws.connect(token, this.userId);
      this._showGreeting();
    }

    inputEl.focus();
  }

  async switchSession(sessionId) {
    if (this.activeSessionId === sessionId && this.ws.connected) return;

    this.chat.hideTyping();
    this._clearFilePreview();
    this.activeSessionId = sessionId;
    this.sidebar.setActive(sessionId);
    Storage.set('lastSessionId', sessionId);

    // Update header title
    const session = this.sidebar.sessions.find(s => s.id === sessionId);
    const headerTitle = document.getElementById('header-title');
    if (headerTitle) {
      headerTitle.textContent = session?.title || 'Mecenas';
    }

    // Load messages from API (guard against race if user switched again)
    try {
      const r = await fetch(`/api/chat/sessions/${sessionId}?userId=${encodeURIComponent(this.userId)}`);
      if (this.activeSessionId !== sessionId) return; // stale response
      if (r.ok) {
        const data = await r.json();
        const msgs = data.messages || [];
        this.chat.loadHistory(msgs);
        this._setWelcomeMode(!msgs.length);
      } else {
        this.chat.clear();
        this.chat.showWelcome();
        this._setWelcomeMode(true);
      }
    } catch {
      if (this.activeSessionId !== sessionId) return;
      this.chat.clear();
      this.chat.showWelcome();
      this._setWelcomeMode(true);
    }

    // Connect or switch WS (skip refresh since we just loaded history above)
    const token = Storage.get('webchat_token') || '';
    if (!this.ws.connected) {
      this._skipNextRefresh = true;
      this.ws.connect(token, this.userId, sessionId);
    } else {
      this.ws.switchSession(sessionId);
    }

    // Close mobile sidebar
    const backdropEl = document.querySelector('.sidebar-backdrop');
    if (backdropEl?.classList.contains('visible')) {
      this.sidebar.toggle();
      backdropEl.classList.remove('visible');
    }
  }

  async _refreshHistory(sessionId) {
    // Deduplicate concurrent calls for the same session
    const seq = (this._refreshSeq = (this._refreshSeq || 0) + 1);
    try {
      const r = await fetch(`/api/chat/sessions/${sessionId}?userId=${encodeURIComponent(this.userId)}`);
      if (this.activeSessionId !== sessionId || this._refreshSeq !== seq) return;
      if (r.ok) {
        const data = await r.json();
        if (this.activeSessionId !== sessionId || this._refreshSeq !== seq) return;
        const msgs = data.messages || [];
        this.chat.loadHistory(msgs);
      }
    } catch { /* ignore */ }
  }

  async newChat() {
    try {
      const r = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.userId }),
      });
      if (!r.ok) return;
      const data = await r.json();
      this.sidebar.addSession(data.session);
      await this.switchSession(data.session.id);
    } catch { /* ignore */ }
  }

  async deleteSession(sessionId) {
    if (!confirm('Usunąć tę rozmowę?')) return;
    try {
      const r = await fetch(`/api/chat/sessions/${sessionId}?userId=${encodeURIComponent(this.userId)}`, {
        method: 'DELETE',
      });
      if (!r.ok) {
        this.chat.addMessage('Nie udało się usunąć rozmowy. Spróbuj ponownie.', 'system');
        return;
      }
    } catch {
      this.chat.addMessage('Nie udało się usunąć rozmowy. Spróbuj ponownie.', 'system');
      return;
    }

    this.sidebar.removeSession(sessionId);

    if (this.activeSessionId === sessionId) {
      this.chat.hideTyping();
      if (this.sidebar.sessions.length > 0) {
        await this.switchSession(this.sidebar.sessions[0].id);
      } else {
        this.activeSessionId = null;
        this.chat.clear();
        this.chat.showWelcome();
        this._setWelcomeMode(true);
        Storage.remove('lastSessionId');
        const headerTitle = document.getElementById('header-title');
        if (headerTitle) headerTitle.textContent = 'Mecenas';
      }
    }
  }

  async _send() {
    if (this._sending) return;
    const inputEl = document.getElementById('input');
    const sendBtnEl = document.getElementById('send-btn');
    const text = inputEl.value.trim();
    if (!text && !this._pendingAttachment) return;
    this._sending = true;

    // If no active session, create one first
    if (!this.activeSessionId) {
      try {
        const r = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: this.userId }),
        });
        if (r.ok) {
          const data = await r.json();
          this.sidebar.addSession(data.session);
          this.activeSessionId = data.session.id;
          this.sidebar.setActive(data.session.id);
          Storage.set('lastSessionId', data.session.id);

          const token = Storage.get('webchat_token') || '';
          this.ws.connect(token, this.userId, data.session.id);
          // Wait for auth with timeout
          await new Promise((resolve) => {
            let elapsed = 0;
            const check = () => {
              if (this.ws.authenticated || elapsed >= 5000) return resolve();
              elapsed += 50;
              setTimeout(check, 50);
            };
            setTimeout(check, 50);
          });
        } else {
          this.chat.addMessage('Nie udało się utworzyć sesji. Spróbuj ponownie.', 'system');
          this._sending = false;
          return;
        }
      } catch {
        this.chat.addMessage('Nie udało się utworzyć sesji. Spróbuj ponownie.', 'system');
        this._sending = false;
        return;
      }
    }

    // Check if WS is actually ready before sending
    if (!this.ws.connected) {
      this.chat.addMessage('Utracono połączenie. Poczekaj i spróbuj ponownie.', 'system');
      this._sending = false;
      return;
    }

    this._setWelcomeMode(false);
    const displayText = text || (this._pendingAttachment ? '\uD83D\uDCCE ' + this._pendingAttachment.filename : '');
    if (displayText) this.chat.addMessage(displayText, 'user');
    if (this._pendingAttachment) {
      // Upload file via HTTP, then send reference to agent
      const att = this._pendingAttachment;
      this._clearFilePreview();
      try {
        const binaryStr = atob(att.data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const uploadUrl = `/api/documents/upload?filename=${encodeURIComponent(att.filename)}`;
        const uploadResp = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        if (!uploadResp.ok) {
          const err = await uploadResp.json().catch(() => ({}));
          this.chat.addMessage(err.error || 'Nie udało się przesłać pliku.', 'system');
          this._sending = false;
          this._setGenerating(false);
          return;
        }
        const uploadData = await uploadResp.json();
        const docId = uploadData.document?.id;
        const chars = uploadData.document?.chars ?? 0;
        const fileMsg = text
          ? `${text}\n\n[Przesłano plik: ${att.filename} (${chars} znaków, ID: ${docId}). Użyj get_uploaded_document aby pobrać treść.]`
          : `Przesłano plik: ${att.filename} (${chars} znaków, ID: ${docId}). Przeanalizuj ten dokument. Użyj get_uploaded_document aby pobrać treść.`;
        this.ws.send(fileMsg);
      } catch (uploadErr) {
        this.chat.addMessage('Błąd przesyłania pliku. Spróbuj ponownie.', 'system');
        this._sending = false;
        this._setGenerating(false);
        return;
      }
    } else {
      this.ws.send(text);
    }
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtnEl.classList.remove('active');
    this.chat.showTyping();
    this._setGenerating(true);
    this.commands.hide();

    // Auto-title: if session has no title, set from first message
    if (this.activeSessionId) {
      const session = this.sidebar.sessions.find(s => s.id === this.activeSessionId);
      if (session && !session.title) {
        const titleSrc = text || displayText;
        const title = titleSrc.slice(0, 50) + (titleSrc.length > 50 ? '...' : '');
        session.title = title;
        this.sidebar.updateSession(session.id, { title });
        const headerTitle = document.getElementById('header-title');
        if (headerTitle) headerTitle.textContent = title;

        // Persist title
        fetch(`/api/chat/sessions/${this.activeSessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, userId: this.userId }),
        }).catch(() => {});
      }
    }
    this._sending = false;
  }

  _setWelcomeMode(on) {
    if (this._mainEl) {
      this._mainEl.classList.toggle('welcome-mode', on);
    }
  }

  _showGreeting() {
    this._setWelcomeMode(true);
  }

  async _loadMarketPulse(el) {
    try {
      const r = await fetch('/api/knowledge/stats');
      if (!r.ok) return;
      const data = await r.json();
      if (!data.total) return;

      el.innerHTML = '';

      // Total articles
      const totalItem = document.createElement('span');
      totalItem.className = 'welcome-pulse-item';
      const dot = document.createElement('span');
      dot.className = 'welcome-pulse-dot live';
      totalItem.appendChild(dot);
      const totalVal = document.createElement('span');
      totalVal.className = 'welcome-pulse-value';
      totalVal.textContent = String(Number(data.total) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
      totalItem.appendChild(totalVal);
      totalItem.appendChild(document.createTextNode(' artykułów w bazie'));
      el.appendChild(totalItem);

      // Number of codes
      const codesItem = document.createElement('span');
      codesItem.className = 'welcome-pulse-item';
      const codesCount = data.byCodes?.filter(c => c.count > 0).length || 0;
      const codesVal = document.createElement('span');
      codesVal.className = 'welcome-pulse-value';
      codesVal.textContent = String(codesCount);
      codesItem.appendChild(codesVal);
      codesItem.appendChild(document.createTextNode(' kodeksów'));
      el.appendChild(codesItem);

      // Biggest code
      if (data.byCodes?.length) {
        const biggest = [...data.byCodes].sort((a, b) => b.count - a.count)[0];
        if (biggest) {
          const bigItem = document.createElement('span');
          bigItem.className = 'welcome-pulse-item';
          const bigVal = document.createElement('span');
          bigVal.className = 'welcome-pulse-value';
          bigVal.textContent = String(biggest.code || '');
          bigItem.appendChild(bigVal);
          bigItem.appendChild(document.createTextNode(' ' + String(Number(biggest.count) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + ' art.'));
          el.appendChild(bigItem);
        }
      }
    } catch { /* silent — pulse is optional */ }
  }

  _setGenerating(on) {
    this._generating = on;
    clearTimeout(this._genTimeout);
    const btn = this._sendBtn;
    if (!btn) return;
    if (on) {
      btn.classList.add('stop-mode');
      btn.innerHTML = this._stopSvg;
      btn.title = 'Anuluj generowanie';
      btn.classList.add('active');
      // Auto-reset after 90s to prevent stuck state
      this._genTimeout = setTimeout(() => {
        this.chat.hideTyping();
        this._setGenerating(false);
      }, 90000);
    } else {
      btn.classList.remove('stop-mode');
      btn.innerHTML = this._sendSvg;
      btn.title = 'Send';
    }
  }

  _updatePrivacyIndicator() {
    const btn = document.getElementById('privacy-indicator');
    if (!btn) return;
    const labels = {
      auto: 'Ochrona prywatności: auto (dane wrażliwe → lokalny model)',
      strict: 'Ochrona prywatności: ścisła (zawsze lokalny model)',
      off: 'Ochrona prywatności: wyłączona',
    };
    btn.title = labels[this._privacyMode] || labels.auto;
    btn.className = 'privacy-indicator privacy-' + this._privacyMode;
  }
}

// Boot
const app = new App();
app.init().catch(console.error);
