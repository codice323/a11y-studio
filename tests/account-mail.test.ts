import './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { unzipSync, strFromU8 } from 'fflate';

test('Chrome 邮箱验证、密码重置与四个独立账号并发修复', {timeout:120_000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'a11y-mail-'));
  const mail=path.join(dir,'mail');
  await mkdir(mail,{mode:0o700});
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{
    env:{...process.env,NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:origin,A11Y_DATA_DIR:dir,A11Y_MAIL_TEST_DIR:mail,
      A11Y_RESEND_API_KEY:'',A11Y_MAIL_FROM:'',AI_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let log='';
  service.stdout.on('data',chunk=>{log+=chunk;});
  service.stderr.on('data',chunk=>{log+=chunk;});
  const seen=new Set<string>();
  const rawSecrets:string[]=[];
  try {
    for(let i=0;!(await fetch(origin+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error('测试服务启动失败');
      await delay(100);
    }
    const db=new Database(path.join(dir,'studio.sqlite'));
    try {
      const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
      try {
        const contexts=await Promise.all(Array.from({length:5},()=>browser.newContext()));
        const [a,b,guestA,guestB,recovery]=contexts;
        const [page,other,guest,resetPage]=await Promise.all([a,b,guestA,recovery].map(context=>context.newPage()));
        const password='Local-Account-123';
        const newPassword='Reset-Account-456';
        rawSecrets.push(password,newPassword);
        const post=(c:BrowserContext,route:string,data:object,from=origin)=>
          c.request.post(origin+route,{data,headers:{origin:from}});
        async function json(c:BrowserContext,route:string){
          const response=await c.request.get(origin+route);
          assert.equal(response.status(),200,route);
          return response.json();
        }
        async function receive(to:string,purpose:string){
          for(let attempt=0;attempt<80;attempt++){
            for(const name of await readdir(mail)){
              if(seen.has(name)) continue;
              const file=path.join(mail,name);
              const item=JSON.parse(await readFile(file,'utf8'));
              if(item.to!==to || item.purpose!==purpose) continue;
              assert.equal((await stat(file)).mode&0o777,0o600);
              seen.add(name);
              const link=new URL(item.link);
              assert.equal(link.origin,origin);
              assert.equal(link.search,'');
              const token=new URLSearchParams(link.hash.slice(1)).get('token')!;
              assert.equal(token.length,43);
              rawSecrets.push(token);
              assert.equal(db.prepare('SELECT count(*) FROM account_mail_tokens WHERE digest=?').pluck().get(token),0);
              return {link,token};
            }
            await delay(100);
          }
          throw new Error('测试邮件未收到');
        }
        async function login(tab:Page,email:string,secret=password){
          await tab.getByLabel('邮箱',{exact:true}).fill(email);
          await tab.getByLabel('密码',{exact:true}).fill(secret);
          await tab.getByRole('button',{name:'登录',exact:true}).click();
        }
        const accountA='mail-a@example.test', accountB='mail-b@example.test';
        await page.goto(origin);
        await page.getByRole('button',{name:'前往注册'}).click();
        await page.getByLabel('邮箱',{exact:true}).fill(accountA);
        await page.getByLabel('密码',{exact:true}).fill(password);
        await page.getByLabel('确认密码',{exact:true}).fill(password);
        await page.getByRole('button',{name:'注册',exact:true}).click();
        await page.getByText(/请查收验证邮件/).waitFor();
        const verifyA=await receive(accountA,'verify');
        await login(page,accountA);
        await page.getByRole('heading',{name:'验证邮箱',exact:true}).waitFor();
        assert.equal((await a.request.get(origin+'/api/projects')).status(),403);
        await page.goto(verifyA.link.href);
        await page.getByRole('button',{name:'验证邮箱',exact:true}).click();
        await page.getByText(/邮箱验证成功/).waitFor();
        assert.equal(new URL(page.url()).hash,'');
        assert.equal((await post(recovery,'/api/auth/confirm-email',{token:verifyA.token})).status(),400);
        await page.getByRole('button',{name:'返回工作区'}).click();
        await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();

        const createdB=await post(b,'/api/auth/sign-up/email',{email:accountB,password,name:'B',emailVerified:true});
        assert.equal(createdB.status(),200);
        const firstB=await receive(accountB,'verify');
        const duplicate=await post(recovery,'/api/auth/sign-up/email',{email:' MAIL-B@example.test ',password,name:'duplicate'});
        assert.deepEqual(await duplicate.json(),await createdB.json());
        assert.equal(db.prepare('SELECT emailVerified FROM user WHERE email=?').pluck().get(accountB),0);
        db.prepare("UPDATE account_mail_tokens SET expires_at=0,issued_at=0 WHERE email=? AND purpose='verify'").run(accountB);
        assert.equal((await post(b,'/api/auth/confirm-email',{token:firstB.token})).status(),400);
        const resend=await post(b,'/api/auth/resend-verification',{email:accountB});
        const unknownResend=await post(b,'/api/auth/resend-verification',{email:'absent@example.test'});
        assert.deepEqual(await resend.json(),await unknownResend.json());
        const verifyB=await receive(accountB,'verify');
        assert.equal((await post(b,'/api/auth/confirm-email',{token:verifyB.token})).status(),200);
        assert.equal((await post(b,'/api/auth/sign-in/email',{email:accountB,password})).status(),200);

        await guest.goto(origin);
        await guest.getByRole('button',{name:'游客登录'}).click();
        await guest.getByText('游客模式',{exact:true}).waitFor();
        assert.equal((await post(guestB,'/api/auth/sign-in/anonymous',{})).status(),200);
        const actors=[a,b,guestA,guestB];
        const projects=await Promise.all(actors.map(async(context,i)=>{
          const html='<html lang="zh"><title>并发 '+i+'</title><main><h1>并发 '+i+'</h1><button id="fixme"></button></main></html>';
          const response=await context.request.post(origin+'/api/projects',{headers:{origin},
            multipart:{file:{name:'parallel-'+i+'.html',mimeType:'text/html',buffer:Buffer.from(html)}}});
          assert.equal(response.status(),201);
          return response.json();
        }));
        assert.equal(new Set(projects.map(p=>p.id)).size,4);
        async function jobs(started:Promise<import('playwright-core').APIResponse>[]){
          const tickets=await Promise.all(started.map(async req=>{
            const response=await req;
            assert.equal(response.status(),202,await response.text());
            return (await response.json()).id as string;
          }));
          await Promise.all(tickets.map(async(ticket,i)=>{
            for(let n=0;n<200;n++){
              const state=await json(actors[i],'/api/jobs/'+ticket);
              if (state.status==='completed') return;
              assert.ok(['queued','running'].includes(state.status),JSON.stringify(state));
              await delay(100);
            }
            throw new Error('并发任务未结束');
          }));
          return tickets;
        }
        const routes=projects.map(project=>'/api/projects/'+project.id);
        const audits=await jobs(actors.map((c,i)=>post(c,routes[i]+'/audits',{})));
        const proposals=await Promise.all(actors.map(async(c,i)=>{
          const state=await json(c,routes[i]);
          const issue=state.current.issues.find((item:{ruleId:string})=>item.ruleId==='button-name');
          assert.ok(issue);
          const response=await post(c,routes[i]+'/issues/'+issue.id+'/proposals',{source:'manual',value:'账号操作 '+i});
          assert.equal(response.status(),201,await response.text());
          return (await response.json()).id as string;
        }));
        await jobs(actors.map((c,i)=>post(c,'/api/proposals/'+proposals[i]+'/apply',{})));
        const states=await Promise.all(actors.map((c,i)=>json(c,routes[i])));
        assert.equal(new Set(states.map(s=>s.project.currentSnapshot)).size,4);
        await Promise.all(actors.map(async(c,i)=>{
          const state=states[i], j=(i+1)%actors.length;
          assert.equal(state.snapshots.length,2);
          assert.equal(state.verifications[0].status,'passed');
          const endpoints=[routes[i],routes[i]+'/reports',routes[i]+'/export',state.current.screenshot,
            routes[i]+'/audits/'+state.current.id+'/semantics?selector=body','/api/jobs/'+audits[i],'/api/proposals/'+proposals[i]+'/preview'];
          for(const endpoint of endpoints) assert.equal((await actors[j].request.get(origin+endpoint)).status(),404,endpoint);
          const foreignSnapshot=await c.request.patch(origin+routes[i]+'/snapshots/'+states[j].project.currentSnapshot,
            {headers:{origin},data:{name:'不允许的改名'}});
          assert.equal(foreignSnapshot.status(),400);
          const [shot,report,exported]=await Promise.all([state.current.screenshot,routes[i]+'/reports',routes[i]+'/export']
            .map(endpoint=>c.request.get(origin+endpoint)));
          assert.equal(shot.status(),200);assert.equal(report.status(),200);assert.equal(exported.status(),200);
          assert.match(strFromU8(unzipSync(new Uint8Array(await exported.body()))['website/index.html']),new RegExp('账号操作 '+i));
        }));

        const upgraded=await post(guestA,'/api/auth/upgrade-guest',{email:'upgraded@example.test',password});
        assert.equal(upgraded.status(),200,await upgraded.text());
        const duplicateUpgrade=await post(guestB,'/api/auth/upgrade-guest',{email:accountB,password});
        assert.deepEqual(await duplicateUpgrade.json(),await upgraded.json());
        assert.equal((await json(guestA,'/api/auth/get-session')).user.isGuest,true);
        const verifiedGuest=await receive('upgraded@example.test','upgrade');
        assert.equal((await post(guestB,'/api/auth/complete-guest-upgrade',{token:verifiedGuest.token})).status(),400);
        await guest.goto(verifiedGuest.link.href);
        await guest.getByRole('button',{name:'确认保存项目',exact:true}).click();
        await guest.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
        assert.equal((await json(guestA,'/api/auth/get-session')).user.emailVerified,true);
        assert.equal((await json(guestA,routes[2])).project.currentSnapshot,states[2].project.currentSnapshot);

        await other.goto(origin+'/?project='+projects[1].id);
        await other.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
        const oldCookie=(await a.cookies()).find(cookie=>cookie.name.includes('session_token'))!;
        assert.ok(oldCookie.httpOnly);
        assert.equal(oldCookie.sameSite,'Lax');
        rawSecrets.push(oldCookie.value);
        await page.getByText('个人菜单',{exact:true}).click();
        await page.getByRole('button',{name:'退出登录'}).click();
        await page.getByRole('heading',{name:'登录',exact:true}).waitFor();
        assert.equal((await b.request.get(origin+routes[1])).status(),200);
        assert.equal((await guestB.request.get(origin+routes[3])).status(),200);
        await page.goto(origin+'/?project='+projects[0].id);
        await login(page,accountA);
        await page.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();

        await resetPage.goto(origin);
        await resetPage.getByRole('button',{name:'忘记密码'}).click();
        await resetPage.getByLabel('邮箱',{exact:true}).fill(accountA);
        await resetPage.getByRole('button',{name:'发送重置邮件'}).click();
        await resetPage.getByText(/你将收到重置邮件/).waitFor();
        const expiredReset=await receive(accountA,'reset');
        db.prepare("UPDATE account_mail_tokens SET expires_at=0,issued_at=0 WHERE email=? AND purpose='reset'").run(accountA);
        assert.equal((await post(recovery,'/api/auth/complete-password-reset',{token:expiredReset.token,newPassword})).status(),400);
        assert.equal((await post(recovery,'/api/auth/forgot-password',{email:accountA})).status(),200);
        const reset=await receive(accountA,'reset');
        const missing=await post(recovery,'/api/auth/forgot-password',{email:'absent@example.test'});
        assert.deepEqual(await missing.json(),{ok:true,mailAvailable:true});
        assert.equal((await post(recovery,'/api/auth/forgot-password',{email:'absent@example.test'})).status(),200);
        assert.equal((await post(recovery,'/api/auth/forgot-password',{email:'absent@example.test'})).status(),429);
        assert.equal((await post(recovery,'/api/auth/complete-password-reset',{token:reset.token,newPassword},'https://outside.example')).status(),403);
        await resetPage.goto(reset.link.href);
        await resetPage.getByLabel('新密码',{exact:true}).fill(newPassword);
        await resetPage.getByLabel('确认新密码',{exact:true}).fill(newPassword);
        await resetPage.getByRole('button',{name:'保存新密码'}).click();
        await resetPage.getByText(/密码已重置/).waitFor();
        assert.equal((await a.request.get(origin+routes[0])).status(),401);
        assert.equal((await post(recovery,'/api/auth/complete-password-reset',{token:reset.token,newPassword})).status(),400);
        assert.equal((await post(recovery,'/api/auth/sign-in/email',{email:accountA,password})).status(),401);
        await resetPage.getByRole('button',{name:'返回登录'}).click();
        await login(resetPage,accountA,newPassword);
        await resetPage.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
        await resetPage.getByRole('button',{name:'parallel-0.html',exact:true}).click();
        await resetPage.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
        assert.equal((await json(recovery,routes[0])).project.currentSnapshot,states[0].project.currentSnapshot);
        assert.equal((await b.request.get(origin+routes[1])).status(),200);
        for(const secret of rawSecrets) assert.equal(log.includes(secret),false,'敏感信息不得写入服务日志');
      } finally {await browser.close();}
    } finally {db.close();}
  } finally {
    if(service.exitCode===null && service.signalCode===null){
      const exit=once(service,'exit');service.kill();
      const force=setTimeout(()=>service.kill('SIGKILL'),2500);
      await exit;clearTimeout(force);
    }
    await rm(dir,{recursive:true,force:true});
  }
});
