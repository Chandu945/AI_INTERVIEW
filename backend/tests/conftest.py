"""Shared test setup: a fresh database for every test and a fake Gemini, so tests never
touch your interviews or call the real API.

The tests use a throwaway SQLite database. With TEST_POSTGRES=1 they use the PostgreSQL database
in .env's DATABASE_URL instead, in a schema of their own that is emptied before each test and
dropped at the end, so the interviews kept there are never touched.
"""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace

from dotenv import dotenv_values

POSTGRES_URL = (
    dotenv_values(Path(__file__).resolve().parent.parent / ".env").get("DATABASE_URL", "")
    if os.environ.get("TEST_POSTGRES") == "1"
    else ""
)
TEST_SCHEMA = "ai_interact_tests"

# Set before main is imported, so a developer's .env can't add a real Gemini client, a thinking
# setting, an access token or their own database to the tests.
for name in (
    "GEMINI_API_KEY",
    "GEMINI_THINKING_LEVEL",
    "GEMINI_THINKING_BUDGET",
    "INTERACT_ACCESS_TOKEN",
    "DATABASE_URL",
):
    os.environ[name] = ""
os.environ["GEMINI_BACKUP_MODEL"] = "backup-model"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402
from database import Database  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def drop_postgres_test_schema():
    yield
    if POSTGRES_URL:
        Database(POSTGRES_URL, schema=TEST_SCHEMA).drop_schema()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB", tmp_path / "chat.db")
    if POSTGRES_URL:
        monkeypatch.setattr(main, "DATABASE_URL", POSTGRES_URL)
        monkeypatch.setattr(main, "DATABASE_SCHEMA", TEST_SCHEMA)
    for hedge in (main.ANSWER_HEDGE, main.RECORDED_HEDGE, main.TRANSCRIBE_HEDGE):
        hedge.recent.clear()  # so timings from one test can't change another's retry delay
    monkeypatch.setattr(main, "backup_resting_until", 0.0)
    with TestClient(main.app) as test_client:
        if POSTGRES_URL:
            main.database.empty()
        yield test_client


class FakeGemini:
    """Streams the given (text, finish_reason) chunks for answers, returns `transcript` for
    transcriptions (or raises it, if it's an exception), and keeps what it was sent. To act slow
    or broken, `delays` and `errors` give, call by call, how many seconds to wait before replying
    and an exception to raise instead, and `breaks` an exception to raise after an answer's first
    chunk. `calls` and `cancelled` count the requests, and `models` and `configs` record what each
    was sent with."""

    def __init__(self, chunks):
        self.config = None
        self.contents = None
        self.transcript = ""
        self.delays: list[float] = []
        self.errors: list[Exception | None] = []
        self.breaks: list[Exception | None] = []
        self.calls = 0
        self.cancelled = 0
        self.models: list[str] = []
        self.configs: list = []

        async def wait_and_check():
            call = self.calls
            self.calls += 1
            try:
                await asyncio.sleep(self.delays[call] if call < len(self.delays) else 0)
            except asyncio.CancelledError:
                self.cancelled += 1
                raise
            if call < len(self.errors) and self.errors[call]:
                raise self.errors[call]

        async def generate_content_stream(model, contents, config):
            self.config, self.contents = config, contents
            self.models.append(model)
            self.configs.append(config)

            async def stream():
                call = self.calls
                await wait_and_check()
                for i, (text, finish) in enumerate(chunks):
                    if i == 1 and call < len(self.breaks) and self.breaks[call]:
                        raise self.breaks[call]
                    yield SimpleNamespace(text=text, candidates=[SimpleNamespace(finish_reason=finish)])

            return stream()

        async def generate_content(model, contents, config):
            self.config, self.contents = config, contents
            self.models.append(model)
            self.configs.append(config)
            await wait_and_check()
            if isinstance(self.transcript, Exception):
                raise self.transcript
            return SimpleNamespace(text=self.transcript)

        async def aclose():
            pass

        self.aio = SimpleNamespace(
            models=SimpleNamespace(generate_content_stream=generate_content_stream, generate_content=generate_content),
            aclose=aclose,
        )


@pytest.fixture
def gemini(client):
    """Call with (text, finish_reason) chunks to make the next answers come from a fake Gemini."""

    def install(*chunks):
        fake = FakeGemini(chunks)
        main.app.state.chat_client = fake
        return fake

    return install
