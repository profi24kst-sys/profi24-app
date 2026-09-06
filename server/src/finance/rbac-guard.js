import {can,PERMISSIONS,isKnownRole} from '../rbac.js';

const P=PERMISSIONS;
const deny=(reply,message='Недостаточно финансовых прав')=>reply.code(403).send({data:null,error:{code:'FORBIDDEN',message}});

export function installFinanceRbacGuard(app,pool){
  app.addHook('preHandler',async(req,reply)=>{
    const route=req.routeOptions?.url||'';
    if(route==='/health'||!route.startsWith('/api/v1/'))return;
    try{await req.jwtVerify();}catch{return reply.code(401).send({data:null,error:{code:'UNAUTHORIZED',message:'Требуется авторизация'}})}
    const user=(await pool.query('SELECT id,name,role FROM users WHERE id=$1 AND active=true',[req.user.id])).rows[0];
    if(!user||!isKnownRole(user.role))return deny(reply,'Пользователь неактивен или роль не поддерживается');
    req.user=user;

    // Order-scoped finance workflows retain their stricter request/account checks in routes/service.
    // This keeps assigned-engineer purchase/expense flows possible without exposing the global ledger.
    if(route.includes('/requests/:'))return;

    let permission;
    if(req.method==='GET'||req.method==='HEAD'){
      permission=route==='/api/v1/audit'?P.FINANCE_AUDIT:P.FINANCE_VIEW;
    }else{
      permission=P.FINANCE_ADJUST;
    }
    if(!can(user.role,permission))return deny(reply);
  });
}
