import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAbortError } from '../abort.ts';

export function sendError(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export function parseMeetingId(raw: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function readMeetingId(request: FastifyRequest): number | undefined {
  return parseMeetingId((request.params as { id: string }).id);
}

export function requireMeetingId(request: FastifyRequest, reply: FastifyReply): number | undefined {
  const id = readMeetingId(request);
  if (id === undefined) {
    sendError(reply, 400, 'invalid meeting id');
    return undefined;
  }
  return id;
}

// reply.raw 'close' is client-gone or response-finished — not request-body-complete.
// Fastify request.signal listens to IncomingMessage 'close', which fires after POST parse.
export function clientDisconnectSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  if (reply.raw.destroyed) {
    controller.abort();
    return controller.signal;
  }
  reply.raw.once('close', () => controller.abort());
  return controller.signal;
}

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

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}
