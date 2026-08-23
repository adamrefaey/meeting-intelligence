import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.ts';
import { ingestTranscript } from '../ingest/pipeline.ts';
import type { Llm } from '../llm/types.ts';
import { ParseError } from '../transcript/parse.ts';
import {
  clientDisconnectSignal,
  errorCode,
  requireMeetingId,
  sendError,
  skipIfAborted,
} from './http.ts';

export type MeetingRouteDeps = {
  db: DatabaseSync;
  llm: Llm;
  config: AppConfig;
};

type UploadedFile = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
};

type UploadParts = {
  file?: UploadedFile;
  title?: string;
  error?: string;
};

type MeetingSummaryRow = {
  id: number | bigint;
  title: string;
  original_filename: string;
  created_at: string;
  status: string;
  error_message: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  char_count: number;
};

function mapMeeting(row: MeetingSummaryRow) {
  return {
    id: Number(row.id),
    title: row.title,
    original_filename: row.original_filename,
    created_at: row.created_at,
    status: row.status,
    error_message: row.error_message,
    embedding_model: row.embedding_model,
    embedding_dimensions: row.embedding_dimensions,
    char_count: row.char_count,
  };
}

const MEETING_COLUMNS = `id, title, original_filename, created_at, status, error_message,
       embedding_model, embedding_dimensions, char_count`;

function listMeetings(db: DatabaseSync) {
  const rows = db
    .prepare(`SELECT ${MEETING_COLUMNS} FROM meetings ORDER BY created_at DESC, id DESC`)
    .all() as MeetingSummaryRow[];
  return rows.map(mapMeeting);
}

function loadMeetingRow(db: DatabaseSync, id: number): MeetingSummaryRow | undefined {
  return db.prepare(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ?`).get(id) as
    | MeetingSummaryRow
    | undefined;
}

function loadDecisions(db: DatabaseSync, meetingId: number) {
  const rows = db
    .prepare(`SELECT id, text, speaker, timestamp FROM decisions WHERE meeting_id = ? ORDER BY id`)
    .all(meetingId) as Array<{
    id: number | bigint;
    text: string;
    speaker: string | null;
    timestamp: string | null;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    text: row.text,
    speaker: row.speaker,
    timestamp: row.timestamp,
  }));
}

function loadActionItems(db: DatabaseSync, meetingId: number) {
  const rows = db
    .prepare(
      `SELECT id, text, owner, due, timestamp FROM action_items WHERE meeting_id = ? ORDER BY id`,
    )
    .all(meetingId) as Array<{
    id: number | bigint;
    text: string;
    owner: string | null;
    due: string | null;
    timestamp: string | null;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    text: row.text,
    owner: row.owner,
    due: row.due,
    timestamp: row.timestamp,
  }));
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
    ...mapMeeting(meeting),
    decisions: loadDecisions(db, id),
    actionItems: loadActionItems(db, id),
  };
}

function loadTurns(db: DatabaseSync, meetingId: number) {
  const rows = db
    .prepare(
      `SELECT id, turn_index, speaker, timestamp, start_seconds, text
       FROM turns WHERE meeting_id = ? ORDER BY turn_index`,
    )
    .all(meetingId) as Array<{
    id: number | bigint;
    turn_index: number;
    speaker: string;
    timestamp: string;
    start_seconds: number;
    text: string;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    turnIndex: row.turn_index,
    speaker: row.speaker,
    timestamp: row.timestamp,
    startSeconds: row.start_seconds,
    text: row.text,
  }));
}

function meetingExists(db: DatabaseSync, id: number): boolean {
  return db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(id) !== undefined;
}

function getTranscript(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return;
  }
  if (!meetingExists(db, id)) {
    return sendError(reply, 404, 'Meeting not found');
  }
  return { turns: loadTurns(db, id) };
}

function loadMessages(db: DatabaseSync, meetingId: number) {
  const rows = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE meeting_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(meetingId) as Array<{
    id: number | bigint;
    role: string;
    content: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: Number(row.id),
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

function getMessages(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const id = requireMeetingId(request, reply);
  if (id === undefined) {
    return;
  }
  if (!meetingExists(db, id)) {
    return sendError(reply, 404, 'Meeting not found');
  }
  return { messages: loadMessages(db, id) };
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

type FilePart = {
  fieldname: string;
  filename: string;
  mimetype: string;
  file: AsyncIterable<unknown>;
  toBuffer: () => Promise<Buffer>;
};

async function discardFile(file: AsyncIterable<unknown>): Promise<void> {
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

async function takeFilePart(part: FilePart, result: UploadParts): Promise<void> {
  if (part.fieldname !== 'file' || result.file || result.error) {
    await discardFile(part.file);
    return;
  }
  const invalid = validateUploadMeta(part.filename, part.mimetype);
  if (invalid) {
    result.error = invalid;
    await discardFile(part.file);
    return;
  }
  result.file = {
    filename: part.filename,
    mimetype: part.mimetype,
    buffer: await part.toBuffer(),
  };
}

async function readUploadParts(request: FastifyRequest): Promise<UploadParts> {
  const result: UploadParts = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      await takeFilePart(part, result);
    } else if (part.fieldname === 'title') {
      result.title = String(part.value);
    }
  }
  return result;
}

function resolveTitle(title: string | undefined, filename: string): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed : filename.replace(/\.txt$/i, '');
}

function mapUploadReadError(error: unknown): { status: number; error: string } {
  const code = errorCode(error);
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return { status: 413, error: 'file too large' };
  }
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
    return { status: 400, error: 'too many files' };
  }
  return { status: 400, error: 'invalid upload' };
}

async function ingestUpload(
  deps: MeetingRouteDeps,
  file: UploadedFile,
  title: string | undefined,
  signal?: AbortSignal,
) {
  return ingestTranscript(
    deps.db,
    deps.llm,
    {
      embeddingModel: deps.config.embeddingModel,
      embeddingDimensions: deps.config.embeddingDimensions,
    },
    {
      title: resolveTitle(title, file.filename),
      filename: file.filename,
      rawText: file.buffer.toString('utf8'),
    },
    signal,
  );
}

async function createMeeting(deps: MeetingRouteDeps, request: FastifyRequest, reply: FastifyReply) {
  let parts: UploadParts;
  try {
    parts = await readUploadParts(request);
  } catch (error) {
    if (skipIfAborted(reply, error)) {
      return;
    }
    const mapped = mapUploadReadError(error);
    return sendError(reply, mapped.status, mapped.error);
  }
  if (parts.error) {
    return sendError(reply, 400, parts.error);
  }
  if (!parts.file) {
    return sendError(reply, 400, 'file is required');
  }
  try {
    const { meetingId } = await ingestUpload(
      deps,
      parts.file,
      parts.title,
      clientDisconnectSignal(reply),
    );
    if (skipIfAborted(reply)) {
      return;
    }
    return reply.code(201).send({ id: meetingId, status: 'ready' });
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
    app.get('/api/meetings', async () => listMeetings(deps.db));
    app.post('/api/meetings', { bodyLimit: 6 * 1024 * 1024 }, (request, reply) =>
      createMeeting(deps, request, reply),
    );
    app.get('/api/meetings/:id', (request, reply) => getMeeting(deps.db, request, reply));
    app.get('/api/meetings/:id/transcript', (request, reply) =>
      getTranscript(deps.db, request, reply),
    );
    app.get('/api/meetings/:id/messages', (request, reply) => getMessages(deps.db, request, reply));
    app.delete('/api/meetings/:id', (request, reply) => deleteMeeting(deps.db, request, reply));
  };
}
