# Ingestion flow

Upload a `.txt` transcript. The server parses speaker turns, packs them into chunks, writes SQLite rows, then embeds those chunks **in parallel with** extracting decisions and action items.

The upload request stays open until ingest finishes, then returns `201 { id, status: ready }`.

## High-level ingestion

```mermaid
flowchart TD
  post["POST /api/meetings"]
  upload[".txt transcript"]
  parse["parseTranscript"]
  chunk["chunkTurns"]
  storeTx["storeTranscript: status = processing"]
  embed["embedChunks"]
  extract["extractFacts"]
  storeEmb["storeEmbeddings: status = ready"]
  storeFacts["storeFacts"]
  created["201 { id, status: ready }"]

  post --> upload --> parse --> chunk --> storeTx
  storeTx --> embed
  storeTx --> extract
  embed --> storeEmb --> storeFacts
  extract --> storeFacts
  storeFacts --> created
```

HTTP entry: [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts). Orchestration: [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `ingestTranscript`.

- The `.txt` transcript is form field `file`. The meeting title is the filename without `.txt`.
- Parse and chunk run **before** any `meetings` row exists.
- Embed and extract start together (embed first). After embeddings commit `ready`, the pipeline waits for extract and writes facts.

## Parsing

```mermaid
flowchart TD
  start["parseTranscript(text)"]
  split["strip BOM, split lines"]
  line["next line"]
  push["push Turn: speaker, timestamp, startSeconds, text"]
  cont["append to the current turn"]
  ok["return turns"]

  start --> split --> line
  line -->|header| push --> line
  line -->|continuation| cont --> line
  line -->|done| ok
```

[`server/src/transcript/parse.ts`](../../server/src/transcript/parse.ts)

Three header forms, first match wins:

- `[00:02:01] Ada: text`
- `Ada (00:02:01): text`
- `00:02:01 Ada: text`

`startSeconds` is derived from the clock. Later non-header lines append to the current turn.

## Chunking

```mermaid
flowchart TD
  start["chunkTurns(turns, maxChars = 2000)"]
  lines["render each turn as [Speaker, timestamp]: text"]
  pack["pack whole turns until the budget"]
  more{"more turns?"}
  done["return chunks"]

  start --> lines --> pack --> more
  more -->|yes| pack
  more -->|no| done
```

[`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts)

Packed `text` looks like:

```
Speakers: Ada, Ben
[Ada, 00:02:01]: …
[Ben, 00:02:15]: …
```

The `Speakers:` line is a roster only. Citations are the `[Speaker, timestamp]:` markers on each turn — the same rendering used at chat time.

- Whole turns only; a turn is never split. When the previous chunk held more than one turn, the next chunk may repeat that last turn.
- `endSeconds` is the last turn's `startSeconds`. `chunkIndex` is `0 .. n-1`.

## Persisting

```mermaid
flowchart TD
  start["storeTranscript"]
  tx["BEGIN IMMEDIATE"]
  meeting["INSERT meetings: processing, model, dimensions, char_count"]
  turns["INSERT turns"]
  chunks["INSERT chunks; chunks_ai fills chunks_fts"]
  commit["COMMIT"]

  start --> tx --> meeting --> turns --> chunks --> commit
```

[`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `storeTranscript`, [`server/src/db/schema.sql`](../../server/src/db/schema.sql)

- `char_count` is `rawText.length`. Chat compares it to `FULL_CONTEXT_CHAR_THRESHOLD`.
- `chunks_fts` is FTS5 over `chunks.text`. The `chunks_ai` trigger indexes each row as it is inserted; ingest does not write FTS itself.

## Embedding

```mermaid
flowchart TD
  start["embedChunks"]
  texts["texts = chunk.text"]
  embed["embed in slices of 128"]
  store["storeEmbeddings: status = ready"]

  start --> texts --> embed --> store
```

[`server/src/llm/embed.ts`](../../server/src/llm/embed.ts) `embed`, [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `embedChunks` / `storeEmbeddings`

- The embedded string is the stored chunk `text` (roster plus turns).
- Slices of `EMBED_BATCH_SIZE` (`128`). `text-embedding-3*` also send `dimensions`. Vectors are L2-normalized, then stored as BLOBs.

## Extracting

```mermaid
flowchart TD
  start["extractFacts"]
  pack["packWindows: 12000 chars, 20% overlap"]
  map["mapPool: JSON extract per window"]
  merge["dedupe; reduce if several windows"]
  facts["return decisions and action items"]

  start --> pack --> map --> merge --> facts
```

[`server/src/extract/window.ts`](../../server/src/extract/window.ts), [`server/src/extract/facts.ts`](../../server/src/extract/facts.ts), [`server/src/llm/chat.ts`](../../server/src/llm/chat.ts) `completeJson`

- Windows are packed from turns (not `chunk.text`), so each utterance still has its clock. Mapped at `EXTRACT_CONCURRENCY` (`8`).
- Duplicate fact text collapses to one row. Several windows may get a follow-up reconcile prompt; a single window skips that.
