import './helpers/account';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { chromium, type BrowserContext } from 'playwright-core';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

test('Chrome：游客修复、事务升级、会话轮换、越权拦截及项目管理', {timeout:100_000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'a11y-upgrade-'));
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{
    env:{...process.env,PORT:String(port),BETTER_AUTH_URL:origin,A11Y_DATA_DIR:dir,AI_API_KEY:''},stdio:['ignore','ignore','pipe']});
  let log='';
  service.stderr.on('data',chunk=>{log+=chunk;});
  try {
    for(let i=0;!(await fetch(origin+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error(log || '服务启动超时');
      await delay(100);
    }
    const db=new Database(path.join(dir,'studio.sqlite'));
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    try {
      const [a,guestB,b]=await Promise.all(Array.from({length:3},()=>browser.newContext()));
      const [page,otherGuest,memberB]=await Promise.all([a.newPage(),guestB.newPage(),b.newPage()]);
      const password='Playwright-Only-42';
      const mutate=(context:BrowserContext,route:string,data:unknown,method='POST',from=origin)=>
        context.request.fetch(origin+route,{method,data,headers:{origin:from}});
      const json=async(context:BrowserContext,route:string)=>{
        const res=await context.request.get(origin+route);
        assert.ok(res.ok(),await res.text());
        return res.json();
      };
      const sessionCookie=async(context:BrowserContext)=>{
        const cookie=(await context.cookies()).find(cookie=>cookie.name.includes('session_token'));
        assert.ok(cookie?.httpOnly);
        assert.equal(cookie.sameSite,'Lax');
        return cookie.name+'='+cookie.value;
      };
      const signInB=await mutate(b,'/api/auth/sign-up/email',{email:'b@example.test',password,name:'B'});
      assert.ok(signInB.ok(),await signInB.text());
      assert.ok((await mutate(b,'/api/auth/sign-in/email',{email:'b@example.test',password})).ok());
      await memberB.goto(origin);
      await memberB.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      for (const tab of [page,otherGuest]) {
        await tab.goto(origin);
        await tab.getByRole('button',{name:'游客登录'}).click();
        await tab.getByText('游客模式',{exact:true}).waitFor();
      }
      const guest=(await json(a,'/api/auth/get-session')).user;
      assert.notEqual(guest.id,(await json(guestB,'/api/auth/get-session')).user.id);
      const oldCookie=await sessionCookie(a);
      const html='<!doctype html><html lang="zh"><title>升级验收</title><main><h1>升级验收</h1><button id="fixme"></button></main></html>';
      await page.locator('input[type=file]').setInputFiles({name:'guest-v1.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'index.html':strToU8(html)}))});
      await page.getByRole('region',{name:'待处理问题'}).getByRole('button').filter({hasText:'#fixme'}).click();
      await page.getByLabel('建议的文本内容',{exact:true}).fill('查看详情');
      const proposed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/proposals'));
      await page.getByRole('button',{name:'生成补丁预览'}).click();
      const proposalResponse=await proposed;
      assert.ok(proposalResponse.ok(),await proposalResponse.text());
      const proposalId=(await proposalResponse.json()).id;
      await page.getByRole('button',{name:'确认应用修复',exact:true}).click();
      await page.getByRole('button',{name:'确认应用并复测',exact:true}).click();
      await page.getByText(/目标问题已解决/).first().waitFor();
      const [project]=await json(a,'/api/projects');
      const route='/api/projects/'+project.id;
      const before=await json(a,route);
      assert.equal(before.snapshots.length,2);
      assert.equal(before.verifications[0].status,'passed');
      assert.equal((await guestB.request.get(origin+route)).status(),404);
      assert.equal((await mutate(guestB,route,{name:'越权'},'PATCH')).status(),404);
      assert.equal((await mutate(guestB,route,{confirm:true},'DELETE')).status(),404);
      const guestJob=await mutate(a,route+'/audits',{});
      assert.equal(guestJob.status(),202);
      const {id:jobId}=await guestJob.json();
      assert.equal((await mutate(a,route+'/audits',{userId:'other'})).status(),429);
      assert.equal((await mutate(a,route,{confirm:true},'DELETE')).status(),409);
      for(let i=0;i<100;i++){
        const job=await json(a,'/api/jobs/'+jobId);
        if(job.status==='completed') break;
        assert.ok(['queued','running'].includes(job.status),JSON.stringify(job));
        await delay(100);
      }
      assert.equal((await json(a,'/api/jobs/'+jobId)).status,'completed');

      for(let i=0;i<2;i++){
        const imported=await a.request.post(origin+'/api/projects',{multipart:{fixture:'demo-form'},headers:{origin}});
        assert.equal(imported.status(),201);
      }
      await page.reload();
      await page.getByText('游客模式',{exact:true}).waitFor();
      const quota=await a.request.post(origin+'/api/projects',{multipart:{fixture:'demo-form',userId:'other',isAnonymous:'false'},headers:{origin}});
      assert.equal(quota.status(),429);
      const denied=await mutate(a,'/api/auth/upgrade-guest',{email:'B@example.test',password});
      assert.equal(denied.status(),409,await denied.text());
      assert.equal((await json(a,'/api/auth/get-session')).user.isGuest,true);
      assert.equal((await mutate(a,'/api/auth/upgrade-guest',{email:'a@example.test',password},'POST','https://outside.example')).status(),403);
      db.exec(`CREATE TRIGGER test_rollback BEFORE INSERT ON account WHEN NEW.userId='${guest.id}' BEGIN
        SELECT RAISE(ABORT,'test rollback'); END;`);
      const failure=await mutate(a,'/api/auth/upgrade-guest',{email:'a@example.test',password});
      assert.ok(failure.status()>=400);
      assert.equal((await json(a,'/api/auth/get-session')).user.isGuest,true);
      assert.equal((await json(a,route)).project.currentSnapshot,before.project.currentSnapshot);
      assert.equal(db.prepare('SELECT count(*) FROM session WHERE userId=?').pluck().get(guest.id),1);
      db.exec('DROP TRIGGER test_rollback');

      await page.getByRole('button',{name:'保存我的项目 / 注册账号'}).click();
      const dialog=page.getByRole('dialog',{name:'保存我的项目'});
      await dialog.getByLabel('邮箱',{exact:true}).fill('a@example.test');
      await dialog.getByLabel('密码',{exact:true}).fill(password);
      await dialog.getByRole('button',{name:'显示密码'}).click();
      assert.equal(await dialog.getByLabel('密码',{exact:true}).getAttribute('type'),'text');
      await dialog.getByRole('button',{name:'隐藏密码'}).click();
      await dialog.getByLabel('确认密码',{exact:true}).fill(password);
      const upgrade=page.waitForResponse(r=>r.url().endsWith('/api/auth/upgrade-guest'));
      await dialog.getByRole('button',{name:'注册并保存项目'}).click();
      const reply=await upgrade;
      assert.ok(reply.ok(),await reply.text());
      await dialog.waitFor({state:'hidden'});
      await page.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
      const formal=(await json(a,'/api/auth/get-session')).user;
      assert.equal(formal.id,guest.id);
      assert.equal(formal.email,'a@example.test');
      assert.equal(formal.isGuest,undefined);
      const freshCookie=await sessionCookie(a);
      assert.notEqual(freshCookie,oldCookie);
      assert.equal(db.prepare('SELECT count(*) FROM guest_usage WHERE user_id=?').pluck().get(guest.id),0);
      const retained=await json(a,route);
      assert.deepEqual(retained.snapshots,before.snapshots);
      assert.deepEqual(retained.verifications,before.verifications);
      const shot=retained.current.screenshot;
      const protectedRoutes=[route,shot,route+'/reports',route+'/export','/api/jobs/'+jobId,'/api/proposals/'+proposalId+'/preview'];
      for (const endpoint of protectedRoutes){
        assert.equal((await b.request.get(origin+endpoint)).status(),404,endpoint);
        assert.equal((await guestB.request.get(origin+endpoint)).status(),404,endpoint);
        assert.equal((await fetch(origin+endpoint,{headers:{cookie:oldCookie}})).status,401,endpoint);
      }
      const archive=unzipSync(new Uint8Array(await (await a.request.get(origin+route+'/export')).body()));
      assert.match(strFromU8(archive['website/index.html']),/查看详情/);

      db.prepare('UPDATE user SET createdAt=? WHERE id=?').run(new Date(Date.now()-26*3600_000).toISOString(),formal.id);
      execFileSync(process.execPath,['--import','tsx','-e',"import('./apps/api/guests.ts').then(m=>m.cleanExpiredGuests())"],
        {env:{...process.env,A11Y_DATA_DIR:dir}});
      assert.equal((await json(a,route)).project.currentSnapshot,before.project.currentSnapshot);

      // Expiration in a live tab preserves only the project URL, then enforces ownership again.
      db.prepare('UPDATE session SET expiresAt=? WHERE userId=?').run(new Date(0).toISOString(),formal.id);
      await page.locator('.project-more summary').click();
      await page.getByRole('button',{name:'重新检测'}).click();
      await page.getByText('会话已过期，请重新登录。',{exact:true}).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('project'),project.id);
      for(const endpoint of protectedRoutes) assert.equal((await fetch(origin+endpoint,{headers:{cookie:freshCookie}})).status,401);
      async function loginA(){
        await page.getByLabel('邮箱',{exact:true}).fill('a@example.test');
        await page.getByLabel('密码',{exact:true}).fill(password);
        const login=page.waitForResponse(r=>r.url().endsWith('/api/auth/sign-in/email'));
        await page.getByRole('button',{name:'登录',exact:true}).click();
        const response=await login;
        assert.ok(response.ok(),await response.text());
      }
      await loginA();
      await page.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor({timeout:8000}).catch(async problem=>{
        const identity=await (await a.request.get(origin+'/api/auth/get-session')).json();
        const alerts=await page.getByRole('alert').allTextContents();
        const headings=await page.getByRole('heading',{level:1}).allTextContents();
        throw new Error(JSON.stringify({message:String(problem),alerts,headings,hasSession:Boolean(identity?.user),
          projectInUrl:new URL(page.url()).searchParams.has('project')}),{cause:problem});
      });
      await page.getByText('个人菜单',{exact:true}).click();
      await page.getByRole('button',{name:'退出登录'}).click();
      await page.getByRole('heading',{name:'登录',exact:true}).waitFor();
      await loginA();
      await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      await page.getByRole('button',{name:'重命名 guest-v1.zip',exact:true}).click();
      await page.getByLabel('项目名称').fill('保留的修复');
      await page.getByRole('button',{name:'保存名称',exact:true}).click();
      await page.getByRole('button',{name:'保留的修复',exact:true}).waitFor();
      assert.equal((await json(a,route)).verifications[0].status,'passed');
      assert.equal((await mutate(a,route,{},'DELETE')).status(),400);
      await page.getByRole('button',{name:'删除 保留的修复',exact:true}).click();
      await page.getByRole('button',{name:'取消',exact:true}).click();
      await page.getByRole('button',{name:'保留的修复',exact:true}).waitFor();
      await page.getByRole('button',{name:'删除 保留的修复',exact:true}).click();
      await page.getByRole('button',{name:'永久删除',exact:true}).click();
      await page.getByText('项目已删除。',{exact:true}).waitFor();
      for(const endpoint of protectedRoutes) assert.equal((await a.request.get(origin+endpoint)).status(),404,endpoint);
      await assert.rejects(access(path.join(dir,'projects',project.id)),{code:'ENOENT'});
      await assert.rejects(access(path.join(dir,'screenshots',retained.current.id+'.png')),{code:'ENOENT'});
      assert.equal(db.prepare('SELECT count(*) FROM verifications WHERE project_id=?').pluck().get(project.id),0);
      assert.equal(db.prepare('SELECT count(*) FROM project_file_cleanup').pluck().get(),0);
    } finally {await browser.close();db.close();}
  } finally {
    if (service.exitCode===null && service.signalCode===null) {
      const exit=once(service,'exit');service.kill();
      const force=setTimeout(()=>service.kill('SIGKILL'),2500);
      await exit;clearTimeout(force);
    }
    await rm(dir,{recursive:true,force:true});
  }
});
