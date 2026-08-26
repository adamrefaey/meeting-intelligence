import { z } from 'zod';
import { isAbortError } from '../abort.ts';
import type { ChatMessage, Llm } from '../llm/types.ts';
import type { Turn } from '../transcript/parse.ts';
import { mapPool } from './pool.ts';
import { packWindows, type FactWindow } from './window.ts';

export const EXTRACT_CONCURRENCY = 8;
export const MERGE_MAX_CHARS = 60_000;
const SUMMARY_MAX_CHARS = 1_000;
const UNMATCHED_SCAN_LIMIT = 32;
const MIN_FUZZY_KEY = 10;

const requiredText = z
  .string()
  .transform((value) => value.replaceAll('\u0000', '').trim())
  .pipe(z.string().min(1));

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

function isClosingHygiene(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith('recap:') ||
    /\bpost(?:ing)? notes in the channel\b/.test(normalized) ||
    /\bsend(?:ing)? (?:a |the )?recap\b/.test(normalized) ||
    /^(?:thanks(?: everyone)?|thank you(?: everyone)?)\.?$/.test(normalized)
  );
}

function dropClosingHygiene(facts: ExtractedFacts): ExtractedFacts {
  return {
    decisions: facts.decisions.filter((item) => !isClosingHygiene(item.text)),
    actionItems: facts.actionItems.filter((item) => !isClosingHygiene(item.text)),
  };
}

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

type WindowExtract = ExtractedFacts & { summary: string };

const FACT_RULES = `Extract only explicit locked decisions and committed action items from this transcript window.
Do not invent. Skip brainstorming ("I think", "we could") and unaccepted proposals.
A decision must be clearly agreed or locked. Do not emit a recap, wrap-up, or "that's enough" restatement of locks already captured.
An action item is assigned or committed work: "X, can you … by DATE?" (even if they do not repeat yes), accepted volunteers, or "I'll …". owner is that person, or null if unassigned. If a deadline is spoken, set due to that phrase; otherwise due is null. due is a spoken deadline (Monday, next Tuesday, EOD), never a clock; clocks belong in timestamp.
If the same person is given the same task twice (they volunteer, then are assigned a date), keep one row with the spoken deadline.
Do not extract "I'll post notes", sending a recap, or thanking the room.
timestamp is the clock only (00:02:01 or 06:10), no extra brackets or parentheses. Speakers must copy transcript names exactly.`;

const FACT_SCHEMA = `decisions: [{ "text": string, "speaker": string, "timestamp": string }]
actionItems: [{ "text": string, "owner": string | null, "due": string | null, "timestamp": string }]
If none, return empty arrays.
Respond with raw JSON only, no markdown fences.`;

const WINDOW_SYSTEM_PROMPT = `${FACT_RULES}
Return a JSON object with keys "decisions" and "actionItems".
${FACT_SCHEMA}`;

const WINDOW_SUMMARY_PROMPT = `${FACT_RULES}
Also set "summary" to 2-4 sentences of locked outcomes and any reversal in this window, not a full recap.
Return a JSON object with keys "summary", "decisions", and "actionItems".
${FACT_SCHEMA}`;

const REDUCE_SYSTEM_PROMPT = `You are given per-window summaries plus extracted decisions and action items from one meeting.
Do not invent items. Only keep items that already appear in the decisions/actionItems lists. Use summaries only to detect duplicates and reversals.
Drop near-duplicates. Copy each kept "text" verbatim from the input lists; never merge or rephrase. Keep the latest locked owner and due date.
If a later window reverses an earlier item, drop the withdrawn item and keep the replacement.
Recap restatements of the same decision collapse to one row.
Return a JSON object with keys "decisions" and "actionItems" using the same object shapes as the input.
If none remain, return empty arrays.
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
    const container = factsFromCandidate(direct);
    if (container !== undefined) {
      return container;
    }
  }
  const decisions: Fact[] = [];
  const actionItems: ActionItem[] = [];
  let unmatched = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '{') {
      continue;
    }
    const extracted = extractJsonObject(text, index);
    if (extracted === undefined) {
      unmatched += 1;
      if (unmatched > UNMATCHED_SCAN_LIMIT) {
        break;
      }
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
      index += extracted.length - 1;
    } else if (inner.actionItem) {
      actionItems.push(inner.actionItem);
      index += extracted.length - 1;
    }
  }
  if (decisions.length === 0 && actionItems.length === 0) {
    return undefined;
  }
  return { decisions, actionItems };
}

function summaryFromParsed(parsed: unknown): string {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const summary = (parsed as Record<string, unknown>).summary;
    if (typeof summary === 'string') {
      return summary.trim().slice(0, SUMMARY_MAX_CHARS);
    }
  }
  return '';
}

function parseWindowExtract(raw: string): WindowExtract {
  const trimmed = raw.trim();
  const parsed = tryParseJson(trimmed);
  return {
    summary: summaryFromParsed(parsed),
    ...(parseFactsFromText(trimmed) ?? emptyFacts()),
  };
}

function factKey(item: { text: string }): string {
  return item.text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function exactDedupeDecisions(items: Fact[]): Fact[] {
  const byKey = new Map<string, Fact>();
  for (const item of items) {
    const key = factKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function exactDedupeActions(items: ActionItem[]): ActionItem[] {
  const byKey = new Map<string, ActionItem>();
  for (const item of items) {
    const key = factKey(item);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...existing,
      owner: item.owner ?? existing.owner,
      due: item.due ?? existing.due,
    });
  }
  return [...byKey.values()];
}

function dedupeExtract(extract: WindowExtract): WindowExtract {
  const cleaned = dropClosingHygiene(extract);
  return {
    summary: extract.summary,
    decisions: exactDedupeDecisions(cleaned.decisions),
    actionItems: exactDedupeActions(cleaned.actionItems),
  };
}

function flattenDedupe(group: WindowExtract[]): ExtractedFacts {
  return {
    decisions: exactDedupeDecisions(group.flatMap((item) => item.decisions)),
    actionItems: exactDedupeActions(group.flatMap((item) => item.actionItems)),
  };
}

function uniqueFactCount(facts: ExtractedFacts): number {
  return facts.decisions.length + facts.actionItems.length;
}

function packExtractGroups(
  extracts: WindowExtract[],
  maxChars = MERGE_MAX_CHARS,
): WindowExtract[][] {
  const groups: WindowExtract[][] = [];
  let current: WindowExtract[] = [];
  let size = 0;
  for (const extract of extracts) {
    const encoded = JSON.stringify(extract).length;
    if (current.length > 0 && size + encoded > maxChars) {
      groups.push(current);
      current = [extract];
      size = encoded;
    } else {
      current.push(extract);
      size += encoded;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function buildWindowMessages(window: FactWindow, withSummary: boolean): ChatMessage[] {
  return [
    { role: 'system', content: withSummary ? WINDOW_SUMMARY_PROMPT : WINDOW_SYSTEM_PROMPT },
    { role: 'user', content: `Transcript:\n${window.text}` },
  ];
}

function buildReduceMessages(group: WindowExtract[]): ChatMessage[] {
  const payload = {
    summaries: group.map((item) => item.summary).filter((summary) => summary.length > 0),
    ...flattenDedupe(group),
  };
  return [
    { role: 'system', content: REDUCE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

async function extractWindow(
  llm: Llm,
  window: FactWindow,
  withSummary: boolean,
  signal?: AbortSignal,
): Promise<WindowExtract> {
  try {
    return dedupeExtract(
      parseWindowExtract(await llm.completeJson(buildWindowMessages(window, withSummary), signal)),
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { summary: '', ...emptyFacts() };
  }
}

function uniqueKnownMatch<T extends { text: string }>(parsed: T, known: T[]): T | undefined {
  const key = factKey(parsed);
  const exact = known.find((item) => factKey(item) === key);
  if (exact !== undefined) {
    return exact;
  }
  if (key.length < MIN_FUZZY_KEY) {
    return undefined;
  }
  const hits = known.filter((item) => {
    const knownKey = factKey(item);
    return knownKey.length >= MIN_FUZZY_KEY && (key.includes(knownKey) || knownKey.includes(key));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function keepKnownFacts(
  parsed: ExtractedFacts,
  fallback: ExtractedFacts,
): { kept: ExtractedFacts; unmatched: number } {
  let unmatched = 0;
  const decisions: Fact[] = [];
  for (const item of parsed.decisions) {
    const matched = uniqueKnownMatch(item, fallback.decisions);
    if (matched === undefined) {
      unmatched += 1;
      continue;
    }
    decisions.push(matched);
  }
  const actionItems: ActionItem[] = [];
  for (const item of parsed.actionItems) {
    const matched = uniqueKnownMatch(item, fallback.actionItems);
    if (matched === undefined) {
      unmatched += 1;
      continue;
    }
    actionItems.push(matched);
  }
  return {
    kept: {
      decisions: exactDedupeDecisions(decisions),
      actionItems: exactDedupeActions(actionItems),
    },
    unmatched,
  };
}

async function reconcileOrFallback(
  llm: Llm,
  group: WindowExtract[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  const fallback = flattenDedupe(group);
  try {
    const parsed = parseFactsFromText(
      (await llm.completeJson(buildReduceMessages(group), signal)).trim(),
    );
    if (parsed === undefined) {
      return fallback;
    }
    const { kept, unmatched } = keepKnownFacts(parsed, fallback);
    return uniqueFactCount(kept) === 0 || unmatched > uniqueFactCount(kept) ? fallback : kept;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return fallback;
  }
}

function withoutSummary(extract: WindowExtract): WindowExtract {
  return { ...extract, summary: '' };
}

async function reduceWindowExtracts(
  llm: Llm,
  extracts: WindowExtract[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  const groups = packExtractGroups(extracts);
  if (groups.length === 1) {
    return reconcileOrFallback(llm, groups[0], signal);
  }
  const collapsed = await mapPool(groups, EXTRACT_CONCURRENCY, async (group) => {
    if (group.length === 1) {
      return withoutSummary(group[0]);
    }
    return { summary: '', ...(await reconcileOrFallback(llm, group, signal)) };
  });
  const packed = packExtractGroups(collapsed);
  if (packed.length === 1) {
    return reconcileOrFallback(llm, packed[0], signal);
  }
  return flattenDedupe(collapsed);
}

export async function extractFacts(
  llm: Llm,
  turns: Turn[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  try {
    const windows = packWindows(turns);
    if (windows.length === 0) {
      return emptyFacts();
    }
    const withSummary = windows.length > 1;
    const extracted = await mapPool(windows, EXTRACT_CONCURRENCY, (window) =>
      extractWindow(llm, window, withSummary, signal),
    );
    const flat = flattenDedupe(extracted);
    if (windows.length === 1 || uniqueFactCount(flat) <= 1) {
      return flat;
    }
    return await reduceWindowExtracts(llm, extracted, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return emptyFacts();
  }
}
