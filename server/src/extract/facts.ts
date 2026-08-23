import { z } from 'zod';
import { isAbortError } from '../abort.ts';
import type { ChatMessage, Llm } from '../llm/types.ts';

export const FACT_TRANSCRIPT_CHAR_LIMIT = 100_000;

const requiredText = z.string().trim().min(1);

function unwrapClock(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === '[' || value[start] === '(')) {
    start += 1;
  }
  while (end > start && (value[end - 1] === ']' || value[end - 1] === ')')) {
    end -= 1;
  }
  return value.slice(start, end).trim();
}

const clockLabel = requiredText.transform(unwrapClock).pipe(z.string().min(1));

const CLOCK_VALUE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

const optionalLabel = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });

const optionalDue = optionalLabel.transform((value) => {
  if (value == null) {
    return null;
  }
  const unwrapped = unwrapClock(value);
  if (unwrapped === '' || CLOCK_VALUE.test(unwrapped)) {
    return null;
  }
  return unwrapped;
});

const factSchema = z.object({
  text: requiredText,
  speaker: requiredText,
  timestamp: clockLabel,
});

const actionItemSchema = z.object({
  text: requiredText,
  owner: optionalLabel,
  due: optionalDue,
  timestamp: clockLabel,
});

export type Fact = z.infer<typeof factSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;
export type ExtractedFacts = {
  decisions: Fact[];
  actionItems: ActionItem[];
};

const SYSTEM_PROMPT = `Extract only explicit locked decisions and committed action items.
Do not invent. Skip brainstorming ("I think", "we could") and unaccepted proposals.
A decision must be clearly agreed or locked.
An action item is assigned or committed work: "X, can you … by DATE?", accepted volunteers, or "I'll …". owner is that person, or null if unassigned. If a deadline is spoken, set due to that phrase; otherwise due is null. due is a spoken deadline (Monday, next Tuesday, EOD), never a clock; clocks belong in timestamp.
timestamp is the clock only (00:02:01 or 06:10), no extra brackets or parentheses. Speakers must copy transcript names exactly.
Return a JSON object with keys "decisions" and "actionItems".
decisions: [{ "text": string, "speaker": string, "timestamp": string }]
actionItems: [{ "text": string, "owner": string | null, "due": string | null, "timestamp": string }]
If none, return empty arrays.
Respond with raw JSON only, no markdown fences.`;

function emptyFacts(): ExtractedFacts {
  return { decisions: [], actionItems: [] };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,(\s*[}\]])$/, '$1'));
    } catch {
      return undefined;
    }
  }
}

function extractJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function keepValid<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: T[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      kept.push(parsed.data);
    }
  }
  return kept;
}

function factsFromCandidate(candidate: unknown): ExtractedFacts | undefined {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  const decisions = record.decisions;
  const actionItems = Array.isArray(record.actionItems) ? record.actionItems : record.action_items;
  if (!Array.isArray(decisions) && !Array.isArray(actionItems)) {
    return undefined;
  }
  return {
    decisions: keepValid(factSchema, decisions),
    actionItems: keepValid(actionItemSchema, actionItems),
  };
}

function classifyInnerObject(parsed: unknown): { decision?: Fact; actionItem?: ActionItem } {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if ('owner' in record || 'due' in record) {
      const action = actionItemSchema.safeParse(parsed);
      if (action.success) {
        return { actionItem: action.data };
      }
    }
  }
  const decision = factSchema.safeParse(parsed);
  if (decision.success) {
    return { decision: decision.data };
  }
  const action = actionItemSchema.safeParse(parsed);
  return action.success ? { actionItem: action.data } : {};
}

function parseFactsFromText(text: string): ExtractedFacts | undefined {
  const direct = tryParseJson(text);
  if (direct !== undefined) {
    return factsFromCandidate(direct) ?? emptyFacts();
  }
  const decisions: Fact[] = [];
  const actionItems: ActionItem[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') {
      continue;
    }
    const extracted = extractJsonObject(text, index);
    if (extracted === undefined) {
      continue;
    }
    const parsed = tryParseJson(extracted);
    if (parsed === undefined) {
      continue;
    }
    const container = factsFromCandidate(parsed);
    if (container) {
      return container;
    }
    const inner = classifyInnerObject(parsed);
    if (inner.decision) {
      decisions.push(inner.decision);
    } else if (inner.actionItem) {
      actionItems.push(inner.actionItem);
    }
    index += extracted.length - 1;
  }
  if (decisions.length === 0 && actionItems.length === 0) {
    return undefined;
  }
  return { decisions, actionItems };
}

function parseExtractedFacts(raw: string): ExtractedFacts {
  return parseFactsFromText(raw.trim()) ?? emptyFacts();
}

function buildExtractionMessages(transcript: string): ChatMessage[] {
  const truncated = transcript.length > FACT_TRANSCRIPT_CHAR_LIMIT;
  const body = truncated ? transcript.slice(0, FACT_TRANSCRIPT_CHAR_LIMIT) : transcript;
  const prefix = truncated
    ? `The transcript was truncated to the first ${FACT_TRANSCRIPT_CHAR_LIMIT} characters.\n\nTranscript:\n`
    : 'Transcript:\n';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${prefix}${body}` },
  ];
}

export async function extractFacts(
  llm: Llm,
  transcript: string,
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  try {
    return parseExtractedFacts(await llm.completeJson(buildExtractionMessages(transcript), signal));
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return emptyFacts();
  }
}
