"""Copies your interviews from SQLite (chat.db) into the PostgreSQL database in DATABASE_URL: their
settings, resumes, questions, answers and images. Run it once, when moving to PostgreSQL.
Interviews already there are left as they are, so running it again copies only new ones.

From the backend folder:  .venv/bin/python copy_to_postgres.py [path to chat.db]
"""

import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from database import Database, is_postgres

HERE = Path(__file__).parent
SESSION_COLUMNS = (
    "id",
    "title",
    "resume_name",
    "resume_text",
    "mode",
    "style",
    "target_role",
    "interview_type",
    "instructions",
    "job_description",
    "created_at",
    "updated_at",
)


def utc(value: str | None) -> datetime:
    """SQLite's timestamps are in UTC, written "2026-11-07 08:16:22"."""
    if not value:
        return datetime.now(timezone.utc)
    return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def copy_interviews(source_path: Path, target: Database) -> dict[str, int]:
    """Copies the interviews in the SQLite database at `source_path` that `target` doesn't have yet.
    All or nothing: if anything fails, nothing is copied."""
    Database(path=source_path).open()  # brings an older chat.db up to date, so every column is there
    source = sqlite3.connect(source_path)
    source.row_factory = sqlite3.Row
    counts = {"copied": 0, "skipped": 0, "questions": 0, "images": 0}
    try:
        with target.connect() as db:
            there = {row["id"] for row in db.execute("SELECT id FROM sessions").fetchall()}
            for session in source.execute("SELECT * FROM sessions ORDER BY created_at, id").fetchall():
                if session["id"] in there:
                    counts["skipped"] += 1
                    continue
                values = [session[column] for column in SESSION_COLUMNS]
                values[-2:] = [utc(session["created_at"]), utc(session["updated_at"])]
                db.execute(
                    f"INSERT INTO sessions ({', '.join(SESSION_COLUMNS)}) VALUES ({', '.join('?' * len(values))})",
                    values,
                )
                messages = source.execute(
                    "SELECT role, content, images, created_at FROM messages WHERE conversation_id=? ORDER BY id",
                    (session["id"],),
                ).fetchall()
                if messages:
                    db.executemany(
                        "INSERT INTO messages (conversation_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?)",
                        [(session["id"], m["role"], m["content"], m["images"], utc(m["created_at"])) for m in messages],
                    )
                kept = source.execute(
                    "SELECT id, mime_type, data, created_at FROM images WHERE conversation_id=?", (session["id"],)
                ).fetchall()
                if kept:
                    db.executemany(
                        "INSERT INTO images (id, conversation_id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)",
                        [(i["id"], session["id"], i["mime_type"], i["data"], utc(i["created_at"])) for i in kept],
                    )
                counts["copied"] += 1
                counts["questions"] += sum(1 for m in messages if m["role"] == "user")
                counts["images"] += len(kept)
            counts["total"] = db.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
    finally:
        source.close()
    return counts


def main():
    load_dotenv(HERE / ".env")
    url = os.getenv("DATABASE_URL", "").strip()
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "chat.db"
    if not is_postgres(url):
        sys.exit("Put your PostgreSQL database's address in backend/.env as DATABASE_URL first.")
    if not source_path.exists():
        sys.exit(f"There's no {source_path} to copy from.")

    target = Database(url)
    target.open()  # makes the tables if they aren't there yet
    try:
        counts = copy_interviews(source_path, target)
    finally:
        target.close()
    print(
        f"Copied {counts['copied']} interviews ({counts['questions']} questions and their answers, {counts['images']} images)."
    )
    if counts["skipped"]:
        print(f"{counts['skipped']} were there already, and were left as they are.")
    print(f"The PostgreSQL database now has {counts['total']} interviews.")


if __name__ == "__main__":
    main()
