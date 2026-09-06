export const warehouseBranchStatements=[
`ALTER TABLE warehouse_items ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
`UPDATE warehouse_items SET branch_id=(SELECT id FROM branches WHERE code='KST') WHERE branch_id IS NULL`,
`ALTER TABLE warehouse_items ALTER COLUMN branch_id SET NOT NULL`,
`ALTER TABLE warehouse_items DROP CONSTRAINT IF EXISTS warehouse_items_sku_key`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_item_branch_sku ON warehouse_items(branch_id,sku) WHERE sku IS NOT NULL`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_items_branch ON warehouse_items(branch_id,active,name)`,
`ALTER TABLE warehouse_movements ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
`UPDATE warehouse_movements m SET branch_id=i.branch_id FROM warehouse_items i WHERE i.id=m.item_id AND m.branch_id IS NULL`,
`ALTER TABLE warehouse_movements ALTER COLUMN branch_id SET NOT NULL`,
`ALTER TABLE warehouse_movements DROP CONSTRAINT IF EXISTS warehouse_movements_movement_type_check`,
`ALTER TABLE warehouse_movements ADD CONSTRAINT warehouse_movements_movement_type_check CHECK(movement_type IN ('RECEIPT','ISSUE','RETURN','INSTALL','WRITE_OFF','ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN'))`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_movements_branch ON warehouse_movements(branch_id,created_at DESC)`,
`ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
`UPDATE stock_reservations sr SET branch_id=i.branch_id FROM warehouse_items i WHERE i.id=sr.item_id AND sr.branch_id IS NULL`,
`ALTER TABLE stock_reservations ALTER COLUMN branch_id SET NOT NULL`,
`CREATE INDEX IF NOT EXISTS idx_stock_reservations_branch ON stock_reservations(branch_id,status,request_id)`,
`CREATE TABLE IF NOT EXISTS warehouse_transfers(
 id BIGSERIAL PRIMARY KEY,
 transfer_key TEXT NOT NULL UNIQUE,
 from_branch_id INT NOT NULL REFERENCES branches(id),
 to_branch_id INT NOT NULL REFERENCES branches(id),
 source_item_id INT NOT NULL REFERENCES warehouse_items(id),
 destination_item_id INT NOT NULL REFERENCES warehouse_items(id),
 quantity NUMERIC(14,3) NOT NULL CHECK(quantity>0),
 unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
 reason TEXT NOT NULL,
 document_reference TEXT NOT NULL,
 created_by INT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(from_branch_id<>to_branch_id)
)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_transfers_from ON warehouse_transfers(from_branch_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_transfers_to ON warehouse_transfers(to_branch_id,created_at DESC)`,
`CREATE OR REPLACE FUNCTION warehouse_item_branch_guard() RETURNS trigger AS $$
DECLARE active_count INT; inferred_branch INT;
BEGIN
 IF NEW.branch_id IS NULL THEN
   SELECT count(*),min(id) INTO active_count,inferred_branch FROM branches WHERE active=true;
   IF active_count=1 THEN NEW.branch_id:=inferred_branch; END IF;
 END IF;
 IF NEW.branch_id IS NULL OR NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.branch_id AND active=true) THEN
   RAISE EXCEPTION 'Филиал складской позиции не найден или отключён' USING ERRCODE='P2403';
 END IF;
 IF TG_OP='UPDATE' AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
   RAISE EXCEPTION 'Нельзя менять филиал складской позиции. Используйте документ перемещения.' USING ERRCODE='P2401';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_warehouse_item_branch_guard ON warehouse_items`,
`CREATE TRIGGER trg_warehouse_item_branch_guard BEFORE INSERT OR UPDATE OF branch_id ON warehouse_items FOR EACH ROW EXECUTE FUNCTION warehouse_item_branch_guard()`,
`CREATE OR REPLACE FUNCTION warehouse_movement_branch_guard() RETURNS trigger AS $$
DECLARE item_branch INT; request_branch INT;
BEGIN
 SELECT branch_id INTO item_branch FROM warehouse_items WHERE id=NEW.item_id;
 IF item_branch IS NULL THEN RAISE EXCEPTION 'Складская позиция не найдена' USING ERRCODE='P2403'; END IF;
 NEW.branch_id:=item_branch;
 IF NEW.engineer_id IS NOT NULL AND NEW.movement_type IN('ISSUE','RETURN','INSTALL') AND NOT EXISTS(
   SELECT 1 FROM users u JOIN user_branches ub ON ub.user_id=u.id
   WHERE u.id=NEW.engineer_id AND u.active=true AND u.role='ENGINEER' AND ub.branch_id=item_branch
 ) THEN
   RAISE EXCEPTION 'Инженер не относится к филиалу склада' USING ERRCODE='P2403';
 END IF;
 IF NEW.request_id IS NOT NULL AND NEW.movement_type='INSTALL' THEN
   SELECT branch_id INTO request_branch FROM requests WHERE id=NEW.request_id AND deleted_at IS NULL;
   IF request_branch IS DISTINCT FROM item_branch THEN
     RAISE EXCEPTION 'Запчасть должна устанавливаться со склада филиала заказа. Сначала оформите перемещение.' USING ERRCODE='P2403';
   END IF;
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_warehouse_movement_branch_guard ON warehouse_movements`,
`CREATE TRIGGER trg_warehouse_movement_branch_guard BEFORE INSERT ON warehouse_movements FOR EACH ROW EXECUTE FUNCTION warehouse_movement_branch_guard()`,
`CREATE OR REPLACE FUNCTION stock_reservation_branch_guard() RETURNS trigger AS $$
DECLARE item_branch INT; request_branch INT;
BEGIN
 SELECT branch_id INTO item_branch FROM warehouse_items WHERE id=NEW.item_id;
 SELECT branch_id INTO request_branch FROM requests WHERE id=NEW.request_id AND deleted_at IS NULL;
 IF item_branch IS NULL OR request_branch IS NULL OR item_branch IS DISTINCT FROM request_branch THEN
   RAISE EXCEPTION 'Резерв возможен только со склада филиала заказа' USING ERRCODE='P2403';
 END IF;
 NEW.branch_id:=item_branch;
 RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_stock_reservation_branch_guard ON stock_reservations`,
`CREATE TRIGGER trg_stock_reservation_branch_guard BEFORE INSERT OR UPDATE OF item_id,request_id ON stock_reservations FOR EACH ROW EXECUTE FUNCTION stock_reservation_branch_guard()`,
`CREATE OR REPLACE FUNCTION warehouse_audit_immutable() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'Проведённые складские документы и движения нельзя изменять или удалять' USING ERRCODE='P2401';
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_warehouse_movements_immutable ON warehouse_movements`,
`CREATE TRIGGER trg_warehouse_movements_immutable BEFORE UPDATE OR DELETE ON warehouse_movements FOR EACH ROW EXECUTE FUNCTION warehouse_audit_immutable()`,
`DROP TRIGGER IF EXISTS trg_warehouse_transfers_immutable ON warehouse_transfers`,
`CREATE TRIGGER trg_warehouse_transfers_immutable BEFORE UPDATE OR DELETE ON warehouse_transfers FOR EACH ROW EXECUTE FUNCTION warehouse_audit_immutable()`
];