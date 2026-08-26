# Ingestion and retrieval flows

These diagrams describe what the server does today. The source of truth is the TypeScript under [`server/src/`](../../server/src/).

Chat is always scoped to one `meeting_id`. There is no cross-meeting index or search.

Chat and embeddings go through one official OpenAI SDK client (`createLlm` in [`server/src/llm/client.ts`](../../server/src/llm/client.ts)), using `OPENAI_BASE_URL` (default `https://api.openai.com/v1`). Document and query strings are sent unchanged.

## How to read

- [Ingestion](ingestion.md) — upload a transcript, parse, chunk, persist, then embed and extract facts in parallel.
- [Retrieval](retrieval.md) — answer a question about one meeting: full-transcript short-circuit, optional reindex, hybrid retrieve, prompt, stream.

Each page starts with one high-level diagram, then one diagram per process. Under every diagram is the implementing file.

Branch labels use the condition in code (`char_count < FULL_CONTEXT_CHAR_THRESHOLD`), not a paraphrase.

## Cancellation

Both flows thread one `AbortSignal` from the route down to the SDK, so the same three helpers drive the abort wording on both pages ([`server/src/routes/http.ts`](../../server/src/routes/http.ts), [`server/src/abort.ts`](../../server/src/abort.ts)):

- `clientDisconnectSignal(reply)` aborts at once if `reply.raw` is already destroyed, otherwise on its `close` event. `close` means the client left **or** the response finished, so the signal is only meaningful while a handler is still running.
- `isAbortError(error)` is true for an `Error` named `AbortError` or `APIUserAbortError`, and nothing else.
- `skipIfAborted(reply, error?)` ends a request without a normal body. A destroyed socket wins and the reply is hijacked; otherwise an abort error answers **204**. Both act only when nothing has been sent yet, and the function returns `true` whenever the caller should stop.

That **204** only exists before a response has started. Once the chat route has begun its SSE response the status is already `200`, so an abort there simply stops the stream: no further events and no `done`.

## Code map

| Process              | Implementation                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP ingest          | [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts), multipart in [`server/src/app.ts`](../../server/src/app.ts)                                                                                        |
| Orchestration        | [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `ingestTranscript`                                                                                                                                  |
| Parsing              | [`server/src/transcript/parse.ts`](../../server/src/transcript/parse.ts)                                                                                                                                                   |
| Chunking             | [`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts)                                                                                                                                                   |
| FTS index            | [`server/src/db/schema.sql`](../../server/src/db/schema.sql) `chunks_fts` + `chunks_ai` / `chunks_ad` / `chunks_au`                                                                                                        |
| LLM client           | [`server/src/llm/client.ts`](../../server/src/llm/client.ts) `createLlm` (one `OpenAI` instance)                                                                                                                           |
| Embedding            | [`server/src/llm/embed.ts`](../../server/src/llm/embed.ts) `embedDocuments`                                                                                                                                                |
| Extracting           | [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts), windows in [`server/src/extract/window.ts`](../../server/src/extract/window.ts), JSON chat in [`server/src/llm/chat.ts`](../../server/src/llm/chat.ts) |
| HTTP chat            | [`server/src/routes/chat.ts`](../../server/src/routes/chat.ts)                                                                                                                                                             |
| Answer orchestration | [`server/src/rag/chat.ts`](../../server/src/rag/chat.ts) `answerQuestion`                                                                                                                                                  |
| Retrieving           | [`server/src/rag/retrieve.ts`](../../server/src/rag/retrieve.ts)                                                                                                                                                           |
| Vector SQL           | [`server/src/db/client.ts`](../../server/src/db/client.ts) `cosineQuery`                                                                                                                                                   |
| Fusing               | [`server/src/rag/fuse.ts`](../../server/src/rag/fuse.ts)                                                                                                                                                                   |
| Prompting            | [`server/src/rag/prompt.ts`](../../server/src/rag/prompt.ts)                                                                                                                                                               |
| Reindexing           | [`server/src/rag/chat.ts`](../../server/src/rag/chat.ts) `reindexMeeting`                                                                                                                                                  |

## Constants

Env knobs that change these flows. The defaults are the same in [`.env.example`](../../.env.example) and [`server/src/config.ts`](../../server/src/config.ts); `OPENAI_API_KEY` is required and has no default.

| Name                          | Default                  | Used for                                         |
| ----------------------------- | ------------------------ | ------------------------------------------------ |
| `CHAT_MODEL`                  | `gpt-5-mini`             | fact extraction JSON and answer streaming        |
| `EMBEDDING_MODEL`             | `text-embedding-3-small` | chunk and query vectors; staleness check         |
| `EMBEDDING_DIMENSIONS`        | `1536`                   | vector width; staleness check                    |
| `FULL_CONTEXT_CHAR_THRESHOLD` | `24000`                  | full transcript instead of retrieval             |
| `FTS_K`                       | `8`                      | `LIMIT` on **both** the lexical and vector lists |
| `RETRIEVE_K`                  | `8`                      | how many fused hits reach the prompt             |
| `CHAT_HISTORY_TURNS`          | `8`                      | history message rows loaded per answer           |

Code (not env):

| Name                             | Value             | File                                                                     |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| `DEFAULT_MAX_CHARS`              | `2000`            | [`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts) |
| `WINDOW_MAX_CHARS`               | `12_000`          | [`server/src/extract/window.ts`](../../server/src/extract/window.ts)     |
| `WINDOW_OVERLAP_RATIO`           | `0.2`             | [`server/src/extract/window.ts`](../../server/src/extract/window.ts)     |
| `EXTRACT_CONCURRENCY`            | `8`               | [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts)       |
| `MERGE_MAX_CHARS`                | `60_000`          | [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts)       |
| `DEFAULT_RRF_K`                  | `60`              | [`server/src/rag/fuse.ts`](../../server/src/rag/fuse.ts)                 |
| `INSERT_BATCH_SIZE`              | `100`             | [`server/src/db/batch.ts`](../../server/src/db/batch.ts)                 |
| `EMBED_BATCH_SIZE`               | `128`             | [`server/src/llm/embed.ts`](../../server/src/llm/embed.ts)               |
| OpenAI client `maxRetries`       | `0`               | [`server/src/llm/client.ts`](../../server/src/llm/client.ts)             |
| Multipart `fileSize`             | `5 * 1024 * 1024` | [`server/src/app.ts`](../../server/src/app.ts)                           |
| Multipart `files`                | `1`               | [`server/src/app.ts`](../../server/src/app.ts)                           |
| `POST /api/meetings` `bodyLimit` | `6 * 1024 * 1024` | [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts)   |
| `requestTimeout`                 | `600_000`         | [`server/src/app.ts`](../../server/src/app.ts)                           |

`maxRetries: 0` means the SDK never retries by itself, so a single failed embedding call fails the whole ingest.

`shouldUseFullTranscript(charCount, threshold)` is `charCount < threshold` (`23999` with `24000` is true; `24000` is false).
