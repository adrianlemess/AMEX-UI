import '../load-env.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';
import { readConfig } from '../config.js';

const pool = createPool(readConfig(process.env).DATABASE_URL);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(844736)');
  const existing = await client.query<{ installed: string | null; other: string | null }>(
    `SELECT to_regclass('public.amex_schema_version')::text AS installed,
            to_regclass('public.households')::text AS other`,
  );
  if (!existing.rows[0]?.installed) {
    if (existing.rows[0]?.other) throw new Error('Database is not empty. Refusing to install on a shared or existing database.');
    const sql = await readFile(fileURLToPath(new URL('../../schema.sql', import.meta.url)), 'utf8');
    await client.query(sql);
    await client.query('CREATE TABLE amex_schema_version (version integer PRIMARY KEY)');
    await client.query('INSERT INTO amex_schema_version(version) VALUES(1)');
  }
  const version = await client.query<{ version: number }>('SELECT version FROM amex_schema_version');
  if (version.rows[0]?.version === 1) {
    const cards = await readFile(fileURLToPath(new URL('../../schema-cards.sql', import.meta.url)), 'utf8');
    await client.query(cards);
    await client.query('ALTER TABLE amex_schema_version DROP CONSTRAINT IF EXISTS amex_schema_version_version_check');
    await client.query('UPDATE amex_schema_version SET version=2');
  }
  if ([1, 2].includes(version.rows[0]?.version ?? -1)) {
    const usernames = await readFile(fileURLToPath(new URL('../../schema-usernames.sql', import.meta.url)), 'utf8');
    await client.query(usernames);
    await client.query('UPDATE amex_schema_version SET version=3');
  }
  if (![1, 2, 3].includes(version.rows[0]?.version ?? -1))
    throw new Error('Unsupported AMEX schema version');
  await client.query('COMMIT');
  console.log('AMEX schema is ready.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
