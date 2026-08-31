import { APIUserAbortError } from 'openai';

/** OpenAI throws APIUserAbortError; AbortSignal throws AbortError. Cancel must match both. */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError || (error instanceof Error && error.name === 'AbortError')
  );
}
