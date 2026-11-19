"""SQLite storage and deterministic sample-project initialization."""
import json
import math
import random
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

UTC = timezone.utc


def utcnow():
    return datetime.now(UTC)


def stamp(value):
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Timestamp must include a time zone")
    return result.astimezone(UTC)


@contextmanager
def connection(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize(path, demo=True):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connection(path) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
          CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, write_key TEXT UNIQUE,
            sample_as_of TEXT, created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
            event TEXT NOT NULL, distinct_id TEXT NOT NULL, timestamp TEXT NOT NULL,
            properties TEXT NOT NULL, uuid TEXT, UNIQUE(project_id, uuid)
          );
          CREATE INDEX IF NOT EXISTS events_date ON events(project_id, timestamp, id);
          CREATE INDEX IF NOT EXISTS events_person ON events(project_id, distinct_id, timestamp, id);
          CREATE INDEX IF NOT EXISTS events_name ON events(project_id, event, timestamp);
        """)
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
            if demo:
                seed(db)
            else:
                new_project(db, "My project")


def new_project(db, name):
    key = "sn_" + secrets.token_urlsafe(24)
    return db.execute("INSERT INTO projects(name,write_key,created_at) VALUES(?,?,?)",
                      (name, key, stamp(utcnow()))).lastrowid


def seed(db):
    now = utcnow()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    project_id = db.execute("INSERT INTO projects(name,sample_as_of,created_at) VALUES(?,?,?)",
                            ("Demo project", stamp(now), stamp(now))).lastrowid
    rng = random.Random(42)
    names = ["page_view", "button_click", "sign_up", "project_create", "feature_use"]
    paths = ["/", "/dashboard", "/pricing", "/docs", "/settings", "/projects"]
    rows = []
    for offset in range(60):
        start = today - timedelta(days=59-offset)
        span = min(86400, max(0, (now-start).total_seconds()))
        # Vary volume across weekdays and grow the active population over time.
        wave = [0.83, 0.93, 0.74, 1.09, 0.98, 1.19, 1.27][(offset-53) % 7]
        volume = int((430 + 16 * offset + 55 * math.sin(offset/4)) * wave)
        for _ in range(volume):
            event = rng.choices(names, weights=[51, 24, 11, 8, 6])[0]
            person = "visitor_%06x" % rng.randrange(350 + 17*offset)
            ts = start + timedelta(seconds=rng.random()*span)
            props = {"path": rng.choice(paths), "device": rng.choice(["desktop", "desktop", "mobile"])}
            rows.append((project_id, event, person, stamp(ts), json.dumps(props)))
    db.executemany("INSERT INTO events(project_id,event,distinct_id,timestamp,properties) VALUES(?,?,?,?,?)", rows)
