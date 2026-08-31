import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { isAbortError } from '../abort.ts';
import type { AppConfig } from '../config.ts';
import type { Llm } from '../llm/types.ts';
import {
  answerQuestion,
  MeetingNotFoundError,
  MeetingNotReadyError,
  type AnswerQuestionResult,
} from '../rag/chat.ts';
import { clientDisconnectSignal, requireMeetingId, sendError, skipIfAborted } from './http.ts';

export type ChatRouteDeps = {
  db: DatabaseSync;
  llm: Llm;
  config: AppConfig;
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};

function readChatMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const message = (body as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return undefined;
  }
  const trimmed = message.trim();
  return trimmed === '' ? undefined : trimmed;
}

function mapChatError(reply: FastifyReply, error: unknown) {
  if (skipIfAborted(reply, error)) {
    return;
  }
  if (error instanceof MeetingNotFoundError) {
    return sendError(reply, 404, error.message);
  }
  if (error instanceof MeetingNotReadyError) {
    return sendError(reply, 409, error.message);
  }
  reply.log.error(error);
  return sendError(reply, 500, 'failed to answer');
}

function persistMessage(
  db: DatabaseSync,
  meetingId: number,
  role: 'user' | 'assistant',
  content: string,
): void {
  db.prepare(`INSERT INTO messages (meeting_id, role, content) VALUES (?, ?, ?)`).run(
    meetingId,
    role,
    content,
  );
}

/** Best-effort: a persist failure must not throw out of the SSE generator. */
function persistAnswer(
  db: DatabaseSync,
  meetingId: number,
  content: string,
  log: FastifyBaseLogger,
): void {
  try {
    persistMessage(db, meetingId, 'assistant', content);
  } catch (persistError) {
    log.error(persistError);
  }
}

function writeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Persist a partial answer if generation fails after tokens. Abort ends the
 * stream with no `error` or `done` event.
 */
async function* sseChunks(
  db: DatabaseSync,
  meetingId: number,
  answer: AnswerQuestionResult,
  log: FastifyBaseLogger,
  signal: AbortSignal,
): AsyncGenerator<string> {
  yield writeSse('context', { useFullTranscript: answer.useFullTranscript });
  let full = '';
  try {
    for await (const text of answer.stream) {
      signal.throwIfAborted();
      full += text;
      yield writeSse('token', { text });
    }
    signal.throwIfAborted();
    if (full === '') {
      yield writeSse('error', { error: 'failed to generate answer' });
      return;
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return;
    }
    log.error(error);
    yield writeSse('error', { error: 'failed to generate answer' });
    if (full !== '') {
      persistAnswer(db, meetingId, full, log);
    }
    return;
  }
  persistAnswer(db, meetingId, full, log);
  yield writeSse('done', {});
}

/**
 * History is loaded inside answerQuestion, before this INSERT, so the question
 * is not in its own history. The user row is stored before SSE starts.
 */
async function postChat(deps: ChatRouteDeps, request: FastifyRequest, reply: FastifyReply) {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return;
  }
  const message = readChatMessage(request.body);
  if (message === undefined) {
    return sendError(reply, 400, 'message is required');
  }
  const signal = clientDisconnectSignal(reply);
  let answer: AnswerQuestionResult;
  try {
    answer = await answerQuestion(deps.db, deps.llm, deps.config, id, message, signal);
  } catch (error) {
    return mapChatError(reply, error);
  }
  try {
    persistMessage(deps.db, id, 'user', message);
  } catch (error) {
    return mapChatError(reply, error);
  }
  if (skipIfAborted(reply)) {
    return;
  }
  return reply
    .headers(SSE_HEADERS)
    .send(Readable.from(sseChunks(deps.db, id, answer, reply.log, signal)));
}

export function chatRoutes(deps: ChatRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.post('/api/meetings/:id/chat', (request, reply) => postChat(deps, request, reply));
  };
}
