export const faultModelStatements=[
`CREATE TABLE IF NOT EXISTS fault_catalog(
 id SERIAL PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 category TEXT NOT NULL DEFAULT '*',
 subsystem TEXT NOT NULL DEFAULT 'GENERAL',
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 created_by INT REFERENCES users(id),
 updated_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_fault_catalog_category_active ON fault_catalog(category,active,name)`,
`CREATE TABLE IF NOT EXISTS fault_cause_catalog(
 id SERIAL PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 created_by INT REFERENCES users(id),
 updated_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_fault_cause_active ON fault_cause_catalog(active,name)`,
`CREATE TABLE IF NOT EXISTS repair_action_catalog(
 id SERIAL PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 created_by INT REFERENCES users(id),
 updated_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_repair_action_active ON repair_action_catalog(active,name)`,
`CREATE TABLE IF NOT EXISTS request_fault_classifications(
 request_id INT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
 fault_id INT NOT NULL REFERENCES fault_catalog(id),
 cause_id INT NOT NULL REFERENCES fault_cause_catalog(id),
 action_id INT NOT NULL REFERENCES repair_action_catalog(id),
 note TEXT NOT NULL DEFAULT '',
 classified_by INT NOT NULL REFERENCES users(id),
 updated_by INT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_request_fault_fault ON request_fault_classifications(fault_id,cause_id,action_id)`,
`CREATE TABLE IF NOT EXISTS request_fault_classification_history(
 id BIGSERIAL PRIMARY KEY,
 request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
 fault_id INT NOT NULL REFERENCES fault_catalog(id),
 cause_id INT NOT NULL REFERENCES fault_cause_catalog(id),
 action_id INT NOT NULL REFERENCES repair_action_catalog(id),
 note TEXT NOT NULL DEFAULT '',
 changed_by INT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_request_fault_history_request ON request_fault_classification_history(request_id,created_at DESC)`,
`CREATE OR REPLACE FUNCTION guard_fault_history_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fault classification history is append-only' USING ERRCODE='P2411'; END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS guard_fault_history ON request_fault_classification_history`,
`CREATE TRIGGER guard_fault_history BEFORE UPDATE OR DELETE ON request_fault_classification_history FOR EACH ROW EXECUTE FUNCTION guard_fault_history_append_only()`,
`INSERT INTO fault_catalog(code,category,subsystem,name,description) VALUES
 ('NO_POWER','*','ELECTRICAL','Не включается','Нет питания или аппарат не запускается'),
 ('CONTROL_ERROR','*','CONTROL','Ошибка управления/код ошибки','Ошибка платы, интерфейса или управляющей логики'),
 ('NO_DRAIN','*','HYDRAULIC','Не сливает','Нарушен слив жидкости'),
 ('NO_FILL','*','HYDRAULIC','Не набирает воду','Нарушена подача воды'),
 ('LEAK','*','HYDRAULIC','Протечка','Утечка воды или рабочей жидкости'),
 ('NO_HEAT_COOL','*','THERMAL','Не греет/не охлаждает','Не достигается требуемая температура'),
 ('NO_ROTATION','*','MECHANICAL','Не вращает/не двигается','Не работает привод или механика'),
 ('NOISE_VIBRATION','*','MECHANICAL','Шум/вибрация','Повышенный шум, биение или вибрация'),
 ('SENSOR_ERROR','*','SENSORS','Ошибка датчика','Некорректный сигнал датчика или цепи измерения'),
 ('OTHER','*','GENERAL','Другая неисправность','Структурированная прочая неисправность')
 ON CONFLICT(code) DO NOTHING`,
`INSERT INTO fault_cause_catalog(code,name,description) VALUES
 ('COMPONENT_FAILURE','Отказ компонента','Электрический, электронный или механический отказ детали'),
 ('WEAR','Износ','Естественный эксплуатационный износ'),
 ('BLOCKAGE_CONTAMINATION','Засор/загрязнение','Засор, накипь, загрязнение или отложения'),
 ('LEAKAGE','Утечка/разгерметизация','Потеря герметичности контура или соединения'),
 ('CONTACT_WIRING','Контакт/проводка','Обрыв, плохой контакт, разъём или проводка'),
 ('POWER_SUPPLY','Питание','Внешнее или внутреннее нарушение питания'),
 ('MISUSE_EXTERNAL','Внешняя причина/эксплуатация','Условия эксплуатации или внешнее воздействие'),
 ('UNKNOWN','Причина не установлена','Причина подтверждённо не определена')
 ON CONFLICT(code) DO NOTHING`,
`INSERT INTO repair_action_catalog(code,name,description) VALUES
 ('REPLACE_COMPONENT','Замена компонента','Неисправный компонент заменён'),
 ('REPAIR_COMPONENT','Ремонт компонента','Компонент восстановлен'),
 ('CLEAN_SERVICE','Очистка/обслуживание','Выполнена очистка, промывка или сервисное обслуживание'),
 ('RESTORE_WIRING','Восстановление проводки','Восстановлены контакты, разъёмы или проводка'),
 ('SEAL_LEAK','Устранение утечки','Восстановлена герметичность'),
 ('REFRIGERANT_SERVICE','Работы с хладагентом','Вакуумирование, дозаправка или работы с холодильным контуром'),
 ('ADJUST_CALIBRATE','Регулировка/калибровка','Выполнена настройка, регулировка или калибровка'),
 ('SOFTWARE_RESET','ПО/сброс','Обновление, настройка программного обеспечения или сброс'),
 ('NO_REPAIR','Без ремонта','Ремонт не выполнялся')
 ON CONFLICT(code) DO NOTHING`
];

export async function prepareFaultModelSchema(pool){for(const sql of faultModelStatements)await pool.query(sql)}
