# AI Interact

Interview practice with Gemini: type or say an interview question and get an answer you could
give out loud. Next.js frontend, FastAPI backend, Google Gemini.

- **Interviews:** the app opens on your interviews, latest first and grouped by day, each with
  its role, type, number of questions and the last one asked. Search them, filter by type, and
  from each one's menu open, rename, delete (after confirming) or start a new interview with the
  same setup, to practice again for the same job.
- **New interview:** the role, interview type (Technical, HR or Mixed), answer length, and an
  optional resume (PDF or DOCX, dropped or browsed) and job description for answers to draw on,
  with a summary beside them. The last role, type and length you chose are filled in next time.
  During an interview, the top bar shows only the way back to Interviews and the interview's
  title (click it to rename) and details.
- **Interview:** type or dictate questions (in Chrome) and watch the answers
  stream in. Each question and its answer have a page of their own: a new question opens at the
  top of the answers, alone, and scrolling up brings back earlier ones one at a time. Optional
  auto-stop after a 2.2-second pause, with optional hands-free sending. Focus Mode, font sizes
  and copy buttons.
- **Accurate dictation:** Gemini writes down what you say from a recording, using the role and
  the technical terms in your resume and job description as hints: every word, with punctuation
  and terms like "LangChain", "RAG" or "FastAPI" instead of "lang chain", "rag" or "fast api".
  Chrome's live recognition only shows a preview, in gray: on long, nonstop speech it falls
  behind and drops words. The recording is cut into pieces at short pauses, every 3 to 8 seconds
  (in nonstop speech, at its quietest moment), and each piece goes to Gemini with the end of the
  text so far, so that it carries on from it. Its text joins the box about 1 to 2 seconds later,
  while you keep speaking, and when you stop, only the last piece is left to write down. If you
  press Send while some of the text is still on its way, the question goes with its recording
  instead: one Gemini request writes it down and answers it, so the answer starts about 2 to 3
  seconds after Send. (To check the text before sending, press Stop and wait for the gray words
  to turn black.) Anything you type meanwhile is kept, and a question you typed in is sent as its
  text. If Gemini can't write a piece down (it's unavailable, or it returns more words than anyone
  could say in that time), the piece is tried again with the next one, and then Chrome's words
  for it are used. Given a piece with no one speaking in it (a pause with a fan, typing or music
  in it), Gemini makes up a likely question, so such pieces aren't sent: only those Chrome heard
  words in, or whose sound rises and falls as speech does, and Gemini is asked first whether
  anyone speaks. Turn it off with "Improve the transcript with Gemini as it listens" to use
  Chrome's words alone.
- **Listen to a browser tab:** instead of the microphone, the app can listen to another Chrome
  tab, such as a YouTube video or a Google Meet call. Set "Listen to" to "A browser tab", press
  **Listen to tab**, pick the tab in Chrome's list and keep "Also share tab audio" on. Live words
  and the Gemini transcript work as with the mic, and you still hear the tab. The tab stays shared
  (Chrome shows its sharing bar), so the next Listen to tab doesn't ask again, until you press
  Stop sharing or switch back to the microphone. A tab is written down piece by piece for as
  long as you listen, a whole class if need be; a question is sent with its recording only if
  it's under 2 minutes long, and otherwise waits for its text. Only Chrome tabs are covered: for
  sound from desktop apps (the Zoom app, say), share your whole screen instead, where Chrome may
  offer the computer's sound.
- **Quick answers:** the default model, Gemini 3.5 Flash-Lite, was the quickest and steadiest in
  tests (November 2026): typed questions are answered within about 1 to 2 seconds, and it stalled
  once in about 50 tries, where Gemini 3.1 Flash-Lite often did, for 5 to 30 seconds. Still,
  if a request takes 1.5 times as long as a quick one (at least 1.5 seconds; 2 for a question
  sent as its recording), or returns an error, the backend also sends it to a second model
  (`GEMINI_BACKUP_MODEL`, Gemini 3.1 Flash-Lite) and uses whichever replies first. It runs on
  separate capacity, so it still answers when the main one is stalled. If it refuses (for
  example, a free daily quota is used up), the retry goes to the main model instead, and the
  second model is left alone until Google says to try again. The connection to Gemini
  stays open between questions, so each question doesn't wait for a new one.
- **Saved locally:** interviews are stored in SQLite on this computer.

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
| `GEMINI_MODEL` | The model that writes the answers and writes down dictated questions (default `gemini-3.5-flash-lite`). |
| `GEMINI_THINKING_LEVEL` | Optional, for Gemini 3 models: `minimal`, `low`, `medium` or `high`. Less thinking is faster; leave unset for the model's default. |
| `GEMINI_THINKING_BUDGET` | Optional, the same for older models as a token budget (`0` turns thinking off). |
| `GEMINI_BACKUP_MODEL` | Optional: the model a slow or failed request is also sent to (default `gemini-3.1-flash-lite`). It answers with minimal thinking, so it must be a Gemini 3 model. If it refuses (say, a free-tier daily limit is used up), retries go to `GEMINI_MODEL` until Google says to try again. Set it empty to always retry with `GEMINI_MODEL`. |
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
- `frontend/components/`: the screens and panels (Interviews, New interview, the top bar, the
  question box, the answers).
- `frontend/hooks/`: speech recognition, sharing a tab's sound, the recording and transcript
  improvement, the question draft and the answer pages.
- `frontend/lib/`: the API client and shared types. Styles are in `frontend/app/style.css`.

## Security and limitations

**Single-user local use only by default.** SQLite history and extracted resume text are not
encrypted at rest, and there is no account login or per-user authorization. Do not expose the
backend publicly without authentication, TLS, access controls and secure storage. The optional
`INTERACT_ACCESS_TOKEN` needs a client that sends `X-Interact-Token`; the bundled frontend does
not. Do not put secrets in `NEXT_PUBLIC_` environment variables.

Live dictation needs the browser's SpeechRecognition (Chrome), so availability varies by
browser. With transcript improvement on, everything you dictate is recorded and sent to Gemini
(Chrome's live recognition also sends audio to Google): one request per piece, every 3 to 8
seconds while you speak, and slow requests are sent twice. These count toward your API key's
rate limits and bill. Model names in `.env.example` may need updating to models available to
your API key.

Before updating an existing installation, back up `backend/chat.db`. Database columns are
migrated at startup.
