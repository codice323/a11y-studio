import './helpers/account';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { unzipSync } from 'fflate';
import { campusFixtures } from '../scripts/campus-fixtures';

test('注册登录、真实校园项目修复、双账号资源隔离及旧项目认领', {timeout:150_000}, async()=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),'a11y-accounts-'));
  process.env.A11Y_DATA_DIR=dir;
  const {createProject} = await import('../apps/api/import');
  const {db,snapshotDir} = await import('../apps/api/storage');
  const legacy = await createProject({fixture:'demo-form'});
  const legacyPath = path.join(snapshotDir(legacy.id,legacy.currentSnapshot),legacy.entry);
  const legacyFile = await readFile(legacyPath);
  const portProbe = createServer().listen(0,'127.0.0.1');
  await once(portProbe,'listening');
  const port = (portProbe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
  const base='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),
    A11Y_DATA_DIR:dir,BETTER_AUTH_URL:base},stdio:['ignore','ignore','pipe']});
  let diagnostics='';
  service.stderr.on('data',data=>{diagnostics+=data;});
  try {
    for(let i=0;!(await fetch(base+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error(diagnostics || '服务启动超时');
      await delay(100);
    }
    const files = await campusFixtures(path.join(dir,'fixture'));
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    try {
      const [a,b]=await Promise.all([browser.newContext({acceptDownloads:true}),browser.newContext()]);
      const [pageA,pageB]=await Promise.all([a.newPage(),b.newPage()]);
      const password='TestOnly-Strong-42!';
      async function login(page:Page,email:string) {
        await page.getByLabel('邮箱',{exact:true}).fill(email);
        await page.getByLabel('密码',{exact:true}).fill(password);
        await page.getByRole('button',{name:'登录',exact:true}).click();
        await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      }
      async function register(page:Page,email:string) {
        await page.goto(base);
        await page.getByRole('button',{name:'前往注册'}).click();
        await page.getByLabel('邮箱',{exact:true}).fill(email);
        await page.getByLabel('密码',{exact:true}).fill(password);
        await page.getByLabel('确认密码',{exact:true}).fill(password);
        await page.getByRole('button',{name:'注册',exact:true}).click();
        await page.getByText(/注册请求已处理/).waitFor();
        await login(page,email);
      }
      async function json(context:typeof a,route:string) {
        const response=await context.request.get(base+route);
        assert.ok(response.ok(),await response.text());
        return response.json();
      }
      async function mutate(context:typeof a,route:string,data:unknown,method='POST',origin=base) {
        return context.request.fetch(base+route,{method,data,headers:{origin}});
      }
      await register(pageA,'owner-a@example.test');
      const profile = await json(a,'/api/auth/get-session');
      assert.deepEqual(Object.keys(profile),['user']);
      assert.deepEqual(Object.keys(profile.user).sort(),['email','id','name']);
      assert.equal(await pageA.evaluate(()=>document.cookie.includes('session_token')),false);
      const originalCookie=(await a.cookies()).find(cookie=>cookie.name.includes('session_token'));
      assert.ok(originalCookie?.httpOnly);
      assert.equal(originalCookie.sameSite,'Lax');
      assert.equal((await a.request.get(base+'/api/projects/'+legacy.id)).status(),404);
      assert.deepEqual(await json(a,'/api/projects'),[]);
      await pageA.getByRole('button',{name:'ZIP',exact:true}).click();
      await pageA.locator('input[type=file]').setInputFiles(files.zip);
      const list=pageA.getByRole('region',{name:'待处理问题'});
      await list.getByRole('button').filter({hasText:'#hero-help'}).waitFor();
      const [project]=await json(a,'/api/projects');
      const route='/api/projects/'+project.id;
      const baseState=await json(a,route);
      const v0=baseState.project.currentSnapshot;
      assert.ok(baseState.current.screenshot);
      const issues=baseState.current.issues;
      let proposalId='';
      async function repair(selector:string,value:string,inputLabel:string) {
        await pageA.getByRole('tab',{name:'问题与历史'}).click();
        await pageA.getByRole('button',{name:/^待处理/}).click();
        await list.getByRole('button').filter({hasText:selector}).click();
        await pageA.getByLabel(inputLabel,{exact:true}).fill(value);
        const proposed=pageA.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/proposals'));
        await pageA.getByRole('button',{name:'生成补丁预览'}).click();
        const proposal=await proposed;
        assert.ok(proposal.ok(),await proposal.text());
        const result=await proposal.json();
        proposalId=result.id;
        await pageA.getByRole('button',{name:'确认应用修复',exact:true}).click();
        await pageA.getByRole('button',{name:'确认应用并复测',exact:true}).click();
        await pageA.getByText(/目标问题已解决/).first().waitFor();
      }
      await repair('#hero-help','校园导航帮助','建议的文本内容');
      await repair('#registration-note','#1c2731','修复颜色');
      const after=await json(a,route);
      assert.equal(after.snapshots.length,3);
      assert.equal(after.verifications.filter((item:{status:string})=>item.status==='passed').length,2);
      assert.ok(proposalId);
      const audit=after.current.id;
      const v2=after.project.currentSnapshot;
      const shot=after.current.screenshot;
      const unauthorizedAiPath=route+'/issues/'+issues[0].id+'/proposals';
      assert.ok((await a.request.get(base+shot)).ok());
      assert.equal((await a.request.get(base+shot)).headers()['cache-control'].includes('no-store'),true);
      assert.ok((await a.request.get(base+route+'/reports')).ok());
      const [download]=await Promise.all([pageA.waitForEvent('download'),
        pageA.getByRole('link',{name:'导出项目 ZIP',exact:true}).click()]);
      const exported=unzipSync(new Uint8Array(await readFile((await download.path())!)));
      assert.ok(exported['report/report.json']);
      assert.ok(exported['website/index.html']);
      const queued=await mutate(a,route+'/audits',{});
      assert.equal(queued.status(),202);
      const {id:job}=await queued.json();
      assert.ok(await json(a,'/api/jobs/'+job));

      await register(pageB,'owner-b@example.test');
      assert.deepEqual(await json(b,'/api/projects'),[]);
      await pageB.getByRole('button',{name:/慢绿生活/}).click();
      await pageB.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
      const [other]=await json(b,'/api/projects');
      const otherRoute='/api/projects/'+other.id;
      const otherState=await json(b,otherRoute);
      assert.notEqual(project.id,other.id);
      for(const url of [route,route+'/reports',route+'/export',route+'/panorama?left='+v0+'&right='+v2,shot,
        '/api/jobs/'+job,'/api/proposals/'+proposalId+'/preview',
        route+'/audits/'+audit+'/semantics?selector=body',
        otherRoute+'/audits/'+audit+'/semantics?selector=body']) {
        assert.equal((await b.request.get(base+url)).status(),404,url);
      }
      assert.equal((await mutate(b,otherRoute+'/snapshots/'+v2,{name:'越权'},'PATCH')).status(),400);
      assert.equal((await mutate(b,route+'/snapshots/'+v2,{name:'越权'},'PATCH')).status(),404);
      assert.equal((await mutate(b,unauthorizedAiPath,{source:'agent'})).status(),404);
      assert.equal((await mutate(b,'/api/jobs/'+job+'/cancel',{})).status(),404);
      assert.equal((await mutate(b,'/api/proposals/'+proposalId+'/apply',{})).status(),404);
      assert.equal((await mutate(a,route+'/rollback',{snapshotId:v0},'POST','https://outside.example')).status(),403);
      assert.equal((await a.request.post(base+route+'/rollback',{data:{snapshotId:v0}})).status(),403);
      assert.equal((await mutate(a,'/api/auth/sign-out',{},'POST','https://outside.example')).status(),403);

      const left=await mutate(a,route+'/live',{left:v0,right:v2});
      assert.ok(left.ok(),await left.text());
      const liveA=await left.json();
      const otherVersion=otherState.project.currentSnapshot;
      const right=await mutate(b,otherRoute+'/live',{left:otherVersion,right:otherVersion});
      assert.ok(right.ok(),await right.text());
      const liveB=await right.json();
      assert.notEqual(liveA.id,liveB.id);
      assert.equal((await mutate(b,route+'/live/'+liveA.id+'/scan/left',{})).status(),404);
      assert.equal((await mutate(b,otherRoute+'/live/'+liveA.id+'/scan/left',{})).status(),400);
      assert.equal((await mutate(b,otherRoute+'/live/'+liveB.id+'/action',{side:'left',sync:false,revision:0,operation:{action:'refresh'}})).status(),200);
      await mutate(b,otherRoute+'/live/'+liveB.id,{},'DELETE');

      await pageA.getByText('个人菜单',{exact:true}).click();
      await pageA.getByRole('button',{name:'退出登录'}).click();
      await pageA.getByRole('heading',{name:'登录',exact:true}).waitFor();
      for(const url of [route,route+'/reports',route+'/export',shot,'/api/jobs/'+job,'/api/proposals/'+proposalId+'/preview']) {
        assert.equal((await a.request.get(base+url)).status(),401,url);
        assert.equal((await a.request.get(base+url,{headers:{cookie:originalCookie.name+'='+originalCookie.value}})).status(),401,url);
      }
      await login(pageA,'owner-a@example.test');
      assert.equal((await mutate(a,route+'/live/'+liveA.id+'/scan/left',{})).status(),400);
      assert.equal((await json(a,route)).snapshots.length,3);
      await pageA.reload();
      await pageA.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
      assert.equal(await pageA.locator('.recent-list').getByRole('button',{name:project.name,exact:true}).count(),1);

      assert.deepEqual(await readFile(legacyPath),legacyFile);
      assert.equal(db.prepare('SELECT owner_user_id FROM projects WHERE id=?').pluck().get(legacy.id),null);
      execFileSync(process.execPath,['--import','tsx','scripts/claim-legacy-project.ts','--apply',legacy.id,profile.user.id],
        {env:{...process.env,PORT:String(port),A11Y_DATA_DIR:dir,BETTER_AUTH_URL:base}});
      assert.ok((await a.request.get(base+'/api/projects/'+legacy.id)).ok());
      assert.equal((await b.request.get(base+'/api/projects/'+legacy.id)).status(),404);
      assert.deepEqual(await readFile(legacyPath),legacyFile);
      let throttled=false;
      for(let i=0;i<7;i++){
        const invalid=await mutate(b,'/api/auth/sign-in/email',{email:'wrong@example.test',password});
        if(invalid.status()===429) {throttled=true;break;}
        assert.equal(invalid.status(),401);
      }
      assert.ok(throttled);
    } finally {await browser.close();}
  } finally {
    if (service.exitCode===null && service.signalCode===null) {
      const stopped=once(service,'exit');
      service.kill();
      const kill=setTimeout(()=>service.kill('SIGKILL'),2500);
      await stopped;
      clearTimeout(kill);
    }
    db.close();
    await rm(dir,{recursive:true,force:true});
  }
});
