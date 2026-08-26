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

function writeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* sseChunks(
  db: DatabaseSync,
  meetingId: number,
  answer: AnswerQuestionResult,
  log: FastifyBaseLogger,
  signal: AbortSignal,
): AsyncGenerator<string> {
  yield writeSse('context', { useFullTranscript: answer.useFullTranscript });
  let full = '';
  let saved = false;
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
    persistMessage(db, meetingId, 'assistant', full);
    saved = true;
    yield writeSse('done', {});
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return;
    }
    log.error(error);
    yield writeSse('error', { error: 'failed to generate answer' });
    if (full !== '' && !saved) {
      try {
        persistMessage(db, meetingId, 'assistant', full);
      } catch (persistError) {
        log.error(persistError);
      }
    }
  }
}

function streamAnswer(
  reply: FastifyReply,
  db: DatabaseSync,
  meetingId: number,
  answer: AnswerQuestionResult,
  signal: AbortSignal,
) {
  return reply
    .header('Content-Type', 'text/event-stream; charset=utf-8')
    .header('Cache-Control', 'no-cache, no-transform')
    .header('Connection', 'keep-alive')
    .header('X-Accel-Buffering', 'no')
    .header('X-Content-Type-Options', 'nosniff')
    .send(Readable.from(sseChunks(db, meetingId, answer, reply.log, signal)));
}

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
  return streamAnswer(reply, deps.db, id, answer, signal);
}

export function chatRoutes(deps: ChatRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.post('/api/meetings/:id/chat', (request, reply) => postChat(deps, request, reply));
  };
}
