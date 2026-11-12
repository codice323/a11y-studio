import { createHash, randomBytes } from 'node:crypto';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { z } from 'zod';
import { newPasswordError } from '../../packages/shared/account';
import { deliverAccountMail, mailEnabled } from './mail-delivery';
import { db, now } from './storage';

type Purpose = 'verify'|'reset';
const lifetimes = {verify:30*60_000,reset:15*60_000};
const digest = (token:string)=>createHash('sha256').update(token).digest('hex');
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const invalidLink = ()=>new APIError('BAD_REQUEST',{message:'链接无效、已过期或已使用，请重新申请。'});
const passwordAccount = "EXISTS (SELECT 1 FROM account a WHERE a.userId=u.id AND a.accountId=u.id AND a.providerId='credential')";
const canIssue = (purpose:Purpose)=>purpose==='verify' ? 'u.emailVerified=0' : 'u.emailVerified=1';

export function migrateAccountMail() {
  db.exec(`CREATE TABLE IF NOT EXISTS account_mail_tokens (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
    digest TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,purpose)
  )`);
  // Remove the short-lived OTP store from databases created by the previous iteration.
  db.exec('DROP TABLE IF EXISTS account_email_codes');
}

export function queueAccountMail(purpose:Purpose,address:string,origin:string,userId?:string) {
  if (!mailEnabled) return;
  // Account existence and provider timing are deliberately outside the request response.
  setImmediate(()=>void issue(purpose,address,origin,userId).catch(()=>{
    console.warn('[account-security] mail-delivery-failed',purpose);
  }));
}

async function issue(purpose:Purpose,email:string,origin:string,userId?:string) {
  const stamp=Date.now();
  const token=randomBytes(32).toString('base64url');
  const hashed=digest(token);
  const user=db.transaction(()=>{
    db.prepare('DELETE FROM account_mail_tokens WHERE expires_at<=?').run(stamp);
    const match=db.prepare(`SELECT u.id FROM user u WHERE u.email=? AND coalesce(u.isAnonymous,0)=0
      AND ${passwordAccount} AND ${canIssue(purpose)}`).get(email) as {id:string}|undefined;
    if (!match || (userId && userId!==match.id)) return;
    const result=db.prepare(`INSERT INTO account_mail_tokens VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id,purpose) DO UPDATE SET digest=excluded.digest,email=excluded.email,
      issued_at=excluded.issued_at,expires_at=excluded.expires_at
      WHERE account_mail_tokens.issued_at<=?`)
      .run(match.id,purpose,hashed,email,stamp,stamp+lifetimes[purpose],stamp-60_000);
    if (result.changes) return match;
  }).immediate();
  if (!user) return;
  const link=new URL('/',origin);
  // Fragments are not included in access logs or Referer headers.
  link.hash=new URLSearchParams({account:purpose,token}).toString();
  try {await deliverAccountMail(email,purpose,link);}
  catch (error) {
    db.prepare('DELETE FROM account_mail_tokens WHERE digest=?').run(hashed);
    throw error;
  }
}

function tokenOwner(purpose:Purpose,hashed:string) {
  return db.prepare(`SELECT t.user_id FROM account_mail_tokens t JOIN user u ON u.id=t.user_id
    WHERE t.digest=? AND t.purpose=? AND t.expires_at>? AND t.email=u.email
    AND coalesce(u.isAnonymous,0)=0 AND ${passwordAccount} AND ${canIssue(purpose)}`)
    .get(hashed,purpose,Date.now()) as {user_id:string}|undefined;
}

export function accountMailPlugin(origin:string,onRevoke:(sessionId:string)=>void) {
  return {
    id:'a11y-account-mail',
    endpoints:{
      resendVerification:createAuthEndpoint('/resend-verification',{method:'POST',body:z.object({email:z.string().max(254)})},async ctx=>{
        queueAccountMail('verify',ctx.body.email.trim().toLowerCase(),origin);
        return ctx.json({ok:true});
      }),
      verifyEmailLink:createAuthEndpoint('/confirm-email',{method:'POST',body:z.object({token:tokenSchema})},async ctx=>{
        const hashed=digest(ctx.body.token);
        db.transaction(()=>{
          const owner=tokenOwner('verify',hashed);
          if (!owner) throw invalidLink();
          db.prepare('UPDATE user SET emailVerified=1,emailVerificationRequired=0,updatedAt=? WHERE id=?').run(now(),owner.user_id);
          db.prepare("DELETE FROM account_mail_tokens WHERE user_id=? AND purpose='verify'").run(owner.user_id);
        }).immediate();
        return ctx.json({ok:true});
      }),
      requestPasswordRecovery:createAuthEndpoint('/forgot-password',{method:'POST',body:z.object({email:z.string().max(254)})},async ctx=>{
        queueAccountMail('reset',ctx.body.email.trim().toLowerCase(),origin);
        return ctx.json({ok:true});
      }),
      resetPasswordLink:createAuthEndpoint('/complete-password-reset',{method:'POST',
        body:z.object({token:tokenSchema,newPassword:z.string().max(128)})},async ctx=>{
        const invalid=newPasswordError(ctx.body.newPassword);
        if (invalid) throw new APIError('BAD_REQUEST',{message:invalid});
        const hashed=digest(ctx.body.token);
        if (!tokenOwner('reset',hashed)) throw invalidLink();
        const password=await ctx.context.password.hash(ctx.body.newPassword);
        const revoked=db.transaction(()=>{
          const owner=tokenOwner('reset',hashed);
          if (!owner) throw invalidLink();
          const updated=db.prepare(`UPDATE account SET password=?,updatedAt=?
            WHERE userId=? AND accountId=? AND providerId='credential'`).run(password,now(),owner.user_id,owner.user_id);
          if (updated.changes!==1) throw invalidLink();
          const sessions=db.prepare('SELECT id FROM session WHERE userId=?').all(owner.user_id) as {id:string}[];
          db.prepare('DELETE FROM session WHERE userId=?').run(owner.user_id);
          db.prepare("DELETE FROM account_mail_tokens WHERE user_id=? AND purpose='reset'").run(owner.user_id);
          return sessions;
        }).immediate();
        for (const {id} of revoked) onRevoke(id);
        return ctx.json({ok:true});
      }),
    },
  };
}
