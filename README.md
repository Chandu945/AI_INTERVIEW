# AI Interact

Interview practice with Gemini: type or say an interview question and get an answer you could
give out loud. Next.js frontend, FastAPI backend, Google Gemini.

- **New Interview:** target role, interview type (Technical, HR or Mixed), answer length, and an
  optional resume (PDF or DOCX) and job description for answers to draw on.
- **Interview:** type or dictate questions (Chrome's speech recognition) and watch the answers
  stream in. Optional auto-stop after a 2.2-second pause, with optional hands-free sending.
  Focus Mode, font sizes and copy buttons.
- **More accurate dictation:** while you dictate, the app also records the microphone. When you
  stop, Gemini transcribes the recording again, using the role and the technical terms in your
  resume and job description as hints, and its version replaces the live words: proper
  punctuation and terms like "LangChain", "RAG" or "FastAPI" instead of "lang chain", "rag" or
  "fast api". To save time, the recording is already sent whenever you pause, so the corrected
  text is usually ready by the time you stop. Anything you typed meanwhile is never overwritten;
  if Gemini is unavailable or its text doesn't match what was heard, the live words stay. Turn it
  off with "Improve the transcript with Gemini when you stop".
- **Quick answers:** Gemini usually starts answering in 1 to 3 seconds, but now and then stalls
  for 10 to 30. If an answer hasn't started within a few seconds (twice as long as a quick
  reply, at least 3 seconds), or Gemini returns an error, the backend also sends the question to
  a second model (`GEMINI_BACKUP_MODEL`) and uses whichever replies first; the same goes for
  transcriptions. The second model runs on separate capacity, so it still answers when the main
  one is stalled. If it refuses (for example, its free daily quota is used up), the retry goes to
  the main model instead, and the second model is left alone until Google says to try again. The connection to Gemini stays open between questions, so each question doesn't
  wait for a new one.
- **History:** reopen, search, rename or delete past interviews, stored locally in SQLite.

## First-time setup (macOS)

Backend:

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env   # then edit .env: set GEMINI_API_KEY and GEMINI_MODEL
```

Frontend:

```bash
cd frontend
npm install
```

## Running it

From the project folder:

- `./start.sh`: for everyday use. Builds the optimized frontend, then serves it at
  http://localhost:3000 with the backend on port 8000.
- `./dev.sh`: while changing code. Both servers reload when you save (the frontend uses Turbopack).

Ctrl+C stops both servers. The frontend calls the backend at http://localhost:8000; to change
that, set `NEXT_PUBLIC_API_URL` in `frontend/.env.local` (see `frontend/.env.local.example`).

## Settings (`backend/.env`)

| Setting | What it does |
| --- | --- |
| `GEMINI_API_KEY` | Your Gemini API key (required). |
| `GEMINI_MODEL` | The model that writes the answers and improves dictated questions (default `gemini-3.1-flash-lite`). |
| `GEMINI_THINKING_LEVEL` | Optional, for Gemini 3 models: `minimal`, `low`, `medium` or `high`. Less thinking is faster; leave unset for the model's default. |
| `GEMINI_THINKING_BUDGET` | Optional, the same for older models as a token budget (`0` turns thinking off). |
| `GEMINI_BACKUP_MODEL` | Optional: the model a slow or failed request is also sent to (default `gemini-3.5-flash`). It answers with minimal thinking, so it must be a Gemini 3 model. On the free tier it allows only 20 requests a day; when they run out, retries go to `GEMINI_MODEL` until the quota resets. Set it empty to always retry with `GEMINI_MODEL`. |
| `FRONTEND_ORIGIN` | Where the frontend runs, for CORS (default `http://localhost:3000`). |
| `INTERACT_ACCESS_TOKEN` | Optional: require an `X-Interact-Token` header on API calls. The bundled frontend doesn't send one. |
| `INTERACT_DB` | Optional: a database file to use instead of `backend/chat.db`. |

## Tests and code checks

Backend, from `backend/` (install the dev tools once with `.venv/bin/python -m pip install -r requirements-dev.txt`):

- `.venv/bin/python -m pytest`: API tests, using a fake Gemini and a throwaway database.
- `.venv/bin/ruff check .` and `.venv/bin/ruff format .`: lint and format.

Frontend, from `frontend/`:

- `npm test`: browser tests with Playwright, including screenshot comparisons of the main
  screens. Needs Google Chrome. The tests start their own servers on ports 3100 and 8100 with a
  throwaway database, so your interviews are never touched. After an intended visual change,
  refresh the saved screenshots with `npm run test:update-screenshots`.
- `npm run lint`, `npm run format` and `npm run typecheck`.

## Project layout

- `backend/main.py`: the API. Interviews, resume parsing, prompts, and answers streamed from Gemini.
- `frontend/app/page.tsx`: the app's state and the actions that connect the screens.
- `frontend/components/`: the screens and panels (New Interview, History, the question box,
  the answers).
- `frontend/hooks/`: speech recognition, the microphone recording and transcript improvement,
  the question draft and answer scrolling.
- `frontend/lib/`: the API client and shared types. Styles are in `frontend/app/style.css`.

## Security and limitations

**Single-user local use only by default.** SQLite history and extracted resume text are not
encrypted at rest, and there is no account login or per-user authorization. Do not expose the
backend publicly without authentication, TLS, access controls and secure storage. The optional
`INTERACT_ACCESS_TOKEN` needs a client that sends `X-Interact-Token`; the bundled frontend does
not. Do not put secrets in `NEXT_PUBLIC_` environment variables.

The voice pause detection relies on the browser's SpeechRecognition events, so its accuracy and
availability vary by browser. With transcript improvement on, each dictated question's recording
is sent to Gemini (Chrome's live recognition also sends audio to Google). Each dictation makes one
or more extra Gemini requests (one per pause), and slow requests are sent twice; these count
toward your API key's rate limits. Model names in `.env.example` may need updating to models
available to your API key.

Before updating an existing installation, back up `backend/chat.db`. Database columns are
migrated at startup.
