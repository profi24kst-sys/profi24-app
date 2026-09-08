export const equipmentCustodyStatements=[
`CREATE TABLE IF NOT EXISTS equipment_custody_events(
 id BIGSERIAL PRIMARY KEY,
 request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL CHECK(event_type IN ('CUSTOMER_TO_OFFICE','OFFICE_TO_STORAGE','STORAGE_TO_ENGINEER','ENGINEER_TO_STORAGE','STORAGE_TO_OFFICE','STORAGE_TO_DELIVERY','DELIVERY_TO_CUSTOMER','OFFICE_TO_CUSTOMER')),
 from_holder TEXT CHECK(from_holder IS NULL OR from_holder IN ('CUSTOMER','OFFICE','STORAGE','ENGINEER','DELIVERY')),
 to_holder TEXT NOT NULL CHECK(to_holder IN ('CUSTOMER','OFFICE','STORAGE','ENGINEER','DELIVERY')),
 from_user_id INT REFERENCES users(id),
 to_user_id INT REFERENCES users(id),
 location_text TEXT,
 condition_text TEXT,
 accessories JSONB NOT NULL DEFAULT '[]'::jsonb,
 note TEXT,
 created_by INT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
)`,
`CREATE INDEX IF NOT EXISTS idx_equipment_custody_request ON equipment_custody_events(request_id,id DESC)`,
`CREATE INDEX IF NOT EXISTS idx_equipment_custody_to_user ON equipment_custody_events(to_user_id,id DESC)`,
`CREATE INDEX IF NOT EXISTS idx_equipment_custody_created ON equipment_custody_events(created_at DESC)`,
`CREATE OR REPLACE VIEW equipment_custody_current AS
 SELECT DISTINCT ON (e.request_id)
   e.id event_id,e.request_id,e.event_type,e.to_holder holder,e.to_user_id responsible_user_id,
   e.location_text,e.condition_text,e.accessories,e.note,e.created_by,e.created_at
 FROM equipment_custody_events e
 ORDER BY e.request_id,e.id DESC`
];
