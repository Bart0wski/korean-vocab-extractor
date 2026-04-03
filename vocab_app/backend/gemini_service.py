import io
import json
import os
import tempfile
import time
from typing import Callable, Optional

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pypdf import PdfReader, PdfWriter

from logger import get_logger
from prompts import IMAGE_SYSTEM_PROMPT, PDF_SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT

logger = get_logger("gemini")

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
model_name = "gemini-3.1-flash-lite-preview"

MAX_FILES = 10
MAX_PDF_PAGES = 10


# ── Shared helpers ─────────────────────────────────────────────

def normalize_response(data) -> list[dict]:
    if isinstance(data, dict):
        for val in data.values():
            if isinstance(val, list):
                return val
        return [data]
    if isinstance(data, list):
        return data
    return []


def _safe_parse(text: str) -> list[dict]:
    """Parse JSON from Gemini response, returning [] on failure."""
    try:
        return normalize_response(json.loads(text))
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning(f"⚠️  [Gemini] Could not parse response as JSON: {e}. Raw: {text[:200]}")
        return []


def _call_text(system_prompt: str, user_msg: str) -> list[dict]:
    logger.info(f"🚀 [Gemini] Calling _call_text using model: {model_name}")
    response = client.models.generate_content(
        model=model_name,
        contents=user_msg,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            temperature=0.0,
        ),
    )
    logger.info("📥 [Gemini] Received response successfully.")
    return _safe_parse(response.text)


def _call_multimodal(system_prompt: str, file_obj, user_msg: str) -> list[dict]:
    logger.info(f"🖼  [Gemini] Calling _call_multimodal using model: {model_name}")
    response = client.models.generate_content(
        model=model_name,
        contents=[file_obj, user_msg],
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            temperature=0.0,
        ),
    )
    logger.info("📥 [Gemini] Multimodal response received successfully.")
    return _safe_parse(response.text)


def _upload_file(tmp_path: str):
    logger.info(f"⬆  [Gemini] Uploading file to Google File API: {tmp_path}")
    uploaded = client.files.upload(file=tmp_path)
    waited = 0
    while uploaded.state.name == "PROCESSING" and waited < 60:
        time.sleep(2)
        waited += 2
        uploaded = client.files.get(name=uploaded.name)
    if uploaded.state.name == "FAILED":
        raise RuntimeError("File processing failed on Google's servers.")
    logger.info(f"✅ [Gemini] File ready on Google servers: {uploaded.name}")
    return uploaded


# ── Single-item processors ─────────────────────────────────────

def process_text(text: str) -> list[dict]:
    """Process raw pasted Korean text — single Gemini call."""
    logger.info("🔍 [Service] process_text initiated.")
    return _call_text(
        TEXT_SYSTEM_PROMPT,
        f"Analyze this Korean vocabulary and create Anki flashcards:\n\n{text}",
    )


def _split_pdf_pages(pdf_bytes: bytes) -> list[bytes]:
    """Split a PDF into a list of single-page PDF bytes."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    pages = []
    for page in reader.pages:
        writer = PdfWriter()
        writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)
        pages.append(buf.getvalue())
    return pages


def _process_single_page(page_bytes: bytes, page_label: str, progress_cb=None) -> list[dict]:
    """Upload one page PDF to Gemini File API and extract vocabulary."""
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(page_bytes)
        tmp_path = tmp.name

    uploaded = None
    try:
        if progress_cb:
            progress_cb(f"Uploading {page_label}…")
        uploaded = _upload_file(tmp_path)

        if progress_cb:
            progress_cb(f"Analysing {page_label}…")
        items = _call_multimodal(
            PDF_SYSTEM_PROMPT,
            uploaded,
            "Extract ALL Korean vocabulary from this PDF page.",
        )
        logger.info(f"📄 [Service] {page_label}: {len(items)} item(s) extracted.")
        return items
    finally:
        os.unlink(tmp_path)
        if uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass


def process_pdf_chunked(
    pdf_bytes: bytes,
    filename: str = "file.pdf",
    progress_cb: Optional[Callable[[str], None]] = None,
    page_offset: int = 0,
    total_pages: int = 0,
) -> list[dict]:
    """Split a PDF into pages and send each to Gemini File API individually."""
    pages = _split_pdf_pages(pdf_bytes)
    logger.info(f"📄 [Service] {filename}: split into {len(pages)} page(s).")
    all_items: list[dict] = []

    for i, page_bytes in enumerate(pages):
        global_page = page_offset + i + 1
        label = f"{filename} — page {i + 1}/{len(pages)} (total {global_page}/{total_pages})"
        items = _process_single_page(page_bytes, label, progress_cb)
        all_items.extend(items)
        if i < len(pages) - 1:
            time.sleep(1)

    return all_items


def process_image(
    image_bytes: bytes,
    filename: str,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """Upload an image to Gemini File API and extract Korean vocabulary."""
    logger.info(f"🖼  [Service] process_image started: {filename} ({len(image_bytes)} bytes).")
    suffix = os.path.splitext(filename)[1].lower() or ".jpg"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name

    uploaded = None
    try:
        if progress_cb:
            progress_cb(f"Uploading {filename}…")
        uploaded = _upload_file(tmp_path)

        if progress_cb:
            progress_cb(f"Analysing {filename}…")
        return _call_multimodal(
            IMAGE_SYSTEM_PROMPT,
            uploaded,
            "Extract ALL Korean vocabulary visible in this image.",
        )
    finally:
        os.unlink(tmp_path)
        if uploaded:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass


# ── Batch processors (called from SSE routes) ──────────────────

def process_pdf_batch(
    files_data: list[tuple[bytes, str]],
    progress_cb: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """Process PDFs page-by-page. Total pages across all files must not exceed MAX_PDF_PAGES."""
    logger.info(f"📦 [Service] process_pdf_batch: {len(files_data)} file(s) received.")

    # Count total pages across all files upfront
    file_pages: list[tuple[bytes, str, int]] = []  # (bytes, filename, page_count)
    total_pages = 0
    for pdf_bytes, filename in files_data[:MAX_FILES]:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        count = len(reader.pages)
        total_pages += count
        file_pages.append((pdf_bytes, filename, count))
        logger.info(f"📦 [Service] {filename}: {count} page(s) (running total: {total_pages})")

    if total_pages > MAX_PDF_PAGES:
        raise ValueError(
            f"Total pages across all files is {total_pages} — maximum is {MAX_PDF_PAGES}. "
            f"Please reduce the number of files or pages."
        )

    all_items: list[dict] = []
    page_offset = 0

    for i, (pdf_bytes, filename, count) in enumerate(file_pages):
        logger.info(f"📦 [Service] Processing PDF {i + 1}/{len(file_pages)}: {filename} ({count} page(s))")
        if progress_cb:
            progress_cb(f"File {i + 1}/{len(file_pages)}: {filename} ({count} page(s))")

        all_items.extend(process_pdf_chunked(
            pdf_bytes, filename, progress_cb,
            page_offset=page_offset, total_pages=total_pages,
        ))
        page_offset += count

    logger.info(f"📦 [Service] Batch done. Total items extracted: {len(all_items)}.")
    return all_items


def process_image_batch(
    files_data: list[tuple[bytes, str]],
    progress_cb: Optional[Callable[[str], None]] = None,
) -> list[dict]:
    """Process up to MAX_FILES images sequentially."""
    logger.info(f"📦 [Service] process_image_batch: {len(files_data)} image(s) received.")
    all_items: list[dict] = []
    batch = files_data[:MAX_FILES]

    for i, (image_bytes, filename) in enumerate(batch):
        logger.info(f"📦 [Service] Processing image {i + 1}/{len(batch)}: {filename}")
        if progress_cb:
            progress_cb(f"Image {i + 1} of {len(batch)}: {filename}")

        def img_cb(msg):
            if progress_cb:
                progress_cb(msg)

        all_items.extend(process_image(image_bytes, filename, img_cb))
        if i < len(batch) - 1:
            time.sleep(1)

    return all_items
