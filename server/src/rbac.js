export const ROLE_CODES=Object.freeze(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE']);

export const ROLE_LABELS=Object.freeze({
  OWNER:'Собственник',
  SUPERVISOR:'Управляющий',
  ACCOUNTANT:'Бухгалтер',
  MANAGER:'Менеджер',
  ENGINEER:'Инженер',
  TRAINEE:'Стажёр'
});

const KNOWN=new Set(ROLE_CODES);
const ASSIGNED_ONLY=new Set(['ENGINEER','TRAINEE']);
const ALL_ORDERS=new Set(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER']);
const FINANCE_ADMIN=new Set(['OWNER','ACCOUNTANT']);
const FINANCE_VIEW=new Set(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER']);
const STAFF_ADMIN=new Set(['OWNER']);
const OPERATIONS_ADMIN=new Set(['OWNER','SUPERVISOR','MANAGER']);

// Compatibility map lets the new supervisor role use routes that were historically
// protected with MANAGER while we migrate each service to explicit permissions.
const LEGACY_INHERITANCE=Object.freeze({
  SUPERVISOR:new Set(['MANAGER']),
  ACCOUNTANT:new Set(),
  TRAINEE:new Set()
});

export function isKnownRole(role){return KNOWN.has(role)}
export function isAssignedOnly(role){return ASSIGNED_ONLY.has(role)}
export function canAccessAllOrders(role){return ALL_ORDERS.has(role)}
export function canAdminFinance(role){return FINANCE_ADMIN.has(role)}
export function canViewFinance(role){return FINANCE_VIEW.has(role)}
export function canAdminStaff(role){return STAFF_ADMIN.has(role)}
export function canManageOperations(role){return OPERATIONS_ADMIN.has(role)}
export function isTechnicalRole(role){return role==='ENGINEER'||role==='TRAINEE'}

export function roleAllowed(role,allowed=[]){
  if(allowed.includes(role))return true;
  const inherited=LEGACY_INHERITANCE[role];
  return Boolean(inherited&&allowed.some(x=>inherited.has(x)));
}

export function canMutateOrder(role,{service='',route='',method='GET'}={}){
  if(['GET','HEAD'].includes(method))return true;
  if(role==='OWNER'||role==='SUPERVISOR'||role==='MANAGER')return true;
  if(role==='ENGINEER')return true;
  if(role==='ACCOUNTANT'){
    // Accountant may register money against an order, but cannot alter repair state,
    // diagnosis, works, parts, scheduling or customer-facing communication.
    return service==='index2'&&/\/payment$/.test(route);
  }
  if(role==='TRAINEE'){
    // Trainee is intentionally restrictive until a mentor workflow is implemented.
    // Notes and evidence files are safe append-only collaboration actions.
    return /\/(notes|comment)$/.test(route)||(service==='documents'&&/\/files(?:\/|$)/.test(route));
  }
  return false;
}

export function roleDescriptor(role){
  if(!isKnownRole(role))return null;
  return {
    code:role,
    label:ROLE_LABELS[role],
    all_orders:canAccessAllOrders(role),
    assigned_only:isAssignedOnly(role),
    finance_view:canViewFinance(role),
    finance_admin:canAdminFinance(role),
    staff_admin:canAdminStaff(role),
    operations_admin:canManageOperations(role)
  };
}
