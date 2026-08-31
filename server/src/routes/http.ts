import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAbortError } from '../abort.ts';

export function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

/** Reject anything that is not a safe positive decimal integer (no leading zeros). */
export function requireMeetingId(request: FastifyRequest, reply: FastifyReply): number | undefined {
  const raw = (request.params as { id: string }).id;
  const id = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) {
    sendError(reply, 400, 'invalid meeting id');
    return undefined;
  }
  return id;
}

/**
 * Abort on reply.raw `close` (client gone or response finished), not on
 * request-body-complete. Fastify's request.signal fires after POST parse, which
 * is too late to cancel ingest or chat.
 */
export function clientDisconnectSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  if (reply.raw.destroyed) {
    controller.abort();
    return controller.signal;
  }
  reply.raw.once('close', () => controller.abort());
  return controller.signal;
}

/**
 * Client gone: hijack so Fastify does not try to send. AbortError: 204 if
 * nothing has been written. Also true once the reply is already sent.
 */
export function skipIfAborted(reply: FastifyReply, error?: unknown): boolean {
  if (reply.raw.destroyed) {
    if (!reply.sent) {
      reply.hijack();
    }
    return true;
  }
  if (isAbortError(error)) {
    if (!reply.sent) {
      reply.code(204).send();
    }
    return true;
  }
  return reply.sent;
}
