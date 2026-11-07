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
from database import DatabaseUnavailable

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
    database = "PostgreSQL" if os.environ.get("TEST_POSTGRES") == "1" else "SQLite"
    assert client.get("/api/health").json() == {"status": "ok", "database": database}


def test_a_database_out_of_reach_is_said_plainly(client, gemini, monkeypatch):
    cid = new_interview(client)
    gemini(("An answer.", "STOP"))

    def out_of_reach(*args):
        raise DatabaseUnavailable("connection timeout expired")

    monkeypatch.setattr(main, "save_turn", out_of_reach)  # the answer came, but couldn't be saved
    assert ask(client, cid)[-1] == {"type": "error", "message": main.DATABASE_UNAVAILABLE}
    monkeypatch.setattr(main, "connect", out_of_reach)
    response = client.get("/api/conversations")
    assert (response.status_code, response.json()) == (503, {"detail": main.DATABASE_UNAVAILABLE})


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


def test_the_list_shows_how_many_questions_each_interview_has_and_the_last_one(client, gemini):
    empty = new_interview(client)
    cid = new_interview(client)
    gemini(("An answer.", "STOP"))
    ask(client, cid, "What is a pod?")
    ask(client, cid, "What is a deployment? " + "x" * 300)
    listed = {s["id"]: s for s in client.get("/api/conversations").json()["sessions"]}
    assert (listed[cid]["questions"], listed[cid]["last_question"]) == (2, ("What is a deployment? " + "x" * 300)[:200])
    assert (listed[empty]["questions"], listed[empty]["last_question"]) == (0, None)


def test_an_interview_can_be_started_again_with_the_same_setup(client, gemini):
    cid = new_interview(
        client, target_role="Data Engineer", interview_type="HR", mode="detailed",
        instructions="Keep it short.", job_description="Spark and Airflow.",
    )  # fmt: skip
    upload(client, cid, "resume.docx", docx_with("Built ETL pipelines in PySpark at Acme for five years."))
    gemini(("An answer.", "STOP"))
    ask(client, cid)
    copy = client.post(f"/api/conversations/{cid}/copy").json()["conversation_id"]
    original, again = (client.get(f"/api/conversations/{c}").json() for c in (cid, copy))
    fields = ("target_role", "interview_type", "mode", "instructions", "job_description", "resume_name")
    assert [again["session"][f] for f in fields] == [original["session"][f] for f in fields]
    assert again["session"]["resume_name"] == "resume.docx"
    assert (again["session"]["title"], again["messages"]) == ("New Interview", [])
    with main.connect() as db:  # the resume's text came along too, for the answers to draw on
        rows = db.execute("SELECT resume_text FROM sessions WHERE id IN (?, ?)", (cid, copy)).fetchall()
    texts = [row["resume_text"] for row in rows]
    assert texts[0] == texts[1] and "PySpark" in texts[0]
    assert client.post("/api/conversations/missing/copy").status_code == 404


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
        {"role": "user", "content": "What is RAG?", "images": []},
        {"role": "assistant", "content": "First part. Second part.", "images": []},
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


# Images shared with questions

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # enough of a PNG for the type check
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def add_image(client, cid, data=PNG, name="screenshot.png"):
    return client.post(f"/api/conversations/{cid}/images", files={"file": (name, data, "application/octet-stream")})


def image_parts(content):
    return [part.inline_data for part in content.parts if part.inline_data]


def test_an_image_is_kept_and_served_by_its_id(client):
    cid = new_interview(client)
    image_id = add_image(client, cid, JPEG, "photo.jpg").json()["image_id"]
    served = client.get(f"/api/images/{image_id}")
    assert (served.status_code, served.headers["content-type"], served.content) == (200, "image/jpeg", JPEG)
    assert client.get("/api/images/missing").status_code == 404


def test_an_upload_must_be_an_image_of_a_known_kind_and_not_too_big(client):
    cid = new_interview(client)
    assert add_image(client, cid, b"GIF89a" + b"\x00" * 64, "anim.gif").status_code == 415
    assert add_image(client, cid, b"just some text", "notes.png").status_code == 415  # the name doesn't count
    assert add_image(client, cid, PNG + b"\x00" * main.MAX_IMAGE_BYTES).status_code == 413
    assert add_image(client, "missing").status_code == 404


def test_a_question_goes_to_gemini_with_its_images_and_is_saved_with_them(client, gemini):
    cid = new_interview(client)
    first, second = (add_image(client, cid, data).json()["image_id"] for data in (PNG, JPEG))
    fake = gemini(("An answer.", "STOP"))
    events = ask_with(client, cid, "What does this code print?", [first, second])
    assert events[-1]["type"] == "done"
    question = fake.contents[-1]
    assert [image.mime_type for image in image_parts(question)] == ["image/png", "image/jpeg"]
    assert question.parts[2].text.startswith("The candidate shared 2 images with this question")
    assert question.parts[3].text == "What does this code print?"
    assert saved_messages(client, cid)[0] == {
        "role": "user",
        "content": "What does this code print?",
        "images": [first, second],
    }
    # A follow-up still has the images, to ask about them; two questions later, they're left out.
    ask(client, cid, "And its time complexity?")
    assert [image.mime_type for image in image_parts(fake.contents[0])] == ["image/png", "image/jpeg"]
    ask(client, cid, "Could it be faster?")
    assert image_parts(fake.contents[0])
    ask(client, cid, "Tell me about yourself.")
    assert not image_parts(fake.contents[0])
    assert fake.contents[0].parts[0].text == "What does this code print?"
    # Sent with a question, it stays; an image taken off before sending goes.
    assert client.delete(f"/api/images/{first}").status_code == 409
    unsent = add_image(client, cid).json()["image_id"]
    assert client.delete(f"/api/images/{unsent}").json() == {"ok": True}
    assert client.get(f"/api/images/{unsent}").status_code == 404


def test_an_image_can_be_the_whole_question(client, gemini):
    cid = new_interview(client)
    image_id = add_image(client, cid).json()["image_id"]
    fake = gemini(("Use a hash map.", "STOP"))
    assert ask_with(client, cid, "", [image_id])[-1]["type"] == "done"
    assert fake.contents[-1].parts[-1].text == main.IMAGE_ONLY_QUESTION
    assert saved_messages(client, cid)[0] == {"role": "user", "content": "", "images": [image_id]}
    session = next(s for s in client.get("/api/conversations").json()["sessions"] if s["id"] == cid)
    assert (session["title"], session["last_question"]) == ("Image question", "(an image)")


def test_a_question_needs_words_or_an_image_and_only_its_own_interview_images(client, gemini):
    cid, other = new_interview(client), new_interview(client)
    gemini(("An answer.", "STOP"))
    assert client.post("/api/chat/stream", json={"message": " ", "conversation_id": cid}).status_code == 422
    elsewhere = add_image(client, other).json()["image_id"]
    response = client.post("/api/chat/stream", json={"message": "Hi", "conversation_id": cid, "image_ids": [elsewhere]})
    assert response.status_code == 404
    too_many = {"message": "Hi", "conversation_id": cid, "image_ids": ["a", "b", "c", "d", "e"]}
    assert client.post("/api/chat/stream", json=too_many).status_code == 422


def test_deleting_an_interview_deletes_its_images(client):
    cid = new_interview(client)
    image_id = add_image(client, cid).json()["image_id"]
    client.delete(f"/api/conversations/{cid}")
    assert client.get(f"/api/images/{image_id}").status_code == 404


def test_images_are_kept_in_memory_once_uploaded_or_read(client, gemini):
    """A database far away takes about a second per MB to send an image back, and a question's
    images go to Gemini again with its next two follow-ups."""
    cid = new_interview(client)
    image_id = add_image(client, cid).json()["image_id"]
    with main.connect() as db:  # changed in the database only, so what's sent shows where it came from
        db.execute("UPDATE images SET data=? WHERE id=?", (JPEG, image_id))
    fake = gemini(("An answer.", "STOP"))
    ask_with(client, cid, "What does this print?", [image_id])
    assert image_parts(fake.contents[-1])[0].data == PNG
    assert client.get(f"/api/images/{image_id}").content == PNG
    main.image_memory.forget(image_id)  # as after a restart: read from the database once, then kept
    ask(client, cid, "And its time complexity?")
    assert image_parts(fake.contents[0])[0].data == JPEG
    assert main.image_memory.get(image_id) == (cid, "image/png", JPEG)


def test_image_memory_lets_the_least_recently_used_go_when_full():
    memory = main.ImageMemory(room=10)
    memory.keep("a", "one", "image/png", b"aaaaa")
    memory.keep("b", "one", "image/png", b"bbbbb")
    memory.get("a")  # used, so "b" is now the least recently used
    memory.keep("c", "two", "image/png", b"ccccc")
    assert [memory.get(image_id) is not None for image_id in "abc"] == [True, False, True]
    memory.forget_interview("one")
    assert (memory.get("a"), memory.size) == (None, 5)


def test_a_question_reads_the_database_all_at_once(client, monkeypatch):
    """Each read is a trip to the database (about 60 ms to one far away), so a question's three
    (its interview's settings, the interview so far and its images) go at the same time."""
    cid = new_interview(client)

    def slowly(read):
        def slow_read(*args):
            time.sleep(0.3)
            return read(*args)

        return slow_read

    for name in ("interview_settings", "interview_so_far", "image_parts"):
        monkeypatch.setattr(main, name, slowly(getattr(main, name)))
    started = time.perf_counter()
    asyncio.run(main.typed_question(cid, "What is RAG?", (), "quick"))
    assert time.perf_counter() - started < 0.85  # one after another, they'd take over 0.9 s


def ask_with(client, cid, message, image_ids):
    body = {"message": message, "conversation_id": cid, "mode": "quick", "image_ids": image_ids}
    response = client.post("/api/chat/stream", json=body)
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


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
    assert fake.config.thinking_config.thinking_level == types.ThinkingLevel.MINIMAL  # quicker
    assert "Data Engineer (Mixed interview)" in prompt.text
    for term in ("LangChain", "PostgreSQL", "PySpark", "TensorFlow", "S3", "AWS"):
        assert term in prompt.text
    assert audio.inline_data.mime_type == "audio/wav"


def test_a_piece_of_a_longer_recording_carries_on_from_the_text_so_far(client, gemini):
    cid = new_interview(client)
    fake = gemini()
    fake.transcript = "and when would you use each one?"
    response = client.post(
        f"/api/conversations/{cid}/transcribe",
        files={"file": ("piece.wav", silence_wav(), "audio/wav")},
        data={"context": "What is the difference between a Deployment and a StatefulSet?"},
    )
    assert response.json() == {"text": "and when would you use each one?"}
    prompt, _ = fake.contents[0].parts
    assert 'which ends: "What is the difference between a Deployment and a StatefulSet?"' in prompt.text
    assert "Do not repeat it." in prompt.text
    send_recording(client, cid)  # without context: no such sentence
    assert "continues what was said" not in fake.contents[0].parts[0].text


def test_gemini_says_first_whether_anyone_speaks(client, gemini):
    cid = new_interview(client)
    fake = gemini()
    for reply, text in (
        ("SPEECH: yes\nWhat is a pod?", "What is a pod?"),
        ("**SPEECH: yes**\n\nWhat is a pod?", "What is a pod?"),
        ("SPEECH: yes What is a pod?", "What is a pod?"),
        ("SPEECH: no", ""),
        ("Speech: No.\nWhat is a pod?", ""),  # made up: no one spoke
        ("What is a pod?", "What is a pod?"),  # no answer to that: the reply is the transcript
    ):
        fake.transcript = reply
        assert send_recording(client, cid).json() == {"text": text}
    assert '"SPEECH: no" if it holds only silence, noise, music' in fake.contents[0].parts[0].text


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


# Questions sent as their recording: Gemini writes the question down and answers it in one go.


def ask_recording(client, cid, heard="what is rag", data=None, content_type="audio/wav"):
    audio = silence_wav() if data is None else data
    return client.post(
        "/api/chat/stream-recording",
        data={"conversation_id": cid, "mode": "quick", "heard": heard},
        files={"file": ("question.wav", audio, content_type)},
    )


def events_of(response):
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_a_recorded_question_is_written_down_and_answered_in_one_go(client, gemini):
    cid = new_interview(client, job_description="We use PostgreSQL.")
    # The question's line arrives in pieces, as it would from Gemini.
    fake = gemini(("Q", None), (": What is RAG", None), ("?\n", None), ("\nRAG pairs a retriever", None), (" with a model.", "STOP"))  # fmt: skip
    events = events_of(ask_recording(client, cid))
    assert [e["type"] for e in events] == ["start", "question", "delta", "delta", "done"]
    assert events[1]["text"] == "What is RAG?"
    assert "".join(e["text"] for e in events if e["type"] == "delta") == "RAG pairs a retriever with a model."
    audio, prompt = fake.contents[-1].parts
    assert audio.inline_data.mime_type == "audio/wav"
    assert 'starting with "Q: "' in prompt.text and "PostgreSQL" in prompt.text
    assert [m["content"] for m in saved_messages(client, cid)] == [
        "What is RAG?",
        "RAG pairs a retriever with a model.",
    ]


def test_a_recorded_question_goes_with_its_images(client, gemini):
    cid = new_interview(client)
    image_id = add_image(client, cid).json()["image_id"]
    fake = gemini(("Q: What does this print?\n\nIt prints 3.", "STOP"))
    response = client.post(
        "/api/chat/stream-recording",
        data={"conversation_id": cid, "mode": "quick", "heard": "what does this print", "image_ids": image_id},
        files={"file": ("question.wav", silence_wav(), "audio/wav")},
    )
    assert events_of(response)[-1]["type"] == "done"
    audio, image, about_images, prompt = fake.contents[-1].parts
    assert (audio.inline_data.mime_type, image.inline_data.mime_type) == ("audio/wav", "image/png")
    assert about_images.text.startswith("The candidate shared an image with this question")
    assert 'starting with "Q: "' in prompt.text
    assert saved_messages(client, cid)[0] == {"role": "user", "content": "What does this print?", "images": [image_id]}


def test_without_a_question_line_the_live_words_are_kept_as_the_question(client, gemini):
    cid = new_interview(client)
    gemini(("RAG pairs a retriever with a model.", "STOP"))
    events = events_of(ask_recording(client, cid, heard="what is rag"))
    assert events[1] == {"type": "question", "text": "what is rag"}
    assert events[2] == {"type": "delta", "text": "RAG pairs a retriever with a model."}
    assert saved_messages(client, cid)[0]["content"] == "what is rag"


def test_the_question_line_is_found_however_it_is_written():
    for first in ("Q: What is RAG?", "**Q:** What is RAG?", "Question: What is RAG?"):
        splitter = main.QuestionLine()
        answer = splitter.feed(first + "\n\n") + splitter.feed("Retrieval first.")
        assert (splitter.question, answer) == ("What is RAG?", "Retrieval first.")


def test_recorded_questions_are_checked(client, gemini):
    cid = new_interview(client)
    assert ask_recording(client, cid).status_code == 503  # no API key
    gemini(("Q: Hi?\n\nHello.", "STOP"))
    assert ask_recording(client, cid, content_type="audio/webm").status_code == 415
    assert ask_recording(client, cid, data=b"").status_code == 400
    assert ask_recording(client, "missing").status_code == 404


# Slow or failed Gemini requests are sent again (see main.Hedge).

SERVER_ERROR = errors.ServerError(503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}})
RATE_LIMIT = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
BAD_REQUEST = errors.ClientError(400, {"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}})
DAILY_LIMIT = errors.ClientError(
    429,
    {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "71447s"}],
        }
    },
)


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
    # The second request went to the backup model, with minimal thinking for speed.
    assert fake.models == [main.MODEL, "backup-model"]
    assert fake.configs[1].thinking_config.thinking_level == types.ThinkingLevel.MINIMAL
    assert fake.configs[1].system_instruction == fake.configs[0].system_instruction
    # The backup's reply doesn't count toward how quick the main model normally is.
    assert not main.ANSWER_HEDGE.recent


def test_a_failed_answer_is_retried_at_once(client, gemini, monkeypatch):
    monkeypatch.setattr(main.ANSWER_HEDGE, "minimum", 30)  # so only the failure can trigger the retry
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [SERVER_ERROR]
    events, seconds = timed_ask(client, cid)
    assert seconds < 5
    assert events[-1]["type"] == "done"
    assert fake.models == [main.MODEL, "backup-model"]


def test_a_rate_limited_answer_goes_to_the_backup_model(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [RATE_LIMIT]  # the backup model has its own limits
    events, _ = timed_ask(client, cid)
    assert events[-1]["type"] == "done"
    assert fake.models == [main.MODEL, "backup-model"]


def test_a_bad_request_is_not_retried(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [BAD_REQUEST]
    events, _ = timed_ask(client, cid)
    assert events[-1]["type"] == "error"
    assert fake.calls == 1


def test_without_a_backup_model_the_main_model_is_tried_again(client, gemini, monkeypatch):
    monkeypatch.setattr(main, "BACKUP_MODEL", main.MODEL)
    monkeypatch.setattr(main.ANSWER_HEDGE, "minimum", 0.3)
    cid = new_interview(client)
    fake = gemini(("Quick answer.", "STOP"))
    fake.delays = [10, 0]
    events, _ = timed_ask(client, cid)
    assert events[-1]["type"] == "done"
    assert fake.models == [main.MODEL, main.MODEL]
    assert fake.configs[1].thinking_config is None  # the main model's own settings
    # A rate limit isn't retried then: the same model would refuse again.
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [RATE_LIMIT]
    assert timed_ask(client, cid)[0][-1]["type"] == "error"
    assert fake.calls == 1


def test_when_the_backup_is_out_of_quota_the_main_model_is_retried(client, gemini, monkeypatch):
    monkeypatch.setattr(main.ANSWER_HEDGE, "minimum", 0.3)
    cid = new_interview(client)
    fake = gemini(("Quick answer.", "STOP"))
    fake.delays = [10, 0, 0]
    fake.errors = [None, DAILY_LIMIT, None]  # the backup refuses; the main model answers the retry
    events, seconds = timed_ask(client, cid)
    assert seconds < 5 and events[-1]["type"] == "done"
    assert fake.models == [main.MODEL, "backup-model", main.MODEL]
    # The backup rests for as long as Google said, so the next retry goes straight to the main model.
    assert main.backup_resting_until - time.monotonic() > 70_000
    fake = gemini(("Quick answer.", "STOP"))
    fake.delays = [10, 0]
    assert timed_ask(client, cid)[0][-1]["type"] == "done"
    assert fake.models == [main.MODEL, main.MODEL]


def test_a_refusal_without_a_retry_delay_rests_the_backup_for_10_minutes(monkeypatch):
    monkeypatch.setattr(main, "backup_resting_until", 0.0)  # restored after the test
    assert main.rest_backup(RATE_LIMIT) == 600


def test_when_both_models_fail_the_answer_reports_an_error(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Answer.", "STOP"))
    fake.errors = [SERVER_ERROR, SERVER_ERROR]
    events, _ = timed_ask(client, cid)
    assert events[-1]["type"] == "error"
    assert fake.models == [main.MODEL, "backup-model"]


def test_an_answer_that_breaks_off_is_started_again(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Part one. ", None), ("Part two.", "STOP"))
    fake.breaks = [SERVER_ERROR]  # the first answer breaks off after its first words
    events = ask(client, cid)
    assert [e["type"] for e in events] == ["start", "delta", "restart", "delta", "delta", "done"]
    assert "".join(e["text"] for e in events[3:] if e["type"] == "delta") == "Part one. Part two."
    assert saved_messages(client, cid)[1]["content"] == "Part one. Part two."
    assert fake.calls == 2


def test_an_answer_that_breaks_off_twice_reports_an_error(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Part one. ", None), ("Part two.", "STOP"))
    fake.breaks = [SERVER_ERROR, SERVER_ERROR]
    events = ask(client, cid)
    assert events[-1]["type"] == "error"
    assert saved_messages(client, cid) == []


def test_a_recorded_question_that_breaks_off_is_written_down_again(client, gemini):
    cid = new_interview(client)
    fake = gemini(("Q: What is RAG?\n\n", None), ("Retrieval first.", "STOP"))
    fake.breaks = [SERVER_ERROR]
    events = events_of(ask_recording(client, cid))
    assert [e["type"] for e in events] == ["start", "question", "restart", "question", "delta", "done"]
    assert [m["content"] for m in saved_messages(client, cid)] == ["What is RAG?", "Retrieval first."]


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
    assert fake.models == [main.MODEL, "backup-model"]


def test_a_slow_answer_to_a_recording_is_requested_again_on_its_own_timing(client, gemini, monkeypatch):
    # An answer to a recording starts later than a typed one, so it has its own retry timing.
    monkeypatch.setattr(main.RECORDED_HEDGE, "minimum", 0.3)
    cid = new_interview(client)
    fake = gemini(("Q: What is RAG?\n\nRetrieval first.", "STOP"))
    fake.delays = [10, 0]
    started = time.perf_counter()
    events = events_of(ask_recording(client, cid))
    assert time.perf_counter() - started < 1.2  # retried after 0.3 s, not a typed answer's 1.5 s
    assert events[1] == {"type": "question", "text": "What is RAG?"} and events[-1]["type"] == "done"
    assert fake.models == [main.MODEL, "backup-model"]


def test_the_retry_waits_twice_a_quick_reply():
    hedge = main.Hedge("test", minimum=3.0, maximum=10.0)
    assert hedge.delay() == 3.0  # no replies yet
    hedge.recent.extend([1.0, 1.2, 1.4])
    assert hedge.delay() == 3.0  # twice 1 s is under the minimum
    hedge.recent.extend([5.0, 6.0, 7.0])
    assert hedge.delay() == 3.0  # a slow spell doesn't make it wait longer
    hedge.recent.clear()
    hedge.recent.extend([4.0, 4.5, 5.0, 6.0])
    assert hedge.delay() == 9.0  # a model that always thinks a while: twice 4.5 s
    hedge.recent.extend([20.0] * 8)
    assert hedge.delay() == 10.0  # never more than the maximum


def test_the_app_retries_after_one_and_a_half_quick_replies():
    main.ANSWER_HEDGE.recent.extend([1.0, 1.1, 1.2, 1.3])
    assert main.ANSWER_HEDGE.delay() == 1.5 * 1.1
    main.TRANSCRIBE_HEDGE.recent.extend([1.8, 1.9, 2.0, 2.2])
    assert main.TRANSCRIBE_HEDGE.delay() == 1.5 * 1.9
    assert main.RECORDED_HEDGE.delay() == 2.0  # no replies yet: its minimum
    for hedge in (main.ANSWER_HEDGE, main.TRANSCRIBE_HEDGE):
        hedge.recent.clear()
