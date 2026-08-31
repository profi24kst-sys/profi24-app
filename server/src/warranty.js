import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import pg from 'pg';
import crypto from 'crypto';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(helmet, { contentSecurityPolicy: false });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (s, p = []) => pool.query(s, p);
const baseUrl = () => (process.env.PUBLIC_BASE_URL || process.env.CORS_ORIGIN?.split(',')[0] || 'http://localhost:5173').replace(/\/$/, '');

for (const s of [
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
  `CREATE TABLE IF NOT EXISTS warranty_state(id INT PRIMARY KEY DEFAULT 1,last_history_id BIGINT NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT now())`,
  `INSERT INTO warranty_state(id,last_history_id) VALUES(1,0) ON CONFLICT(id) DO NOTHING`
]) await q(s);

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
    LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.id=$1`, [requestId])).rows[0];
  if (!r || Number(r.total) <= 0 || Number(r.paid) + 0.01 < Number(r.total)) return null;

  let card = (await q('SELECT * FROM warranty_cards WHERE request_id=$1', [requestId])).rows[0];
  if (!card) {
    const days = await warrantyDays(requestId);
    const token = crypto.randomBytes(24).toString('hex');
    card = (await q(`INSERT INTO warranty_cards(request_id,token,warranty_days,warranty_until)
      VALUES($1,$2,$3,CURRENT_DATE+$3::int) RETURNING *`, [requestId, token, days])).rows[0];
    await q('UPDATE requests SET warranty_until=$1 WHERE id=$2', [card.warranty_until, requestId]);
    const no = `WARRANTY-${requestId}-${Date.now().toString().slice(-8)}`;
    await q(`INSERT INTO generated_documents(request_id,document_type,document_number)
      VALUES($1,'WARRANTY',$2)`, [requestId, no]);
    await q(`INSERT INTO request_history(request_id,action,details)
      VALUES($1,'WARRANTY_ISSUED',$2)`, [requestId, { warranty_days: days, warranty_until: card.warranty_until, document_number: no }]);
  }

  const url = `${baseUrl()}/warranty/${card.token}`;
  const body = `Здравствуйте, ${r.customer_name}! Оплата по заказу ${r.number} получена полностью. Гарантийный талон PROFI24: ${url}. Гарантия действует до ${new Date(card.warranty_until).toLocaleDateString('ru-RU')}.`;
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
    WHERE id>$1 AND action='PAYMENT_RECEIVED' ORDER BY id ASC LIMIT 500`, [state.last_history_id])).rows;
  let last = Number(state.last_history_id || 0);
  for (const h of rows) {
    last = Math.max(last, Number(h.id));
    try { await issue(h.request_id); } catch (e) { app.log.error(e); }
  }
  const maxAny = (await q('SELECT COALESCE(max(id),$1)::bigint id FROM request_history', [last])).rows[0].id;
  await q('UPDATE warranty_state SET last_history_id=$1,updated_at=now() WHERE id=1', [maxAny]);
}

app.get('/health', async () => { await q('SELECT 1'); return { ok: true, service: 'profi24-warranty', version: '1.0.0' }; });

app.get('/public/warranty/:token', async (req, reply) => {
  const card = (await q('SELECT * FROM warranty_cards WHERE token=$1', [req.params.token])).rows[0];
  if (!card) return reply.code(404).send({ data: null, error: { code: 'NOT_FOUND', message: 'Гарантийный талон не найден' } });
  const r = (await q(`SELECT r.number,r.total,r.paid,r.closed_at,r.warranty_until,c.name customer_name,c.phone,
      e.category,e.brand,e.model,e.serial_number,eng.name engineer_name
    FROM requests r JOIN customers c ON c.id=r.customer_id
    LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users eng ON eng.id=r.engineer_id
    WHERE r.id=$1`, [card.request_id])).rows[0];
  const [works, parts] = await Promise.all([
    q('SELECT name,qty,unit_price FROM request_works WHERE request_id=$1 ORDER BY id', [card.request_id]),
    q('SELECT name,qty,sale_price FROM parts WHERE request_id=$1 ORDER BY id', [card.request_id])
  ]);
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
