"""The database: the same behavior with SQLite and PostgreSQL (TEST_POSTGRES=1 runs these against
PostgreSQL too), and what's particular to PostgreSQL."""

import os
import re
from datetime import datetime, timedelta, timezone

import pytest

import main
from copy_to_postgres import copy_interviews
from database import Database, client_url

POSTGRES = os.environ.get("TEST_POSTGRES") == "1"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_times_are_sent_as_sqlite_writes_them_with_either_database(client):
    """In UTC, written "2026-11-07 08:16:22": how the app reads them (frontend/lib/dates.ts)."""
    cid = client.post("/api/conversations", json={}).json()["conversation_id"]
    session = client.get(f"/api/conversations/{cid}").json()["session"]
    listed = client.get("/api/conversations").json()["sessions"][0]
    times = [session["created_at"], session["updated_at"], listed["created_at"], listed["updated_at"]]
    assert all(re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", time) for time in times), times
    written = datetime.strptime(listed["updated_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    assert abs(written - datetime.now(timezone.utc)) < timedelta(minutes=2)


def test_a_block_that_fails_is_undone(client):
    cid = client.post("/api/conversations", json={}).json()["conversation_id"]
    with pytest.raises(ValueError):
        with main.connect() as db:
            db.execute("UPDATE sessions SET title=? WHERE id=?", ("Changed", cid))
            raise ValueError("something went wrong")
    assert client.get(f"/api/conversations/{cid}").json()["session"]["title"] == "New Interview"


def test_settings_for_other_tools_are_left_out_of_a_database_url():
    """Supabase's connection strings end "?pgbouncer=true" (for Prisma), which psycopg turns down."""
    pooler = "postgresql://postgres.abc:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"
    assert client_url(pooler + "?pgbouncer=true") == pooler
    assert client_url(pooler + "?pgbouncer=true&sslmode=require") == pooler + "?sslmode=require"
    assert client_url(pooler) == pooler


def test_the_tests_never_empty_the_interviews_kept_in_public():
    with pytest.raises(RuntimeError):
        Database("postgresql://user:secret@localhost/postgres").empty()


@pytest.mark.skipif(not POSTGRES, reason="copies into PostgreSQL: run with TEST_POSTGRES=1")
def test_interviews_are_copied_from_sqlite_with_their_questions_and_images(client, tmp_path):
    old = tmp_path / "chat.db"
    source = Database(path=old)
    source.open()
    with source.connect() as db:
        db.execute(
            "INSERT INTO sessions (id, title, target_role, created_at, updated_at)"
            " VALUES ('s1', 'System design', 'Backend Engineer', '2026-11-01 09:00:00', '2026-11-02 18:30:15')"
        )
        db.executemany(
            "INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)",
            [("s1", "user", "What does this print?", "i1"), ("s1", "assistant", "It prints 3.", "")],
        )
        db.execute(
            "INSERT INTO images (id, conversation_id, mime_type, data) VALUES ('i1', 's1', 'image/png', ?)", (PNG,)
        )
    counts = copy_interviews(old, main.database)
    assert counts == {"copied": 1, "skipped": 0, "questions": 1, "images": 1, "total": 1}
    copied = client.get("/api/conversations/s1").json()
    session = copied["session"]
    assert (session["title"], session["target_role"], session["updated_at"]) == (
        "System design",
        "Backend Engineer",
        "2026-11-02 18:30:15",
    )
    assert copied["messages"] == [
        {"role": "user", "content": "What does this print?", "images": ["i1"]},
        {"role": "assistant", "content": "It prints 3.", "images": []},
    ]
    assert client.get("/api/images/i1").content == PNG
    # Run again, it copies only what's new.
    assert copy_interviews(old, main.database)["copied"] == 0
