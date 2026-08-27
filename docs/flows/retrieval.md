# Retrieval flow

Retrieval runs inside `POST /api/meetings/:id/chat` → [`answerQuestion`](../../server/src/rag/chat.ts).

Every query is limited to the open meeting. Short meetings (`char_count < FULL_CONTEXT_CHAR_THRESHOLD`) skip retrieval and send the full transcript instead.

## High-level retrieval

```mermaid
flowchart TD
  post["POST /api/meetings/:id/chat"]
  load["load ready meeting"]
  useFull{"char_count < FULL_CONTEXT_CHAR_THRESHOLD"}
  retrieve["retrieveForMeeting"]
  facts["load decisions, action items, history"]
  prompt["buildChatMessages"]
  persistUser["INSERT user message"]
  context["SSE context"]
  tokens["SSE token"]
  persistAsst["INSERT assistant message"]
  doneEvent["SSE done"]

  post --> load --> useFull
  useFull -->|yes| facts
  useFull -->|no| retrieve --> facts
  facts --> prompt --> persistUser --> context --> tokens --> persistAsst --> doneEvent
```

HTTP: [`server/src/routes/chat.ts`](../../server/src/routes/chat.ts). Orchestration: [`server/src/rag/chat.ts`](../../server/src/rag/chat.ts) `answerQuestion`.

- `body.message` is a non-empty string. The meeting must exist and be `ready`.
- Both paths load decisions, action items, and recent history. Full transcript: stored turns go on the **system** message. Hybrid retrieve: excerpts go on the **user** message.
- History is loaded **before** the current user row is inserted, so a question is never part of its own history.
- SSE events: `context` (`{ useFullTranscript }`), then `token` (`{ text }`), then `done`. Citations are inline in the answer; retrieved chunks are not sent on the wire.

## Retrieving

```mermaid
flowchart TD
  start["retrieveForMeeting"]
  vec["embed query, nearest FTS_K by cosine"]
  lex["FTS MATCH, bm25 top FTS_K"]
  rrf["reciprocalRankFusion"]
  top["slice 0, RETRIEVE_K"]
  load["load those chunks"]

  start --> vec
  start --> lex
  vec --> rrf
  lex --> rrf --> top --> load
```

[`server/src/rag/retrieve.ts`](../../server/src/rag/retrieve.ts)

The query embedding runs while the FTS query executes. Both lists use `LIMIT` `FTS_K` (default `8`); `RETRIEVE_K` trims the fused list.

- **Lexical:** quote each token from the question, join with `OR`, and rank by bm25 within this meeting.
- **Vector:** embed the query string unchanged, L2-normalize, then nearest `chunk_embeddings` for this meeting (cosine distance, lowest first).

## Fusing

```mermaid
flowchart TD
  start["reciprocalRankFusion, k = 60"]
  add["each list: score += 1 / (k + index + 1)"]
  sort["sort score descending"]
  out["fused ids"]

  start --> add --> sort --> out
```

[`server/src/rag/fuse.ts`](../../server/src/rag/fuse.ts)

An id that appears in both lists gets both contributions. `index` is 0-based, so first place is `1 / 61`.

## Prompting

```mermaid
flowchart TD
  start["buildChatMessages"]
  sys["system: rules, title, decisions, action items"]
  full{"useFullTranscript"}
  sysTranscript["system += full transcript"]
  sysExcerpt["system += excerpt rules"]
  userFull["user = question"]
  userChunks["user = excerpts + question"]
  msgs["system, then history, then user"]

  start --> sys --> full
  full -->|yes| sysTranscript --> userFull --> msgs
  full -->|no| sysExcerpt --> userChunks --> msgs
```

[`server/src/rag/prompt.ts`](../../server/src/rag/prompt.ts)

- System always includes the rules, title, decisions, and action items. On the full-transcript path it also includes the stored turns rendered as `[Speaker, timestamp]: text`.
- Retrieved path: excerpt rules on the system message, excerpt text on the user message.
