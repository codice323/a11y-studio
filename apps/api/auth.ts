import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { anonymous } from 'better-auth/plugins/anonymous';
import { z } from 'zod';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Request, Response, NextFunction } from 'express';
import { newPasswordError } from '../../packages/shared/account';
import { db } from './storage';
import { migrateOwnership } from './migrations/001-account-ownership';
import { checkEmailUniqueness, migrateAccountPolicy } from './migrations/002-account-policy';
import { guestLifetimeMs } from './guests';
import { completeUpgradePath, guestUpgrade, migrateGuestUpgrade, upgradePath } from './account-upgrade';
import { accountMailPlugin, migrateAccountMail, queueAccountMail } from './account-mail';
import { mailEnabled } from './mail-delivery';

const production = process.env.NODE_ENV === 'production';
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) throw new Error('请配置至少 32 字符的 BETTER_AUTH_SECRET。');
const port = Number(process.env.PORT || 4173);
const configured = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:'+port);
if (configured.origin !== configured.href.replace(/\/$/,'') || configured.username || configured.password ||
    (production && (!process.env.BETTER_AUTH_URL || configured.protocol !== 'https:')) ||
    (!production && !['http:','https:'].includes(configured.protocol))) {
  throw new Error('BETTER_AUTH_URL 必须是有效的站点 Origin，生产环境必须使用 HTTPS。');
}
const localHosts = ['localhost','127.0.0.1'];
const localOrigins = localHosts.flatMap(host => [port,5173].map(p => 'http://'+host+':'+p));
const trustedOrigins = [...new Set([configured.origin,...(production ? [] : localOrigins)])];
const allowedHosts = new Set(trustedOrigins.map(origin => new URL(origin).host));
if (production) for (const host of localHosts) allowedHosts.add(host+':'+port);

const signupPath = '/api/auth/sign-up/email';
const guestPath = '/api/auth/sign-in/anonymous';
const duplicateEmail = '该邮箱已注册，请直接登录';
const emailRegistered = (email:string) =>
  Boolean(db.prepare('SELECT 1 FROM user WHERE lower(trim(email))=?').get(email));

const mailPaths = ['/resend-verification','/confirm-email','/forgot-password','/complete-password-reset'].map(path=>'/api/auth'+path);
let revokeSession = (_id:string)=>{};
const options = {
  appName:'A11y Studio',
  logger:{level:'warn'},
  baseURL:configured.origin,
  secret,
  database:db,
  trustedOrigins,
  emailAndPassword:{
    // Keep Better Auth's login limit compatible with passwords from V1.
    enabled:true,autoSignIn:false,minPasswordLength:8,maxPasswordLength:128,
  },
  user:{additionalFields:{emailVerificationRequired:{type:'boolean',required:false,defaultValue:false,input:false}}},
  plugins:[
    accountMailPlugin(configured.origin,id=>revokeSession(id)),
    guestUpgrade(configured.origin),
    anonymous({generateName:()=> '游客',disableDeleteAnonymousUser:true}),
    {
      id:'a11y-account-policy',
      async onRequest(request) {
        const route = new URL(request.url).pathname;
        const passwordField = route === signupPath ? 'password' :
          ['/api/auth/change-password','/api/auth/reset-password','/api/auth/set-password'].includes(route) ? 'newPassword' : null;
        if (request.method !== 'POST' || !passwordField) return;
        // Runs after Better Auth's database-backed rate limit, before its endpoint validation.
        const body = await request.clone().json().catch(()=>null);
        if (!body || typeof body[passwordField] !== 'string') return;
        const error = newPasswordError(body[passwordField]);
        if (error) return {response:Response.json({message:error},{status:400})};
        if (route !== signupPath || typeof body.email !== 'string') return;
        const email = body.email.trim().toLowerCase();
        if (!z.email().safeParse(email).success) return {response:Response.json({message:'请输入有效邮箱。'},{status:400})};

        const headers = new Headers(request.headers);
        headers.delete('content-length');
        return {request:new Request(request.url,{method:'POST',headers,body:JSON.stringify({...body,email})})};
      },
    },
  ],
  databaseHooks:{user:{create:{before:async (user,ctx)=>{
    if (mailEnabled && ctx?.path==='/sign-up/email') return {data:{...user,emailVerificationRequired:true}};
  }}},session:{create:{before:async (session,ctx)=>{
    const started=ctx?.request?.headers.get('x-a11y-login-started');
    if (ctx?.path==='/sign-in/email' && started) {
      if (credentialChangedAfter(session.userId,started)) return false;
      return {data:{...session,credentialCheckedAt:started}};
    }
    const user = db.prepare('SELECT isAnonymous,createdAt FROM user WHERE id=?').get(session.userId) as
      {isAnonymous:number;createdAt:string}|undefined;
    if (user?.isAnonymous) return {data:{...session,expiresAt:new Date(new Date(user.createdAt).getTime()+guestLifetimeMs)}};
  }}}},
  session:{additionalFields:{credentialCheckedAt:{type:'string',required:false,input:false}},expiresIn:60*60*24*7,updateAge:60*60*24,cookieCache:{enabled:false}},
  rateLimit:{enabled:true,storage:'database',window:60,max:100,customRules:{
    '/sign-in/email':{window:60,max:5}, '/sign-up/email':{window:60,max:8},
    '/sign-in/anonymous':{window:3600,max:4}, '/upgrade-guest':{window:3600,max:5},'/complete-guest-upgrade':{window:60,max:8},
    '/resend-verification':{window:60,max:4},'/forgot-password':{window:60,max:4},
    '/confirm-email':{window:60,max:8},'/complete-password-reset':{window:60,max:8},
  }},
  advanced:{
    useSecureCookies:configured.protocol==='https:',
    ipAddress:{ipAddressHeaders:['x-a11y-client-ip']},
    defaultCookieAttributes:{httpOnly:true,sameSite:'lax'},
  },
} satisfies BetterAuthOptions;

const createAuth = () => betterAuth(options);
let auth: ReturnType<typeof createAuth>;

export async function initializeAccounts(onRevoke?:(id:string)=>void) {
  if (onRevoke) revokeSession=onRevoke;
  checkEmailUniqueness(db);
  const migrations = await getMigrations(options);
  await migrations.runMigrations();
  migrateOwnership(db);
  migrateAccountPolicy(db);
  migrateAccountMail();
  migrateGuestUpgrade();
  auth = createAuth();
}

function publicUser(user:{id:string;name:string;email:string;isAnonymous?:boolean|null;createdAt?:Date|string;emailVerified?:boolean;emailVerificationRequired?:boolean|null}) {
  if (!user.isAnonymous) return {id:user.id,name:user.name,email:user.email,
    ...(mailEnabled?{emailVerified:Boolean(user.emailVerified)}:{}),
    ...(user.emailVerificationRequired && !user.emailVerified ? {needsEmailVerification:true}:{}),
  };
  return {id:user.id,name:user.name,email:'',isGuest:true,expiresAt:
    new Date(new Date(user.createdAt!).getTime()+guestLifetimeMs).toISOString()};
}

const apiHandler = toNodeHandler(async request => {
  const route = new URL(request.url).pathname;
  const signupBody = route === signupPath ? request.clone() : undefined;
  const response = await auth.handler(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control','private, no-store');
  headers.delete('content-length');
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if ([signupPath,guestPath,upgradePath,completeUpgradePath,'/api/auth/sign-in/email','/api/auth/sign-out',...mailPaths].includes(route)) {
    console.info('[account-security]',route.slice('/api/auth/'.length),response.status);
  }
  if (route===signupPath && response.status!==429) {
    if (response.ok && payload?.user) {
      queueAccountMail('verify',payload.user.email,configured.origin,payload.user.id);
      return Response.json({ok:true,verificationRequired:mailEnabled},{headers});
    }
    if (payload?.code === 'FAILED_TO_CREATE_USER' || payload?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') {
      const body = await signupBody?.json().catch(()=>null);
      if (typeof body?.email === 'string' && emailRegistered(body.email.trim().toLowerCase())) {
        return Response.json({ok:true,verificationRequired:mailEnabled},{headers});
      }
    }
  }
  if (route===upgradePath && response.ok && payload?.pendingUpgrade) return Response.json({ok:true,pendingUpgrade:true},{headers});
  if ([signupPath,...mailPaths].includes(route) && response.status===400) {
    const safe=['密码至少需要 8 个字符','密码不能超过 20 个字符','请输入有效邮箱。','链接无效、已过期或已使用，请重新申请。'];
    return Response.json({error:safe.includes(payload?.message)?payload.message:
      (route.endsWith('/confirm-email') || route.endsWith('/complete-password-reset')?'链接无效、已过期或已使用，请重新申请。':'请检查填写内容。')},{status:400,headers});
  }
  if ([upgradePath,completeUpgradePath].includes(route) && !response.ok && [400,401,409].includes(response.status)) {
    const safe = ['请输入有效邮箱。','密码至少需要 8 个字符','密码不能超过 20 个字符',duplicateEmail,
      '游客会话已过期，请重新登录。','请先使用有效的游客会话。','请在申请时使用的游客会话中打开链接。',
      '链接无效、已过期或已使用，请重新申请。'];
    return Response.json({error:safe.includes(payload?.message)?payload.message:'无法升级账号，请检查填写内容。'},{status:response.status,headers});
  }
  if (!response.ok) {
    const error = response.status === 429 ? '操作过于频繁，请稍后再试。' :
      route.endsWith('/sign-in/email') ? '邮箱或密码不正确。' : '账号操作未完成，请检查输入后重试。';
    return Response.json({error},{status:response.status,headers});
  }
  if (!payload?.user) return Response.json(payload === null ? null : {ok:true,...(mailPaths.includes(route)?{mailAvailable:mailEnabled}:{})},{headers});
  return Response.json({user:publicUser(payload.user)},{headers});
});

function credentialChangedAfter(userId:string,stamp:string) {
  return Boolean(db.prepare(`SELECT 1 FROM account
    WHERE userId=? AND providerId='credential' AND updatedAt>?`).get(userId,stamp));
}

async function sessionFor(req:Request) {
  const account = await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableCookieCache:true,disableRefresh:true}});
  if (account?.user.isAnonymous && new Date(account.user.createdAt).getTime()+guestLifetimeMs <= Date.now()) return null;
  // Covers a password reset between a concurrent sign-in check and session insertion.
  if (account?.session.credentialCheckedAt && credentialChangedAfter(account.user.id,account.session.credentialCheckedAt)) return null;
  return account;
}

export function verifyRequest(req:Request,res:Response,next:NextFunction) {
  const host = req.get('host');
  const origin = req.get('origin');
  if (!host || !allowedHosts.has(host)) return res.status(403).json({error:'请求主机无效。'});
  if ((origin && !trustedOrigins.includes(origin)) || ['cross-site','same-site'].includes(req.get('sec-fetch-site')??'') ||
      (!['GET','HEAD','OPTIONS'].includes(req.method) && !origin)) {
    return res.status(403).json({error:'请求来源无效。'});
  }
  // Never accept a client-supplied IP header. A reverse proxy can apply per-client quotas at the edge.
  req.headers['x-a11y-client-ip'] = req.socket.remoteAddress;
  req.headers['x-a11y-login-started'] = new Date().toISOString();
  next();
}

const authMethods = new Set(['GET /api/auth/get-session','POST /api/auth/sign-in/email','POST /api/auth/sign-up/email','POST /api/auth/sign-out','POST /api/auth/sign-in/anonymous','POST '+upgradePath,'POST '+completeUpgradePath,...mailPaths.map(path=>'POST '+path)]);
export function authEndpoints(onSignOut:(sessionId:string)=>void) {
  return async (req:Request,res:Response,next:NextFunction) => {
    res.set('Cache-Control','private, no-store');
    if (!authMethods.has(req.method+' '+req.path)) return res.status(404).json({error:'接口不存在。'});
    try {
      if (production && !mailEnabled && [signupPath,upgradePath].includes(req.path)) {
        return res.status(503).json({error:'账号邮件服务尚未配置。'});
      }
      if ([signupPath,'/api/auth/sign-in/email',guestPath,upgradePath,completeUpgradePath,...mailPaths].includes(req.path)) {
        const size = Number(req.get('content-length') ?? 0);
        if (req.get('transfer-encoding') || !Number.isSafeInteger(size) || size>8192) {
          return res.status(413).json({error:'账号请求过大。'});
        }
        const current = await sessionFor(req);
        if ((req.path===guestPath && current) || ([signupPath,'/api/auth/sign-in/email'].includes(req.path) && current?.user.isAnonymous)) {
          return res.status(409).json({error:'请先退出当前会话。'});
        }
        // An expired cookie must not reach the anonymous plugin's post-sign-in hook,
        // where its cleanup would otherwise overwrite the fresh sign-in cookie.
        if (!current && [guestPath,'/api/auth/sign-in/email'].includes(req.path)) delete req.headers.cookie;
      }
      if (req.path==='/api/auth/get-session') {
        const current = await sessionFor(req);
        if (!current || current.user.isAnonymous) return res.json(current ? {user:publicUser(current.user)} : null);
      }
      if (req.path==='/api/auth/sign-out' || req.path===completeUpgradePath || (req.path===upgradePath && !mailEnabled)) {
        const current = await sessionFor(req);
        if (current) res.once('finish',() => { if (res.statusCode < 300) onSignOut(current.session.id); });
      }
      await apiHandler(req,res);
    } catch (error) { next(error); }
  };
}

export async function requireSession(req:Request,res:Response,next:NextFunction) {
  res.set('Cache-Control','private, no-store');
  try {
    const account = await sessionFor(req);
    if (!account) return res.status(401).json({code:'AUTH_REQUIRED',error:'请先登录。'});
    if (account.user.emailVerificationRequired && !account.user.emailVerified) {
      return res.status(403).json({code:'EMAIL_VERIFICATION_REQUIRED',error:'请先验证邮箱。'});
    }
    res.locals.account = account;
    next();
  } catch (error) { next(error); }
}

export function accountFor(res:Response) {
  return res.locals.account as NonNullable<Awaited<ReturnType<typeof sessionFor>>>;
}
