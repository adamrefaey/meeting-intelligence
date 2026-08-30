import { APIUserAbortError } from 'openai';

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError || (error instanceof Error && error.name === 'AbortError')
  );
}
