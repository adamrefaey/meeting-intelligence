# Meeting Intelligence

Upload a speaker-labeled transcript, then ask questions about **that** meeting’s discussion, decisions, and action items. Chat never mixes meetings.

**Cancel** during ingest aborts the upload and deletes the in-progress meeting. **Stop** (or leaving the meeting) aborts an in-flight answer.

Diagrams and the files that implement them: [docs/flows](docs/flows/README.md).

## Contents

- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Transcript format](#transcript-format)
- [Configuration](#configuration)
- [Docker](#docker)
- [Data](#data)
- [Checks](#checks)

## Screenshots

Empty state — drop or click-select a `.txt` transcript.

![Upload a transcript to start](docs/screenshots/01.png)

Ingest in progress (`Ingesting…`, with **Cancel**).

![Ingesting a transcript](docs/screenshots/02.png)

A ready meeting: extracted **decisions** and **Ask this meeting**.

![Extracted decisions and Ask this meeting](docs/screenshots/03.png)

Transcript plus a cited answer (chips scroll to the turn).

![Transcript with cited chat answers](docs/screenshots/04.png)

## Quick start

Needs [Node.js](https://nodejs.org/) **24+** (pin with [`.nvmrc`](.nvmrc)) and an [OpenAI API key](https://platform.openai.com/api-keys).

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY
npm run dev
```

That installs the `server` and `web` workspaces, then starts both processes. Config is read at process start — restart after changing `.env`.

| Process     | URL                                            | Role                                      |
| ----------- | ---------------------------------------------- | ----------------------------------------- |
| Vite UI     | [http://localhost:5173](http://localhost:5173) | React app. Browser origin.                |
| Fastify API | `http://127.0.0.1:3000`                        | Ingest, SQLite, chat. Bound to loopback.  |

Open **http://localhost:5173**. Vite proxies `/api` to port **3000** (hardcoded in `web/vite.config.ts`).

```bash
curl -s http://localhost:5173/api/health
```

Expect `{"ok":true,"chatModel":"gpt-5.6-luna","embeddingModel":"text-embedding-3-small"}` with the defaults.

### First transcript

1. On **Upload a transcript to start**, drop or click-select [`fixtures/transcripts/planning.txt`](fixtures/transcripts/planning.txt).
2. The drop zone shows **Ingesting…** with **Cancel**. When ingest finishes you get the transcript, extracted **decisions** and **action items**, and **Ask this meeting**.
3. Ask **What are the action items?**

Expect Omar’s storage RFC by Monday, Priya’s workspace mockups by Wednesday, Sam’s soak test by Thursday, and Maya’s legal retention review next Tuesday. Those owners and due days are in the transcript; the model may rephrase.

Eleven samples live in [`fixtures/transcripts/`](fixtures/transcripts/). `standup.txt` and `planning.txt` are tidy one-line-per-turn files; the others read like transcription-service exports (wrapped turns, filler, `[inaudible]`, diarisation failures). Sizes straddle the full-transcript threshold so both chat paths are reachable. Catalog: [`fixtures/README.md`](fixtures/README.md).

## How it works

### Upload

The server parses speaker turns, packs them into ~2000-character chunks, and writes SQLite rows. It then embeds those chunks and extracts decisions and action items **in parallel**, from overlapping ~12k-character windows of the **turns** (a longer turn is sliced). If several windows produced more than one fact, a reconcile pass merges them.

Ingest **always** embeds. If extraction fails, ingest can still return `201`: a `ready` meeting with empty decision and action-item lists. Embed failure or **Cancel** deletes the meeting. There is no `failed` status.

### Ask

Every question is `WHERE meeting_id = ?`. The last `CHAT_HISTORY_TURNS` stored messages (default 8 **rows**, user and assistant mixed) go into the prompt. The question being answered is not among them.

- **Below** `FULL_CONTEXT_CHAR_THRESHOLD` (24000 characters of uploaded text): the model sees the **full transcript**. `planning.txt` takes this path.
- **At or above** that threshold: hybrid retrieval (vector similarity + SQLite FTS, fused) plus the extracted facts.

If stored `embedding_model` / `embedding_dimensions` do not match `.env`, the meeting is reindexed first — retrieval path only. Full-transcript chats skip reindex; those vectors are unused. One vector per chunk; a reindex replaces it.

### Citations

The model copies `[Speaker, timestamp]` from the turn that supports the claim. Chunks use that same marker on each turn and keep clocks off the `Speakers:` header, so a roster line cannot be cited as a greeting.

When the stream **completes**, those markers become chips that scroll to the turn. Only cited markers get a chip. A live full-transcript answer also shows a **Full transcript** badge. Reloaded history still turns markers into chips; it does not restore the badge.

The cited clock is the model’s guess. Before drawing a chip, the web app checks it against the transcript: among that speaker’s turns it picks the one whose words the claim actually shares. That is why “who asked about remote work?” points at Keiko’s question rather than “Hi. Can you hear me?” three seconds earlier.

**Stop** shows **Answer was interrupted**. If the question was already stored, it stays; a partial answer is not saved. Leaving the meeting aborts the same request; the panel unmounts, so that interrupted bubble is gone.

## Transcript format

`.txt` only, up to **5 MiB**. The filename must end in `.txt`. The body is decoded as UTF-8. The form field is `file`; Content-Type must be `text/plain` or empty.

Canonical line:

```text
[HH:MM:SS] Speaker: utterance
```

Also accepted:

```text
[MM:SS] Speaker: utterance
Speaker (HH:MM:SS): utterance
Speaker (MM:SS): utterance
HH:MM:SS Speaker: utterance
```

Bare clocks (no brackets or parentheses) must be three parts (`H:MM:SS` / `HH:MM:SS`). `01:02 Ada: hello` is not a turn header.

A non-header line after the first turn continues that turn. Lines before the first header, and blank lines, are ignored. A file that yields no turns is rejected (`400`). BOM is stripped.

Transcription services wrap a single turn across several lines, breaking on pauses rather than grammar. A phrase can therefore straddle a newline **inside** one turn — the citation grounder matches whole words, so those words still count.

## Configuration

The API loads `../.env` from the `server/` workspace (`--env-file-if-exists`). `.env` is gitignored.

`OPENAI_API_KEY` is required and must be non-empty. Everything else falls back to the defaults below. They match [`.env.example`](.env.example) and `loadConfig`, except `HOST`, which is only in `loadConfig` (and the image).

Chat and embeddings use one official OpenAI SDK client. Point `OPENAI_BASE_URL` at a proxy if you need to; embedding inputs and the assembled chat messages are sent as built.

| Variable                      | Default                     | Role                                              |
| ----------------------------- | --------------------------- | ------------------------------------------------- |
| `OPENAI_BASE_URL`             | `https://api.openai.com/v1` | Chat and embedding HTTP API                       |
| `CHAT_MODEL`                  | `gpt-5.6-luna`              | Fact extraction and answer streaming              |
| `EMBEDDING_MODEL`             | `text-embedding-3-small`    | Chunk and query vectors                           |
| `EMBEDDING_DIMENSIONS`        | `1536`                      | Vector width                                      |
| `DATABASE_PATH`               | `data/app.db`               | SQLite file                                       |
| `FULL_CONTEXT_CHAR_THRESHOLD` | `24000`                     | Full transcript if `char_count` is strictly below |
| `RETRIEVE_K`                  | `8`                         | Max fused chunks in the prompt                    |
| `FTS_K`                       | `8`                         | Limit on the vector and FTS lists                 |
| `CHAT_HISTORY_TURNS`          | `8`                         | Stored message rows in the next prompt            |
| `PORT`                        | `3000`                      | API port (Vite proxies `/api` here)               |
| `HOST`                        | `127.0.0.1`                 | Listen address (`0.0.0.0` in Docker)              |

`char_count` is the uploaded file’s JavaScript string length, stored at ingest.

## Docker

One image serves the **built** web app (`web/dist`) and the Fastify API on port **3000**. SQLite lives on a volume. Pass secrets at run time; they are not baked into the image.

```bash
cp .env.example .env   # set OPENAI_API_KEY
docker compose up --build
```

That uses [`compose.yaml`](compose.yaml). Open **http://localhost:3000**.

```bash
curl -s http://localhost:3000/api/health
```

`HOST=0.0.0.0` is set in the image so the process is reachable from outside the container. Local `npm run dev` still binds `127.0.0.1`.

Without Compose:

```bash
docker build -t meeting-intelligence .
docker run --rm -p 3000:3000 --env-file .env -v meeting-data:/app/data meeting-intelligence
```

## Data

| Path                                    | What                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_PATH` (default `data/app.db`) | SQLite + `sqlite-vec`. Meetings, turns, chunks, embeddings, extracted facts, and chat messages. The API creates the directory on start. |
| `.env`                                  | `OPENAI_API_KEY` and optional overrides.                                                                                                 |

With `npm run dev`, the API cwd is `server/`, so the default file is `server/data/app.db`. In Docker, Compose mounts it at `/app/data/app.db` on a named volume.

Do not commit `data/`, `*.db`, or `.env`.

Chunks are written once, at upload. Nothing re-chunks an existing meeting, so after a change to chunking, citation rendering, or the meetings schema, re-upload the transcript — or delete `server/data/app.db`. Stored answers are history and are never rewritten.

## Checks

```bash
npm test          # Node test runner in each workspace
npm run typecheck
npm run lint
```
