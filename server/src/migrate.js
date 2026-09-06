import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {coreStatements} from './core-schema.js';
import {migrateFinance} from './finance/migrate.js';

export async function migrateCore(pool) {
  for(const sql of coreStatements) await pool.query(sql);
  await migrateFinance(pool);
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try {
    await migrateCore(pool);
    console.log(`Applied ${coreStatements.length} database migration statements`);
  } catch(error) {
    console.error('Migration failed:',error);
    process.exitCode=1;
  } finally { await pool.end(); }
}
