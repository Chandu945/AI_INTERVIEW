"""Shared test setup: a fresh database for every test and a fake Gemini, so tests never
touch chat.db or call the real API."""

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
    with TestClient(main.app) as test_client:
        yield test_client


class FakeGemini:
    """Streams the given (text, finish_reason) chunks and keeps what it was sent."""

    def __init__(self, chunks):
        self.config = None
        self.contents = None

        async def generate_content_stream(model, contents, config):
            self.config, self.contents = config, contents

            async def stream():
                for text, finish in chunks:
                    yield SimpleNamespace(text=text, candidates=[SimpleNamespace(finish_reason=finish)])

            return stream()

        async def aclose():
            pass

        self.aio = SimpleNamespace(
            models=SimpleNamespace(generate_content_stream=generate_content_stream), aclose=aclose
        )


@pytest.fixture
def gemini(client):
    """Call with (text, finish_reason) chunks to make the next answers come from a fake Gemini."""

    def install(*chunks):
        fake = FakeGemini(chunks)
        main.app.state.chat_client = fake
        return fake

    return install
