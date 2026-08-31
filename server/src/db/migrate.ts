import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCHEMA_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'),
  'utf8',
);

/**
 * Apply schema.sql when `user_version` is 0, then set it to 1. Any non-zero
 * version is a no-op — there are no incremental steps.
 */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  if ((row?.user_version ?? 0) !== 0) {
    return;
  }
  db.exec(SCHEMA_SQL);
  db.exec('PRAGMA user_version = 1');
}
