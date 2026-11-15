import './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium, type BrowserContext } from 'playwright-core';
import { unzipSync, strFromU8 } from 'fflate';

test('两个正式账号和两个游客并发修复与项目隔离', {timeout:180_000}, async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'a11y-account-concurrency-'));
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{
    env:{...process.env,NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:origin,A11Y_DATA_DIR:dir,
      AI_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let log='';
  service.stdout.on('data',chunk=>{log+=chunk;});
  service.stderr.on('data',chunk=>{log+=chunk;});
  try {
    for(let i=0;!(await fetch(origin+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error('测试服务启动失败');
      await delay(100);
    }
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    try {
      const [a,b,guestA,guestB]=await Promise.all(Array.from({length:4},()=>browser.newContext()));
      const guest=await guestA.newPage();
      const password='Local-Account-123';
      const post=(c:BrowserContext,route:string,data:object,from=origin)=>
        c.request.post(origin+route,{data,headers:{origin:from}});
      async function json(c:BrowserContext,route:string){
        const response=await c.request.get(origin+route);
        assert.equal(response.status(),200,route);
        return response.json();
      }

      for (const [context,email] of [[a,'parallel-a@example.test'],[b,'parallel-b@example.test']] as const) {
        const credentials={email,password,name:'测试账号'};
        assert.equal((await post(context,'/api/auth/sign-up/email',credentials)).status(),200);
        assert.equal((await post(context,'/api/auth/sign-in/email',credentials)).status(),200);
      }
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
          for(let n=0;n<600;n++){
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
      const states=await Promise.all(actors.map(async(c,i)=>{
        for(let n=0;n<600;n++){
          const state=await json(c,routes[i]);
          if(state.current?.screenshot) return state;
          await delay(100);
        }
        throw new Error('修复后的检测证据未生成');
      }));
      assert.equal(new Set(states.map(s=>s.project.currentSnapshot)).size,4);
      await Promise.all(actors.map(async(c,i)=>{
        const state=states[i], j=(i+1)%actors.length;
        assert.equal(state.snapshots.length,2);
        assert.equal(state.verifications[0].status,'applied');
        assert.equal(state.current.issues.some((issue:{ruleId:string})=>issue.ruleId==='button-name'),false);
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

      assert.equal(log.includes(password),false,'密码不得写入服务日志');
    } finally {await browser.close();}
  } finally {
    if(service.exitCode===null && service.signalCode===null){
      const exit=once(service,'exit');service.kill();
      const force=setTimeout(()=>service.kill('SIGKILL'),2500);
      await exit;clearTimeout(force);
    }
    await rm(dir,{recursive:true,force:true});
  }
});
