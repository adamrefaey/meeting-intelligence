# Transcript fixtures

Sample transcripts for manual testing. Every file is written to read like an export from a real transcription service — Otter, Rev, Zoom, Whisper — rather than a tidy script, so extraction and retrieval are exercised against the kind of input the product actually receives.

Sizes are deliberate. The set straddles `FULL_CONTEXT_CHAR_THRESHOLD` and `DEFAULT_MAX_CHARS` so each code path is reachable by uploading a file. `all-hands-marathon.txt` is the only fixture large enough to force several overlapping extract windows. See [Limits](#limits).

## How to test with them

```bash
npm run dev
```

1. Drop a file from [`transcripts/`](transcripts/) on the empty state ("Upload a transcript to start").
2. Open the meeting. Check the extracted decisions and action items against the "Try asking" answer below — every owner and due date listed here is stated in the transcript.
3. Ask the suggested question. Follow the citations back to the transcript gutter and confirm the cited turn actually supports the claim.

Upload more than one and switch between meetings: chat is scoped to a single `meeting_id`, so an answer must never cite a chunk from another meeting.

The strongest test of that is deliberate. `customer-interview.txt` and `all-hands-marathon.txt` feature the same customer, Liam, telling the same story — the Monday transaction volume export, the spreadsheet his director actually reads, the website he pastes JSON into. The two accounts share about 3% of their six-word sequences, so the chunks embed close together. Upload both, then ask the marathon _what does Liam paste his data into?_ and check the citation lands in the marathon rather than the interview. Two fixtures that share no vocabulary cannot catch a scoping bug; these can.

To compare the two chat paths, upload [`customer-interview.txt`](transcripts/customer-interview.txt) and [`solo-keynote.txt`](transcripts/solo-keynote.txt). They sit **309 characters apart** on either side of the threshold, so the first is answered from the full transcript and the second from retrieved chunks. That gap is tight on purpose — adding a couple of sentences to the interview flips it onto the retrieval path.

## Reading like a real export

Machine transcription does not produce one tidy line per turn, and the fixtures do not either. Every file except `standup.txt` and `planning.txt` carries the artifacts that real exports have:

- **Turns wrap mid-sentence.** Between 29% and 78% of turns span several lines, because transcription services break on pauses rather than on grammar. Each of those extra lines exercises the parser's continuation branch, where a line with no speaker header is appended to the previous turn.
- **People speak like people.** False starts, "uh", repeated words ("That's, uh, that's the open question"), sentences abandoned halfway, and answers that arrive several turns after the question.
- **Audio fails.** `[laughs]` appears in every wrapped fixture, `[inaudible]` in four of them, and `[crosstalk]` in `sprint-retrospective.txt` where people talk over each other.
- **Diarisation fails.** `town-hall-qna.txt` attributes turns to `Unknown Speaker` and `Conference Room B`, which is what happens with an unlabelled room microphone.
- **Nobody reads code aloud.** Technical detail is spoken, not pasted. In `technical-war-room.txt` an engineer reads an error off a dashboard as "it says type error, cannot read properties of undefined, and then in brackets it says reading street line one", and the call stack becomes "it's coming out of the address serialiser, which gets called by the order serialiser, which gets called from the orders controller". A test in [`fixtures.test.ts`](../server/test/fixtures.test.ts) fails the suite if a stack frame, SQL statement, JSON payload, or `snake_case` identifier ever reappears in a fixture.

## The fixtures

`Chat path` is `full` when `char_count < FULL_CONTEXT_CHAR_THRESHOLD` (`24000`), otherwise hybrid retrieval runs. `Wrapped` is the share of turns spanning more than one line.

| File                                                                         | Format            | Chars   | Turns | Chunks | Speakers | Wrapped | Chat path |
| ---------------------------------------------------------------------------- | ----------------- | ------- | ----- | ------ | -------- | ------- | --------- |
| [`standup.txt`](transcripts/standup.txt)                                     | `[HH:MM:SS]`      | 834     | 15    | 1      | 3        | 0%      | full      |
| [`planning.txt`](transcripts/planning.txt)                                   | `[HH:MM:SS]`      | 2,398   | 40    | 2      | 4        | 0%      | full      |
| [`customer-interview.txt`](transcripts/customer-interview.txt)               | `Speaker (MM:SS)` | 23,940  | 295   | 13     | 2        | 43%     | full      |
| [`solo-keynote.txt`](transcripts/solo-keynote.txt)                           | `Speaker (MM:SS)` | 24,249  | 161   | 13     | 1        | 78%     | retrieval |
| [`security-architecture-rfc.txt`](transcripts/security-architecture-rfc.txt) | bare `HH:MM:SS`   | 24,668  | 280   | 14     | 4        | 48%     | retrieval |
| [`sprint-retrospective.txt`](transcripts/sprint-retrospective.txt)           | `[HH:MM:SS]`      | 24,831  | 398   | 14     | 5        | 29%     | retrieval |
| [`town-hall-qna.txt`](transcripts/town-hall-qna.txt)                         | `[HH:MM:SS]`      | 24,894  | 268   | 14     | 18       | 51%     | retrieval |
| [`incident-postmortem.txt`](transcripts/incident-postmortem.txt)             | `[HH:MM:SS]`      | 25,143  | 284   | 14     | 5        | 46%     | retrieval |
| [`executive-budget-review.txt`](transcripts/executive-budget-review.txt)     | `[MM:SS]`         | 25,552  | 312   | 15     | 5        | 42%     | retrieval |
| [`technical-war-room.txt`](transcripts/technical-war-room.txt)               | bare `HH:MM:SS`   | 28,346  | 350   | 16     | 4        | 44%     | retrieval |
| [`all-hands-marathon.txt`](transcripts/all-hands-marathon.txt)               | `[HH:MM:SS]`      | 106,337 | 1,198 | 60     | 9        | 54%     | retrieval |

## What each one is for

### `standup.txt`

Three engineers, three minutes, no decisions. The smallest valid upload: it fits in a single chunk, so chunking is a no-op and the whole transcript goes into the prompt. Written one line per turn, as a hand-typed note would be, which is the baseline the wrapped fixtures are contrasted against.

**Try asking:** _What is everyone working on?_ — Ada is shipping the health endpoint, Ben is finishing the `sqlite-vec` load in the db client, Chen is reading the ingest notes.

### `planning.txt`

Q3 planning with four speakers. Decisions are stated explicitly ("we are locking it") and each follow-up has a named owner and a due day, so it is the cleanest check that extraction populates both panels. Used by the root README's sample flow, and also one line per turn.

**Try asking:** _What are the action items?_ — Omar's storage RFC by Monday, Priya's workspace mockups by Wednesday, Sam's soak test by Thursday, Maya's legal retention review next Tuesday.

### `customer-interview.txt`

A 27-minute product discovery call between Rachel, who is doing the research, and Liam, a customer who runs payment operations and reports to a director. Exported in Otter's style: `Speaker (MM:SS)` headers with a blank line between turns. Two speakers only, so turns are long and answers ramble the way customers actually talk.

Requirements arrive buried in anecdotes rather than stated as a list, and Liam changes his mind mid-call: he asks for the export by email, then realises his own email system strips attachments over ten megabytes, and lands on a webhook instead. Extraction has to follow him to the second answer, not the first.

The largest transcript that still fits the full-context path, by 60 characters. That makes it the stress case for prompt size without retrieval, and the fixture most sensitive to threshold changes.

**Try asking:** _What are Liam's requirements for the CSV export?_ — CSV rather than JSON, stable column order with new columns appended not inserted, integer cents rather than floats, UTC timestamps, and delivery by webhook carrying a signed URL plus a row count and checksum.

### `solo-keynote.txt`

A conference keynote. One speaker for the entire file, delivered in long uninterrupted stretches — 78% of turns wrap, the highest in the set, including a single turn of 3,657 characters.

Two things only this fixture reaches. Chunk speaker labels must stay `Evelyn` rather than accumulating `Evelyn, Evelyn, Evelyn`, and a turn longer than `DEFAULT_MAX_CHARS` is emitted whole — so the chunker legitimately produces one chunk of 3,691 characters, nearly twice its nominal maximum.

**Try asking:** _What does Evelyn insist on before running consensus in production?_ — an election timeout at least ten times measured p99 inter-node latency, log compaction configured from day one, quorum-aware deployments, clock skew monitoring, and a runbook tested by someone who does not understand the system.

### `security-architecture-rfc.txt`

An architecture review over RFC 042 with a genuine unresolved disagreement about hardware attestation, settled by a compromise rather than by one side winning. Núria from compliance is flagged as joining late in the first minute, the group deliberately parks the compliance questions for her, and she arrives seventeen minutes in — so the decision depends on turns that are far apart in the file.

This is the non-ASCII fixture. The export uses typographic punctuation throughout — curly apostrophes and quotes, no straight ones anywhere — and two speakers are named Núria and Zoë. UTF-8 byte length exceeds JavaScript string length by 577 bytes, which is the gap that matters anywhere the system counts bytes rather than characters, and the accented names have to survive into chunk speaker labels.

It also tests the difference between a decision and a deferral: one item is agreed, another is explicitly postponed to a scheduled review, and the transcript is careful about the distinction.

**Try asking:** _What was decided about hardware attestation?_ — deferred to a scheduled Q4 evaluation rather than an implementation commitment; software attestation via service account tokens ships now.

### `sprint-retrospective.txt`

A five-person retro with 398 turns, the shortest turns of any full-length fixture at 62 characters each, and the lowest wrap rate in the set, because people interrupt each other before finishing a sentence. Backchannels ("right", "yeah", "exactly") and `[crosstalk]` markers appear where speech overlaps. Only the marathon has more turns, and it is four times the size.

The valuable content is a causal chain that no single turn contains: adding an end-to-end suite tripled CI time, which made people batch changes, which made pull requests bigger, which made reviews slower.

**Try asking:** _Why did pull requests get bigger this sprint?_ — CI went from six to eighteen minutes on the twelfth when the Playwright suite went into the main pipeline, so nobody wanted to push small changes and started batching them.

### `town-hall-qna.txt`

A Q4 company town hall with 18 distinct speaker labels: Alex hosting and reading questions out, Victoria taking most of them, five leaders answering in their own areas, a long tail of nine people asking one or two questions each, plus `Unknown Speaker` and `Conference Room B` where diarisation gave up on a shared room microphone.

Highest speaker count in the set, and the widest chunk label spans nine distinct speakers. Chunk headers list every distinct speaker in the window, so this is where label accumulation eats into the character budget, and where speaker attribution is easiest to get wrong. It is the fixture that most needs each turn to carry its own clock: with nine names in one header, a single window timestamp is enough to pin a claim on the wrong person. One speaker is named Jonás, so the labels carry non-ASCII too.

**Try asking:** _Who owns the YubiKey rollout and when is it due?_ — Frank, shipping to engineering by Tuesday, with a two-week grace period before hardware keys are required for production access.

### `incident-postmortem.txt`

A blameless postmortem for a Black Friday outage, five speakers. Devon from support joins nine minutes in because a handover overran, and Sam drops in two-thirds of the way through for three minutes, asks what the outage cost, and leaves before the actions are agreed.

Contains the things that make real timelines hard. The timeline is corrected live — "the alert fired at fourteen oh two, that's right, but the error rate started climbing at thirteen fifty-eight" — and everyone has to restate the number afterwards, so the same event appears with two times attached. The mitigation made things worse: restarting the connection pooler turned a forty percent partial outage into a total one for four minutes, because every pod reconnected in lockstep with fixed-delay retries and no jitter. And one item is deliberately left without an owner, because Marcus rules it too large for a postmortem — "then it goes in as a recommendation without an owner, and I'll raise it separately."

The database detail is described rather than pasted — a missing index on the promo code column, an eleven-second sequential scan, connections stuck idle in transaction — which is how an engineer actually explains it on a call.

**Try asking:** _What was the root cause?_ — an unindexed promo code lookup on a 190-million-row table turned an eleven-second sequential scan into connection pool exhaustion. Note that the meeting explicitly rejects that as the root cause, arguing the real one is that a single slow query can consume the entire shared pool.

### `executive-budget-review.txt`

A budget meeting in `[MM:SS]` two-part timestamps, the only fixture using that format. Requests exceed the ceiling by £180,000, so approvals happen against live cuts. Rina volunteers her own agency spend for elimination, and two separate headcount requests are cut from four to three in the room — machine learning engineers and EMEA account executives — which is the kind of change that leaves a stale number earlier in the transcript.

Every decision is restated in a recap at the end, in slightly different words, and each attendee confirms it. Extraction should produce one item per decision, not two.

**Try asking:** _What was approved and what was cut?_ — the £350,000 GPU cluster approved subject to legal review and to research committing to use it, three machine learning engineers rather than four, one frontend contractor starting in January with the second deferred to April, the finance system upgrade going ahead in January because October end-of-support makes it non-optional, marketing outbound agency spend frozen and reallocated, three EMEA account executives rather than four with France deferred to Q2, and a Q4 ARR target of 25%.

### `technical-war-room.txt`

A live Sev-2 debugging session with four engineers, in bare `HH:MM:SS` format. The most technically dense fixture, and the clearest demonstration that density does not mean pasted output. Dave reads the exception off a dashboard in words — "it says type error, cannot read properties of undefined, and then in brackets it says reading street line one" — and Jax describes the fix as "there's a function for it, you give it the process ID and it terminates the backend". When Jax finds the deploy that triggered it he says "I'm not going to read the whole hash", which is exactly what a person does.

It also has the shape of a real incident rather than a clean narrative: the severity is argued about before anyone investigates, one engineer's fan is audible on the call, Ophelia joins six minutes in apologising for having been on mute, and the first plausible theory is talked down by Samira before anyone acts on it, because it does not explain why the errors started this morning.

**Try asking:** _What did they run to clear the stuck connections?_ — Jax used the Postgres function that terminates a backend by process ID, targeting sessions idle in transaction for over five minutes, and killed eleven of them before connection counts came down.

### `all-hands-marathon.txt`

A quarterly business review billed as three hours, of which 2 hours 36 minutes is recorded. Nine speakers, 1,198 turns, and a guest customer — Liam, the same person interviewed in `customer-interview.txt` — taking questions for fourteen minutes near the end. Sections cover finance, sales, marketing, product, engineering, support, and people, so the same terms recur in different contexts and retrieval has to pick the right one out of 60 chunks with `RETRIEVE_K=8`.

The recording is paused for both breaks, so the timeline jumps: ten minutes between `00:28:00` and `00:38:02`, and fifteen between `01:03:12` and `01:18:14`. The parser only requires timestamps not to move backwards, so gaps like these are legal — but anything that treats a transcript as continuous audio will be wrong about this file.

Lisa’s commitment to rebuild the **onboarding buddy rota** and circulate it by Monday sits in the last minutes of the file. Windowed extraction must still list it; if the panel omits it, a window was dropped or truncated.

**Try asking:** _How much were the orphaned preview environments costing?_ — about nineteen thousand a month at peak, and roughly a hundred and fifty thousand across the eight months it went unnoticed, because the teardown webhook broke in February and returned a success code instead of erroring, so nothing alerted. It is discussed early and referenced again much later, so a wrong answer usually means retrieval ranking rather than generation.

## Limits

| Limit                                                                                                 | Value     | Fixture that reaches it                                         |
| ----------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| `FULL_CONTEXT_CHAR_THRESHOLD` — below it the whole transcript is prompted                             | `24000`   | `customer-interview.txt` (23,940) / `solo-keynote.txt` (24,249) |
| [`DEFAULT_MAX_CHARS`](../server/src/transcript/chunk.ts) — soft cap, a longer turn is emitted whole   | `2000`    | `solo-keynote.txt`, one chunk of 3,691                          |
| [`WINDOW_MAX_CHARS`](../server/src/extract/window.ts) / 20% overlap — extract windows, not truncation | `12000`   | `all-hands-marathon.txt` (106,337), several windows             |
| `RETRIEVE_K` / `FTS_K` — chunks fused into the prompt                                                 | `8`       | `all-hands-marathon.txt`, 60 chunks                             |
| Distinct speakers in one chunk label                                                                  | unbounded | `town-hall-qna.txt`, 18 speakers, 9 in one label                |
| Continuation lines appended to the previous turn                                                      | unbounded | `solo-keynote.txt`, one turn of 3,657 chars across 55 lines     |
| UTF-8 bytes exceeding JavaScript string length                                                        | —         | `security-architecture-rfc.txt`, 25,245 bytes vs 24,668 chars   |
| Gap between consecutive timestamps when the recording is paused                                       | unbounded | `all-hands-marathon.txt`, 902 seconds across the second break   |

Constants and their source files are listed in [docs/flows](../docs/flows/README.md#constants).

## Keeping this accurate

[`server/test/fixtures.test.ts`](../server/test/fixtures.test.ts) asserts the character count, turn count, speaker set, and key phrases for every file in `transcripts/`, plus every limit in the table above, the wrap rate of each ASR-style fixture, and the rule that no fixture may contain pasted machine output. Editing a fixture without updating that test fails the suite:

```bash
npm test -w server
```

The sweep at the end of that file also requires that every fixture parses, chunks, and never has a timestamp that moves backwards, so a new fixture only needs adding to the `cases` array.
