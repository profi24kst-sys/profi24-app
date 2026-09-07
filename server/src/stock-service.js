import {accessError} from './access.js';

export async function lockStock(c, id) {
  const item=(await c.query('SELECT * FROM warehouse_items WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!item || !item.active) throw accessError('NOT_FOUND','Запчасть не найдена',404);
  return item;
}
export async function availableStock(c,item,requestId=null) {
  const row=(await c.query(`SELECT COALESCE(sum(quantity),0) reserved FROM stock_reservations
    WHERE item_id=$1 AND status='ACTIVE' AND ($2::int IS NULL OR request_id IS DISTINCT FROM $2)`,[item.id,requestId])).rows[0];
  return Number(item.quantity)-Number(row.reserved);
}
export async function requireStock(c,item,quantity,requestId=null) {
  if(!Number.isFinite(Number(quantity))||Number(quantity)<=0)throw accessError('VALIDATION','Количество должно быть положительным числом',422);
  const available=await availableStock(c,item,requestId);
  if(available+0.000001<Number(quantity))throw accessError('NO_FREE_STOCK',`Свободно ${Math.max(0,available)}. Остальное зарезервировано под заказы.`);
  return available;
}
export async function consumeReservations(c,requestId,itemId,quantity) {
  const rows=(await c.query("SELECT * FROM stock_reservations WHERE request_id=$1 AND item_id=$2 AND status='ACTIVE' ORDER BY id FOR UPDATE",[requestId,itemId])).rows;
  let left=Number(quantity);
  for(const row of rows){
    if(left<=0)break;
    const used=Math.min(left,Number(row.quantity));left-=used;
    if(used===Number(row.quantity))await c.query("UPDATE stock_reservations SET status='CONSUMED',released_at=now() WHERE id=$1",[row.id]);
    else await c.query('UPDATE stock_reservations SET quantity=quantity-$1 WHERE id=$2',[used,row.id]);
  }
}
