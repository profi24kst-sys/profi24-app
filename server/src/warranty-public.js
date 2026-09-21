const pick=(source,keys)=>Object.fromEntries(keys.filter(key=>source?.[key]!==undefined).map(key=>[key,source[key]]));

const requestFields=['number','customer_name','phone','category','brand','model','serial_number','engineer_name','total','paid','closed_at','warranty_until'];

export function publicWarrantyPayload(card,currentRequest,{works=[],parts=[]}={}){
 const snapshotRequest=card?.snapshot?.request||null;
 const request={...pick(currentRequest,requestFields),...pick(snapshotRequest,requestFields)};
 if(!request.engineer_name&&currentRequest?.engineer_name)request.engineer_name=currentRequest.engineer_name;
 const sourceWorks=card?.snapshot?.works||works||[];
 const sourceParts=card?.snapshot?.parts||parts||[];
 return {
  warranty_days:card?.warranty_days,
  issued_at:card?.issued_at,
  warranty_until:card?.warranty_until||request.warranty_until,
  ...request,
  works:sourceWorks.map(row=>pick(row,['name','qty','unit_price'])),
  parts:sourceParts.map(row=>pick(row,['name','qty','sale_price']))
 };
}
