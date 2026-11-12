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
import { registerTestAccount, attachTestAccount, testFetch } from './helpers/account';

test('工作台可导入浏览器采集文件并分别展示原页面与副本检测', {timeout:60000}, async () => {
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
    const file=path.join(dir,'capture.json');
    fs.writeFileSync(file,JSON.stringify({format:'a11y-studio-browser-capture',version:1,title:'已登录账户',capturedAt:new Date().toISOString(),
      html:'<!doctype html><html lang="zh-CN"><title>账户</title><main><h1>已登录账户</h1><button id="missing"></button></main></html>',
      screenshot:'data:image/png;base64,'+screenshot.toString('base64'),viewport:{width:900,height:700},
      violations:[{id:'button-name',help:'按钮缺少名称',impact:'critical',count:1}],incomplete:0,limitations:['副本不运行原站脚本。']}));
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
      await page.getByRole('button',{name:'导入已有的浏览器采集 JSON'}).click();
      await page.getByText('导入已有的浏览器采集文件').waitFor();
      await page.getByRole('button',{name:'返回 URL 采集'}).click();
      assert.equal(await page.getByLabel('网页地址').isVisible(),true);
      await page.getByRole('button',{name:'导入已有的浏览器采集 JSON'}).click();
      await page.locator('input[type=file]').setInputFiles(file);
      await page.getByText('浏览器原始页面证据', {exact:false}).waitFor({timeout:40000});
      await page.getByText('原页面发现 1 处问题', {exact:false}).waitFor();
      const image=page.getByRole('img',{name:'采集时浏览器可见区域截图'});
      await image.waitFor();
      assert.equal(await image.evaluate((element:HTMLImageElement)=>element.complete && element.naturalWidth>0),true);
      await page.getByText('下方工作台使用本地副本重新检测', {exact:false}).waitFor();
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
