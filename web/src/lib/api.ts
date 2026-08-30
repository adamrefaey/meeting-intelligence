export class ApiError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string) {
    super(error);
    this.name = 'ApiError';
    this.status = status;
    this.error = error;
  }
}

export type MeetingStatus = 'processing' | 'ready';

export type MeetingSummary = {
  id: number;
  title: string;
  createdAt: string;
  status: MeetingStatus;
};

export type Decision = {
  id: number;
  text: string;
  speaker: string | null;
  timestamp: string | null;
};

export type ActionItem = {
  id: number;
  text: string;
  owner: string | null;
  due: string | null;
  timestamp: string | null;
};

export type MeetingDetail = MeetingSummary & {
  decisions: Decision[];
  actionItems: ActionItem[];
};

export type Turn = {
  id: number;
  speaker: string;
  timestamp: string;
  startSeconds: number;
  text: string;
};

export type ChatMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
};

export type ChatEvent =
  | { type: 'context'; useFullTranscript: boolean }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

export function parseMeetingId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
    return undefined;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isUploadCancelled(error: unknown): boolean {
  return isAbortError(error) || (error instanceof ApiError && error.status === 204);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.error : fallback;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') {
      return body.error;
    }
  } catch {
    // Non-JSON error bodies still map to status text below.
  }
  return response.statusText || 'Request failed';
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new ApiError(response.status, await readErrorMessage(response));
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, response.statusText || 'Request failed');
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  await throwIfNotOk(response);
  return parseJson<T>(response);
}

function parseSseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function fieldValue(line: string): string {
  const raw = line.slice(line.indexOf(':') + 1);
  return raw.startsWith(' ') ? raw.slice(1) : raw;
}

function parseSseBlock(block: string): { event: string; data: unknown } | undefined {
  const dataLines: string[] = [];
  let event = '';
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = fieldValue(line);
    } else if (line.startsWith('data:')) {
      dataLines.push(fieldValue(line));
    }
  }
  if (event === '' || dataLines.length === 0) {
    return undefined;
  }
  const data = parseSseData(dataLines.join('\n'));
  if (data === undefined) {
    return undefined;
  }
  return { event, data };
}

// SSE allows CRLF, LF, or a bare CR as a line terminator. A trailing CR is left as-is
// because it may be the first half of a CRLF that straddles two chunks.
function foldSse(text: string): string {
  const held = text.endsWith('\r') ? '\r' : '';
  const body = held === '' ? text : text.slice(0, -1);
  return body.replaceAll('\r\n', '\n').replaceAll('\r', '\n') + held;
}

function toChatEvent(event: string, data: unknown): ChatEvent | undefined {
  if (event === 'done') {
    return { type: 'done' };
  }
  if (data === null || typeof data !== 'object') {
    return undefined;
  }
  const payload = data as Record<string, unknown>;
  if (event === 'token' && typeof payload.text === 'string') {
    return { type: 'token', text: payload.text };
  }
  if (event === 'error' && typeof payload.error === 'string') {
    return { type: 'error', error: payload.error };
  }
  if (event === 'context') {
    return { type: 'context', useFullTranscript: payload.useFullTranscript === true };
  }
  return undefined;
}

function drainSseBuffer(buffer: string, onEvent: (event: ChatEvent) => void): string {
  let rest = buffer;
  let idx = rest.indexOf('\n\n');
  while (idx !== -1) {
    const parsed = parseSseBlock(rest.slice(0, idx));
    rest = rest.slice(idx + 2);
    if (parsed) {
      const event = toChatEvent(parsed.event, parsed.data);
      if (event) {
        onEvent(event);
      }
    }
    idx = rest.indexOf('\n\n');
  }
  return rest;
}

export async function listMeetings(signal?: AbortSignal): Promise<MeetingSummary[]> {
  return getJson<MeetingSummary[]>('/api/meetings', signal);
}

export async function createMeeting(file: File, signal?: AbortSignal): Promise<{ id: number }> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch('/api/meetings', { method: 'POST', body, signal });
  await throwIfNotOk(response);
  if (response.status === 204) {
    throw new ApiError(204, 'Upload was cancelled');
  }
  return parseJson<{ id: number }>(response);
}

export async function getMeeting(id: number, signal?: AbortSignal): Promise<MeetingDetail> {
  return getJson<MeetingDetail>(`/api/meetings/${id}`, signal);
}

export async function getTranscript(id: number, signal?: AbortSignal): Promise<{ turns: Turn[] }> {
  return getJson<{ turns: Turn[] }>(`/api/meetings/${id}/transcript`, signal);
}

export async function getMessages(
  id: number,
  signal?: AbortSignal,
): Promise<{ messages: ChatMessage[] }> {
  return getJson<{ messages: ChatMessage[] }>(`/api/meetings/${id}/messages`, signal);
}

export async function deleteMeeting(id: number, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/meetings/${id}`, { method: 'DELETE', signal });
  await throwIfNotOk(response);
}

async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const rest = drainSseBuffer(
          foldSse(buffer + decoder.decode()).replaceAll('\r', '\n'),
          onEvent,
        );
        if (rest.trim() !== '') {
          drainSseBuffer(`${rest}\n\n`, onEvent);
        }
        return;
      }
      buffer = drainSseBuffer(foldSse(buffer + decoder.decode(value, { stream: true })), onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function chat(
  id: number,
  message: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/meetings/${id}/chat`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal,
  });
  await throwIfNotOk(response);
  if (response.status === 204) {
    return;
  }
  if (!response.body) {
    throw new ApiError(500, 'chat stream was empty');
  }
  try {
    await readChatStream(response.body, onEvent);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  }
}
