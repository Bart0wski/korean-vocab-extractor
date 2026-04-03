import os
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = "sqlite:///./vocab.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Canonical part-of-speech list — shared by prompts and API validation
POS_LIST = [
    "Noun", "Verb", "Adjective", "Adverb", "Conjunction",
    "Expression", "Particle", "Interjection", "Counter", "Determiner",
]


class Vocabulary(Base):
    __tablename__ = "vocabulary"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    korean         = Column(String, unique=True, index=True, nullable=False)
    french         = Column(String, nullable=False)
    phrase         = Column(String, default="")
    part_of_speech = Column(String, nullable=True)
    thematic_tag   = Column(String, nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)


def init_db():
    Base.metadata.create_all(bind=engine)


def run_migrations():
    """Additive ALTER TABLE migrations — safe to run on existing vocab.db."""
    migrations = [
        "ALTER TABLE vocabulary ADD COLUMN part_of_speech TEXT DEFAULT NULL",
        "ALTER TABLE vocabulary ADD COLUMN thematic_tag   TEXT DEFAULT NULL",
    ]
    with engine.connect() as conn:
        for stmt in migrations:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                # Column already exists — safe to ignore
                pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
