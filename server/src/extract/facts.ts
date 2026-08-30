import { z } from 'zod';
import { isAbortError } from '../abort.ts';
import type { Llm } from '../llm/types.ts';
import type { Turn } from '../transcript/parse.ts';
import { mapPool } from './pool.ts';
import { packWindows, type FactWindow } from './window.ts';

export const EXTRACT_CONCURRENCY = 8;
export const MERGE_MAX_CHARS = 60_000;
const SUMMARY_MAX_CHARS = 1_000;
const MIN_FUZZY_KEY = 10;

const requiredText = z
  .string()
  .transform((value) => value.replaceAll('\u0000', '').trim())
  .pipe(z.string().min(1));

function unwrapClock(value: string): string {
  return value
    .replace(/^[[(]+/, '')
    .replace(/[\])]+$/, '')
    .trim();
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
    const cleaned = value.replaceAll('\u0000', '').trim();
    return cleaned === '' ? null : cleaned;
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

type WindowExtract = {
  summary: string;
  facts: ExtractedFacts;
};

function emptyFacts(): ExtractedFacts {
  return { decisions: [], actionItems: [] };
}

function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const text = fenced ? fenced[1].trim() : trimmed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function factsRecord(candidate: unknown): Record<string, unknown> | undefined {
  if (!isRecord(candidate)) {
    return undefined;
  }
  for (const value of [candidate, candidate.result, candidate.data]) {
    if (isRecord(value) && (Array.isArray(value.decisions) || Array.isArray(value.actionItems))) {
      return value;
    }
  }
  return undefined;
}

function parseWindowExtract(raw: string): WindowExtract {
  const parsed = parseModelJson(raw);
  const record = factsRecord(parsed);
  const nested = typeof record?.summary === 'string' ? record.summary.trim() : '';
  const outer = isRecord(parsed) && typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return {
    summary: (nested || outer).slice(0, SUMMARY_MAX_CHARS),
    facts:
      record === undefined
        ? emptyFacts()
        : {
            decisions: keepValid(factSchema, record.decisions),
            actionItems: keepValid(actionItemSchema, record.actionItems),
          },
  };
}

function isClosingHygiene(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith('recap:') ||
    /\bpost(?:ing)? notes in the channel\b/.test(normalized) ||
    /\bsend(?:ing)? (?:a |the )?recap\b/.test(normalized) ||
    /^(?:thanks(?: everyone)?|thank you(?: everyone)?)\.?$/.test(normalized)
  );
}

function factKey(item: { text: string }): string {
  return item.text.toLowerCase().replace(/\s+/g, ' ');
}

function exactDedupe<T extends { text: string }>(
  items: T[],
  merge: (kept: T, incoming: T) => T = (kept) => kept,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = factKey(item);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? item : merge(existing, item));
  }
  return [...byKey.values()];
}

function dedupeFacts(facts: ExtractedFacts): ExtractedFacts {
  return {
    decisions: exactDedupe(facts.decisions),
    actionItems: exactDedupe(facts.actionItems, (kept, incoming) => ({
      ...kept,
      owner: incoming.owner ?? kept.owner,
      due: incoming.due ?? kept.due,
    })),
  };
}

function flattenWindows(group: readonly WindowExtract[]): ExtractedFacts {
  return dedupeFacts({
    decisions: group.flatMap((item) => item.facts.decisions),
    actionItems: group.flatMap((item) => item.facts.actionItems),
  });
}

function keepKnown<T extends { text: string }>(
  parsed: T[],
  known: T[],
): { kept: T[]; unmatched: number } {
  const byKey = new Map<string, T>();
  for (const item of known) {
    const key = factKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }
  const kept: T[] = [];
  let unmatched = 0;
  for (const item of parsed) {
    const key = factKey(item);
    const exact = byKey.get(key);
    if (exact !== undefined) {
      kept.push(exact);
      continue;
    }
    if (key.length >= MIN_FUZZY_KEY) {
      const hits = known.filter((entry) => {
        const knownKey = factKey(entry);
        return (
          knownKey.length >= MIN_FUZZY_KEY && (key.includes(knownKey) || knownKey.includes(key))
        );
      });
      if (hits.length === 1) {
        kept.push(hits[0]);
        continue;
      }
    }
    unmatched += 1;
  }
  return { kept, unmatched };
}

async function unlessAborted<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return fallback;
  }
}

function packExtractGroups(extracts: WindowExtract[]): WindowExtract[][] {
  const groups: WindowExtract[][] = [];
  let current: WindowExtract[] = [];
  let size = 0;
  for (const extract of extracts) {
    const encoded = JSON.stringify(extract).length;
    if (current.length > 0 && size + encoded > MERGE_MAX_CHARS) {
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

async function extractWindow(
  llm: Llm,
  window: FactWindow,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<WindowExtract> {
  return unlessAborted(
    async () => {
      const extract = parseWindowExtract(
        await llm.completeJson(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Transcript:\n${window.text}` },
          ],
          signal,
        ),
      );
      return {
        summary: extract.summary,
        facts: dedupeFacts({
          decisions: extract.facts.decisions.filter((item) => !isClosingHygiene(item.text)),
          actionItems: extract.facts.actionItems.filter((item) => !isClosingHygiene(item.text)),
        }),
      };
    },
    { summary: '', facts: emptyFacts() },
  );
}

async function reconcileOrFallback(
  llm: Llm,
  group: WindowExtract[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  const fallback = flattenWindows(group);
  return unlessAborted(async () => {
    const parsed = parseWindowExtract(
      await llm.completeJson(
        [
          { role: 'system', content: REDUCE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              summaries: group.map((item) => item.summary).filter((summary) => summary.length > 0),
              ...fallback,
            }),
          },
        ],
        signal,
      ),
    ).facts;
    const decisions = keepKnown(parsed.decisions, fallback.decisions);
    const actionItems = keepKnown(parsed.actionItems, fallback.actionItems);
    const kept = dedupeFacts({ decisions: decisions.kept, actionItems: actionItems.kept });
    const keptCount = kept.decisions.length + kept.actionItems.length;
    return keptCount === 0 || decisions.unmatched + actionItems.unmatched > keptCount
      ? fallback
      : kept;
  }, fallback);
}

async function reduceWindowExtracts(
  llm: Llm,
  extracts: WindowExtract[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  const firstPack = packExtractGroups(extracts);
  if (firstPack.length === 1) {
    return reconcileOrFallback(llm, firstPack[0], signal);
  }
  const collapsed = await mapPool(firstPack, EXTRACT_CONCURRENCY, async (group) => {
    const facts =
      group.length === 1 ? group[0].facts : await reconcileOrFallback(llm, group, signal);
    return { summary: '', facts };
  });
  const secondPack = packExtractGroups(collapsed);
  // A second overflow flattens instead of looping.
  if (secondPack.length === 1) {
    return reconcileOrFallback(llm, secondPack[0], signal);
  }
  return flattenWindows(collapsed);
}

export async function extractFacts(
  llm: Llm,
  turns: Turn[],
  signal?: AbortSignal,
): Promise<ExtractedFacts> {
  return unlessAborted(async () => {
    const windows = packWindows(turns);
    if (windows.length === 0) {
      return emptyFacts();
    }
    const systemPrompt = windows.length > 1 ? WINDOW_SUMMARY_PROMPT : WINDOW_SYSTEM_PROMPT;
    const extracted = await mapPool(windows, EXTRACT_CONCURRENCY, (window) =>
      extractWindow(llm, window, systemPrompt, signal),
    );
    const flat = flattenWindows(extracted);
    if (windows.length === 1 || flat.decisions.length + flat.actionItems.length <= 1) {
      return flat;
    }
    return reduceWindowExtracts(llm, extracted, signal);
  }, emptyFacts());
}
