"""API tests: interviews, resume uploads, streamed answers and how prompts are built."""

import asyncio
import io
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import httpx
from docx import Document
from google.genai import errors, types
from pypdf import PdfWriter

import main

QUESTION = "Tell me about a time you disagreed with a teammate"


def new_interview(client, **fields):
    return client.post("/api/conversations", json=fields).json()["conversation_id"]


def blank_pdf(pages):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def docx_with(text):
    document = Document()
    document.add_paragraph(text)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def upload(client, cid, name, data):
    return client.post(f"/api/conversations/{cid}/resume", files={"file": (name, data, "application/octet-stream")})


def ask(client, cid, message=QUESTION, mode="quick"):
    response = client.post("/api/chat/stream", json={"message": message, "conversation_id": cid, "mode": mode})
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def saved_messages(client, cid):
    return client.get(f"/api/conversations/{cid}").json()["messages"]


# Interviews


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_new_interview_keeps_its_settings_and_is_listed(client):
    cid = new_interview(client, target_role="Data Engineer", interview_type="HR", mode="detailed")
    session = client.get(f"/api/conversations/{cid}").json()["session"]
    assert (session["title"], session["target_role"], session["interview_type"], session["mode"]) == (
        "New Interview",
        "Data Engineer",
        "HR",
        "detailed",
    )
    assert [s["id"] for s in client.get("/api/conversations").json()["sessions"]] == [cid]


def test_answer_length_is_saved_and_renaming_keeps_it(client):
    cid = new_interview(client)
    assert client.patch(f"/api/conversations/{cid}", json={"mode": "detailed"}).status_code == 200
    assert client.patch(f"/api/conversations/{cid}", json={"title": "  Mock round 1  "}).status_code == 200
    session = client.get(f"/api/conversations/{cid}").json()["session"]
    assert (session["title"], session["mode"]) == ("Mock round 1", "detailed")


def test_update_rejects_bad_requests(client):
    cid = new_interview(client)
    assert client.patch(f"/api/conversations/{cid}", json={}).status_code == 422
    assert client.patch(f"/api/conversations/{cid}", json={"mode": "bogus"}).status_code == 422
    assert client.patch("/api/conversations/missing", json={"mode": "quick"}).status_code == 404


def test_delete_removes_the_interview_and_its_messages(client, gemini):
    cid = new_interview(client)
    gemini(("An answer.", "STOP"))
    ask(client, cid)
    assert client.delete(f"/api/conversations/{cid}").json() == {"ok": True}
    assert client.get(f"/api/conversations/{cid}").status_code == 404


def test_access_token_gate(client, monkeypatch):
    monkeypatch.setenv("INTERACT_ACCESS_TOKEN", "s3cret")
    assert client.get("/api/conversations").status_code == 401
    assert client.get("/api/conversations", headers={"X-Interact-Token": "s3cret"}).status_code == 200


def test_removed_endpoints_are_gone(client):
    for path in ("/api/chat", "/api/audio/transcribe", "/api/audio/speech"):
        assert client.post(path, json={}).status_code == 404
    assert client.delete(f"/api/conversations/{new_interview(client)}/resume").status_code == 405


# Resume uploads


def test_resume_over_20_pages_gets_the_page_limit_message(client):
    response = upload(client, new_interview(client), "long.pdf", blank_pdf(21))
    assert (response.status_code, response.json()["detail"]) == (422, "Resume has 21 pages; the limit is 20")


def test_unreadable_pdf_gets_the_generic_message(client):
    response = upload(client, new_interview(client), "broken.pdf", b"not a pdf")
    assert response.status_code == 422 and "Could not extract resume text" in response.json()["detail"]


def test_pdf_without_text_is_rejected(client):
    response = upload(client, new_interview(client), "blank.pdf", blank_pdf(1))
    assert response.json()["detail"] == "Resume contains insufficient extractable text"


def test_docx_resume_is_saved(client):
    cid = new_interview(client)
    response = upload(
        client, cid, "resume.docx", docx_with("Jane Doe. Python developer: FastAPI, RAG pipelines, PostgreSQL.")
    )
    assert response.status_code == 200 and response.json()["resume_name"] == "resume.docx"
    assert client.get(f"/api/conversations/{cid}").json()["session"]["resume_name"] == "resume.docx"


def test_resume_upload_validation(client):
    cid = new_interview(client)
    assert upload(client, cid, "resume.txt", b"plain text").status_code == 400
    assert upload(client, cid, "big.pdf", b"x" * (5 * 1024 * 1024 + 1)).status_code == 413
    assert (
        upload(client, "missing", "resume.docx", docx_with("Jane Doe, Python developer with FastAPI.")).status_code
        == 404
    )


def test_resume_parsing_does_not_block_other_requests(client, monkeypatch):
    """A slow parse runs in a worker thread, so other requests still get answers right away."""

    def slow_extract(ext, raw):
        time.sleep(1.0)
        return "Jane Doe. Python developer with FastAPI and RAG experience."

    monkeypatch.setattr(main, "extract_resume_text", slow_extract)
    cid = new_interview(client)

    async def seconds_until_health_answers():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test") as api:
            started = time.perf_counter()
            parsing = asyncio.create_task(
                api.post(f"/api/conversations/{cid}/resume", files={"file": ("r.docx", b"x")})
            )
            await asyncio.sleep(0.2)
            await api.get("/api/health")
            elapsed = time.perf_counter() - started
            assert (await parsing).status_code == 200
            return elapsed

    assert asyncio.run(seconds_until_health_answers()) < 0.6


# Streamed answers


def test_streamed_answer_is_saved_and_names_the_interview(client, gemini):
    cid = new_interview(client)
    gemini(("First part.", None), (" Second part.", "STOP"))
    events = ask(client, cid, "What is RAG?")
    assert [e["type"] for e in events] == ["start", "delta", "delta", "done"]
    assert saved_messages(client, cid) == [
        {"role": "user", "content": "What is RAG?"},
        {"role": "assistant", "content": "First part. Second part."},
    ]
    assert client.get(f"/api/conversations/{cid}").json()["session"]["title"] == "What is RAG?"


def test_cut_off_answer_is_marked_and_saved(client, gemini):
    cid = new_interview(client)
    gemini(
        ("Situation: our team split on a database choice. I proposed", None),
        (" a short spike to", types.FinishReason.MAX_TOKENS),
    )
    events = ask(client, cid)
    assert events[-1]["type"] == "done"
    assert "Cut off at the answer-length limit" in events[-2]["text"]
    assert saved_messages(client, cid)[-1]["content"].endswith("ask again for the full answer.)*")


def test_limit_reached_before_any_text_gives_a_clear_error_and_saves_nothing(client, gemini):
    cid = new_interview(client)
    gemini((None, types.FinishReason.MAX_TOKENS))
    events = ask(client, cid)
    assert events[-1]["type"] == "error" and "before writing anything" in events[-1]["message"]
    assert saved_messages(client, cid) == []


def test_chat_without_an_api_key_is_503(client):
    response = client.post("/api/chat/stream", json={"message": "Hi", "conversation_id": new_interview(client)})
    assert response.status_code == 503


def test_question_over_10000_characters_is_rejected(client):
    response = client.post("/api/chat/stream", json={"message": "x" * 10001})
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "String should have at most 10000 characters"


# Prompt building


def test_hr_interview_gets_behavioral_guidance(client, gemini):
    fake = gemini(("An answer.", "STOP"))
    ask(client, new_interview(client, interview_type="HR"))
    prompt = fake.config.system_instruction
    assert "HR or behavioral interview" in prompt and "situation, action and result" in prompt
    assert "practice answering real interview questions" in prompt


def test_technical_interview_says_so(client, gemini):
    fake = gemini(("An answer.", "STOP"))
    ask(client, new_interview(client, interview_type="Technical"))
    assert "This is a technical interview." in fake.config.system_instruction


def test_resume_and_job_description_reach_the_prompt(client, gemini):
    cid = new_interview(client, job_description="We need FastAPI and Postgres skills.")
    upload(client, cid, "resume.docx", docx_with("Jane Doe built a RAG pipeline with LangGraph at Acme."))
    fake = gemini(("An answer.", "STOP"))
    ask(client, cid)
    assert "LangGraph at Acme" in fake.config.system_instruction
    assert "We need FastAPI and Postgres skills." in fake.config.system_instruction


def test_only_the_last_10_messages_are_sent_as_history(client, gemini):
    cid = new_interview(client)
    for i in range(7):
        gemini((f"Answer {i}.", "STOP"))
        ask(client, cid, f"Question {i}")
    fake = gemini(("Last answer.", "STOP"))
    ask(client, cid, "Question 7")
    texts = [content.parts[0].text for content in fake.contents]
    assert (len(texts), texts[0], texts[-1]) == (11, "Question 2", "Question 7")


def test_thinking_settings(monkeypatch):
    monkeypatch.setattr(main, "THINKING_LEVEL", "MINIMAL")
    assert main.chat_config("balanced").thinking_config.thinking_level == types.ThinkingLevel.MINIMAL
    monkeypatch.setattr(main, "THINKING_LEVEL", "")
    monkeypatch.setattr(main, "THINKING_BUDGET", "0")
    assert main.chat_config("balanced").thinking_config.thinking_budget == 0
    monkeypatch.setattr(main, "THINKING_BUDGET", "")
    assert main.chat_config("balanced").thinking_config is None


def test_invalid_thinking_level_stops_startup():
    result = subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=Path(main.__file__).parent,
        env={**os.environ, "GEMINI_THINKING_LEVEL": "bogus"},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and "GEMINI_THINKING_LEVEL must be" in result.stderr


# Transcribing recorded questions


def silence_wav(seconds=0.1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buffer.getvalue()


def send_recording(client, cid, data=None, content_type="audio/wav"):
    audio = silence_wav() if data is None else data
    return client.post(f"/api/conversations/{cid}/transcribe", files={"file": ("question.wav", audio, content_type)})


def test_transcription_uses_the_interview_as_hints(client, gemini):
    cid = new_interview(client, target_role="Data Engineer", interview_type="Mixed",
                        job_description="Experience with AWS S3 and PostgreSQL.")  # fmt: skip
    upload(client, cid, "resume.docx", docx_with("Built ETL pipelines in PySpark and TensorFlow models at Acme."))
    fake = gemini()
    fake.transcript = "  What is a DAG in Airflow?  "
    assert send_recording(client, cid).json() == {"text": "What is a DAG in Airflow?"}
    prompt, audio = fake.contents[0].parts
    assert "Data Engineer (Mixed interview)" in prompt.text
    for term in ("LangChain", "PostgreSQL", "PySpark", "TensorFlow", "S3", "AWS"):
        assert term in prompt.text
    assert audio.inline_data.mime_type == "audio/wav"


def test_vocabulary_picks_technical_words():
    text = "We use PostgreSQL, GPT-4, Node.js, C++ and AWS. Python is great; so is the team."
    assert main.vocabulary(text) == ["PostgreSQL", "GPT-4", "Node.js", "C++", "AWS"]


def test_transcription_rejects_bad_recordings(client, gemini):
    gemini()
    cid = new_interview(client)
    assert send_recording(client, cid, content_type="audio/webm").status_code == 415
    assert send_recording(client, cid, data=b"").status_code == 400
    assert send_recording(client, cid, data=b"x" * (main.MAX_RECORDING_BYTES + 1)).status_code == 413
    assert send_recording(client, "missing").status_code == 404


def test_transcription_problems_are_reported(client, gemini):
    cid = new_interview(client)
    assert send_recording(client, cid).status_code == 503  # no API key
    gemini().transcript = RuntimeError("Gemini is busy")
    assert send_recording(client, cid).status_code == 502


# Slow or failed Gemini requests are sent again (see main.Hedge).

SERVER_ERROR = errors.ServerError(503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}})
RATE_LIMIT = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})


def timed_ask(client, cid):
    started = time.perf_counter()
    events = ask(client, cid, "Question?")
    return events, time.perf_counter() - started


def test_a_slow_answer_is_requested_again_and_the_quicker_one_is_used(client, gemini, monkeypatch):
    monkeypatch.setattr(main.ANSWER_HEDGE, "minimum", 0.3)
    cid = new_interview(client)
    fake = gemini(("Quick answer.", "STOP"))
    fake.delays = [10, 0]  # the first request hangs
    events, seconds = timed_ask(client, cid)
    assert seconds < 5
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "Quick answer."
    assert events[-1]["type"] == "done"
    assert (fake.calls, fake.cancelled) == (2, 1)


def test_a_failed_answer_is_retried_at_once(client, gemini, monkeypatch):
    monkeypatch.setattr(main.ANSWER_HEDGE, "minimum", 30)  # so only the failure can trigger the retry
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [SERVER_ERROR]
    events, seconds = timed_ask(client, cid)
    assert seconds < 5
    assert events[-1]["type"] == "done"
    assert fake.calls == 2


def test_a_rate_limited_answer_is_not_retried(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [RATE_LIMIT]
    events, _ = timed_ask(client, cid)
    assert events[-1]["type"] == "error"
    assert fake.calls == 1


def test_a_slow_transcription_is_requested_again(client, gemini, monkeypatch):
    monkeypatch.setattr(main.TRANSCRIBE_HEDGE, "minimum", 0.3)
    cid = new_interview(client)
    fake = gemini()
    fake.transcript = "What is RAG?"
    fake.delays = [10, 0]
    started = time.perf_counter()
    response = send_recording(client, cid)
    assert time.perf_counter() - started < 5
    assert response.json() == {"text": "What is RAG?"}
    assert (fake.calls, fake.cancelled) == (2, 1)


def test_the_retry_waits_twice_the_typical_time():
    hedge = main.Hedge("test", minimum=3.0)
    assert hedge.delay() == 3.0
    hedge.recent.extend([1.0, 1.2, 1.4])
    assert hedge.delay() == 3.0  # twice the typical 1.2 s is under the minimum
    hedge.recent.clear()
    hedge.recent.extend([2.0, 2.5, 30.0])
    assert hedge.delay() == 5.0  # twice the typical (median) 2.5 s; one very slow reply barely counts
