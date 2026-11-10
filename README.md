# AI Interact

Interview practice with Gemini: type or say an interview question and get an answer you could
give out loud. Next.js frontend, FastAPI backend, Google Gemini.

- **Interviews:** the app opens on your interviews, latest first and grouped by day, each with
  its role, type, number of questions and the last one asked. Search them, filter by type, and
  from each one's menu open, rename, delete (after confirming) or start a new interview with the
  same setup, to practice again for the same job.
- **New interview:** the role, interview type (Technical, HR or Mixed), answer length and style,
  and an optional resume (PDF or DOCX, dropped or browsed) and job description for answers to
  draw on, with a summary beside them. The last role, type, length and style you chose are
  filled in next time.
- **Answer style:** Simple (the default) answers the way you'd explain it to a person: a plain
  first sentence, everyday words, short sentences, technical terms explained, an everyday
  comparison where it helps. Balanced uses the right technical terms in fairly short, plain
  sentences, a step deeper. Technical uses precise terms and more depth, for senior
  interviews. All are written to be said out loud. Change it during an interview too, beside
  the answer length.
- **Answer length:** Short (two to four sentences, about 20 seconds to say), Medium (about 30 to
  60 seconds) or Detailed (with an example and trade-offs). Each answer opens with its main idea
  in a sentence of its own, shown in bold, then short paragraphs, so it's easy to keep your place
  while saying it. Answers are written as speech, with contractions and sentences that follow on
  from each other, and say what you would do ("I'd start by...") rather than claim experience
  or habits your resume doesn't show.
- **Say it again:** under the latest answer, **Shorter** (about half the words), **Simpler**
  (everyday words) and **More detail** (the reasoning, an example and a trade-off) rewrite it,
  keeping its points. The new version takes the old one's place, on screen and in the saved
  interview.
- **Interview:** type or dictate questions (in Chrome) and watch the answers stream in. Enter
  sends a question (Shift+Enter starts a new line). Each question and its answer have a page of
  their own: a new question opens at the top of the answers, alone, and scrolling up brings back
  earlier ones one at a time. Optional auto-stop after a 2.2-second pause, with optional
  hands-free sending. Focus Mode, font sizes and copy buttons. The top bar shows only the way
  back to Interviews and the interview's title (click it to rename) and details.
- **Questions with images:** add a screenshot, a diagram or a photo to a question (Add image,
  paste it into the box, or drop it on the box), up to 4 per question; an image alone can be
  the question, such as a screenshot of a coding problem. Gemini reads the images with the
  question, typed or spoken. Each image uploads as soon as it's added (a big one is shrunk to
  2048 pixels first), so Send doesn't wait for it, and it's saved with the interview and shown
  with the question. The next two questions get the image too, for follow-ups about it.
- **Accurate dictation:** Gemini writes down what you say from a recording, using the role and
  the technical terms in your resume and job description as hints: every word, with punctuation
  and terms like "LangChain", "RAG" or "FastAPI" instead of "lang chain", "rag" or "fast api".
  Chrome's live recognition only shows a preview, in gray: on long, nonstop speech it falls
  behind and drops words. The recording is cut into pieces at short pauses, every 3 to 8 seconds
  (in nonstop speech, at its quietest moment), and each piece goes to Gemini with the end of the
  text so far, so that it carries on from it. Its text joins the box about 1 to 2 seconds later,
  while you keep speaking, and when you stop, only the last piece is left to write down. Once all
  of that text is in, Send sends it as it stands. Press Send sooner, while words are still gray or
  not even heard yet, and the question goes with its recording instead: Gemini writes the whole
  question down in one go (leaving out fillers and false starts) while it answers, so the answer
  starts about 1 to 2 seconds after Send and the question shows its text as soon as it's in. If
  Gemini can't make the question out from the recording but has written it down, it answers the
  question as written down rather than giving up on it. If no one can be heard in the recording
  (you spoke before the microphone had opened, say), the live words are sent as the question
  instead, and with none of those the app says nothing was heard, rather than answering a question
  Gemini made up to fit your resume. After you stop, the microphone stays open for a minute
  without recording (Chrome shows the tab as using it, and the status says so), so the next
  question starts the moment you press the button and no first words are lost. Anything you type
  meanwhile is kept, and a question you typed in or edited is sent as its text, as is a dictation
  of over 2 minutes, once its text is in. If Gemini can't write a piece down (it's unavailable, or it returns more words
  than anyone could say in that time), the piece is tried again with the next one, and then
  Chrome's words for it are used. Given a piece with no one speaking in it (a pause with a fan,
  typing or music in it), Gemini makes up a likely question, so such pieces aren't sent: only those
  Chrome heard words in, or whose sound rises and falls as speech does, and Gemini is asked first
  whether anyone speaks. Turn it off with "Improve the transcript with Gemini as it listens" to use
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
- **Saved in a database:** PostgreSQL (a hosted one, such as Supabase) when `DATABASE_URL` is
  set, and otherwise SQLite, a file on this computer. See [Database](#database).

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
| `DATABASE_URL` | Optional: the PostgreSQL database to keep interviews in, such as `postgresql://USER:PASSWORD@HOST:6543/postgres`. Without it, they're kept in SQLite. |
| `INTERACT_DB` | Optional: the SQLite file to use instead of `backend/chat.db` (when there's no `DATABASE_URL`). |

## Database

Interviews (their settings and resume, questions, answers and images) are kept in **PostgreSQL**
when `DATABASE_URL` is set in `backend/.env`, and otherwise in **SQLite**, in `backend/chat.db`.
The backend makes the tables itself the first time it starts, and `/api/health` says which
database it uses.

To use a free hosted PostgreSQL database on [Supabase](https://supabase.com):

1. Create a project, choosing the region nearest you (for India, Mumbai), and note its database
   password.
2. Press **Connect** and copy the **Transaction pooler** or **Session pooler** connection string
   (both work on any network; the direct one needs IPv6). Put your password in place of
   `[YOUR-PASSWORD]`. A `?pgbouncer=true` at the end is fine.
3. Add it to `backend/.env` as `DATABASE_URL=...` and restart the backend.
4. Copy your existing interviews over, once, from `backend/`:
   `.venv/bin/python copy_to_postgres.py`. It leaves interviews already there alone, so it's
   safe to run again.

Each trip to a database far away is a wait (about 60 ms from India to Mumbai), and it sends data
at about 1 MB a second, so the backend keeps the database out of an interview's way:

- It keeps the interviews in use in memory (each one's settings and last messages) and the
  questions' images. Once an interview is open, its questions and dictation read nothing from
  the database.
- It saves questions, answers and images in the background, in order, so nothing waits for that.
  While the database is out of reach it keeps trying, and the interview goes on meanwhile.
- Opening an interview and the Interviews page read from the database, once what's waiting to be
  saved is.

When the backend stops, it waits up to 10 seconds for anything still waiting to be saved (only
while the database is out of reach would there be any). Changes made to an interview outside
the app, in Supabase's table editor, say, count once you reopen it.

Supabase's web API can reach the tables in a project's public schema with the project's public
key, so the backend turns on row level security on its tables: with no rules, that API gets
nothing from them. The backend connects as their owner, which the rules don't apply to.

A free Supabase project holds up to 500 MB (images take the most room) and is paused after a
week without use. The app then says it can't reach the database, until you resume the project
in Supabase.

## Tests and code checks

Backend, from `backend/` (install the dev tools once with `.venv/bin/python -m pip install -r requirements-dev.txt`):

- `.venv/bin/python -m pytest`: API tests, using a fake Gemini and a throwaway SQLite database.
  `TEST_POSTGRES=1 .venv/bin/python -m pytest` runs them against the PostgreSQL database in
  `DATABASE_URL` instead, in a schema of their own (`ai_interact_tests`) that's dropped
  afterwards, so your interviews there are never touched. That takes a few minutes, as each
  test connects anew.
- `.venv/bin/ruff check .` and `.venv/bin/ruff format .`: lint and format.

Frontend, from `frontend/`:

- `npm test`: browser tests with Playwright, including screenshot comparisons of the main
  screens. Needs Google Chrome. The tests start their own servers on ports 3100 and 8100 with a
  throwaway database, so your interviews are never touched. After an intended visual change,
  refresh the saved screenshots with `npm run test:update-screenshots`.
- `npm run lint`, `npm run format` and `npm run typecheck`.

## Project layout

- `backend/main.py`: the API. Interviews, resume parsing, prompts, and answers streamed from Gemini.
- `backend/database.py`: the database (PostgreSQL or SQLite), and `backend/copy_to_postgres.py`,
  which copies interviews from SQLite to PostgreSQL.
- `frontend/app/page.tsx`: the app's state and the actions that connect the screens.
- `frontend/components/`: the screens and panels (Interviews, New interview, the top bar, the
  question box, the answers).
- `frontend/hooks/`: speech recognition, sharing a tab's sound, the recording and transcript
  improvement, the question draft and the answer pages.
- `frontend/lib/`: the API client and shared types. Styles are in `frontend/app/style.css`.

## Security and limitations

**Single-user local use only by default.** Interviews and extracted resume text are not
encrypted by the app (a hosted database encrypts its disks; keep its connection string, which
holds the password, out of anything shared), and there is no account login or per-user authorization. Do not expose the
backend publicly without authentication, TLS, access controls and secure storage. The optional
`INTERACT_ACCESS_TOKEN` needs a client that sends `X-Interact-Token`; the bundled frontend does
not. Do not put secrets in `NEXT_PUBLIC_` environment variables.

Live dictation needs the browser's SpeechRecognition (Chrome), so availability varies by
browser. With transcript improvement on, everything you dictate is recorded and sent to Gemini
(Chrome's live recognition also sends audio to Google): one request per piece, every 3 to 8
seconds while you speak, two at Send (one writes the question down, one answers it), and slow
requests are sent twice. These count toward your API key's
rate limits and bill. Model names in `.env.example` may need updating to models available to
your API key.

Before updating an existing installation, back up `backend/chat.db` (or your PostgreSQL
database). New tables and columns are added at startup.
