import asyncio
import csv
import io
import json
import os
import sys
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

sys.path.insert(0, os.path.dirname(__file__))

from database import POS_LIST, Vocabulary, get_db, init_db, run_migrations
from gemini_service import (
    MAX_FILES,
    process_image_batch,
    process_pdf_batch,
    process_text,
    model_name,
)
from logger import get_logger

logger = get_logger("api")

app = FastAPI(title="Korean Vocab Extractor v2")
logger.info(f"🚀 [API] App starting — Gemini model: {model_name}")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


# ── Pydantic models ────────────────────────────────────────────

class IdsPayload(BaseModel):
    ids: List[int]


class VocabItem(BaseModel):
    korean: str
    french: str
    phrase: str = ""
    part_of_speech: Optional[str] = None
    thematic_tag: Optional[str] = None


class CommitPayload(BaseModel):
    items: List[VocabItem]
    thematic_tag: Optional[str] = None  # batch-level override


# ── Startup ────────────────────────────────────────────────────

@app.on_event("startup")
def startup():
    run_migrations()
    init_db()


# ── Static / root ──────────────────────────────────────────────

@app.get("/api/info")
def api_info():
    return {"model": model_name}

@app.get("/")
def root():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


# ── SSE streaming helper ───────────────────────────────────────

def _make_sse_stream(processor_fn, files_data):
    """
    Returns an async generator that runs processor_fn in a thread,
    forwarding progress callbacks as SSE events, then emits a final
    'done' event with the result items.
    """
    async def generator():
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        def progress_cb(msg: str):
            loop.call_soon_threadsafe(
                queue.put_nowait, {"type": "progress", "message": msg}
            )

        task = asyncio.create_task(
            asyncio.to_thread(processor_fn, files_data, progress_cb)
        )

        # Drain queue while task is running
        while not task.done():
            try:
                event = queue.get_nowait()
                yield {"data": json.dumps(event)}
            except asyncio.QueueEmpty:
                await asyncio.sleep(0.05)

        # Drain any remaining progress messages
        while not queue.empty():
            yield {"data": json.dumps(await queue.get())}

        # Emit final result or error
        exc = task.exception()
        if exc:
            yield {"data": json.dumps({"type": "error", "message": str(exc)})}
        else:
            yield {"data": json.dumps({"type": "done", "items": task.result()})}

    return generator


# ── Process: text (simple JSON, no SSE needed) ─────────────────

# ── Process: text (simple JSON, no SSE needed) ─────────────────
@app.post("/api/process/text")
def api_process_text(text: str = Form(...)):
    logger.info("📝 [API] POST /api/process/text called.")

    if not text.strip():
        logger.warning("⚠️ [API] Rejected: Text input is empty.")
        raise HTTPException(status_code=400, detail="Text is empty.")

    try:
        logger.info(f"⚙️ [API] Processing text input (Length: {len(text)} characters)...")
        items = process_text(text)
        logger.info(f"✅ [API] Success! Returning {len(items)} items to frontend.")
    except Exception as e:
        logger.error(f"❌ [API] Gemini error occurred: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Gemini error: {e}")

    return {"items": items}


# ── Process: PDF (SSE stream) ──────────────────────────────────

@app.post("/api/process/pdf")
async def api_process_pdf(
    files: List[UploadFile] = File(...),
):
    logger.info(f"📄 [API] POST /api/process/pdf — {len(files)} file(s) received.")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"Maximum {MAX_FILES} files per batch.")

    files_data = []
    for f in files:
        if not f.filename.lower().endswith(".pdf"):
            raise HTTPException(400, f"'{f.filename}' is not a PDF.")
        files_data.append((await f.read(), f.filename))

    logger.info(f"📄 [API] Starting SSE stream for {len(files_data)} PDF(s).")
    return EventSourceResponse(_make_sse_stream(process_pdf_batch, files_data)())


# ── Process: image (SSE stream) ────────────────────────────────

@app.post("/api/process/image")
async def api_process_image(
    files: List[UploadFile] = File(...),
):
    logger.info(f"🖼  [API] POST /api/process/image — {len(files)} file(s) received.")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"Maximum {MAX_FILES} files per batch.")

    files_data = []
    for f in files:
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in ALLOWED_IMAGE_EXTS:
            raise HTTPException(400, f"'{f.filename}' is not a supported image (jpg/png/gif/webp).")
        files_data.append((await f.read(), f.filename))

    logger.info(f"🖼  [API] Starting SSE stream for {len(files_data)} image(s).")
    return EventSourceResponse(_make_sse_stream(process_image_batch, files_data)())


# ── Commit reviewed items to DB ────────────────────────────────

@app.post("/api/vocabulary/commit")
def commit_vocabulary(payload: CommitPayload, db: Session = Depends(get_db)):
    logger.info(f"💾 [API] POST /api/vocabulary/commit — {len(payload.items)} item(s) to save.")
    saved, duplicates = [], []
    batch_tag = (payload.thematic_tag or "").strip() or None

    for item in payload.items:
        korean = item.korean.strip()
        french = item.french.strip()
        phrase = item.phrase.strip()
        pos    = item.part_of_speech if item.part_of_speech in POS_LIST else None
        tag    = batch_tag or (item.thematic_tag or "").strip() or None

        if not korean or not french:
            continue
        if db.query(Vocabulary).filter(Vocabulary.korean == korean).first():
            duplicates.append(korean)
            continue

        db.add(Vocabulary(
            korean=korean, french=french, phrase=phrase,
            part_of_speech=pos, thematic_tag=tag,
        ))
        saved.append({"korean": korean, "french": french, "phrase": phrase,
                      "part_of_speech": pos, "thematic_tag": tag})

    db.commit()
    logger.info(f"💾 [API] Commit done — {len(saved)} saved, {len(duplicates)} duplicate(s).")
    return {"saved": saved, "duplicates": duplicates, "total_found": len(payload.items)}


# ── Import CSV directly (bypasses AI) ─────────────────────────

@app.post("/api/import/csv")
async def import_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    logger.info(f"📥 [API] POST /api/import/csv — file: {file.filename}")
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Only .csv files are accepted.")

    content = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(content))

    if not reader.fieldnames or "korean" not in reader.fieldnames or "french" not in reader.fieldnames:
        raise HTTPException(400, "CSV must have at least 'korean' and 'french' columns.")

    imported, duplicates, errors = [], [], []

    for i, row in enumerate(reader, start=2):  # row 1 = header
        korean = (row.get("korean") or "").strip()
        french = (row.get("french") or "").strip()
        if not korean or not french:
            errors.append(f"Row {i}: missing korean or french — skipped.")
            continue

        phrase = (row.get("phrase") or "").strip()
        pos    = row.get("part_of_speech", "").strip()
        tag    = row.get("thematic_tag", "").strip()

        if db.query(Vocabulary).filter(Vocabulary.korean == korean).first():
            duplicates.append(korean)
            continue

        db.add(Vocabulary(
            korean=korean, french=french, phrase=phrase,
            part_of_speech=pos if pos in POS_LIST else None,
            thematic_tag=tag or None,
        ))
        imported.append(korean)

    db.commit()
    logger.info(f"📥 [API] CSV import done — {len(imported)} imported, {len(duplicates)} duplicate(s), {len(errors)} error(s).")
    return {
        "imported": len(imported),
        "duplicates": len(duplicates),
        "errors": errors,
        "skipped_words": duplicates,
    }


# ── Vocabulary CRUD ────────────────────────────────────────────

@app.get("/api/vocabulary")
def get_vocabulary(
    pos: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(Vocabulary)
    if pos:
        q = q.filter(Vocabulary.part_of_speech == pos)
    if tag:
        q = q.filter(Vocabulary.thematic_tag == tag)
    rows = q.order_by(Vocabulary.created_at.desc()).all()
    return [_row_to_dict(r) for r in rows]


@app.get("/api/vocabulary/tags")
def get_tags(db: Session = Depends(get_db)):
    """Return distinct thematic_tag values for filter UI."""
    rows = db.query(Vocabulary.thematic_tag).distinct().all()
    return sorted({r[0] for r in rows if r[0]})


# NOTE: named routes must come BEFORE /{entry_id}

@app.get("/api/vocabulary/export")
def export_all_csv(db: Session = Depends(get_db)):
    rows = db.query(Vocabulary).order_by(Vocabulary.created_at.desc()).all()
    return _build_csv_response(rows, "vocabulary_all.csv")


@app.post("/api/vocabulary/export-selected")
def export_selected_csv(payload: IdsPayload, db: Session = Depends(get_db)):
    if not payload.ids:
        raise HTTPException(400, "No IDs provided.")
    rows = db.query(Vocabulary).filter(Vocabulary.id.in_(payload.ids)).all()
    return _build_csv_response(rows, "vocabulary_selected.csv")


@app.delete("/api/vocabulary")
def delete_all(db: Session = Depends(get_db)):
    count = db.query(Vocabulary).count()
    db.query(Vocabulary).delete()
    db.commit()
    logger.info(f"🗑  [API] DELETE /api/vocabulary — {count} entries deleted.")
    return {"deleted": count}


@app.delete("/api/vocabulary/bulk")
def delete_bulk(payload: IdsPayload, db: Session = Depends(get_db)):
    if not payload.ids:
        raise HTTPException(400, "No IDs provided.")
    count = db.query(Vocabulary).filter(Vocabulary.id.in_(payload.ids)).delete(
        synchronize_session=False
    )
    db.commit()
    logger.info(f"🗑  [API] DELETE /api/vocabulary/bulk — {count} entries deleted.")
    return {"deleted": count}


@app.delete("/api/vocabulary/{entry_id}")
def delete_vocabulary(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(Vocabulary).filter(Vocabulary.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found.")
    db.delete(entry)
    db.commit()
    logger.info(f"🗑  [API] DELETE /api/vocabulary/{entry_id} — entry deleted.")
    return {"deleted": entry_id}


# ── Helpers ────────────────────────────────────────────────────

def _row_to_dict(r: Vocabulary) -> dict:
    return {
        "id":             r.id,
        "korean":         r.korean,
        "french":         r.french,
        "phrase":         r.phrase,
        "part_of_speech": r.part_of_speech,
        "thematic_tag":   r.thematic_tag,
        "created_at":     r.created_at.isoformat() if r.created_at else None,
    }


def _build_csv_response(rows, filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.DictWriter(
        buf, fieldnames=["korean", "french", "phrase", "part_of_speech", "thematic_tag"]
    )
    writer.writeheader()
    for r in rows:
        writer.writerow({
            "korean":         r.korean,
            "french":         r.french,
            "phrase":         r.phrase,
            "part_of_speech": r.part_of_speech or "",
            "thematic_tag":   r.thematic_tag or "",
        })
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
