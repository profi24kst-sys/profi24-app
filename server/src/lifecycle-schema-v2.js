export const lifecycleV2Statements=[
  `ALTER TABLE request_holds DROP CONSTRAINT IF EXISTS request_holds_hold_type_check`,
  `ALTER TABLE request_holds ADD CONSTRAINT request_holds_hold_type_check CHECK(hold_type IN ('WAITING_CUSTOMER','WAITING_APPROVAL','WAITING_PART','REPEAT_VISIT','EXTERNAL_SERVICE','WAITING_DELIVERY','OTHER')) NOT VALID`,
  `ALTER TABLE request_holds VALIDATE CONSTRAINT request_holds_hold_type_check`
];
