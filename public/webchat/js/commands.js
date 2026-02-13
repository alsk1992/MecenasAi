/**
 * Command palette for legal assistant slash commands
 */

const LEGAL_COMMANDS = [
  // Pisma (Documents)
  { name: '/pozew', description: 'Napisz pozew', category: 'Pisma' },
  { name: '/odpowiedz', description: 'Napisz odpowiedź na pozew', category: 'Pisma' },
  { name: '/apelacja', description: 'Napisz apelację', category: 'Pisma' },
  { name: '/wezwanie', description: 'Napisz wezwanie do zapłaty', category: 'Pisma' },
  { name: '/wniosek', description: 'Napisz wniosek procesowy', category: 'Pisma' },
  { name: '/umowa', description: 'Napisz umowę', category: 'Pisma' },
  { name: '/opinia', description: 'Napisz opinię prawną', category: 'Pisma' },

  // Sprawy (Cases)
  { name: '/sprawa', description: 'Utwórz nową sprawę', category: 'Sprawy' },
  { name: '/sprawy', description: 'Lista spraw', category: 'Sprawy' },
  { name: '/klient', description: 'Dodaj nowego klienta', category: 'Sprawy' },
  { name: '/klienci', description: 'Lista klientów', category: 'Sprawy' },

  // Przepisy (Law)
  { name: '/przepis', description: 'Wyszukaj artykuł kodeksu (np. /przepis art. 415 KC)', category: 'Przepisy' },
  { name: '/kc', description: 'Szukaj w Kodeksie cywilnym', category: 'Przepisy' },
  { name: '/kpc', description: 'Szukaj w Kodeksie postępowania cywilnego', category: 'Przepisy' },
  { name: '/kk', description: 'Szukaj w Kodeksie karnym', category: 'Przepisy' },
  { name: '/kp', description: 'Szukaj w Kodeksie pracy', category: 'Przepisy' },
  { name: '/kro', description: 'Szukaj w Kodeksie rodzinnym', category: 'Przepisy' },
  { name: '/ksh', description: 'Szukaj w Kodeksie spółek handlowych', category: 'Przepisy' },
  { name: '/kpa', description: 'Szukaj w Kodeksie postępowania administracyjnego', category: 'Przepisy' },

  // Terminy (Deadlines)
  { name: '/termin', description: 'Dodaj termin procesowy', category: 'Terminy' },
  { name: '/terminy', description: 'Lista nadchodzących terminów', category: 'Terminy' },

  // Dokumenty (Documents management)
  { name: '/dokumenty', description: 'Lista dokumentów', category: 'Dokumenty' },
  { name: '/eksport', description: 'Eksportuj dokument do DOCX', category: 'Dokumenty' },
  { name: '/zatwierdz', description: 'Zatwierdź dokument', category: 'Dokumenty' },

  // Pomoc (Help)
  { name: '/pomoc', description: 'Pokaż dostępne komendy', category: 'Pomoc' },
  { name: '/status', description: 'Status bazy wiedzy prawnej', category: 'Pomoc' },
];

const CAT_ICONS = {
  'Pisma': '\u270D\uFE0F',
  'Sprawy': '\uD83D\uDCBC',
  'Przepisy': '\u2696\uFE0F',
  'Terminy': '\uD83D\uDCC5',
  'Dokumenty': '\uD83D\uDCC4',
  'Pomoc': '\u2753',
};

const CAT_ORDER = ['Pisma', 'Sprawy', 'Przepisy', 'Terminy', 'Dokumenty', 'Pomoc'];

export class CommandPalette {
  constructor(paletteEl, inputEl, sendBtnEl) {
    this.paletteEl = paletteEl;
    this.inputEl = inputEl;
    this.sendBtnEl = sendBtnEl;
    this.allCommands = LEGAL_COMMANDS;
    this.filteredCommands = [];
    this.activeIndex = -1;
    this.visible = false;
    this.onExecute = null;
  }

  _esc(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  show(filter) {
    const text = filter.slice(1).toLowerCase();
    this.filteredCommands = text
      ? this.allCommands.filter(c =>
          c.name.toLowerCase().includes(text) ||
          c.description.toLowerCase().includes(text) ||
          c.category.toLowerCase().includes(text))
      : this.allCommands;

    if (!this.filteredCommands.length) { this.hide(); return; }

    const groups = {};
    for (const cmd of this.filteredCommands) {
      (groups[cmd.category] = groups[cmd.category] || []).push(cmd);
    }

    let html = '<div class="cmd-palette-header">'
      + '<span>Komendy</span>'
      + '<span class="cmd-palette-hint"><kbd>\u2191\u2193</kbd> nawigacja <kbd>Tab</kbd> wybierz <kbd>Esc</kbd> zamknij</span>'
      + '</div>';

    let idx = 0;
    const sortedCategories = Object.keys(groups).sort((a, b) => {
      const ai = CAT_ORDER.indexOf(a);
      const bi = CAT_ORDER.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const category of sortedCategories) {
      const cmds = groups[category];
      const icon = CAT_ICONS[category] || '\uD83D\uDCE6';
      html += '<div class="cmd-category">'
        + '<div class="cmd-category-label">'
        + '<span class="cmd-category-icon">' + icon + '</span>'
        + '<span>' + this._esc(category) + '</span>'
        + '<span class="cmd-category-count">' + cmds.length + '</span>'
        + '</div>';
      for (const cmd of cmds) {
        html += '<div class="cmd-item' + (idx === this.activeIndex ? ' active' : '') + '" data-index="' + idx + '" data-name="' + this._esc(cmd.name) + '">'
          + '<span class="cmd-item-name">' + this._esc(cmd.name) + '</span>'
          + '<span class="cmd-item-desc">' + this._esc(cmd.description) + '</span></div>';
        idx++;
      }
      html += '</div>';
    }

    this._render(html);
  }

  _render(html) {
    this.paletteEl.innerHTML = html;
    this.paletteEl.classList.add('visible');
    this.visible = true;

    this.paletteEl.querySelectorAll('.cmd-item').forEach(item => {
      item.addEventListener('click', () => {
        const name = item.dataset.name;
        this.inputEl.value = name + ' ';
        this.hide();
        this.inputEl.focus();
        this.sendBtnEl.classList.add('active');
      });
    });
  }

  hide() {
    this.paletteEl.classList.remove('visible');
    this.visible = false;
    this.activeIndex = -1;
  }

  handleInput(text) {
    if (text.startsWith('/')) {
      this.activeIndex = -1;
      this.show(text);
    } else {
      this.hide();
    }
  }

  handleKeydown(e) {
    if (!this.visible) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeIndex = Math.min(this.activeIndex + 1, this.filteredCommands.length - 1);
      this.show(this.inputEl.value.startsWith('/') ? this.inputEl.value : '/' + this.inputEl.value);
      const active = this.paletteEl.querySelector('.cmd-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
      this.show(this.inputEl.value.startsWith('/') ? this.inputEl.value : '/' + this.inputEl.value);
      const active = this.paletteEl.querySelector('.cmd-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (this.activeIndex >= 0 && this.activeIndex < this.filteredCommands.length) {
        const sel = this.filteredCommands[this.activeIndex];
        this.inputEl.value = sel.name + ' ';
        this.hide();
        this.sendBtnEl.classList.add('active');
      }
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (this.activeIndex >= 0 && this.activeIndex < this.filteredCommands.length) {
        e.preventDefault();
        const sel = this.filteredCommands[this.activeIndex];
        this.inputEl.value = sel.name + ' ';
        this.hide();
        this.sendBtnEl.classList.add('active');
        return true;
      }
      // Palette visible but no selection — close palette, let Enter send normally
      this.hide();
      return false;
    }
    if (e.key === 'Escape') {
      this.hide();
      return true;
    }
    return false;
  }
}
