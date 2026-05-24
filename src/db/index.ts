import type { IDatabase } from '../types.js';

export async function createDatabase(): Promise<IDatabase> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { PostgresDatabase } = await import('./postgres.js');
    const db = new PostgresDatabase(url);
    await db.initialize();
    return db;
  }

  const { SqliteDatabase } = await import('./sqlite.js');
  const db = new SqliteDatabase();
  await db.initialize();
  return db;
}

export type { IDatabase } from '../types.js';
