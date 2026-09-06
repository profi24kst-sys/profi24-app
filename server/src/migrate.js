import pg from 'pg';
import {pathToFileURL} from 'node:url';
import {coreStatements} from './core-schema.js';
import {branchStatements} from './branch-schema.js';
import {lifecycleStatements} from './lifecycle-schema.js';
import {lifecycleV2Statements} from './lifecycle-schema-v2.js';
import {lifecycleV3Statements} from './lifecycle-schema-v3.js';
import {lifecycleV4Statements} from './lifecycle-schema-v4.js';
import {payrollV2Statements} from './payroll-schema-v2.js';
import {migrateFinance} from './finance/migrate.js';

export async function migrateCore(pool) {
  for(const sql of coreStatements) await pool.query(sql);
  for(const sql of branchStatements) await pool.query(sql);
  for(const sql of lifecycleStatements) await pool.query(sql);
  for(const sql of lifecycleV2Statements) await pool.query(sql);
  await migrateFinance(pool);
  for(const sql of lifecycleV3Statements) await pool.query(sql);
  for(const sql of lifecycleV4Statements) await pool.query(sql);
  for(const sql of payrollV2Statements) await pool.query(sql);
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try {
    await migrateCore(pool);
    console.log(`Applied ${coreStatements.length+branchStatements.length+lifecycleStatements.length+lifecycleV2Statements.length+lifecycleV3Statements.length+lifecycleV4Statements.length+payrollV2Statements.length} database migration statements`);
  } catch(error) {
    console.error('Migration failed:',error);
    process.exitCode=1;
  } finally { await pool.end(); }
}
