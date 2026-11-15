import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { newPasswordError } from '../../packages/shared/account';
import { db, id, now } from './storage';
import { guestLifetimeMs } from './guests';

export const upgradePath = '/api/auth/upgrade-guest';
const duplicateEmail = '该邮箱已注册，请直接登录';

const promote = db.transaction((userId:string, oldSessionId:string, newSessionId:string, email:string, passwordHash:string, expiresAt:Date) => {
  const current = db.prepare(`SELECT u.createdAt FROM user u JOIN session s ON s.userId=u.id
    WHERE u.id=? AND u.isAnonymous=1 AND s.id=? AND julianday(s.expiresAt)>julianday(?)`)
    .get(userId,oldSessionId,now()) as {createdAt:string}|undefined;
  if (!current || Date.parse(current.createdAt)+guestLifetimeMs<=Date.now()) {
    throw new APIError('UNAUTHORIZED',{message:'游客会话已过期，请重新登录。'});
  }
  if (db.prepare('SELECT 1 FROM user WHERE lower(trim(email))=?').get(email)) {
    throw new APIError('CONFLICT',{message:duplicateEmail});
  }

  // Retain the principal ID so every project and its dependent records stay attached.
  const name=email.split('@')[0];
  const changedAt=now();
  db.prepare('UPDATE user SET email=?,name=?,isAnonymous=0,updatedAt=? WHERE id=?').run(email,name,changedAt,userId);
  db.prepare('INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(id(),userId,'credential',userId,passwordHash,changedAt,changedAt);
  if (db.prepare('UPDATE session SET expiresAt=? WHERE id=? AND userId=?').run(expiresAt.toISOString(),newSessionId,userId).changes!==1) {
    throw new Error('无法建立正式会话。');
  }
  db.prepare('DELETE FROM session WHERE userId=? AND id<>?').run(userId,newSessionId);
  db.prepare('DELETE FROM guest_usage WHERE user_id=?').run(userId);
  return name;
});

export const guestUpgrade = {
  id:'a11y-guest-upgrade',
  endpoints:{
    upgradeGuest:createAuthEndpoint('/upgrade-guest',{method:'POST',body:z.object({email:z.string().max(254),password:z.string().max(128)})},async ctx=>{
      const current=await getSessionFromCtx(ctx,{disableRefresh:true,disableCookieCache:true});
      if (!current?.user.isAnonymous) throw new APIError('UNAUTHORIZED',{message:'请先使用有效的游客会话。'});
      const email=ctx.body.email.trim().toLowerCase();
      if (!z.email().safeParse(email).success) throw new APIError('BAD_REQUEST',{message:'请输入有效邮箱。'});
      const invalid=newPasswordError(ctx.body.password);
      if (invalid) throw new APIError('BAD_REQUEST',{message:invalid});
      const passwordHash=await ctx.context.password.hash(ctx.body.password);

      return ctx.json({user:await finishUpgrade(ctx,current,email,passwordHash)});
    }),
  },
};

async function finishUpgrade(ctx:Parameters<typeof setSessionCookie>[0],
  current:NonNullable<Awaited<ReturnType<typeof getSessionFromCtx>>>,email:string,passwordHash:string) {
  // Better Auth mints the cookie credential. It stays undisclosed until the SQLite transaction commits.
  const staged=await ctx.context.internalAdapter.createSession(current.user.id);
  if (!staged) throw new Error('无法建立正式会话。');
  const expiresAt=new Date(Date.now()+ctx.context.sessionConfig.expiresIn*1000);
  let name:string;
  try {
    name=promote.immediate(current.user.id,current.session.id,staged.id,email,passwordHash,expiresAt);
  } catch (error) {
    await ctx.context.internalAdapter.deleteSession(staged.token);
    throw error;
  }
  const user={...current.user,name,email,isAnonymous:false};
  await setSessionCookie(ctx,{session:{...staged,expiresAt},user});
  return user;
}
