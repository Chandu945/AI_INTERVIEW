"""Shared test setup: a fresh database for every test and a fake Gemini, so tests never
touch chat.db or call the real API."""

import asyncio
import os
from types import SimpleNamespace

# Set before main is imported, so a developer's .env can't add a real Gemini client,
# a thinking setting or an access token to the tests.
for name in ("GEMINI_API_KEY", "GEMINI_THINKING_LEVEL", "GEMINI_THINKING_BUDGET", "INTERACT_ACCESS_TOKEN"):
    os.environ[name] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB", tmp_path / "chat.db")
    for hedge in (main.ANSWER_HEDGE, main.TRANSCRIBE_HEDGE):
        hedge.recent.clear()  # so timings from one test can't change another's retry delay
    with TestClient(main.app) as test_client:
        yield test_client


class FakeGemini:
    """Streams the given (text, finish_reason) chunks for answers, returns `transcript` for
    transcriptions (or raises it, if it's an exception), and keeps what it was sent. To act slow
    or broken, `delays` and `errors` give, call by call, how many seconds to wait before replying
    and an exception to raise instead. `calls` and `cancelled` count the requests."""

    def __init__(self, chunks):
        self.config = None
        self.contents = None
        self.transcript = ""
        self.delays: list[float] = []
        self.errors: list[Exception | None] = []
        self.calls = 0
        self.cancelled = 0

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

            async def stream():
                await wait_and_check()
                for text, finish in chunks:
                    yield SimpleNamespace(text=text, candidates=[SimpleNamespace(finish_reason=finish)])

            return stream()

        async def generate_content(model, contents, config):
            self.config, self.contents = config, contents
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
