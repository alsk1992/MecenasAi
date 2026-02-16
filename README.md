# Mecenas — Polish AI Legal Assistant

**Mecenas** is a privacy-first AI legal assistant for Polish lawyers (adwokaci and radcy prawni). It uses Bielik LLM (via Ollama) with RAG over 7 Polish legal codes — 5,549 articles fetched from the official Sejm API. Draft court documents, manage cases and clients, track deadlines, handle billing, search the law, export to DOCX. Chat via WebChat or Telegram. All data stays on your machine by default.

Built with tajemnica adwokacka (attorney-client privilege) in mind — the system defaults to local-only processing with automatic PII detection and anonymization.

---

## Quick Start

```bash
git clone https://github.com/alsk1992/MecenasAi.git && cd MecenasAi
npm install
npm run build
npm run ingest    # Load 5,549 articles from the Sejm API
npm start         # http://localhost:18789/webchat
```

Requires Ollama with Bielik **or** an Anthropic API key:

```bash
# Option A: Ollama (local, private — recommended)
ollama pull SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M
ollama pull gemma3:4b              # optional speed model for fast responses
export OLLAMA_URL=http://localhost:11434

# Option B: Claude (cloud — requires DPA acceptance)
export ANTHROPIC_API_KEY=sk-ant-...
export MECENAS_PRIVACY_MODE=auto   # default is 'strict' (local only)
export MECENAS_DPA_ACCEPTED=true   # confirm you signed Anthropic's DPA
```

---

## Features

| Category | Feature | Description |
|----------|---------|-------------|
| **Documents** | Court documents | Pozwy (claims), odpowiedzi (answers), apelacje (appeals), wezwania, wnioski, umowy, legal opinions |
| | DOCX export | Professional formatting — Times New Roman, headers, page numbers, draft watermark |
| | Document workflow | Draft > Review > Approved > Filed — with version history |
| | Document upload | PDF, DOCX, TXT — extract text and analyze with AI |
| | Templates | Save and reuse document templates across cases |
| **Cases** | Case management | Clients, cases, sygnatury, courts, opposing parties, value of dispute |
| | Deadlines | Procedural, statutory, contractual, internal — with reminders and completion tracking |
| | Timeline | Full case timeline with all events |
| **Clients** | Client management | osoba fizyczna / osoba prawna, PESEL, NIP, REGON, KRS, contact info |
| | Company lookup | KRS + CEIDG company registry search |
| **Legal** | Law search | RAG over 7 codes: KC, KPC, KK, KP, KRO, KSH, KPA (5,549 articles) |
| | Court decisions | Search 400K+ Polish court decisions via SAOS API |
| | Calculators | Court fees, statutory interest, limitation periods (przedawnienie) |
| **Billing** | Time tracking | Log hours per case with hourly rates |
| | Invoicing | Create, track, and manage invoices (FV/2026/XXX) |
| | Billing summaries | Generate billing reports per case |
| **Privacy** | PII detection | PESEL, NIP, REGON, IBAN, phone, email, ID cards, passports, addresses, company names, Polish names (with declination) |
| | Anonymization | Bidirectional PII replacement before cloud calls |
| | Privacy routing | Auto/strict/off modes — strict = local only (default) |
| | Database encryption | AES-256-GCM at rest with auto-generated keys |
| | RODO compliance | GDPR deletion (Art. 17), consent tracking, DPIA generation, privacy notices |
| | Audit trail | Every privacy decision logged without PII values |
| | Log scrubbing | PII patterns automatically redacted from all log output |
| **Channels** | WebChat | Built-in browser-based chat with real-time WebSocket |
| | Telegram | Full Telegram bot integration |
| **Routing** | Smart model routing | Gemma 3 4B for fast queries + Bielik 11B for complex legal work |
| | Fallback chain | Gemma 3 > Bielik > Claude (with privacy checks) |

### 52 AI Tools

**Client & Case Management (16)**
- `create_client`, `list_clients`, `get_client`, `update_client`, `delete_client`
- `create_case`, `list_cases`, `get_case`, `update_case`, `delete_case`, `search_cases`, `get_case_timeline`
- `set_active_case`, `clear_active_case`
- `add_case_note`
- `lookup_company` — KRS/CEIDG registry lookup

**Documents (7)**
- `draft_document`, `list_documents`, `get_document`, `update_document`, `delete_document`
- `list_document_versions`
- `get_uploaded_document`

**Templates (3)**
- `save_template`, `list_templates`, `use_template`

**Deadlines (5)**
- `add_deadline`, `list_deadlines`, `update_deadline`, `complete_deadline`, `delete_deadline`

**Legal Knowledge (5)**
- `search_law`, `lookup_article`
- `calculate_court_fee`, `calculate_interest`, `calculate_limitation`

**Court & Registry (2)**
- `search_court_decisions` — SAOS database (400K+ decisions)
- `lookup_company` — KRS/CEIDG

**Billing (5)**
- `log_time`, `list_time_entries`, `generate_billing_summary`
- `create_invoice`, `list_invoices`, `get_invoice`, `update_invoice`

**Privacy & RODO Compliance (9)**
- `record_ai_consent`, `check_ai_consent`, `revoke_ai_consent`
- `gdpr_delete_client` — Art. 17 right to erasure (irreversible cascade delete)
- `set_case_privacy` — per-case privacy mode (auto/strict)
- `record_client_informed` — Art. 13 information obligation tracking
- `generate_privacy_notice` — RODO information notice template in Polish
- `generate_dpia_report` — Art. 35 DPIA/OSOD report template

---

## Privacy & Legal Compliance

Mecenas is designed for compliance with:
- **Tajemnica adwokacka** (Art. 6 Prawo o adwokaturze)
- **Tajemnica radcowska** (Art. 3 Ustawa o radcach prawnych)
- **RODO/GDPR** (Regulation 2016/679)
- **KIRP Recommendations on AI** (April 2025)

### Privacy Modes

| Mode | Default | Behavior |
|------|---------|----------|
| `strict` | **Yes** | All processing local (Ollama only). Cloud calls blocked entirely. |
| `auto` | No | PII detected > route to local. No PII > cloud allowed (with anonymization). |
| `off` | No | No protection. **Requires explicit waiver** (`MECENAS_OFF_MODE_WAIVER=true`). |

### How It Works

1. **PII Detection** — Every message scanned for 13 types of Polish PII (PESEL with checksum, NIP, REGON, IBAN, phone, email, names with grammatical declination, addresses, case signatures, company names)
2. **Privacy Routing** — PII detected or active case context > forced local routing
3. **Anonymization** — If cloud is allowed, PII replaced with consistent placeholders (`<<MECENAS_PESEL_1>>`) before transmission, de-anonymized on return
4. **DPA Gate** — Cloud calls blocked unless DPA with Anthropic is confirmed (`MECENAS_DPA_ACCEPTED=true`)
5. **Database Encryption** — AES-256-GCM at rest with per-installation random salt
6. **Audit Trail** — Every privacy decision logged (without PII values) in `privacy_audit_log`
7. **Log Scrubbing** — PII patterns (PESEL, NIP, IBAN, phone, email, ID cards) automatically redacted from all log output
8. **Session Protection** — Auto-lock after 30 min inactivity, auto-purge after 72 hours

### RODO (GDPR) Tools

| Tool | RODO Article | Description |
|------|-------------|-------------|
| `gdpr_delete_client` | Art. 17 | Right to erasure — cascade deletes all client data |
| `record_ai_consent` | Art. 6-7 | Record consent for AI processing per case |
| `record_client_informed` | Art. 13 | Track that client was informed about AI processing |
| `generate_privacy_notice` | Art. 13-14 | Generate Polish-language information notice |
| `generate_dpia_report` | Art. 35 | Generate Data Protection Impact Assessment |

---

## Legal Knowledge Base

5,549 articles from the official Sejm ELI API (`api.sejm.gov.pl/eli`):

| Code | Articles | Full Name |
|------|----------|-----------|
| KC | 1,255 | Kodeks cywilny (Civil Code) |
| KPC | 1,961 | Kodeks postepowania cywilnego (Civil Procedure) |
| KK | 403 | Kodeks karny (Criminal Code) |
| KP | 478 | Kodeks pracy (Labour Code) |
| KRO | 238 | Kodeks rodzinny i opiekunczy (Family Code) |
| KSH | 912 | Kodeks spolek handlowych (Commercial Companies Code) |
| KPA | 302 | Kodeks postepowania administracyjnego (Administrative Procedure) |

```bash
npm run ingest
```

---

## REST API

### Core Resources
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status |
| `/api/clients` | GET, POST | List / create clients |
| `/api/cases` | GET, POST | List / create cases |
| `/api/deadlines` | GET, POST | List / create deadlines |
| `/api/documents` | GET | List documents |
| `/api/documents/:id` | GET | Document details |
| `/api/documents/:id/versions` | GET | Version history |
| `/api/documents/:id/approve` | POST | Approve document |
| `/api/documents/:id/reject` | POST | Reject (with notes) |
| `/api/documents/:id/export` | GET | DOCX export |
| `/api/documents/upload` | POST | Upload PDF/DOCX/TXT |
| `/api/templates` | GET, POST | List / create templates |
| `/api/time-entries` | GET, POST | List / create time entries |
| `/api/invoices` | GET, POST | List / create invoices |

### Legal Tools
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/knowledge/search?q=` | GET | Search legal codes |
| `/api/knowledge/stats` | GET | Knowledge base stats |
| `/api/calc/court-fee?amount=&type=` | GET | Court fee calculator |
| `/api/calc/interest?principal=&from=&to=&type=` | GET | Interest calculator |
| `/api/calc/limitation?type=&from=` | GET | Limitation period calculator |

### Chat & Sessions
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat/sessions` | GET, POST | List / create chat sessions |
| `/ws` | WebSocket | Real-time chat (WebChat) |

### Privacy
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/privacy/status` | GET | Current privacy config, Ollama/Anthropic status, DPA state |
| `/api/privacy/check` | POST | PII detection check for arbitrary text |
| `/api/privacy/audit` | GET | Query privacy audit log |

---

## Configuration

### Environment Variables

```bash
# LLM (pick one or both)
OLLAMA_URL=http://localhost:11434        # Bielik locally
ANTHROPIC_API_KEY=sk-ant-...             # Claude in the cloud

# Models (optional overrides)
MECENAS_MODEL=SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M
MECENAS_SPEED_MODEL=gemma3:4b

# Server
PORT=18789
MECENAS_BIND=loopback                    # loopback | all

# Privacy (defaults shown)
MECENAS_PRIVACY_MODE=strict              # strict | auto | off
MECENAS_DPA_ACCEPTED=false               # true = confirmed DPA with Anthropic
MECENAS_OFF_MODE_WAIVER=false            # true = allow disabling all privacy
MECENAS_SESSION_PURGE_HOURS=72           # auto-delete sessions after N hours
MECENAS_SESSION_LOCK_MINUTES=30          # auto-lock active case after N minutes
MECENAS_HSTS=false                       # enable HSTS header

# Database encryption
MECENAS_DB_KEY=                          # custom encryption key (auto-generated if empty)
MECENAS_DB_ENCRYPT=true                  # false to disable encryption

# Auth
MECENAS_TOKEN=                           # API auth token
MECENAS_PASSWORD=                        # basic auth password

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789
```

### Config File

`~/.mecenas/mecenas.json`:
```json
{
  "privacy": {
    "mode": "strict",
    "blockCloudOnPii": true,
    "anonymizeForCloud": true,
    "stripActiveCaseForCloud": true,
    "dpaAccepted": false,
    "offModeWaiver": false
  },
  "agent": {
    "model": "SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M",
    "speedModel": "gemma3:4b"
  }
}
```

### Data Storage

All data stored in `~/.mecenas/`:
- `mecenas.db` — Encrypted SQLite database (AES-256-GCM)
- `db.key` — Auto-generated encryption key (chmod 600)
- `db.salt` — Per-installation random salt for key derivation
- `backups/` — Daily automated backups (7 days retained)

### Multi-Model Routing

| Query Type | Model | Speed |
|------------|-------|-------|
| Greetings, confirmations, simple lookups | Gemma 3 4B | ~2-3x faster |
| Calculator triggers (fees, interest, limitation) | Gemma 3 4B | ~2-3x faster |
| Article lookups, case/client lists | Gemma 3 4B | ~2-3x faster |
| Document drafting (pozwy, apelacje, umowy) | Bielik 11B | Full quality |
| Legal analysis, long explanations | Bielik 11B | Full quality |
| Complex multi-step reasoning | Bielik 11B | Full quality |

Fallback chain: **Gemma 3** > **Bielik** > **Claude** (if API key set + DPA accepted + privacy allows). If Gemma 3 isn't installed, all queries go to Bielik.

---

## Docker

```bash
docker compose up --build
```

Ollama starts automatically as a sidecar. After startup:
```bash
docker compose exec ollama ollama pull SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M
docker compose exec ollama ollama pull gemma3:4b    # optional speed model
```

---

## Architecture

```
+------------------------------------------------+
|             WebChat + Telegram                  |
|  HTTP  -  WebSocket  -  REST API  -  Calcs     |
+----------------------+-------------------------+
                       |
+----------------------+-------------------------+
|          Privacy-Aware Model Router             |
|  PII Detection -> Anonymization -> Routing     |
|  strict: local only  |  auto: smart routing    |
+----------------------+-------------------------+
                       |
          +------------+------------+
          |                         |
+---------+---------+   +-----------+---------+
|   Ollama (local)  |   | Anthropic (cloud)   |
|  Bielik 11B       |   | Claude              |
|  Gemma 3 4B       |   | DPA required        |
|  Zero data leaves  |   | PII anonymized      |
+-------------------+   +---------------------+
                       |
+----------------------+-------------------------+
|            Agent (52 tools)                     |
|  Cases - Docs - Law - SAOS - Billing - Privacy |
|  Calculators - KRS/CEIDG - Templates           |
+----------------------+-------------------------+
                       |
+----------------------+-------------------------+
|        SQLite (sql.js WASM) — Encrypted        |
|  Clients - Cases - Documents - Deadlines       |
|  Invoices - Templates - Time Entries           |
|  Legal knowledge (5,549 articles)              |
|  Privacy audit log - AI consent                |
+------------------------------------------------+
```

---

## For Lawyers: Getting Started

1. **Install and start** (see Quick Start above)
2. **First run**: The system will auto-generate encryption keys and create the database
3. **Default mode is `strict`**: All data processed locally, nothing leaves your machine
4. **Create a client**: Just ask "Utwórz klienta Jan Kowalski, PESEL 92010112345"
5. **AI will remind you** to inform the client about AI processing (RODO Art. 13)
6. **Draft documents**: "Napisz pozew o zapłatę 50 000 zł" — the AI uses Polish legal templates
7. **Export to DOCX**: Click the export button or use the API
8. **For criminal/family cases**: Set privacy to strict (`set_case_privacy`)
9. **Generate DPIA**: Required by RODO Art. 35 — ask "Wygeneruj raport DPIA"

---

## Development

```bash
npm run dev          # Hot reload (tsx watch)
npm run build        # TypeScript compilation
npm run typecheck    # Type checking
npm run ingest       # Load legal knowledge base
npm start            # Production
```

---

## License

MIT — see [LICENSE](./LICENSE)
