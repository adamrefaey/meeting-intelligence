import type { DatabaseSync } from 'node:sqlite';

export const INSERT_BATCH_SIZE = 100;

export type SqlValue = null | number | string | Uint8Array;

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result instanceof Promise) {
      db.exec('ROLLBACK');
      throw new Error('inTransaction callback must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}

export function insertRows(
  db: DatabaseSync,
  insertInto: string,
  rowPlaceholder: string,
  rows: SqlValue[][],
): void {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const sql = `${insertInto} VALUES ${batch.map(() => rowPlaceholder).join(', ')}`;
    db.prepare(sql).run(...batch.flat());
  }
}

export function insertRowsReturning(
  db: DatabaseSync,
  insertInto: string,
  rowPlaceholder: string,
  returning: string,
  rows: SqlValue[][],
): Array<Record<string, unknown>> {
  const inserted: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const sql = `${insertInto} VALUES ${batch.map(() => rowPlaceholder).join(', ')} RETURNING ${returning}`;
    inserted.push(...db.prepare(sql).all(...batch.flat()));
  }
  return inserted;
}
