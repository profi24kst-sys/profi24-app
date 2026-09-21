import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import pg from 'pg';
import crypto from 'crypto';
import {installDocumentVersionSchema} from './document-version-schema.js';
import {runSchemaStatements} from './schema-retry.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(helmet, { contentSecurityPolicy: false });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (s, p = []) => pool.query(s, p);
const baseUrl = () => (process.env.PUBLIC_BASE_URL || process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:5173').replace(/\/$/, '');

await runSchemaStatements(pool,[
  `CREATE TABLE IF NOT EXISTS warranty_cards(
    id BIGSERIAL PRIMARY KEY,
    request_id INT UNIQUE NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    warranty_days INT NOT NULL DEFAULT 90,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    warranty_until DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_warranty_cards_token ON warranty_cards(token)`,
  `ALTER TABLE warranty_cards ADD COLUMN IF NOT EXISTS snapshot JSONB`,
  `ALTER TABLE warranty_cards ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  `CREATE OR REPLACE FUNCTION warranty_card_immutable() RETURNS trigger AS $ BEGIN
    RAISE EXCEPTION 'Выданный гарантийный талон нельзя изменять или удалять' USING ERRCODE='P2401';
  END $ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_warranty_card_immutable ON warranty_cards`,
  `CREATE TRIGGER trg_warranty_card_immutable BEFORE UPDATE OR DELETE ON warranty_cards FOR EACH ROW EXECUTE FUNCTION warranty_card_immutable()`,
  `CREATE TABLE IF NOT EXISTS warranty_state(id INT PRIMARY KEY DEFAULT 1,last_history_id BIGINT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT now())`,
  `INSERT INTO warranty_state(id,last_history_id) VALUES(1,0) ON CONFLICT(id) DO NOTHING`
],{logger:app.log});
await installDocumentVersionSchema(pool,{logger:app.log});

async function warrantyDays(requestId) {
  try {
    const z = (await q(`SELECT max(pb.warranty_days)::int d
      FROM request_quote_lines l
      JOIN pricebook pb ON pb.id=l.ref_id
      WHERE l.request_id=$1 AND l.line_type='WORK'`, [requestId])).rows[0];
    if (Number(z?.d) > 0) return Number(z.d);
  } catch {}
  return 90;
}

async function issue(requestId) {
  const r = (await q(`SELECT r.*,c.name customer_name,c.phone,c.address,e.category,e.brand,e.model,e.serial_number
    FROM requests r JOIN customers c ON c.id=r.customer_id
    LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id
    WHERE r.id=$1 AND r.deleted_at IS NULL`, [requestId])).rows[0];
  if (!r || r.status !== 'CLOSED' || !r.closed_at || !r.warranty_until || Number(r.paid) + 0.01 < Number(r.total)) return null;

  let card = (await q('SELECT * FROM warranty_cards WHERE request_id=$1', [requestId])).rows[0];
  if (!card) {
    const days = Math.max(1,Math.ceil((new Date(r.warranty_until)-new Date(r.closed_at))/86400000));
    const token = crypto.randomBytes(24).toString('hex');
    const [works,parts]=await Promise.all([
      q('SELECT id,name,qty,unit_price,direct_cost,performed_by FROM request_works WHERE request_id=$1 ORDER BY id',[requestId]),
      q("SELECT id,name,qty,sale_price,purchase_price,status FROM parts WHERE request_id=$1 AND status<>'CANCELLED' ORDER BY id",[requestId])
    ]);
    const snapshot={request:{id:r.id,number:r.number,customer_name:r.customer_name,phone:r.phone,address:r.address,category:r.category,brand:r.brand,model:r.model,serial_number:r.serial_number,engineer_id:r.engineer_id,engineer_name:r.engineer_name,total:r.total,paid:r.paid,closed_at:r.closed_at,warranty_until:r.warranty_until},works:works.rows,parts:parts.rows,warranty_days:days};
    const contentHash=crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    card = (await q(`INSERT INTO warranty_cards(request_id,token,warranty_days,warranty_until,snapshot,content_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO NOTHING RETURNING *`, [requestId, token, days, r.warranty_until,snapshot,contentHash])).rows[0];
    if(!card)card=(await q('SELECT * FROM warranty_cards WHERE request_id=$1',[requestId])).rows[0];
    const no = `WARRANTY-${requestId}-V01`;
    await q(`INSERT INTO generated_documents(request_id,document_type,document_number,version,snapshot,content_hash)
      SELECT $1,'WARRANTY',$2,1,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM generated_documents WHERE request_id=$1 AND document_type='WARRANTY')`, [requestId, no,snapshot,contentHash]);
    await q(`INSERT INTO request_history(request_id,action,details)
      VALUES($1,'WARRANTY_ISSUED',$2)`, [requestId, { warranty_days: days, warranty_until: card.warranty_until, document_number: no,content_hash:contentHash }]);
  }

  const url = `${baseUrl()}/warranty/${card.token}`;
  const body = `Здравствуйте, ${r.customer_name}! Ремонт по заказу ${r.number} завершён. Гарантийный талон PROFI24: ${url}. Гарантия действует до ${new Date(card.warranty_until).toLocaleDateString('ru-RU')}.`;
  try {
    await q(`INSERT INTO message_queue(request_id,template_code,channel,audience,recipient,body,status,dedupe_key)
      VALUES($1,'CUSTOMER_WARRANTY','WHATSAPP','CUSTOMER',$2,$3,$4,$5)
      ON CONFLICT(dedupe_key) DO NOTHING`, [requestId, r.phone, body, r.phone ? 'QUEUED' : 'WAITING_RECIPIENT', `warranty:${requestId}`]);
  } catch (e) {
    app.log.warn({ err: e }, 'message queue unavailable');
  }
  return card;
}

async function syncPayments() {
  const state = (await q('SELECT last_history_id FROM warranty_state WHERE id=1')).rows[0];
  const rows = (await q(`SELECT id,request_id FROM request_history
    WHERE id>$1 AND action='REQUEST_CLOSED' ORDER BY id ASC LIMIT 500`, [state.last_history_id])).rows;
  let last = Number(state.last_history_id || 0);
  for (const h of rows) {
    try { await issue(h.request_id);last = Math.max(last, Number(h.id)); } catch (e) { app.log.error(e);break; }
  }
  await q('UPDATE warranty_state SET last_history_id=$1,updated_at=now() WHERE id=1', [last]);
}

app.get('/health', async () => { await q('SELECT 1'); return { ok: true, service: 'profi24-warranty', version: '1.0.1' }; });

app.get('/public/warranty/:token', async (req, reply) => {
  const card = (await q('SELECT * FROM warranty_cards WHERE token=$1', [req.params.token])).rows[0];
  if (!card) return reply.code(404).send({ data: null, error: { code: 'NOT_FOUND', message: 'Гарантийный талон не найден' } });
  const r = (await q(`SELECT r.number,r.total,r.paid,r.closed_at,r.warranty_until,c.name customer_name,c.phone,
      e.category,e.brand,e.model,e.serial_number,eng.name engineer_name
    FROM requests r JOIN customers c ON c.id=r.customer_id
    LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id
    WHERE r.id=$1 AND r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at IS NOT NULL AND r.paid+0.01>=r.total`, [card.request_id])).rows[0];
  if (!r) return reply.code(404).send({ data: null, error: { code: 'WARRANTY_INACTIVE', message: 'Гарантийный талон недействителен' } });
  if(card.snapshot?.request)return {data:{...card,...card.snapshot.request,works:card.snapshot.works||[],parts:card.snapshot.parts||[]}};
  const [works, parts] = await Promise.all([q('SELECT name,qty,unit_price FROM request_works WHERE request_id=$1 ORDER BY id', [card.request_id]),q("SELECT name,qty,sale_price FROM parts WHERE request_id=$1 AND status<>'CANCELLED' ORDER BY id", [card.request_id])]);
  return { data: { ...card, ...r, works: works.rows, parts: parts.rows } };
});

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await syncPayments(); } catch (e) { app.log.error(e); } finally { busy = false; }
}, 5000);
await syncPayments();

const close = async () => { try { await pool.end(); } finally { process.exit(0); } };
process.on('SIGTERM', close);
process.on('SIGINT', close);
app.listen({ port: Number(process.env.PORT || 8101), host: '0.0.0.0' });
