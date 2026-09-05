import { readFile } from 'node:fs/promises';

// A single database transaction and advisory lock make restarts/multiple services safe.
export async function migrateFinance(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(24090501)');
    await client.query('CREATE TABLE IF NOT EXISTS finance_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const migrations=['001-auditable-accounts','002-part-returns-and-close-guard'];
    for(const version of migrations){
      const applied=await client.query('SELECT version FROM finance_schema_migrations WHERE version=$1',[version]);
      if(applied.rows.length)continue;
      await client.query(await readFile(new URL('./'+version+'.sql', import.meta.url),'utf8'));
      await client.query('INSERT INTO finance_schema_migrations(version) VALUES($1)',[version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
