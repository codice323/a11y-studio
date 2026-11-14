import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { unzipSync } from 'fflate';
import { seedBrowserCapture } from './helpers/project-import';
import { registerTestAccount, attachTestAccount, testFetch } from './helpers/account';

test('工作台在同一可交互副本内定位和验证旧采集项目', {timeout:60000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-capture-ui-'));
  const socket=http.createServer();
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as AddressInfo).port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),BETTER_AUTH_URL:`http://127.0.0.1:${port}`,A11Y_DATA_DIR:dir},stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;
    let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready,'服务未启动');
    await registerTestAccount(base);
    const screenshot=fs.readFileSync('tests/fixtures/vision/bars.png');
    const payload={format:'a11y-studio-browser-capture',version:1,title:'已登录账户',capturedAt:new Date().toISOString(),
      html:'<!doctype html><html lang="zh-CN"><title>账户</title><body style="margin:0"><a id="aging-total-page" role="pagedescription" aria-label="页面导览" tabindex="0" style="display:inline"></a><main><h1>已登录账户</h1><div style="height:2500px"></div><button id="missing"></button><input id="unlabelled"></main></body></html>',
      screenshot:'data:image/png;base64,'+screenshot.toString('base64'),viewport:{width:900,height:700},
      violations:[{id:'button-name',help:'按钮缺少名称',impact:'critical',count:1}],incomplete:0,limitations:['副本不运行原站脚本。']};
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    try {
      const page=await browser.newPage();
      await attachTestAccount(page.context(),base);
      const navigationHeaders={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
      assert.equal((await page.context().request.get(base+'/',{headers:navigationHeaders})).status(),200);
      assert.equal((await page.context().request.get(base+'/api/projects',{headers:navigationHeaders})).status(),403);
      page.setDefaultTimeout(10000);
      await page.goto(base);
      await page.getByRole('button',{name:'URL',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'浏览器采集',exact:true}).count(),0);
      assert.equal(await page.getByLabel('网页地址').isVisible(),true);
      assert.equal(await page.getByRole('button',{name:/浏览器采集 JSON/}).count(),0);
      assert.equal((await page.request.post(base+'/api/projects/import-browser-capture',{headers:{origin:base}})).status(),404);
      const project=await seedBrowserCapture(page,base,dir,payload);
      const audit=await page.request.post(base+'/api/projects/'+project.id+'/audits',{headers:{origin:base}});
      assert.equal(audit.status(),202);
      await page.reload();
      await page.getByRole('button',{name:project.name,exact:true}).click();
      const workspace=page.getByRole('region',{name:'诊断工作区'});
      const interactive=workspace.locator('.inline-interactive');
      const frame=interactive.frameLocator('iframe');
      await frame.getByRole('heading',{name:'已登录账户'}).waitFor({timeout:40000});
      assert.equal(await interactive.locator('iframe').count(),1);
      assert.equal(await workspace.getByRole('button',{name:'扫描截图',exact:true}).count(),0);
      const issueList=page.getByRole('region',{name:'待处理问题'});
      const ruleFilter=page.getByLabel('问题类型');
      await ruleFilter.selectOption('button-name');
      await issueList.getByRole('button',{name:/按钮缺少名称/}).click();
      const marker=frame.getByText('问题位置',{exact:true});
      await marker.waitFor();
      assert.ok(await frame.locator('html').evaluate(()=>scrollY)>100);
      await frame.locator('#unlabelled').fill('交互输入');
      assert.equal(await frame.locator('#unlabelled').inputValue(),'交互输入');
      await frame.locator('html').evaluate(()=>scrollTo(0,0));
      await marker.waitFor({state:'hidden'});
      await workspace.getByRole('button',{name:'在网页中验证'}).click();
      await marker.waitFor();
      assert.equal(await interactive.locator('iframe').count(),1);
      await page.getByLabel('建议的文本内容').fill('打开菜单');
      await page.getByRole('button',{name:'生成补丁预览'}).click();
      await page.getByText('待应用预览',{exact:false}).waitFor();
      assert.equal(await frame.locator('#missing').getAttribute('aria-label'),null);
      await page.getByRole('button',{name:'确认应用修复',exact:true}).click();
      await page.getByRole('button',{name:'确认应用并复测'}).click();
      await workspace.locator('.assistant-body').getByRole('heading',{name:'复测通过'}).waitFor();
      const toggle=workspace.getByRole('checkbox',{name:'查看原始状态'});
      await frame.getByRole('button',{name:'打开菜单',exact:true}).waitFor();
      await toggle.check();
      await frame.locator('#missing').waitFor();
      assert.equal(await frame.locator('#missing').getAttribute('aria-label'),null);
      await toggle.uncheck();
      await frame.getByRole('button',{name:'打开菜单',exact:true}).waitFor();
      assert.equal(await interactive.locator('iframe').count(),1);
      await page.getByRole('button',{name:'结果报告',exact:true}).click();
      await page.getByRole('heading',{name:'结果报告',exact:true}).waitFor();
      await page.getByRole('button',{name:'诊断工作台',exact:true}).click();
      const projects=await (await testFetch(base+'/api/projects')).json() as {id:string}[];
      const exported=await testFetch(base+'/api/projects/'+projects[0].id+'/export');
      assert.equal(exported.status,200);
      const files=unzipSync(new Uint8Array(await exported.arrayBuffer()));
      assert.ok(files['report/screenshots/browser-original.png']);
      assert.equal(JSON.parse(Buffer.from(files['report/report.json']).toString()).browserCapture.screenshot,'screenshots/browser-original.png');
      const other=await browser.newContext();
      try {
        const anonymous=await other.request.post(base+'/api/auth/sign-in/anonymous',{data:{},headers:{origin:base}});
        assert.equal(anonymous.status(),200);
        assert.equal((await other.request.get(base+'/api/projects/'+projects[0].id)).status(),404);
        assert.equal((await other.request.get(base+'/api/projects/'+projects[0].id+'/browser-capture/screenshot')).status(),404);
      } finally {await other.close();}
      const captureDir=path.join(dir,'browser-captures');
      assert.ok(fs.existsSync(path.join(captureDir,projects[0].id+'.png')));
      let deleted=await page.context().request.delete(base+'/api/projects/'+projects[0].id,{data:{confirm:true},headers:{origin:base}});
      for(let i=0;deleted.status()===409&&i<50;i++){
        await new Promise(resolve=>setTimeout(resolve,200));
        deleted=await page.context().request.delete(base+'/api/projects/'+projects[0].id,{data:{confirm:true},headers:{origin:base}});
      }
      assert.equal(deleted.status(),204);
      assert.equal(fs.existsSync(path.join(captureDir,projects[0].id+'.png')),false);
      assert.equal(fs.existsSync(path.join(captureDir,projects[0].id+'.json')),false);
    } finally {await browser.close();}
  } finally {
    if(service.exitCode===null && service.signalCode===null){
      const stopped=new Promise<void>(resolve=>service.once('exit',()=>resolve()));
      service.kill('SIGKILL');
      await stopped;
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
