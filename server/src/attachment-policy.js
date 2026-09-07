export const ATTACHMENT_KINDS=Object.freeze([
  'DEFECT_PHOTO',
  'PHOTO_BEFORE',
  'NAMEPLATE',
  'PHOTO_AFTER',
  'RECEIPT',
  'OTHER'
]);

const ATTACHMENT_KIND_ALIASES=Object.freeze({
  DEFECT:'DEFECT_PHOTO',
  AFTER:'PHOTO_AFTER'
});

export const ATTACHMENT_KIND_SET=new Set(ATTACHMENT_KINDS);

export function normalizeAttachmentKind(value){
  const kind=String(value||'OTHER').toUpperCase();
  return ATTACHMENT_KIND_ALIASES[kind]||kind;
}

export function isAttachmentKind(value){
  return ATTACHMENT_KIND_SET.has(normalizeAttachmentKind(value));
}
