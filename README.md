# Korean Vocabulary Extractor

A full-stack web app that extracts Korean-French vocabulary from text, PDFs, and images using the **Google Gemini API**, stores results in a local SQLite database, and lets you review, filter, and export your word list — all from a browser UI.

Built as a personal study tool for TOPIK preparation.

---

## Features

- **4 input sources** — paste text, upload PDFs, upload images, or import a CSV directly
- **AI extraction** — Gemini reads each source and returns Korean word, French translation, example sentence, part of speech, and thematic tag
- **Human-in-the-loop review** — extracted items appear in an editable table before being saved; edit or remove anything before committing
- **SSE progress streaming** — live progress bar while PDFs and images are processed page by page
- **PDF page splitting** — multi-page PDFs are split into single pages and sent to Gemini individually for accurate OCR on scanned documents
- **History table** — searchable, filterable by part of speech and tag, paginated (10 / 50 / 100 / all)
- **POS badges** — color-coded part-of-speech labels (Noun, Verb, Adjective…)
- **Bulk operations** — select multiple entries to export or delete
- **CSV export** — export all or selected vocabulary to CSV (Anki-compatible)
- **Structured logging** — terminal logs + `logs/app.log` + browser console with timestamps

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10, FastAPI, Uvicorn |
| AI | Google Gemini API (`google-genai` SDK) |
| Database | SQLite via SQLAlchemy |
| PDF processing | `pypdf` (page splitting) |
| Streaming | Server-Sent Events (`sse-starlette`) |
| Frontend | Vanilla HTML / CSS / JavaScript |

---

## Project Structure

```
korean-vocab-extractor/
├── README.md
└── vocab_app/
    ├── WIKI.md                  # Detailed technical documentation
    ├── package.json             # npm dev script
    ├── backend/
    │   ├── main.py              # FastAPI app — all API routes
    │   ├── database.py          # SQLAlchemy model + live migrations
    │   ├── gemini_service.py    # Gemini API calls (text / PDF / image)
    │   ├── prompts.py           # System prompt templates
    │   ├── logger.py            # Centralized logging setup
    │   └── requirements.txt
    └── frontend/
        ├── index.html           # Single-page UI
        ├── app.js               # All client logic (SSE, review, filters)
        └── styles.css
```

---

## Setup

### 1. Get a Gemini API key

Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create a key.

### 2. Create a `.env` file

Create `Gemini_project/.env` (two levels above `backend/`):

```
GEMINI_API_KEY=your_key_here
```

### 3. Install dependencies

```bash
cd vocab_app/backend
pip install -r requirements.txt
```

### 4. Run the app

```bash
cd vocab_app
npm run dev
```

Then open **http://localhost:8000** in your browser.

> The SQLite database `vocab.db` is created automatically on first run.

---

## How It Works

### Processing pipeline

```
Input (text / PDF / image / CSV)
        │
        ▼
FastAPI route receives the file(s)
        │
        ├── PDF  → pypdf splits into single-page PDFs
        │          → each page uploaded to Gemini File API
        │
        ├── Image → uploaded to Gemini File API
        │
        └── Text  → sent directly as a Gemini text prompt
                │
                ▼
        Gemini returns JSON array of vocabulary items
                │
                ▼
        SSE stream sends progress + results to browser
                │
                ▼
        Review table (editable) — user approves before saving
                │
                ▼
        POST /api/vocabulary/commit → SQLite
```

### Human-in-the-loop review

Nothing is saved automatically. After extraction you see an editable table where you can:
- Fix any field (Korean, French, phrase, POS, tag)
- Delete unwanted rows
- Apply a batch deck tag to all rows
- Click **Commit to Database** to save

### Duplicate detection

Before saving, each word is checked against the `korean` column (unique constraint). Duplicates are reported but not re-inserted.

---

## Database Schema

| Column | Type | Notes |
|---|---|---|
| `id` | Integer | Primary key |
| `korean` | String | Unique — dictionary form |
| `french` | String | French translation |
| `phrase` | String | Example sentence |
| `part_of_speech` | String | Noun / Verb / Adjective… |
| `thematic_tag` | String | e.g. "TOPIK 1", "Kdrama" |
| `created_at` | DateTime | Auto-set on insert |

---

## API Overview

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/process/text` | Extract from pasted text |
| `POST` | `/api/process/pdf` | Extract from PDF(s) — SSE stream |
| `POST` | `/api/process/image` | Extract from image(s) — SSE stream |
| `POST` | `/api/vocabulary/commit` | Save reviewed items to DB |
| `POST` | `/api/import/csv` | Import CSV directly |
| `GET` | `/api/vocabulary` | Get all vocabulary (filterable) |
| `GET` | `/api/vocabulary/export` | Download all as CSV |
| `POST` | `/api/vocabulary/export-selected` | Download selected as CSV |
| `DELETE` | `/api/vocabulary/{id}` | Delete one entry |
| `DELETE` | `/api/vocabulary/bulk` | Delete selected entries |
| `DELETE` | `/api/vocabulary` | Delete all entries |

Full API and architecture details in [`vocab_app/WIKI.md`](vocab_app/WIKI.md).

---

## Limits

- PDF uploads: max **10 total pages** across all files per request
- Image uploads: max **10 files** per request
- Supported image formats: jpg, png, gif, webp

---

## Changelog

### v2
- Image upload tab (OCR via Gemini File API)
- CSV import tab
- PDF page-by-page splitting with Gemini visual OCR
- Human-in-the-loop review table
- SSE progress streaming
- `part_of_speech` and `thematic_tag` columns
- POS badges, tag filters, pagination
- Bulk export / delete
- Structured logging (terminal + browser console)

### v1
- Text paste and PDF upload
- Auto-save to SQLite
- History table with search and delete
