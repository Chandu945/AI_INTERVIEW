# AI Interact V4 (development build)

Next.js frontend + FastAPI backend + Gemini. Separate **New Interview**, **Interview**, and **History** views. No bookmark feature.

## Setup on macOS

Backend:
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Edit .env to set GEMINI_API_KEY and a valid GEMINI_MODEL
uvicorn main:app --reload --port 8000
```

Frontend (second terminal):
```bash
cd frontend
cp .env.local.example .env.local
npm install
npm run dev
```

Visit http://localhost:3000. Set `NEXT_PUBLIC_API_URL=http://localhost:8000` if necessary.

## V4 changes

- Streaming Gemini answers; recent-message context and relevant resume extraction to reduce unnecessary prompt size.
- More natural candidate-style answers and question-type-specific formatting for code, architecture, and comparisons.
- Better follow-up context; the last 10 messages are sent to Gemini.
- Optional job description pasted during new interview setup; resume upload remains optional and session-specific.
- Optional 2.2-second voice-pause stop (does **not** automatically send; review transcript first); technical transcription vocabulary guidance.
- Focus Mode, larger font options, retry button after failed streaming, microphone permission errors.
- Local SQLite session history, session rename/delete, and optional `INTERACT_ACCESS_TOKEN` backend gate.

## Security and limitations

**Single-user local development only by default.** SQLite history and extracted resume text are not encrypted at rest; there is no account login or per-user authorization. Do not expose the backend publicly without authentication, TLS, access controls, and secure storage. The optional `INTERACT_ACCESS_TOKEN` requires a client that sends `X-Interact-Token`; the bundled browser UI does not implement token login. Do not place secrets in `NEXT_PUBLIC_` environment variables.

The voice pause detector uses the browser's SpeechRecognition events, so its accuracy and browser availability vary. Gemini model names in `.env.example` may need updating to models available to your API key. The implementation has not been validated end-to-end against a live Gemini API.

Before updating an existing installation, back up `backend/chat.db`. Existing database columns are migrated at startup.
