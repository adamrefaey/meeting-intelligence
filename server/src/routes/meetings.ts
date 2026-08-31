import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { discardMeeting, ingestTranscript } from '../ingest/pipeline.ts';
import type { Llm } from '../llm/types.ts';
import { ParseError } from '../transcript/parse.ts';
import { clientDisconnectSignal, requireMeetingId, sendError, skipIfAborted } from './http.ts';

export type MeetingRouteDeps = {
  db: DatabaseSync;
  llm: Llm;
  config: AppConfig;
};

type UploadParts = {
  file?: { filename: string; buffer: Buffer };
  error?: string;
};

type MeetingSummaryRow = {
  id: number;
  title: string;
  createdAt: string;
  status: 'processing' | 'ready';
};

type DecisionRow = { id: number; text: string; speaker: string | null; timestamp: string | null };

type ActionItemRow = {
  id: number;
  text: string;
  owner: string | null;
  due: string | null;
  timestamp: string | null;
};

type TurnRow = {
  id: number;
  speaker: string;
  timestamp: string;
  startSeconds: number;
  text: string;
};

type MessageRow = { id: number; role: 'user' | 'assistant'; content: string };

const MEETING_COLUMNS = `id, title, created_at AS createdAt, status`;

function listMeetings(db: DatabaseSync) {
  return db
    .prepare(`SELECT ${MEETING_COLUMNS} FROM meetings ORDER BY created_at DESC, id DESC`)
    .all() as MeetingSummaryRow[];
}

function loadMeetingRow(db: DatabaseSync, id: number): MeetingSummaryRow | undefined {
  return db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ?`).get(id) as
    | MeetingSummaryRow
    | undefined;
}

function loadDecisions(db: DatabaseSync, meetingId: number): DecisionRow[] {
  return db
    .prepare(`SELECT id, text, speaker, timestamp FROM decisions WHERE meeting_id = ? ORDER BY id`)
    .all(meetingId) as DecisionRow[];
}

function loadActionItems(db: DatabaseSync, meetingId: number): ActionItemRow[] {
  return db
    .prepare(
      `SELECT id, text, owner, due, timestamp FROM action_items WHERE meeting_id = ? ORDER BY id`,
    )
    .all(meetingId) as ActionItemRow[];
}

function getMeeting(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return;
  }
  const meeting = loadMeetingRow(db, id);
  if (!meeting) {
    return sendError(reply, 404, 'Meeting not found');
  }
  return {
    ...meeting,
    decisions: loadDecisions(db, id),
    actionItems: loadActionItems(db, id),
  };
}

function loadTurns(db: DatabaseSync, meetingId: number): TurnRow[] {
  return db
    .prepare(
      `SELECT id, speaker, timestamp, start_seconds AS startSeconds, text
       FROM turns WHERE meeting_id = ? ORDER BY turn_index`,
    )
    .all(meetingId) as TurnRow[];
}

function requireExistingMeeting(
  db: DatabaseSync,
  request: FastifyRequest,
  reply: FastifyReply,
): number | undefined {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return undefined;
  }
  if (db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(id) === undefined) {
    sendError(reply, 404, 'Meeting not found');
    return undefined;
  }
  return id;
}

function loadMessages(db: DatabaseSync, meetingId: number): MessageRow[] {
  return db
    .prepare(
      `SELECT id, role, content FROM messages
       WHERE meeting_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(meetingId) as MessageRow[];
}

function deleteMeeting(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return;
  }
  const result = db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  if (result.changes === 0) {
    return sendError(reply, 404, 'Meeting not found');
  }
  return reply.code(204).send();
}

async function drainFile(file: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of file) {
    // Drain so busboy can emit the next part.
  }
}

function validateUploadMeta(filename: string, mimetype: string): string | undefined {
  if (!filename.toLowerCase().endsWith('.txt')) {
    return 'file must be a .txt transcript';
  }
  const mime = mimetype.trim().toLowerCase();
  if (mime !== '' && mime !== 'text/plain' && !mime.startsWith('text/plain;')) {
    return 'file must be text/plain';
  }
  return undefined;
}

/** The `file` field; other file parts are drained so the parser does not stall. */
async function readUpload(request: FastifyRequest): Promise<UploadParts> {
  const result: UploadParts = {};
  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      continue;
    }
    if (part.fieldname !== 'file') {
      await drainFile(part.file);
      continue;
    }
    const invalid = validateUploadMeta(part.filename, part.mimetype);
    if (invalid) {
      result.error = invalid;
      await drainFile(part.file);
      continue;
    }
    result.file = { filename: part.filename, buffer: await part.toBuffer() };
  }
  return result;
}

function mapUploadReadError(error: unknown): { status: number; error: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return { status: 413, error: 'file too large' };
  }
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return { status: 400, error: 'too many files' };
  }
  return { status: 400, error: 'invalid upload' };
}

/**
 * Ingest is bound to disconnect. If the client is gone after ingest would have
 * returned 201, discard the meeting so a cancelled upload does not stay listed.
 */
async function createMeeting(deps: MeetingRouteDeps, request: FastifyRequest, reply: FastifyReply) {
  let upload: UploadParts;
  try {
    upload = await readUpload(request);
  } catch (error) {
    if (skipIfAborted(reply, error)) {
      return;
    }
    const mapped = mapUploadReadError(error);
    return sendError(reply, mapped.status, mapped.error);
  }
  if (upload.error) {
    return sendError(reply, 400, upload.error);
  }
  if (!upload.file) {
    return sendError(reply, 400, 'file is required');
  }
  try {
    const { meetingId } = await ingestTranscript(
      deps.db,
      deps.llm,
      deps.config,
      {
        title: upload.file.filename.replace(/\.txt$/i, ''),
        rawText: upload.file.buffer.toString('utf8'),
      },
      clientDisconnectSignal(reply),
    );
    if (skipIfAborted(reply)) {
      discardMeeting(deps.db, meetingId);
      return;
    }
    return reply.code(201).send({ id: meetingId });
  } catch (error) {
    if (skipIfAborted(reply, error)) {
      return;
    }
    if (error instanceof ParseError) {
      return sendError(reply, 400, error.message);
    }
    request.log.error(error);
    return sendError(reply, 500, 'failed to ingest transcript');
  }
}

export function meetingsRoutes(deps: MeetingRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/api/meetings', () => listMeetings(deps.db));
    // 5 MiB file + multipart wrapping; the plugin still enforces files: 1 / fileSize.
    app.post('/api/meetings', { bodyLimit: 6 * 1024 * 1024 }, (request, reply) =>
      createMeeting(deps, request, reply),
    );
    app.get('/api/meetings/:id', (request, reply) => getMeeting(deps.db, request, reply));
    app.get('/api/meetings/:id/transcript', (request, reply) => {
      const id = requireExistingMeeting(deps.db, request, reply);
      if (id === undefined) {
        return;
      }
      return { turns: loadTurns(deps.db, id) };
    });
    app.get('/api/meetings/:id/messages', (request, reply) => {
      const id = requireExistingMeeting(deps.db, request, reply);
      if (id === undefined) {
        return;
      }
      return { messages: loadMessages(deps.db, id) };
    });
    app.delete('/api/meetings/:id', (request, reply) => deleteMeeting(deps.db, request, reply));
  };
}
