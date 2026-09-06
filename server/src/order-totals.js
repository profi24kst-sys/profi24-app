import {requireOrder} from './access.js';

// PostgreSQL NUMERIC performs the calculation; do not round each line in JavaScript.
export async function recalculateOrder(c, requestId) {
  await requireOrder(c, null, requestId, {mutable:true,lock:true});
  const row = (await c.query(`UPDATE requests r SET
    total=GREATEST(0,COALESCE((SELECT sum(qty*unit_price) FROM request_works WHERE request_id=r.id),0)
      +COALESCE((SELECT sum(qty*sale_price) FROM parts WHERE request_id=r.id AND status<>'CANCELLED'),0)-COALESCE(r.discount_amount,0)),
    direct_cost=COALESCE((SELECT sum(qty*direct_cost) FROM request_works WHERE request_id=r.id),0)
      +COALESCE((SELECT sum(qty*purchase_price) FROM parts WHERE request_id=r.id AND status<>'CANCELLED'),0),
    updated_at=now() WHERE r.id=$1 RETURNING total,direct_cost`, [requestId])).rows[0];
  return {total:Number(row.total),direct_cost:Number(row.direct_cost),cost:Number(row.direct_cost)};
}
