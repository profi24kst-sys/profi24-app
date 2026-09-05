import pg from 'pg';
import { migrateFinance } from './finance/migrate.js';
import { buildFinanceApp } from './finance/app.js';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
await migrateFinance(pool);
const app=await buildFinanceApp(pool);
app.addHook('onClose',async()=>pool.end());
await app.listen({port:Number(process.env.PORT||8085),host:'0.0.0.0'});
