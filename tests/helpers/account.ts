import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { BrowserContext } from 'playwright-core';

// Test workers spawn real servers with isolated SQLite databases.
process.env.BETTER_AUTH_SECRET ??= randomBytes(48).toString('base64');
const sessions = new Map<string,string>();
const plainFetch = globalThis.fetch;

export function testFetch(input:string | URL, options:RequestInit = {}) {
  const origin = new URL(input).origin;
  const cookie = sessions.get(origin);
  if (!cookie) return plainFetch(input,options);
  const headers = new Headers(options.headers);
  if (!headers.has('cookie')) headers.set('cookie',cookie);
  if (!headers.has('origin') && options.method && !['GET','HEAD'].includes(options.method)) headers.set('origin',origin);
  return plainFetch(input,{...options,headers});
}

export async function registerTestAccount(base:string, credentials = {email:'test-'+randomBytes(8).toString('hex')+'@example.test',password:randomBytes(9).toString('hex'),name:'Test workspace'}) {
  if (sessions.has(base)) return;
  const post = (endpoint:string) => plainFetch(base+'/api/auth/'+endpoint,{method:'POST',headers:{
    'content-type':'application/json',origin:base,
  },body:JSON.stringify(credentials)});
  const signup = await post('sign-up/email');
  assert.ok(signup.ok, await signup.text());
  const signin = await post('sign-in/email');
  assert.ok(signin.ok, await signin.text());
  const cookie = signin.headers.getSetCookie().map(line=>line.split(';')[0]).find(value=>value.startsWith('better-auth.session_token='));
  assert.ok(cookie,'Better Auth did not issue a session cookie');
  sessions.set(base,cookie);
}

export async function attachTestAccount(context:BrowserContext,base:string) {
  const cookie = sessions.get(base);
  assert.ok(cookie);
  const split = cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:base,httpOnly:true,sameSite:'Lax'}]);
}
