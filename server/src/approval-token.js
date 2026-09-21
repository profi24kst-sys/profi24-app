import {createHash,createHmac,randomBytes} from 'node:crypto';

const secret=()=>process.env.APPROVAL_TOKEN_SECRET||process.env.JWT_SECRET||'dev-approval-secret-change-me';

export const approvalTokenHash=token=>createHash('sha256').update(String(token||'')).digest('hex');

export function approvalTokenFor(requestId,version,nonce){
  return createHmac('sha256',secret()).update(`${requestId}:${version}:${nonce}`).digest('base64url');
}

export function issueApprovalToken(requestId,version){
  const nonce=randomBytes(24).toString('base64url');
  const token=approvalTokenFor(requestId,version,nonce);
  return {nonce,token,token_hash:approvalTokenHash(token)};
}

export function publicApprovalToken(row){
  if(!row)return null;
  if(row.token_nonce)return approvalTokenFor(row.request_id,row.version,row.token_nonce);
  return row.token||null;
}
