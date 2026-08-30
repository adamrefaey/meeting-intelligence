# Ingestion and retrieval flows

What the server does on the happy path. The source of truth is the TypeScript under [`server/src/`](../../server/src/).

Chat is always scoped to one `meeting_id`. FTS and vector lookups are limited to that meeting.

Chat and embeddings go through one OpenAI SDK client (`createLlm` in [`server/src/llm/client.ts`](../../server/src/llm/client.ts)), using `OPENAI_BASE_URL` (default `https://api.openai.com/v1`).

## How to read

- [Ingestion](ingestion.md) — upload a transcript, parse, chunk, persist, then embed and extract facts in parallel.
- [Retrieval](retrieval.md) — answer a question about one meeting: full transcript or hybrid retrieve, then prompt and stream.

Each page starts with one high-level diagram, then one diagram per process. Under every diagram is the implementing file.

## Code map

| Process              | Implementation                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP ingest          | [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts), multipart in [`server/src/app.ts`](../../server/src/app.ts)                                                                                        |
| Orchestration        | [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `ingestTranscript`                                                                                                                                  |
| Parsing              | [`server/src/transcript/parse.ts`](../../server/src/transcript/parse.ts)                                                                                                                                                   |
| Chunking             | [`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts)                                                                                                                                                   |
| FTS index            | [`server/src/db/schema.sql`](../../server/src/db/schema.sql) `chunks_fts`                                                                                                                                                  |
| LLM client           | [`server/src/llm/client.ts`](../../server/src/llm/client.ts) `createLlm`                                                                                                                                                   |
| Embedding            | [`server/src/llm/embed.ts`](../../server/src/llm/embed.ts) `embed`                                                                                                                                                         |
| Extracting           | [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts), windows in [`server/src/extract/window.ts`](../../server/src/extract/window.ts), JSON chat in [`server/src/llm/chat.ts`](../../server/src/llm/chat.ts) |
| HTTP chat            | [`server/src/routes/chat.ts`](../../server/src/routes/chat.ts)                                                                                                                                                             |
| Answer orchestration | [`server/src/rag/chat.ts`](../../server/src/rag/chat.ts) `answerQuestion`                                                                                                                                                  |
| Reindexing           | [`server/src/rag/reindex.ts`](../../server/src/rag/reindex.ts) `reindexMeeting`                                                                                                                                            |
| Retrieving           | [`server/src/rag/retrieve.ts`](../../server/src/rag/retrieve.ts)                                                                                                                                                           |
| Vector SQL           | [`server/src/db/client.ts`](../../server/src/db/client.ts) `cosineQuery`                                                                                                                                                   |
| Fusing               | [`server/src/rag/fuse.ts`](../../server/src/rag/fuse.ts)                                                                                                                                                                   |
| Prompting            | [`server/src/rag/prompt.ts`](../../server/src/rag/prompt.ts)                                                                                                                                                               |

## Constants

Env knobs that change these flows. Defaults match [`.env.example`](../../.env.example) and [`server/src/config.ts`](../../server/src/config.ts). `OPENAI_API_KEY` is required and has no default.

| Name                          | Default                  | Used for                                  |
| ----------------------------- | ------------------------ | ----------------------------------------- |
| `CHAT_MODEL`                  | `gpt-5.6-luna`           | fact extraction JSON and answer streaming |
| `EMBEDDING_MODEL`             | `text-embedding-3-small` | chunk and query vectors                   |
| `EMBEDDING_DIMENSIONS`        | `1536`                   | vector width                              |
| `FULL_CONTEXT_CHAR_THRESHOLD` | `24000`                  | full transcript instead of retrieval      |
| `FTS_K`                       | `8`                      | `LIMIT` on the lexical and vector lists   |
| `RETRIEVE_K`                  | `8`                      | max fused hits passed to the prompt       |
| `CHAT_HISTORY_TURNS`          | `8`                      | history message rows loaded per answer    |

Code (not env):

| Name                       | Value             | File                                                                     |
| -------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `DEFAULT_MAX_CHARS`        | `2000`            | [`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts) |
| `WINDOW_MAX_CHARS`         | `12_000`          | [`server/src/extract/window.ts`](../../server/src/extract/window.ts)     |
| `WINDOW_OVERLAP_RATIO`     | `0.2`             | [`server/src/extract/window.ts`](../../server/src/extract/window.ts)     |
| `EXTRACT_CONCURRENCY`      | `8`               | [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts)       |
| `DEFAULT_RRF_K`            | `60`              | [`server/src/rag/fuse.ts`](../../server/src/rag/fuse.ts)                 |
| `INSERT_BATCH_SIZE`        | `100`             | [`server/src/db/batch.ts`](../../server/src/db/batch.ts)                 |
| `EMBED_BATCH_SIZE`         | `128`             | [`server/src/llm/embed.ts`](../../server/src/llm/embed.ts)               |
| Multipart `fileSize`       | `5 * 1024 * 1024` | [`server/src/app.ts`](../../server/src/app.ts)                           |
| `POST /api/meetings` limit | `6 * 1024 * 1024` | [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts)   |
