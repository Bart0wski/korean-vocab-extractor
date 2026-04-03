import logging
import os


def get_logger(name: str) -> logging.Logger:
    """Return a logger with console + file handlers. Safe to call multiple times."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger  # already configured

    logger.setLevel(logging.DEBUG)
    logger.propagate = False  # don't bubble up to uvicorn's root logger

    fmt = logging.Formatter(
        "%(asctime)s [%(name)-12s] %(levelname)-8s %(message)s",
        datefmt="%H:%M:%S",
    )

    # ── Console ──────────────────────────────────────────────────
    ch = logging.StreamHandler()
    ch.setLevel(logging.DEBUG)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # ── File ─────────────────────────────────────────────────────
    os.makedirs("logs", exist_ok=True)
    fh = logging.FileHandler("logs/app.log", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    return logger
