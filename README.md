# Mecenas — Polish AI Legal Assistant

**Mecenas** is a local-first AI legal assistant for Polish lawyers. It uses Bielik LLM (via Ollama) with RAG over 7 Polish legal codes — 5,549 articles fetched from the official Sejm API. Draft court documents, manage cases, search the law, export to DOCX. Chat via WebChat or Telegram. All data stays on your machine.

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
# Option A: Ollama (local, private)
ollama pull SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M
export OLLAMA_URL=http://localhost:11434

# Option B: Claude (cloud)
export ANTHROPIC_API_KEY=sk-ant-...
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Court Documents** | Draft pozwy (claims), odpowiedzi (answers), apelacje (appeals), wezwania do zapłaty (payment demands), wnioski (motions), umowy (contracts), legal opinions |
| **Case Management** | Clients, cases, court file numbers (sygnatury), courts, opposing parties, value of dispute |
| **Deadlines** | Procedural, statutory, contractual, internal — with reminders |
| **Law Search** | RAG over 7 codes: KC, KPC, KK, KP, KRO, KSH, KPA |
| **DOCX Export** | Professional formatting — Times New Roman, headers, page numbers, draft watermark |
| **Document Workflow** | Draft → Review → Approved → Filed |
| **Channels** | Built-in WebChat + Telegram bot |
| **LLM** | Bielik 11B (Ollama, local) or Claude (Anthropic, cloud) |
| **Database** | SQLite (sql.js WASM) — fully private, data stays on your machine |

### 13 AI Tools

- `create_client`, `list_clients`, `get_client` — client management
- `create_case`, `list_cases`, `get_case`, `update_case` — case management
- `add_deadline`, `list_deadlines` — deadline tracking
- `draft_document`, `list_documents`, `get_document` — document drafting
- `search_law`, `lookup_article` — legal code search
- `add_case_note` — case notes

---

## Legal Knowledge Base

5,549 articles from the official Sejm ELI API (`api.sejm.gov.pl/eli`):

| Code | Articles | Full Name |
|------|----------|-----------|
| KC | 1,255 | Kodeks cywilny (Civil Code) |
| KPC | 1,961 | Kodeks postępowania cywilnego (Civil Procedure) |
| KK | 403 | Kodeks karny (Criminal Code) |
| KP | 478 | Kodeks pracy (Labour Code) |
| KRO | 238 | Kodeks rodzinny i opiekuńczy (Family Code) |
| KSH | 912 | Kodeks spółek handlowych (Commercial Companies Code) |
| KPA | 302 | Kodeks postępowania administracyjnego (Administrative Procedure) |

Load the knowledge base:
```bash
npm run ingest
```

---

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status |
| `/api/documents` | GET | List documents |
| `/api/documents/:id` | GET | Document details |
| `/api/documents/:id/versions` | GET | Version history |
| `/api/documents/:id/approve` | POST | Approve document |
| `/api/documents/:id/reject` | POST | Reject (with notes) |
| `/api/documents/:id/export` | GET | DOCX export |
| `/api/cases` | GET | List cases |
| `/api/deadlines` | GET | List deadlines |
| `/api/clients` | GET | List clients |
| `/api/knowledge/search?q=` | GET | Search legal codes |
| `/api/knowledge/stats` | GET | Knowledge base stats |

---

## Configuration

```bash
# LLM (pick one)
OLLAMA_URL=http://localhost:11434        # Bielik locally
ANTHROPIC_API_KEY=sk-ant-...             # Claude in the cloud

# Model (optional)
MECENAS_MODEL=SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M

# Server
PORT=18789
MECENAS_BIND=loopback                    # loopback or all

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USERS=123456789
```

Data stored in `~/.mecenas/` (SQLite, auto-created on first run).

---

## Docker

```bash
docker compose up --build
```

Ollama starts automatically as a sidecar. After startup:
```bash
docker compose exec ollama ollama pull SpeakLeash/bielik-11b-v2.2-instruct:Q4_K_M
```

---

## Architecture

```
┌──────────────────────────────────────────────┐
│              WebChat + Telegram               │
│     HTTP • WebSocket • REST API • CORS       │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────┴───────────────────────────┐
│              Agent (13 tools)                 │
│  Bielik (Ollama) or Claude (Anthropic)       │
│  Sessions • History • Tool loop              │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────┴───────────────────────────┐
│           SQLite (sql.js WASM)               │
│  Clients • Cases • Documents • Deadlines     │
│  Legal knowledge (5,549 articles) • Sessions │
└──────────────────────────────────────────────┘
```

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
