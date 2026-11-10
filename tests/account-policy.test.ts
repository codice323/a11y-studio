import './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { hashPassword } from 'better-auth/crypto';
import { chromium } from 'playwright-core';
import { checkEmailUniqueness } from '../apps/api/migrations/002-account-policy';

test('旧邮箱冲突在迁移前中止，保留原记录',()=>{
  const db=new Database(':memory:');
  try {
    db.exec("CREATE TABLE user(email TEXT); INSERT INTO user VALUES ('Example@example.test'),(' example@example.test ');");
    assert.throws(()=>checkEmailUniqueness(db),/历史重复邮箱/);
    assert.equal(db.prepare('SELECT count(*) FROM user').pluck().get(),2);
  } finally {db.close();}
});

test('Chrome 验证登录、注册边界、游客隔离、额度、过期和清理', {timeout:120_000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'a11y-account-policy-'));
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const base='http://127.0.0.1:'+port;
  const upstream=createHttpServer((_request,response)=>{
    response.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><html lang="zh"><title>游客 URL</title><h1>游客 URL</h1></html>');
  }).listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const service=spawn(process.execPath,['--require','./tests/helpers/url-upstream.cjs','--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),
    A11Y_TEST_UPSTREAM_PORT:String((upstream.address() as AddressInfo).port),
    A11Y_DATA_DIR:dir,BETTER_AUTH_URL:base,AI_API_KEY:''},stdio:['ignore','ignore','pipe']});
  let diagnostics='';
  service.stderr.on('data',data=>{diagnostics+=data;});
  const stop=async()=>{
    if (service.exitCode!==null || service.signalCode!==null) return;
    const exit=once(service,'exit');
    service.kill();
    const force=setTimeout(()=>service.kill('SIGKILL'),2500);
    await exit;
    clearTimeout(force);
  };
  try {
    for(let i=0;!(await fetch(base+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error(diagnostics || '服务启动超时');
      await delay(100);
    }
    const db=new Database(path.join(dir,'studio.sqlite'));
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const evidence=process.env.ACCOUNT_V11_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence,{recursive:true});
    try {
      const [member,guestA,guestB]=await Promise.all(Array.from({length:3},()=>browser.newContext({viewport:{width:1280,height:800}})));
      const form=await member.newPage();
      const title=form.getByRole('heading',{name:'登录',exact:true});
      const submit=(route:string,data:object,context=member)=>context.request.post(base+'/api/'+route,{data,headers:{origin:base}});
      const signup=(email:string,password:string)=>submit('auth/sign-up/email',{email,password,name:'测试账号'});
      const snap=async(page:typeof form,name:string)=>{if(evidence) await page.screenshot({path:path.join(evidence,name)});};
      await form.goto(base);
      await title.waitFor();
      await snap(form,'01-login.png');
      await form.getByRole('button',{name:'前往注册'}).click();
      async function fillSignup(email:string,password:string) {
        await form.getByLabel('邮箱',{exact:true}).fill(email);
        await form.getByLabel('密码',{exact:true}).fill(password);
        await form.getByLabel('确认密码',{exact:true}).fill(password);
        await form.getByRole('button',{name:'注册',exact:true}).click();
      }
      for (const [length,error] of [[7,'密码至少需要 8 个字符'],[21,'密码不能超过 20 个字符']] as const) {
        await fillSignup('boundary@example.test','x'.repeat(length));
        assert.equal(await form.getByRole('alert').innerText(),error);
        const reply=await signup('boundary@example.test','x'.repeat(length));
        assert.equal(reply.status(),400);
        assert.equal((await reply.json()).error,error);
      }
      await fillSignup('Boundary@example.test','x'.repeat(8));
      await title.waitFor();
      await form.getByRole('button',{name:'前往注册'}).click();
      await fillSignup('boundary@example.test','x'.repeat(8));
      await form.getByText(/注册请求已处理/).waitFor();
      await snap(form,'02-duplicate-email.png');
      const duplicate=await signup(' BOUNDARY@example.test ','x'.repeat(8));
      assert.equal(duplicate.status(),200);
      assert.deepEqual(await duplicate.json(),{ok:true,verificationRequired:false});
      await form.getByRole('button',{name:'前往注册'}).click();
      await fillSignup('second@example.test','x'.repeat(20));
      await title.waitFor();
      const simultaneous=await Promise.all([signup(' Race@example.test ','abcdefgh'),signup('race@example.test','abcdefgh')]);
      assert.deepEqual(simultaneous.map(r=>r.status()),[200,200]);
      assert.equal(db.prepare("SELECT count(*) FROM user WHERE email='race@example.test'").pluck().get(),1);
      assert.equal((await signup('limited@example.test','abcdefgh')).status(),429);
      assert.throws(()=>db.prepare("UPDATE user SET email=' Boundary@Example.test ' WHERE email='second@example.test'").run(),/UNIQUE/);

      const now=new Date().toISOString();
      const oldPassword='old-password-longer-than-twenty';
      db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
        .run('legacy-user','旧账号','legacy@example.test',0,now,now);
      db.prepare('INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
        .run('legacy-credential','legacy-user','credential','legacy-user',await hashPassword(oldPassword),now,now);
      async function login(email:string,password:string) {
        await form.getByLabel('邮箱',{exact:true}).fill(email);
        await form.getByLabel('密码',{exact:true}).fill(password);
        await form.getByRole('button',{name:'登录',exact:true}).click();
        await form.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      }
      async function logout(page:typeof form) {
        await page.getByText('个人菜单',{exact:true}).click();
        await page.getByRole('button',{name:'退出登录'}).click();
        await page.getByRole('heading',{name:'登录',exact:true}).waitFor();
      }
      await login('boundary@example.test','x'.repeat(8));
      await logout(form);
      await login('legacy@example.test',oldPassword);
      const create=(context:typeof member)=>context.request.post(base+'/api/projects',{multipart:{fixture:'demo-form'},headers:{origin:base}});
      const owned=await create(member);
      assert.equal(owned.status(),201,await owned.text());
      const memberId=(await owned.json()).id as string;

      const [a,b]=await Promise.all([guestA.newPage(),guestB.newPage()]);
      for(const page of [a,b]){
        await page.goto(base);
        await page.getByRole('button',{name:'游客登录'}).click();
        await page.getByText('游客模式',{exact:true}).waitFor();
        await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      }
      await snap(a,'03-guest-workspace.png');
      const [identityA,identityB]=await Promise.all([guestA,guestB].map(async context=>
        (await (await context.request.get(base+'/api/auth/get-session')).json()).user));
      assert.notEqual(identityA.id,identityB.id);
      assert.equal(identityA.isGuest,true);
      assert.equal(identityA.email,'');
      assert.ok(Math.abs(Date.parse(identityA.expiresAt)-Date.now()-86_400_000)<30_000);
      const storedExpiry=db.prepare('SELECT expiresAt FROM session WHERE userId=?').pluck().get(identityA.id) as string;
      assert.equal(Date.parse(storedExpiry),Date.parse(identityA.expiresAt));
      const protectedRoute=(project:string)=>'/projects/'+project;
      const get=(context:typeof member,route:string)=>context.request.get(base+'/api'+route);
      for(const suffix of ['', '/reports', '/export', '/compare?left=bad&right=bad']) {
        assert.equal((await get(guestA,protectedRoute(memberId)+suffix)).status(),404);
      }
      const upload=await guestA.request.post(base+'/api/projects',{multipart:{file:{name:'guest.html',
        mimeType:'text/html',buffer:Buffer.from('<!doctype html><html lang="zh"><title>游客验收</title><button></button></html>')}},headers:{origin:base}});
      assert.equal(upload.status(),201,await upload.text());
      const project=await upload.json();
      assert.deepEqual(await (await get(guestB,'/projects')).json(),[]);
      assert.equal((await get(guestB,protectedRoute(project.id))).status(),404);
      const jobResponse=await submit('projects/'+project.id+'/audits',{},guestA);
      assert.equal(jobResponse.status(),202);
      const {id:job}=await jobResponse.json();
      let scan:any;
      for(let i=0;i<100;i++){
        scan=await (await get(guestA,'/jobs/'+job)).json();
        if(scan.status!=='queued' && scan.status!=='running') break;
        await delay(200);
      }
      assert.equal(scan.status,'completed',JSON.stringify(scan));
      assert.ok(scan.result.issues.some((issue:{ruleId:string})=>issue.ruleId==='button-name'));
      const screenshot=scan.result.screenshot.replace(/^\/api/,'');
      assert.equal((await get(guestA,screenshot)).status(),200);
      assert.equal((await get(guestB,screenshot)).status(),404);
      assert.equal((await get(guestB,'/jobs/'+job)).status(),404);
      assert.equal((await get(guestA,protectedRoute(project.id)+'/export')).status(),200);
      const snapshots=new URLSearchParams({left:project.currentSnapshot,right:project.currentSnapshot});
      assert.equal((await get(guestA,protectedRoute(project.id)+'/compare?'+snapshots)).status(),200);
      assert.equal((await get(guestA,protectedRoute(project.id)+'/reports')).status(),200);
      const zip=await guestA.request.post(base+'/api/projects',{multipart:{file:{name:'guest.zip',mimeType:'application/zip',
        buffer:Buffer.from(zipSync({'index.html':strToU8('<!doctype html><title>游客 ZIP</title>')}))}},headers:{origin:base}});
      assert.equal(zip.status(),201,await zip.text());
      const url=await submit('projects/import-url',{url:'http://93.184.216.34/',mode:'static'},guestA);
      assert.equal(url.status(),201,await url.text());
      assert.equal((await create(guestA)).status(),429);
      for(let i=0;i<6;i++) {
        const reply=await submit('projects/'+project.id+'/issues/unknown/proposals',{source:'agent'},guestA);
        assert.equal(reply.status(),i===5?429:400);
      }
      const previousCookie=(await guestB.cookies()).find(cookie=>cookie.name.includes('session_token'));
      assert.ok(previousCookie?.httpOnly);
      await logout(b);
      assert.equal((await guestB.request.get(base+'/api/projects',{headers:{cookie:previousCookie.name+'='+previousCookie.value}})).status(),401);
      db.prepare('UPDATE user SET createdAt=? WHERE id=?').run(new Date(Date.now()-26*3600_000).toISOString(),identityA.id);
      assert.equal((await get(guestA,'/projects')).status(),401);
      await stop();
      const clean=spawn(process.execPath,['--import','tsx','-e',
        "import('./apps/api/guests.ts').then(({cleanExpiredGuests})=>{cleanExpiredGuests()})"],
        {env:{...process.env,A11Y_DATA_DIR:dir},stdio:['ignore','ignore','pipe']});
      let cleanupError='';
      clean.stderr.on('data',data=>{cleanupError+=data;});
      assert.equal((await once(clean,'exit'))[0],0,cleanupError);
      assert.equal(cleanupError,'');
      assert.equal(db.prepare('SELECT count(*) FROM projects WHERE owner_user_id=?').pluck().get(identityA.id),0);
      assert.equal(db.prepare('SELECT count(*) FROM projects WHERE id=?').pluck().get(memberId),1);
      await assert.rejects(access(path.join(dir,'projects',project.id)),{code:'ENOENT'});
    } finally {await browser.close();db.close();}
  } finally {await stop();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
