# Ingestion flow

Upload a `.txt` transcript. The server parses speaker turns, packs them into chunks, writes SQLite rows, embeds those chunk strings, then tries to extract decisions and action items.

[`meetings.ts`](../../server/src/routes/meetings.ts) calls [`ingestTranscript`](../../server/src/ingest/pipeline.ts). Parse and chunk run **before** any `meetings` row exists.

Ingest is synchronous: the upload request stays open until the meeting is `ready`, so `processing` is a state only concurrent readers observe.

## High-level ingestion

```mermaid
flowchart TD
  post["POST /api/meetings"]
  parts["readUploadParts: file part named file, optional title field"]
  abortedRead{"skipIfAborted"}
  readFail["mapUploadReadError"]
  tooLarge["413 file too large"]
  tooMany["400 too many files"]
  invalid["400 invalid upload"]
  check{"parts.error / parts.file"}
  badMeta["400 validateUploadMeta message"]
  noFile["400 file is required"]
  ingest["ingestTranscript"]
  parse["parseTranscript"]
  parseFail["throw ParseError: HTTP 400, no meetings row"]
  chunk["chunkTurns"]
  storeTx["storeTranscript TX"]
  processing["meetings.status = processing"]
  embed["embedDocuments(chunk.text)"]
  abortCheck{"signal.throwIfAborted"}
  storeEmb["storeEmbeddings TX"]
  ready["meetings.status = ready, error_message = NULL"]
  extract["extractFacts then storeFacts"]
  abortDel["isAbortError before ready: DELETE FROM meetings"]
  keepReady["isAbortError after ready: keep meeting"]
  failDel["hard-fail before ready: DELETE FROM meetings"]
  doneCheck{"skipIfAborted"}
  noBody["hijack; meeting stays ready, no 201"]
  created["201 { id, status: ready }"]
  http204["204, or hijack if the socket is gone"]
  http500["500 failed to ingest transcript"]

  post --> parts
  parts -->|throws| abortedRead
  abortedRead -->|yes| http204
  abortedRead -->|no| readFail
  readFail -->|FST_REQ_FILE_TOO_LARGE or FST_ERR_CTP_BODY_TOO_LARGE| tooLarge
  readFail -->|FST_FILES_LIMIT or FST_PARTS_LIMIT| tooMany
  readFail -->|any other code| invalid
  parts -->|resolves| check
  check -->|parts.error| badMeta
  check -->|no parts.file| noFile
  check -->|file present| ingest --> parse
  parse -->|turns.length === 0| parseFail
  parse --> chunk --> storeTx --> processing --> embed
  embed -->|isAbortError| abortDel
  embed -->|other throw| failDel
  embed -->|resolves| abortCheck
  abortCheck -->|aborted| abortDel
  abortCheck -->|ok| storeEmb
  storeEmb -->|throw| failDel
  storeEmb --> ready --> extract
  extract -->|isAbortError| keepReady
  extract -->|success or swallowed non-abort| doneCheck
  doneCheck -->|socket gone| noBody
  doneCheck -->|ok| created
  abortDel --> http204
  keepReady --> http204
  failDel --> http500
```

HTTP entry: [`server/src/routes/meetings.ts`](../../server/src/routes/meetings.ts). Orchestration: [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `ingestTranscript`.

- The transcript must arrive as the file part named `file`. `validateUploadMeta` requires a filename ending in `.txt` (case-insensitive) and a MIME type that, after trim and lowercase, is empty, `text/plain`, or starts with `text/plain;`. A failed check becomes `400` with that message; no `file` part at all becomes `400 file is required`.
- `files` is `1`, so only one file part ever reaches the handler. A second file part fails the whole request with `400 too many files`, whatever its fieldname. A lone file part under some other fieldname is drained and ignored, which ends as `400 file is required`.
- Size is not checked in `validateUploadMeta`; it is enforced by `@fastify/multipart` `fileSize` (`5 * 1024 * 1024`) and the route `bodyLimit` (`6 * 1024 * 1024`). `mapUploadReadError` turns whatever `readUploadParts` throws into a response by error code:

| Error code                                             | Response             |
| ------------------------------------------------------ | -------------------- |
| `FST_REQ_FILE_TOO_LARGE`, `FST_ERR_CTP_BODY_TOO_LARGE` | `413 file too large` |
| `FST_FILES_LIMIT`, `FST_PARTS_LIMIT`                   | `400 too many files` |
| anything else                                          | `400 invalid upload` |

- `skipIfAborted` runs before that mapping. When a client disappears mid-upload the socket is destroyed, so the reply is hijacked. The error `@fastify/multipart` throws in that case is `FST_MP_PREMATURE_CLOSE`, which is not an `AbortError`, so a premature close on a socket that is somehow still open falls through the table to `400 invalid upload`. Ingest never starts either way.
- `title` is the optional `title` field, trimmed; a later `title` field overwrites an earlier one. When it is missing or blank the title is `filename.replace(/\.txt$/i, '')`.
- `parseTranscript` runs before `storeTranscript`. Zero turns **throws** `ParseError` (it does not return `[]`). `createMeeting` maps that to 400; no `meetings` row exists yet.
- `storeEmbeddings` sets `status = 'ready'` and `error_message = NULL` **before** fact extraction.
- [`recoverIngestFailure`](../../server/src/ingest/pipeline.ts) does nothing when `meetingId` is unset or when `storeEmbeddings` already committed in this call; otherwise it runs `DELETE FROM meetings WHERE id = ?`. An incomplete ingest (abort **or** hard failure before `ready`) therefore leaves no `meetings` row, while an abort during fact extraction keeps the meeting, which is already searchable.
- The status code still separates those two cases: an abort answers **204** through `skipIfAborted` (or hijacks when the socket is already gone), a hard failure answers **500** `failed to ingest transcript`.
- That recovery `DELETE` is itself best-effort. If it fails the error is swallowed, which leaves a `processing` row behind but still surfaces the original ingest failure to the client.
- After a successful ingest, `skipIfAborted` may omit the `201` if the client is already gone; the meeting stays `ready`.

## Parsing

```mermaid
flowchart TD
  start["parseTranscript(text)"]
  bom["strip leading BOM U+FEFF"]
  split["split on CR?LF"]
  each["for each rawLine"]
  trim["line = rawLine.trim"]
  blank{"line.length === 0"}
  header["matchHeader(line)"]
  bracketed{"BRACKETED"}
  paren{"PAREN"}
  bare{"BARE_HMS"}
  push["push Turn: speaker, timestamp, startSeconds, text"]
  prev{"turns is non-empty"}
  cont["previous.text += newline + line"]
  drop["drop line"]
  done{"turns.length === 0"}
  err["throw ParseError"]
  ok["return turns"]

  start --> bom --> split --> each --> trim --> blank
  blank -->|yes| each
  blank -->|no| header --> bracketed
  bracketed -->|match| push --> each
  bracketed -->|no| paren
  paren -->|match| push --> each
  paren -->|no| bare
  bare -->|match| push --> each
  bare -->|no| prev
  prev -->|yes| cont --> each
  prev -->|no| drop --> each
  each -->|exhausted| done
  done -->|yes| err
  done -->|no| ok
```

[`server/src/transcript/parse.ts`](../../server/src/transcript/parse.ts)

- The three header forms are `[00:02:01] Ada: text` (`BRACKETED`), `Ada (00:02:01): text` (`PAREN`), and `00:02:01 Ada: text` (`BARE_HMS`), tried in that order. First match wins, and the captured speaker is trimmed.
- `BRACKETED` and `PAREN` clocks are `\d{1,2}:\d{2}` with an optional `:\d{2}` (`MM:SS` or `H:MM:SS` / `HH:MM:SS`). `BARE_HMS` is `\d{1,2}:\d{2}:\d{2}` (three parts; hours may be one digit). So `01:02 Ada: hello` is not a turn header — a bare clock needs seconds.
- `startSeconds`: two parts → `minutes * 60 + seconds`; three parts → `hours * 3600 + minutes * 60 + seconds`. The `timestamp` string is stored as written.
- A non-header line before any turn is dropped. After the first turn it is a continuation (`previous.text += '\n' + line`).
- Zero turns → `ParseError` with message `Could not parse speaker labels and timestamps. Expected lines like [HH:MM:SS] Speaker: text`.

## Chunking

```mermaid
flowchart TD
  start["chunkTurns(turns, maxChars = 1800)"]
  empty{"turns.length === 0"}
  none["return empty array"]
  lines["lines[i] = Speaker: text"]
  cursor["cursor = 0"]
  more{"cursor < turns.length"}
  packNext["packNext(cursor, chunks, turns, lines, maxChars)"]
  first{"chunks.length === 0"}
  fromCursor["packFrom(cursor)"]
  multi{"previous.turnEndIndex > previous.turnStartIndex"}
  overlap["packFrom(previous.turnEndIndex)"]
  grew{"overlapped.end >= cursor"}
  toChunk["toChunk; cursor = packed.end + 1"]
  done["return chunks"]

  start --> empty
  empty -->|yes| none
  empty -->|no| lines --> cursor --> more
  more -->|no| done
  more -->|yes| packNext --> first
  first -->|yes| fromCursor --> toChunk
  first -->|no| multi
  multi -->|no| fromCursor --> toChunk
  multi -->|yes| overlap --> grew
  grew -->|yes| toChunk
  grew -->|no| fromCursor --> toChunk
  toChunk --> more
```

[`server/src/transcript/chunk.ts`](../../server/src/transcript/chunk.ts)

- Packed `text` is `` `[${startTimestamp}–${endTimestamp}] ${speakerLabel}\n` `` plus the turn lines joined by `\n`. The dash in the header is en-dash `U+2013`.
- `packFrom` always includes `turns[start]`. Further whole turns are added while `candidateLength <= maxChars`. A single turn longer than `1800` stays one chunk; a turn is never split.
- `candidateLength` = header length + `1` (the newline after the header) + sum of line lengths + `(lineCount - 1)` (newlines between lines).
- `speakerLabel` lists unique speakers in first-seen order, comma-separated (`Ada, Ben`). The same speaker twice does not duplicate the label.
- Overlap: only when the previous chunk covers more than one turn, try starting again at `previous.turnEndIndex`, so the previous chunk's last turn is repeated. Keep that window only if it reaches `overlapped.end >= cursor`, which guarantees at least one new turn and therefore forward progress. A previous chunk holding a single turn skips overlap entirely.
- Example: if chunk 0 covers turns 0–3, `cursor` is 4 and the next window is tried from turn 3. If it fits turn 4 or beyond it is kept (turn 3 appears in both chunks); if turn 3 alone fills the budget, the retry is discarded and chunk 1 starts at turn 4 with no overlap.
- `endSeconds` is the last turn’s `startSeconds`, not an utterance end time.
- `chunkIndex` is `0 .. n-1` in push order.

## Persisting

```mermaid
flowchart TD
  start["storeTranscript"]
  tx["inTransaction: BEGIN IMMEDIATE"]
  meeting["INSERT meetings: processing, embedding_model, embedding_dimensions, char_count = rawText.length"]
  turns["insertRows turns, batches of 100"]
  chunks["insertRowsReturning chunks, batches of 100"]
  fts["chunks_ai: INSERT chunks_fts rowid, text"]
  commit["COMMIT"]
  ids["return meetingId, chunkIds by chunk_index"]

  start --> tx --> meeting --> turns --> chunks --> fts --> commit --> ids
```

[`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `storeTranscript`, [`server/src/db/schema.sql`](../../server/src/db/schema.sql), [`server/src/db/batch.ts`](../../server/src/db/batch.ts)

- `char_count` is `rawText.length`, the JavaScript string length in UTF-16 code units, not bytes. That is the number compared against `FULL_CONTEXT_CHAR_THRESHOLD` at chat time.
- `chunks_fts` is FTS5 `content='chunks'`, `content_rowid='id'`, `tokenize='porter unicode61'`. Ingest never `INSERT`s into `chunks_fts` itself.
- `chunks_ai` runs after each `chunks` row: `INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text)`.
- `chunks_ad` / `chunks_au` keep FTS in sync on delete/update (`INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', ...)`).
- `inTransaction` rejects a Promise-returning callback (the callback must be synchronous).

## Embedding

```mermaid
flowchart TD
  start["embedChunks"]
  map["texts = chunks.map chunk.text"]
  embedCall["embedDocuments(texts)"]
  startAbort["signal.throwIfAborted"]
  empty{"texts.length === 0"}
  skip["return empty array; no HTTP"]
  send["input texts unchanged"]
  loop["for offset = 0; offset < input.length; offset += 128"]
  abortCheck["signal.throwIfAborted"]
  slice["embedSlice input.slice offset, offset+128"]
  dims{"model toLowerCase startsWith text-embedding-3"}
  withDims["pass dimensions: embeddingDimensions"]
  noDims["omit dimensions"]
  create["embeddings.create encoding_format float"]
  sort["sort response.data by index"]
  count{"ordered.length === slice.length"}
  countFail["throw Expected N embeddings, got M"]
  l2["l2Normalize each vector"]
  dim{"vector.length === embeddingDimensions"}
  dimFail["throw EmbeddingDimensionError"]
  more{"offset + 128 < input.length"}
  countAll{"vectors.length === chunks.length"}
  countAllFail["throw Expected N embeddings, got M"]
  store["storeEmbeddings TX"]
  blob["toVectorBlob: Float32Array to Uint8Array"]
  insert["INSERT chunk_embeddings"]
  ready["UPDATE meetings SET status = ready, error_message = NULL"]

  start --> map --> embedCall --> startAbort
  startAbort -->|throw| abortOut["throw"]
  startAbort -->|ok| empty
  empty -->|yes| skip --> countAll
  empty -->|no| send --> loop --> abortCheck
  abortCheck -->|throw| abortOut
  abortCheck -->|ok| slice --> dims
  dims -->|yes| withDims --> create
  dims -->|no| noDims --> create
  create --> sort --> count
  count -->|no| countFail
  count -->|yes| l2 --> dim
  dim -->|no| dimFail
  dim -->|yes| more
  more -->|yes| loop
  more -->|no| countAll
  countAll -->|no| countAllFail
  countAll -->|yes| store --> blob --> insert --> ready
```

[`server/src/llm/embed.ts`](../../server/src/llm/embed.ts) `embedDocuments`, [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `embedChunks` / `storeEmbeddings`, [`server/src/db/client.ts`](../../server/src/db/client.ts) `toVectorBlob`

- The embedded string is the stored chunk `text` (header plus body), not `raw_text`.
- `embed()` calls `signal.throwIfAborted()` **before** the empty check, so an already-aborted signal throws even when `texts` is empty.
- `embedDocuments` and `embedQueries` share `embed()`. Inputs are sent unchanged. `embed()` calls `embedSlice` on windows of `EMBED_BATCH_SIZE` (`128`), so the count check inside `embedSlice` is per slice; `embedChunks` then checks the concatenated length against `chunks.length` again.
- `text-embedding-3*` (case-insensitive) sends `dimensions` on each slice’s create payload.
- Empty `texts` skips the HTTP call and returns `[]`. Ingest never reaches that case: `parseTranscript` throws on zero turns, so `chunkTurns` always returns at least one chunk. The guard exists because `embed()` is shared with reindex and query embedding.
- `storeEmbeddings` also checks `vector.length === config.embeddingDimensions` before insert, then `UPDATE meetings SET status = 'ready', error_message = NULL`.
- Zero-magnitude vectors are returned unchanged by `l2Normalize`.

## Extracting

```mermaid
flowchart TD
  start["extractFacts(llm, input.rawText)"]
  trunc{"transcript.length > 100000"}
  slice["user: truncated-to-100000 notice + Transcript: + slice"]
  full["user: Transcript: + rawText"]
  sys["system: SYSTEM_PROMPT"]
  complete["completeJson"]
  cjAbort["signal.throwIfAborted"]
  extra["extra = chatSampling(model, 0) + response_format json_object"]
  streamed["completions.create stream true"]
  plain["completions.create without stream"]
  content["delta.content or message.content"]
  parse["parseExtractedFacts"]
  parsed{"JSON.parse succeeded"}
  direct["factsFromCandidate on the whole value"]
  usableDirect{"factsFromCandidate defined"}
  scan["for each brace-matched object"]
  container{"has decisions or actionItems array"}
  classify["keep closed decision/action objects"]
  hasInner{"any inner items kept"}
  empty["return empty decisions and actionItems"]
  abort{"isAbortError"}
  rethrow["throw"]
  store["storeFacts"]
  bothEmpty{"no decisions and no action items"}
  noop["return without INSERT"]
  insert["TX: INSERT decisions, INSERT action_items"]

  start --> trunc
  trunc -->|yes| slice --> sys
  trunc -->|no| full --> sys
  sys --> complete --> cjAbort
  cjAbort -->|throw| abort
  cjAbort -->|ok| extra --> streamed
  streamed -->|success| content
  streamed -->|throw non-400| abort
  streamed -->|HTTP 400| plain
  plain -->|success| content
  plain -->|throw| abort
  abort -->|yes| rethrow
  abort -->|no| empty
  content --> parse --> parsed
  parsed -->|yes| direct --> usableDirect
  usableDirect -->|no| empty
  usableDirect -->|yes| store
  parsed -->|no| scan --> container
  container -->|yes| store
  container -->|no| classify --> scan
  scan -->|exhausted| hasInner
  hasInner -->|yes| store
  hasInner -->|no| empty
  empty --> store
  store --> bothEmpty
  bothEmpty -->|yes| noop
  bothEmpty -->|no| insert
```

[`server/src/extract/facts.ts`](../../server/src/extract/facts.ts), [`server/src/llm/chat.ts`](../../server/src/llm/chat.ts) `completeJson`, [`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `storeFacts`

The prompt is built from **`input.rawText`**, not from the concatenated chunk texts:

- Truncation happens when `length > 100_000`; exactly `100_000` is not truncated.
- Truncated user content is `The transcript was truncated to the first 100000 characters.\n\nTranscript:\n` plus the slice. Otherwise it is `Transcript:\n` plus the full text.

`completeJson` ([`server/src/llm/chat.ts`](../../server/src/llm/chat.ts)) makes the request:

- It starts with `signal.throwIfAborted()`, then adds one extra payload: `chatSampling(model, 0)` plus `response_format: json_object`. `chatSampling` omits `temperature` when the model name matches `/^(gpt-5|o1|o3|o4)/i` and otherwise sends `temperature: 0`.
- It tries `stream: true` first and concatenates `delta.content`. Only an `APIError` with status `400` triggers the fallback, one non-streaming call that reads `message.content`. Every other throw, abort included, propagates.
- The `try` wraps the iteration as well as the create call, so a `400` raised part-way through the stream also falls back, discarding whatever was collected.
- If the fallback call fails too, that error propagates; there is no second retry.
- If the SSE iterator hangs, `completeJson` still rejects on abort rather than resolving as empty JSON, because `collectDeltaContent` races the collection against the signal.

`parseExtractedFacts` ([`server/src/extract/facts.ts`](../../server/src/extract/facts.ts)) turns the reply into facts, tolerating a truncated or fenced response:

- First `JSON.parse` the whole text. On failure retry once after stripping a trailing comma, matched only at the very end of the text (`/,(\s*[}\]])$/`), so interior `,}` is never touched.
- If either parse succeeds, the result goes straight to `factsFromCandidate`; `undefined` means empty arrays and **no** brace scan.
- If both fail, scan for brace-matched `{...}` slices. The first slice carrying a `decisions` or `actionItems`/`action_items` array is returned as the whole answer.
- Otherwise each slice is classified on its own, so a truncated response still stores the items that finished. A slice that fails to parse is not skipped over — scanning continues inside it, which is how items nested in a broken container are still found.
- An inner object holding `owner` or `due` is treated as an action item even when it also has `speaker`.
- Unclosed objects are ignored. Nothing closes braces on the model's behalf, which would invent the tail of a cut-off string.
- A clock-shaped `due` (including a bracketed `[00:06:15]`) is stored as `null`; clocks belong in `timestamp`.

Extraction is best-effort, so the pipeline never loses a meeting over it:

- `extractFacts` maps every non-abort throw to `{ decisions: [], actionItems: [] }` and rethrows only `isAbortError`.
- `ingestTranscript` always calls `storeFacts` with that result unless `extractFacts` threw an abort, and `storeFacts` no-ops when both arrays are empty.
- A non-abort throw from `storeFacts` is swallowed and the meeting stays `ready`. An abort is rethrown into `recoverIngestFailure`, which keeps the meeting because embeddings are already committed.

## Status and failure recovery

```mermaid
flowchart TD
  parse["parseTranscript / chunkTurns"]
  noRow["no meetings row yet"]
  store["storeTranscript TX"]
  processing["status = processing"]
  embed["embedDocuments"]
  readyTx["storeEmbeddings TX: status = ready, error_message = NULL"]
  facts["extractFacts / storeFacts"]
  readyStay["status stays ready"]
  outerCatch["recoverIngestFailure"]
  hasId{"meetingId defined"}
  committed{"embeddingsCommitted"}
  del["DELETE FROM meetings WHERE id = ?"]
  keep["leave ready; facts may be empty"]

  parse --> noRow --> store --> processing --> embed
  embed --> readyTx --> facts --> readyStay
  embed -->|throw| outerCatch
  readyTx -->|throw| outerCatch
  facts -->|isAbortError| outerCatch
  outerCatch --> hasId
  hasId -->|no| leave["return; no DB change"]
  hasId -->|yes| committed
  committed -->|yes| keep
  committed -->|no| del
```

[`server/src/ingest/pipeline.ts`](../../server/src/ingest/pipeline.ts) `ingestTranscript`, `recoverIngestFailure`

- `signal.throwIfAborted()`, `parseTranscript`, and `chunkTurns` run **outside** the try, so failure there never calls `recoverIngestFailure` (no row yet). `throwIfAborted` after `storeTranscript` and after `embedChunks` is inside the try; abort then deletes the meeting.
- `processing` is visible while embeddings are in flight (after the first transaction commits).
- `ready` is set in the embeddings transaction, even when facts are empty or extraction later fails without aborting.
- `openDb` sets `PRAGMA foreign_keys = ON`. `DELETE FROM meetings` cascades turns, chunks, embeddings, facts, and messages. Nothing in the code ever writes `status = 'error'`, so a failed ingest never leaves an `error` stub even though the schema allows that value.
- Abort after `storeEmbeddings` skips that delete: the meeting stays `ready` even if fact extraction is cancelled.
- `recoverIngestFailure` swallows a failing `DELETE`, so it never masks the original ingest error with one of its own.
