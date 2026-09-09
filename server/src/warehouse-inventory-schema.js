export const warehouseInventoryStatements=[
`CREATE TABLE IF NOT EXISTS warehouse_inventories(
 id BIGSERIAL PRIMARY KEY,
 number TEXT NOT NULL UNIQUE,
 branch_id INT NOT NULL REFERENCES branches(id),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','POSTED','CANCELLED')),
 note TEXT,
 document_reference TEXT,
 started_by INT NOT NULL REFERENCES users(id),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 posted_by INT REFERENCES users(id),
 posted_at TIMESTAMPTZ,
 cancelled_by INT REFERENCES users(id),
 cancelled_at TIMESTAMPTZ,
 cancel_reason TEXT
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_inventory_open_branch ON warehouse_inventories(branch_id) WHERE status='DRAFT'`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_inventories_branch_date ON warehouse_inventories(branch_id,started_at DESC)`,
`CREATE TABLE IF NOT EXISTS warehouse_inventory_lines(
 id BIGSERIAL PRIMARY KEY,
 inventory_id BIGINT NOT NULL REFERENCES warehouse_inventories(id) ON DELETE CASCADE,
 item_id INT NOT NULL REFERENCES warehouse_items(id),
 item_name TEXT NOT NULL,
 sku TEXT,
 oem_code TEXT,
 location TEXT,
 unit_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
 expected_quantity NUMERIC(14,3) NOT NULL CHECK(expected_quantity>=0),
 actual_quantity NUMERIC(14,3) CHECK(actual_quantity>=0),
 variance NUMERIC(14,3),
 snapshot_updated_at TIMESTAMPTZ NOT NULL,
 counted_by INT REFERENCES users(id),
 counted_at TIMESTAMPTZ,
 note TEXT,
 UNIQUE(inventory_id,item_id)
)`,
`CREATE INDEX IF NOT EXISTS idx_warehouse_inventory_lines_doc ON warehouse_inventory_lines(inventory_id,id)`,
`CREATE OR REPLACE FUNCTION warehouse_inventory_document_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Документы инвентаризации нельзя удалять' USING ERRCODE='P2401';
 END IF;
 IF OLD.status<>'DRAFT' THEN
   RAISE EXCEPTION 'Проведённый или отменённый документ инвентаризации нельзя изменять' USING ERRCODE='P2401';
 END IF;
 IF NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.started_by IS DISTINCT FROM OLD.started_by OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
   RAISE EXCEPTION 'Нельзя изменять реквизиты начатой инвентаризации' USING ERRCODE='P2401';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_warehouse_inventory_document_guard ON warehouse_inventories`,
`CREATE TRIGGER trg_warehouse_inventory_document_guard BEFORE UPDATE OR DELETE ON warehouse_inventories FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_document_guard()`,
`CREATE OR REPLACE FUNCTION warehouse_inventory_line_guard() RETURNS trigger AS $$
DECLARE doc_status TEXT;
BEGIN
 SELECT status INTO doc_status FROM warehouse_inventories WHERE id=COALESCE(NEW.inventory_id,OLD.inventory_id);
 IF doc_status IS DISTINCT FROM 'DRAFT' THEN
   RAISE EXCEPTION 'Строки проведённой или отменённой инвентаризации нельзя изменять' USING ERRCODE='P2401';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.inventory_id IS DISTINCT FROM OLD.inventory_id OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.expected_quantity IS DISTINCT FROM OLD.expected_quantity OR NEW.snapshot_updated_at IS DISTINCT FROM OLD.snapshot_updated_at OR NEW.item_name IS DISTINCT FROM OLD.item_name OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost) THEN
   RAISE EXCEPTION 'Учётный снимок строки инвентаризации неизменяем' USING ERRCODE='P2401';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_warehouse_inventory_line_guard ON warehouse_inventory_lines`,
`CREATE TRIGGER trg_warehouse_inventory_line_guard BEFORE INSERT OR UPDATE OR DELETE ON warehouse_inventory_lines FOR EACH ROW EXECUTE FUNCTION warehouse_inventory_line_guard()`
];
