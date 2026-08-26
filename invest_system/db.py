import os
import sqlite3
from contextlib import contextmanager

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    name TEXT,
    price REAL,
    change_pct REAL,
    volume REAL,
    amount REAL,
    high REAL,
    low REAL,
    open REAL,
    prev_close REAL,
    fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_code_time ON quotes(code, fetched_at);
"""


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def insert_quotes(rows):
    with get_conn() as conn:
        conn.executemany(
            """
            INSERT INTO quotes
            (code, name, price, change_pct, volume, amount, high, low, open, prev_close, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
