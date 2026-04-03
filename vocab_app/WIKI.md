# Korean Vocabulary Extractor — Wiki

A full-stack web app that extracts Korean-French vocabulary from raw text, PDFs, or images using the Gemini API, stores results in a local SQLite database, and displays them in a browser UI with filtering, pagination, and bulk operations.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Setup & Installation](#2-setup--installation)
3. [Running the App](#3-running-the-app)
4. [Backend Architecture](#4-backend-architecture)
   - [main.py — API Routes](#mainpy--api-routes)
   - [database.py — SQLite & SQLAlchemy](#databasepy--sqlite--sqlalchemy)
   - [gemini_service.py — Gemini API Integration](#gemini_servicepy--gemini-api-integration)
   - [prompts.py — Dynamic Prompt Templates](#promptspy--dynamic-prompt-templates)
5. [Processing Paths & SSE Streaming](#5-processing-paths--sse-streaming)
6. [Human-in-the-Loop Review](#6-human-in-the-loop-review)
7. [Duplicate Detection](#7-duplicate-detection)
8. [Frontend Overview](#8-frontend-overview)
9. [API Reference](#9-api-reference)
10. [Changelog](#10-changelog)

---

## 1. Project Structure

```
vocab_app/
├── WIKI.md                  ← you are here
├── backend/
│   ├── main.py              # FastAPI application — routes, CORS, startup
│   ├── database.py          # SQLAlchemy engine, Vocabulary model, migrations
│   ├── gemini_service.py    # Gemini API calls (text / PDF / image paths)
│   ├── prompts.py           # System prompt templates for Gemini
│   └── requirements.txt     # Python dependencies
└── frontend/
    ├── index.html           # Main UI — tabs, forms, review table, history
    ├── app.js               # All client-side logic (SSE, rendering, filters)
    └── styles.css           # Styling
```

The SQLite database file `vocab.db` is created automatically at first run inside the `backend/` folder.

---

## 2. Setup & Installation

**Prerequisites:** Python 3.10+, a Gemini API key.

### Step 1 — Get a Gemini API key

Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create a key.

### Step 2 — Create the `.env` file

Create a file at `Gemini_project/.env` (two levels above `backend/`):

```
GEMINI_API_KEY=your_key_here
```

`gemini_service.py` walks two directories up from its own location to find this file automatically.

### Step 3 — Install dependencies

```bash
cd vocab_app/backend
pip install -r requirements.txt
```

Key packages:

| Package | Purpose |
|---|---|
| `fastapi` | Web framework for the API |
| `uvicorn` | ASGI server to run FastAPI |
| `sqlalchemy` | ORM for the SQLite database |
| `google-genai` | Official Google Gemini SDK |
| `python-multipart` | Required by FastAPI to handle file uploads |
| `pdfplumber` | PDF text extraction (page-by-page chunking) |
| `python-dotenv` | Loads `GEMINI_API_KEY` from `.env` |
| `sse-starlette` | Server-Sent Events support for progress streaming |
| `Pillow` | Image processing support |

---

## 3. Running the App

From the `vocab_app/` directory:

```bash
npm run dev
```

Or directly from `backend/`:

```bash
python3.10 -m uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000** in your browser.

- `--reload` restarts the server automatically when you edit a Python file.
- The frontend is served directly by FastAPI — no separate dev server needed.

---

## 4. Backend Architecture

### `main.py` — API Routes

Entry point for the application. It:

1. **Creates the FastAPI app** and enables CORS.
2. **Mounts the `frontend/` folder** as static files at `/static`, serves `index.html` at `/`.
3. **Runs `run_migrations()` then `init_db()`** on startup — safe to call on every restart.
4. **Defines all API routes** — see [API Reference](#9-api-reference).

Processing routes for PDF and Image return SSE streams (progress events followed by a final `done` event with the extracted items). The text route returns a simple JSON response since it's a single fast call.

---

### `database.py` — SQLite & SQLAlchemy

Defines the database connection and the `Vocabulary` table.

**The `Vocabulary` model (v2):**

| Column | Type | Notes |
|---|---|---|
| `id` | Integer | Primary key, auto-incremented |
| `korean` | String | Unique, indexed — used for duplicate checks |
| `french` | String | The French translation |
| `phrase` | String | An example sentence in Korean |
| `part_of_speech` | String | Optional — Noun, Verb, Adjective, etc. |
| `thematic_tag` | String | Optional — e.g. "TOPIK 1", "Kdrama" |
| `created_at` | DateTime | Set automatically on insert |

**`POS_LIST`** — the canonical list of allowed part-of-speech values:
```python
["Noun", "Verb", "Adjective", "Adverb", "Conjunction",
 "Expression", "Particle", "Interjection", "Counter", "Determiner"]
```

**`run_migrations()`** runs additive `ALTER TABLE ... ADD COLUMN` statements (wrapped in `try/except`) to upgrade existing databases without data loss. Safe to run on a live DB.

**`get_db()`** is a FastAPI dependency that opens a session per request and closes it on completion.

---

### `gemini_service.py` — Gemini API Integration

Three processing functions, one per input type. All use `MODEL = "gemini-2.0-flash"`.

#### `process_text(text: str) -> list[dict]`

Single Gemini call with the text as a user message. Fast — no file upload needed.

#### `process_pdf_chunked(pdf_bytes, progress_cb) -> list[dict]`

Extracts text page-by-page with `pdfplumber`, then sends each page to Gemini separately. Max **10 pages** per file. A 2-second pause between pages respects Gemini rate limits. Reports progress via the `progress_cb` callback.

#### `process_image(image_bytes, filename, progress_cb) -> list[dict]`

Uploads the image to the **Google File API**, waits for it to be ready (polls up to 60s), then calls Gemini with the file reference. Always deletes the uploaded file from Google servers after use.

**Batch wrappers** (`process_pdf_batch`, `process_image_batch`) accept up to **10 files** and call the single-file processors sequentially, forwarding progress messages.

**`normalize_response(data)`** handles Gemini sometimes wrapping results in a dict like `{"vocabulary": [...]}` instead of a bare list.

---

### `prompts.py` — Dynamic Prompt Templates

Three system prompts, each tuned to its input type. All share the same output contract including `part_of_speech`.

#### `TEXT_SYSTEM_PROMPT` — raw text

Acts as an A2 Korean-French teacher. Filters basic words, focuses on TOPIK I/II, always uses dictionary form, generates one 아/어요 example sentence per word.

#### `PDF_SYSTEM_PROMPT` — PDF pages

Acts as an OCR correction specialist. Handles multi-column layouts, reconstructs broken Hangeul from PDF encoding errors, filters noise (page numbers, headers), prioritizes completeness.

#### `IMAGE_SYSTEM_PROMPT` — images

Acts as a visual OCR specialist. Reads Korean text visible in the image (textbooks, flashcards, screenshots, handwriting), applies the same extraction rules.

**Output contract (all prompts):**
```json
[
  {
    "korean": "고민",
    "french": "souci / préoccupation",
    "phrase": "요즘 고민이 많아요.",
    "part_of_speech": "Noun",
    "thematic_tag": ""
  }
]
```

---

## 5. Processing Paths & SSE Streaming

```
Browser
  │
  ├─── Paste Text ──────► POST /api/process/text
  │                              │
  │                              ▼
  │                         process_text()  →  Gemini (text)
  │                              │
  │                              ▼
  │                         JSON response → Review table
  │
  ├─── Upload PDF(s) ───► POST /api/process/pdf   (SSE stream)
  │                              │
  │                              ▼
  │                         asyncio.to_thread(process_pdf_batch)
  │                              │  progress_cb → SSE progress events
  │                              ▼
  │                         pdfplumber → Gemini (per page)
  │                              │
  │                              ▼
  │                         SSE "done" event → Review table
  │
  ├─── Upload Image(s) ─► POST /api/process/image  (SSE stream)
  │                              │
  │                              ▼
  │                         asyncio.to_thread(process_image_batch)
  │                              │  progress_cb → SSE progress events
  │                              ▼
  │                         Google File API upload → Gemini
  │                              │
  │                              ▼
  │                         SSE "done" event → Review table
  │
  └─── Import CSV ──────► POST /api/import/csv
                                 │
                                 ▼
                            Parse CSV → duplicate check → SQLite
                                 │
                                 ▼
                            JSON: imported / duplicates / errors
```

**How SSE streaming works:**

The PDF and image routes use `EventSourceResponse` from `sse-starlette`. A background thread runs the Gemini processing and pushes progress messages into an `asyncio.Queue` via `loop.call_soon_threadsafe()`. The async generator drains the queue every 50ms, yielding SSE events. The frontend uses `fetch()` + `ReadableStream` reader (not `EventSource`, which is GET-only).

SSE event types:
- `{"type": "progress", "message": "Page 2 of 5…"}` — updates the progress bar
- `{"type": "done", "items": [...]}` — triggers the review table
- `{"type": "error", "message": "..."}` — shown as an error status

---

## 6. Human-in-the-Loop Review

Extraction routes **never save directly to the database**. Instead they return items to a review table where you can:

- Edit any field (Korean, French, phrase, part of speech, thematic tag)
- Delete individual rows you don't want
- Override the deck tag for all rows at once
- Click **Commit to Database** to save only the approved rows

The commit call goes to `POST /api/vocabulary/commit` with the final edited list. Duplicate detection happens at commit time.

---

## 7. Duplicate Detection

Before any word is saved, the commit route queries:

```python
db.query(Vocabulary).filter(Vocabulary.korean == korean).first()
```

If a row is found, the word is added to the `duplicates` list and not re-inserted. The response reports `saved`, `duplicates`, and `total_found`. The `korean` column also has a `UNIQUE` constraint at the DB level as a second safety net.

---

## 8. Frontend Overview

Single HTML page served by FastAPI. No framework — plain HTML, CSS, and vanilla JS.

**Four input tabs:**
- **Paste Text** — textarea input, single Gemini call
- **Upload PDF** — up to 10 PDFs, max 10 pages each, with live progress bar
- **Upload Image** — up to 10 images (jpg/png/gif/webp), with live progress bar
- **Import CSV** — bypasses AI entirely; directly imports rows matching the schema

**Review table** (appears after extraction):
- Editable fields for all columns
- Per-row delete button
- Batch deck-tag override
- Commit button → `POST /api/vocabulary/commit`

**History table:**
- Loads all vocabulary on page open, refreshes after each commit or import
- Search box (live filter across Korean, French, phrase)
- Filter dropdowns: Part of Speech, Thematic Tag
- Pagination: 10 / 50 / 100 / All per page
- POS badges with color-coded styling per category
- Per-row delete, select-all checkbox
- Toolbar: Export All CSV, Delete All, Export Selected, Delete Selected

---

## 9. API Reference

### `POST /api/process/text`
Process raw Korean text. Returns items for review (not saved).

**Body** (`multipart/form-data`): `text` (string)

**Response:**
```json
{ "items": [{ "korean": "고민", "french": "souci", "phrase": "...", "part_of_speech": "Noun", "thematic_tag": "" }] }
```

---

### `POST /api/process/pdf`
Upload and process PDF file(s). Returns SSE stream.

**Body** (`multipart/form-data`): `files` (up to 10 `.pdf` files)

**SSE events:** `progress` messages, then a final `done` with `items`.

---

### `POST /api/process/image`
Upload and process image file(s). Returns SSE stream.

**Body** (`multipart/form-data`): `files` (up to 10 image files: jpg/png/gif/webp)

**SSE events:** `progress` messages, then a final `done` with `items`.

---

### `POST /api/vocabulary/commit`
Save reviewed items to the database.

**Body** (JSON):
```json
{
  "items": [{ "korean": "...", "french": "...", "phrase": "...", "part_of_speech": "Noun", "thematic_tag": "TOPIK 1" }],
  "thematic_tag": "optional batch override"
}
```

**Response:**
```json
{ "saved": [...], "duplicates": ["고민"], "total_found": 5 }
```

---

### `POST /api/import/csv`
Import a CSV directly, bypassing AI extraction.

**Body** (`multipart/form-data`): `file` (`.csv`)

Required columns: `korean`, `french`. Optional: `phrase`, `part_of_speech`, `thematic_tag`.

**Response:**
```json
{ "imported": 42, "duplicates": 3, "errors": [], "skipped_words": ["고민"] }
```

---

### `GET /api/vocabulary`
Return all saved vocabulary, newest first. Supports optional filters.

**Query params:** `?pos=Noun` · `?tag=TOPIK+1`

**Response:**
```json
[{ "id": 1, "korean": "고민", "french": "souci", "phrase": "...", "part_of_speech": "Noun", "thematic_tag": "TOPIK 1", "created_at": "2026-03-31T10:00:00" }]
```

---

### `GET /api/vocabulary/tags`
Return distinct thematic tag values for the filter dropdown.

**Response:** `["Kdrama", "TOPIK 1", "TOPIK 2"]`

---

### `GET /api/vocabulary/export`
Download all vocabulary as a CSV file.

---

### `POST /api/vocabulary/export-selected`
Download selected rows as CSV.

**Body** (JSON): `{ "ids": [1, 2, 3] }`

---

### `DELETE /api/vocabulary`
Delete all vocabulary entries.

**Response:** `{ "deleted": 153 }`

---

### `DELETE /api/vocabulary/bulk`
Delete selected entries.

**Body** (JSON): `{ "ids": [1, 2, 3] }`

**Response:** `{ "deleted": 3 }`

---

### `DELETE /api/vocabulary/{id}`
Delete a single entry by database ID.

**Response:** `{ "deleted": 1 }`

---

## 10. Changelog

### v2 (2026-04-01)
- **New input sources:** Image upload tab (OCR via Gemini File API), CSV import tab (bypasses AI)
- **Batch uploads:** Up to 10 files per submission for PDF and image routes
- **SSE progress streaming:** Live progress bar for PDF and image processing
- **Human-in-the-loop review:** Extracted items shown in an editable review table before committing to DB
- **New DB columns:** `part_of_speech` and `thematic_tag` — live migration via `run_migrations()` preserves existing data
- **Part-of-speech badges:** Color-coded inline badges on all vocabulary entries
- **Filter UI:** Filter history by POS and thematic tag
- **Pagination:** Configurable page size (10 / 50 / 100 / All)
- **Bulk operations:** Select multiple rows to export or delete
- **Model upgrade:** Switched to `gemini-2.0-flash`

### v1 (initial)
- Text paste and PDF upload via Gemini File API
- Auto-save to SQLite on extraction
- History table with search and per-row delete
- Export All CSV and Delete All
