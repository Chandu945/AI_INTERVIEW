"""Throwaway backend for the frontend's browser tests (started by `npm test`).

Runs on port 8100 with a fresh, seeded database and no Gemini key, so the browser tests
never touch chat.db or call the real API.
"""
import os
import sqlite3
import sys
import tempfile
import uuid
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")

DB = Path(tempfile.mkdtemp(prefix="interact-ui-tests-")) / "chat.db"
os.environ.update(INTERACT_DB=str(DB), GEMINI_API_KEY="", GEMINI_THINKING_LEVEL="", INTERACT_ACCESS_TOKEN="",
                  FRONTEND_ORIGIN="http://localhost:3100")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

DEMO = [
    ("What is retrieval-augmented generation?",
     "RAG pairs a retriever with a language model. Before answering, the system searches a knowledge base, "
     "usually a vector database of embedded document chunks, and passes the best matches to the model as context.\n\n"
     "That keeps answers grounded in current, private data without retraining the model, and lets you cite sources."),
    ("How would you evaluate a RAG pipeline?",
     "I split it into two parts. For **retrieval**, I check recall@k and MRR against a labelled set of "
     "question-to-chunk pairs. For **generation**, I score faithfulness to the retrieved context and answer "
     "relevance, often with an LLM judge plus human spot checks.\n\n"
     "I also track latency and cost per query, because a pipeline that is accurate but slow will not survive production."),
    ("Explain FastAPI dependency injection.",
     "FastAPI lets an endpoint declare what it needs with `Depends`, and the framework builds and passes those "
     "objects in for each request.\n\n```python\ndef get_db():\n    db = SessionLocal()\n    try:\n        yield db\n"
     "    finally:\n        db.close()\n\n@app.get(\"/users/{user_id}\")\ndef read_user(user_id: int, db = Depends(get_db)):\n"
     "    return db.get(User, user_id)\n```\n\n"
     "The main benefit is testability: in tests you can override `get_db` with a fake without touching the endpoint."),
]
# Uses every kind of Markdown the answer styles cover, for the screenshot tests.
SHOWCASE = [
    ("Explain RAG with an example.", "\n".join([
        "# Retrieval-augmented generation",
        "RAG pairs a **retriever** with a model, using `top_k` chunks and a [reference](https://example.com).",
        "", "## When it helps", "- Fresh or private data", "- Citations with `source` ids",
        "", "1. Embed the documents", "", "2. Search and generate",
        "", "### Watch out for", "> Retrieval quality caps answer quality.",
        "", "#### Example", "```python", "def answer(q):", "    return llm(q, retrieve(q))", "```",
        "", "| Option | Use when |", "| --- | --- |", "| RAG | Data changes often |", "| Fine-tuning | Style or format |",
        "", "---", "That covers it.",
    ])),
    ("Short follow-up?", "Yes: retrieval first, then generation."),
]


def seed():
    with TestClient(main.app):  # startup creates the tables
        pass
    db = sqlite3.connect(DB)
    with db:
        for title, updated_at, pairs in (("Demo interview", None, DEMO),
                                         ("Markdown showcase", "2000-01-01 00:00:00", SHOWCASE)):
            cid = str(uuid.uuid4())
            db.execute("INSERT INTO sessions (id, title) VALUES (?, ?)", (cid, title))
            if updated_at:  # listed last in History
                db.execute("UPDATE sessions SET updated_at=? WHERE id=?", (updated_at, cid))
            for question, answer in pairs:
                db.executemany("INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)",
                               [(cid, "user", question), (cid, "assistant", answer)])
    db.close()


if __name__ == "__main__":
    seed()
    uvicorn.run(main.app, host="127.0.0.1", port=8100, log_level="warning")
