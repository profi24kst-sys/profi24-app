export const ATTACHMENT_KINDS=Object.freeze([
  'DEFECT_PHOTO',
  'PHOTO_BEFORE',
  'NAMEPLATE',
  'PHOTO_AFTER',
  'RECEIPT',
  'OTHER'
]);

export const ATTACHMENT_KIND_SET=new Set(ATTACHMENT_KINDS);

export function isAttachmentKind(value){
  return ATTACHMENT_KIND_SET.has(String(value||'').toUpperCase());
}
