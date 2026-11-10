import { createHash, randomBytes } from 'node:crypto';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { newPasswordError } from '../../packages/shared/account';
import { db, id, now } from './storage';
import { guestLifetimeMs } from './guests';
import { deliverAccountMail, mailEnabled } from './mail-delivery';

export const upgradePath = '/api/auth/upgrade-guest';
export const completeUpgradePath = '/api/auth/complete-guest-upgrade';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export function migrateGuestUpgrade() {
  db.exec(`CREATE TABLE IF NOT EXISTS guest_upgrade_tokens (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, session_id TEXT NOT NULL,
    digest TEXT NOT NULL UNIQUE, email TEXT NOT NULL, password_hash TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
}
function queueUpgrade(userId:string,sessionId:string,email:string,password:string,origin:string) {
  setImmediate(()=>void (async()=>{
    const stamp=Date.now();
    db.prepare('DELETE FROM guest_upgrade_tokens WHERE expires_at<=?').run(stamp);
    if (!db.prepare('SELECT 1 FROM user WHERE id=? AND isAnonymous=1').get(userId)) return;
    if (db.prepare('SELECT 1 FROM user WHERE lower(trim(email))=?').get(email)) return;
    const token=randomBytes(32).toString('base64url');
    const hashed=digest(token);
    const saved=db.prepare(`INSERT INTO guest_upgrade_tokens VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,digest=excluded.digest,email=excluded.email,
      password_hash=excluded.password_hash,issued_at=excluded.issued_at,expires_at=excluded.expires_at
      WHERE guest_upgrade_tokens.issued_at<=?`).run(userId,sessionId,hashed,email,password,stamp,stamp+15*60_000,stamp-60_000);
    if (!saved.changes) return;
    const link=new URL('/',origin);
    link.hash=new URLSearchParams({account:'upgrade',token}).toString();
    try {await deliverAccountMail(email,'upgrade',link);}
    catch {
      db.prepare('DELETE FROM guest_upgrade_tokens WHERE digest=?').run(hashed);
      console.warn('[account-security] mail-delivery-failed upgrade');
    }
  })().catch(()=>console.warn('[account-security] mail-delivery-failed upgrade')));
}
function pendingUpgrade(userId:string,sessionId:string,hashed:string) {
  return db.prepare(`SELECT email,password_hash FROM guest_upgrade_tokens
    WHERE user_id=? AND session_id=? AND digest=? AND expires_at>?`).get(userId,sessionId,hashed,Date.now()) as
    {email:string;password_hash:string}|undefined;
}
const invalidUpgrade=()=>new APIError('BAD_REQUEST',{message:'链接无效、已过期或已使用，请重新申请。'});

const duplicateEmail = '该邮箱已注册，请直接登录';

const promote = db.transaction((userId:string, oldSessionId:string, newSessionId:string, email:string, passwordHash:string, expiresAt:Date,proof?:string) => {
  const current = db.prepare(`SELECT u.createdAt FROM user u JOIN session s ON s.userId=u.id
    WHERE u.id=? AND u.isAnonymous=1 AND s.id=? AND julianday(s.expiresAt)>julianday(?)`)
    .get(userId,oldSessionId,now()) as {createdAt:string}|undefined;
  if (!current || Date.parse(current.createdAt)+guestLifetimeMs<=Date.now()) {
    throw new APIError('UNAUTHORIZED',{message:'游客会话已过期，请重新登录。'});
  }
  if (proof && !pendingUpgrade(userId,oldSessionId,proof)) throw invalidUpgrade();
  if (db.prepare('SELECT 1 FROM user WHERE lower(trim(email))=?').get(email)) {
    throw new APIError('CONFLICT',{message:duplicateEmail});
  }

  // Retain the principal ID so every project and its dependent records stay attached.
  const name=email.split('@')[0];
  const changedAt=now();
  db.prepare('UPDATE user SET email=?,name=?,emailVerified=?,isAnonymous=0,emailVerificationRequired=0,updatedAt=? WHERE id=?').run(email,name,Number(Boolean(proof)),changedAt,userId);
  db.prepare('INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(id(),userId,'credential',userId,passwordHash,changedAt,changedAt);
  if (db.prepare('UPDATE session SET expiresAt=? WHERE id=? AND userId=?').run(expiresAt.toISOString(),newSessionId,userId).changes!==1) {
    throw new Error('无法建立正式会话。');
  }
  db.prepare('DELETE FROM session WHERE userId=? AND id<>?').run(userId,newSessionId);
  db.prepare('DELETE FROM guest_upgrade_tokens WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM guest_usage WHERE user_id=?').run(userId);
  return name;
});

export const guestUpgrade = (origin:string)=>({
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

      if (mailEnabled) {
        queueUpgrade(current.user.id,current.session.id,email,passwordHash,origin);
        return ctx.json({ok:true,pendingUpgrade:true});
      }
      return ctx.json({user:await finishUpgrade(ctx,current,email,passwordHash)});
    }),
    completeGuestUpgrade:createAuthEndpoint('/complete-guest-upgrade',{method:'POST',
      body:z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)})},async ctx=>{
      const current=await getSessionFromCtx(ctx,{disableRefresh:true,disableCookieCache:true});
      if (!current?.user.isAnonymous) throw new APIError('UNAUTHORIZED',{message:'请在申请时使用的游客会话中打开链接。'});
      const proof=digest(ctx.body.token);
      const pending=pendingUpgrade(current.user.id,current.session.id,proof);
      if (!pending) throw invalidUpgrade();
      return ctx.json({user:await finishUpgrade(ctx,current,pending.email,pending.password_hash,proof)});
    }),
  },
});

async function finishUpgrade(ctx:Parameters<typeof setSessionCookie>[0],
  current:NonNullable<Awaited<ReturnType<typeof getSessionFromCtx>>>,email:string,passwordHash:string,proof?:string) {
  // Better Auth mints the cookie credential. It stays undisclosed until the SQLite transaction commits.
  const staged=await ctx.context.internalAdapter.createSession(current.user.id);
  if (!staged) throw new Error('无法建立正式会话。');
  const expiresAt=new Date(Date.now()+ctx.context.sessionConfig.expiresIn*1000);
  let name:string;
  try {
    name=promote.immediate(current.user.id,current.session.id,staged.id,email,passwordHash,expiresAt,proof);
  } catch (error) {
    await ctx.context.internalAdapter.deleteSession(staged.token);
    throw error;
  }
  const user={...current.user,name,email,isAnonymous:false,emailVerified:Boolean(proof),emailVerificationRequired:false};
  await setSessionCookie(ctx,{session:{...staged,expiresAt},user});
  return user;
}
