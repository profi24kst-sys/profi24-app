export const ROLE_CODES=Object.freeze(['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE']);

export const ROLE_LABELS=Object.freeze({
  OWNER:'Собственник',
  SUPERVISOR:'Управляющий',
  ACCOUNTANT:'Бухгалтер',
  MANAGER:'Менеджер',
  ENGINEER:'Инженер',
  TRAINEE:'Стажёр'
});

export const PERMISSIONS=Object.freeze({
  ORDERS_VIEW_ALL:'orders.view.all',
  ORDERS_VIEW_ASSIGNED:'orders.view.assigned',
  ORDERS_CREATE:'orders.create',
  ORDERS_ASSIGN:'orders.assign',
  ORDERS_EDIT:'orders.edit',
  ORDERS_TECHNICAL:'orders.technical',
  ORDERS_NOTES:'orders.notes',
  ORDERS_FILES:'orders.files',
  ORDERS_CLOSE:'orders.close',
  ORDERS_CANCEL:'orders.cancel',
  FINANCE_VIEW:'finance.view',
  FINANCE_RECEIVE_PAYMENT:'finance.receive_payment',
  FINANCE_REFUND:'finance.refund',
  FINANCE_ADJUST:'finance.adjust',
  FINANCE_AUDIT:'finance.audit',
  CASH_SHIFTS_VIEW:'cash_shifts.view',
  CASH_SHIFTS_OPERATE:'cash_shifts.operate',
  CASH_SHIFTS_RECONCILE:'cash_shifts.reconcile',
  WAREHOUSE_VIEW:'warehouse.view',
  WAREHOUSE_RECEIVE:'warehouse.receive',
  WAREHOUSE_ISSUE:'warehouse.issue',
  WAREHOUSE_WRITEOFF:'warehouse.writeoff',
  PROCUREMENT_VIEW:'procurement.view',
  PROCUREMENT_MANAGE:'procurement.manage',
  BRANCHES_VIEW:'branches.view',
  BRANCHES_MANAGE:'branches.manage',
  STAFF_VIEW:'staff.view',
  STAFF_MANAGE:'staff.manage',
  ROLES_MANAGE:'roles.manage',
  ANALYTICS_VIEW:'analytics.view',
  PAYROLL_VIEW:'payroll.view',
  PAYROLL_MANAGE:'payroll.manage',
  OPERATIONS_MANAGE:'operations.manage',
  COMMUNICATIONS_MANAGE:'communications.manage',
  APPROVALS_MANAGE:'approvals.manage',
  DIRECTORY_DELETED_LOOKUP:'directory.deleted_lookup',
  DIRECTORY_DELETE:'directory.delete',
  ENGINEER_PERFORMANCE_VIEW:'engineer.performance.view'
});

const P=PERMISSIONS;
const ROLE_PERMISSION_MAP=Object.freeze({
  OWNER:new Set(Object.values(P)),
  SUPERVISOR:new Set([
    P.ORDERS_VIEW_ALL,P.ORDERS_CREATE,P.ORDERS_ASSIGN,P.ORDERS_EDIT,P.ORDERS_TECHNICAL,P.ORDERS_NOTES,P.ORDERS_FILES,P.ORDERS_CLOSE,P.ORDERS_CANCEL,
    P.FINANCE_VIEW,P.FINANCE_AUDIT,P.CASH_SHIFTS_VIEW,
    P.WAREHOUSE_VIEW,P.WAREHOUSE_RECEIVE,P.WAREHOUSE_ISSUE,P.WAREHOUSE_WRITEOFF,P.PROCUREMENT_VIEW,P.PROCUREMENT_MANAGE,
    P.BRANCHES_VIEW,P.BRANCHES_MANAGE,
    P.STAFF_VIEW,P.STAFF_MANAGE,P.ANALYTICS_VIEW,P.OPERATIONS_MANAGE,P.COMMUNICATIONS_MANAGE,P.APPROVALS_MANAGE,
    P.DIRECTORY_DELETED_LOOKUP,P.ENGINEER_PERFORMANCE_VIEW
  ]),
  ACCOUNTANT:new Set([
    P.ORDERS_VIEW_ALL,P.FINANCE_VIEW,P.FINANCE_RECEIVE_PAYMENT,P.FINANCE_REFUND,P.FINANCE_ADJUST,P.FINANCE_AUDIT,
    P.CASH_SHIFTS_VIEW,P.CASH_SHIFTS_OPERATE,P.CASH_SHIFTS_RECONCILE,
    P.WAREHOUSE_VIEW,P.PROCUREMENT_VIEW,P.BRANCHES_VIEW,P.PAYROLL_VIEW,P.PAYROLL_MANAGE
  ]),
  MANAGER:new Set([
    P.ORDERS_VIEW_ALL,P.ORDERS_CREATE,P.ORDERS_ASSIGN,P.ORDERS_EDIT,P.ORDERS_TECHNICAL,P.ORDERS_NOTES,P.ORDERS_FILES,P.ORDERS_CLOSE,P.ORDERS_CANCEL,
    P.FINANCE_VIEW,P.FINANCE_RECEIVE_PAYMENT,P.CASH_SHIFTS_VIEW,P.CASH_SHIFTS_OPERATE,
    P.WAREHOUSE_VIEW,P.WAREHOUSE_RECEIVE,P.WAREHOUSE_ISSUE,P.PROCUREMENT_VIEW,P.PROCUREMENT_MANAGE,P.BRANCHES_VIEW,
    P.OPERATIONS_MANAGE,P.COMMUNICATIONS_MANAGE,P.APPROVALS_MANAGE,P.DIRECTORY_DELETED_LOOKUP,P.ENGINEER_PERFORMANCE_VIEW
  ]),
  ENGINEER:new Set([
    P.ORDERS_VIEW_ASSIGNED,P.ORDERS_TECHNICAL,P.ORDERS_NOTES,P.ORDERS_FILES,P.APPROVALS_MANAGE,P.BRANCHES_VIEW
  ]),
  TRAINEE:new Set([
    P.ORDERS_VIEW_ASSIGNED,P.ORDERS_NOTES,P.ORDERS_FILES,P.BRANCHES_VIEW
  ])
});

const KNOWN=new Set(ROLE_CODES);
const ASSIGNED_ONLY=new Set(['ENGINEER','TRAINEE']);

// Temporary compatibility inheritance while legacy services are migrated to can().
const LEGACY_INHERITANCE=Object.freeze({
  SUPERVISOR:new Set(['MANAGER']),
  ACCOUNTANT:new Set(),
  TRAINEE:new Set()
});

export function isKnownRole(role){return KNOWN.has(role)}
export function can(role,permission){return Boolean(isKnownRole(role)&&ROLE_PERMISSION_MAP[role]?.has(permission))}
export function permissionsForRole(role){return isKnownRole(role)?Object.freeze([...ROLE_PERMISSION_MAP[role]]):Object.freeze([])}
export function isAssignedOnly(role){return ASSIGNED_ONLY.has(role)}
export function canAccessAllOrders(role){return can(role,P.ORDERS_VIEW_ALL)}
export function canAdminFinance(role){return can(role,P.FINANCE_ADJUST)}
export function canViewFinance(role){return can(role,P.FINANCE_VIEW)}
export function canAdminStaff(role){return can(role,P.ROLES_MANAGE)}
export function canManageOperations(role){return can(role,P.OPERATIONS_MANAGE)}
export function isTechnicalRole(role){return role==='ENGINEER'||role==='TRAINEE'}

export function roleAllowed(role,allowed=[]){
  if(allowed.includes(role))return true;
  const inherited=LEGACY_INHERITANCE[role];
  return Boolean(inherited&&allowed.some(x=>inherited.has(x)));
}

export function canMutateOrder(role,{service='',route='',method='GET'}={}){
  if(['GET','HEAD'].includes(method))return true;
  if(role==='OWNER'||role==='SUPERVISOR'||role==='MANAGER')return true;
  if(role==='ENGINEER'){
    if(/\/(payment|refund|schedule|assign|cancel|close)(?:\/|$)/.test(route))return false;
    return can(role,P.ORDERS_TECHNICAL)||can(role,P.ORDERS_NOTES)||can(role,P.ORDERS_FILES);
  }
  if(role==='ACCOUNTANT'){
    return service==='index2'&&/\/payment$/.test(route)&&can(role,P.FINANCE_RECEIVE_PAYMENT);
  }
  if(role==='TRAINEE'){
    return (/\/(notes|comment)$/.test(route)&&can(role,P.ORDERS_NOTES))||(service==='documents'&&/\/files(?:\/|$)/.test(route)&&can(role,P.ORDERS_FILES));
  }
  return false;
}

export function roleDescriptor(role){
  if(!isKnownRole(role))return null;
  return {
    code:role,
    label:ROLE_LABELS[role],
    permissions:permissionsForRole(role),
    all_orders:canAccessAllOrders(role),
    assigned_only:isAssignedOnly(role),
    finance_view:canViewFinance(role),
    finance_admin:canAdminFinance(role),
    staff_admin:canAdminStaff(role),
    operations_admin:canManageOperations(role)
  };
}
