import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { registerTestAccount, attachTestAccount } from './helpers/account';
import { normalizeCaptureUrl } from '../packages/shared/capture-url';

test('URL 采集失败后可原地重试，刷新保留网址，残留路由仍可再次打开', {timeout:60000}, async()=>{
  assert.equal(normalizeCaptureUrl(' baidu.com '),'https://baidu.com/');
  assert.throws(()=>normalizeCaptureUrl('javascript:alert(1)'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-managed-ui-'));
  const socket=http.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const base=`http://127.0.0.1:${port}`;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),BETTER_AUTH_URL:base,A11Y_DATA_DIR:dir},stdio:'ignore'});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready,'隔离测试服务未启动');
    await registerTestAccount(base);
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const context=await browser.newContext();await attachTestAccount(context,base);
    const target=await context.newPage();
    await target.setViewportSize({width:1280,height:820});
    await target.setContent('<!doctype html><html><body><main style="height:4000px">顶部<div style="margin-top:2500px">页面底部内容</div></main></body></html>');
    const page=await context.newPage();page.setDefaultTimeout(10000);
    let starts=0;
    const actions:Array<{action:string;delta?:number;x?:number;y?:number}>=[];
    const frame={image:'data:image/png;base64,'+fs.readFileSync('tests/fixtures/vision/bars.png').toString('base64'),width:1280,height:820,title:'采集成功',url:'https://baidu.com/',scrollHeight:820,failedResources:2};
    await page.route('**/api/browser-capture-sessions**',async route=>{
      const req=route.request();
      if(req.method()==='DELETE')return route.fulfill({status:204});
      if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/browser-capture-sessions'){
        starts++;assert.equal(req.postDataJSON().url,'https://baidu.com/');
        if(starts===1)return route.fulfill({status:404,json:{error:'资源不存在。'}});
        return route.fulfill({status:201,json:{id:'session-'+starts,frame}});
      }
      if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/action')){
        const action=req.postDataJSON();actions.push(action);
        if(action.action==='scroll'){
          await target.mouse.move(action.x??640,action.y??410);
          await target.mouse.wheel(0,action.delta);
        }
      }
      return route.fulfill({json:frame});
    });
    const open=async()=>{
      await page.getByRole('button',{name:'URL',exact:true}).click();
      await page.getByLabel('网页地址',{exact:true}).fill('baidu.com');
      await page.getByRole('button',{name:'打开采集浏览器'}).click();
    };
    await page.goto(base);await open();
    await page.getByRole('alert').filter({hasText:'请重启后端服务'}).waitFor();
    await page.getByText('网页加载失败',{exact:true}).waitFor();
    assert.equal(await page.locator('.managed-capture-placeholder .spin').count(),0);
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.getByRole('region',{name:'应用内原网页实时画面'}).waitFor();
    await page.getByText(/本次加载有 2 项网页资源请求失败/).waitFor();
    await page.getByText(/当前页面高度未超出画面/).waitFor();
    assert.equal(starts,2);
    await page.reload();await page.getByRole('region',{name:'应用内原网页实时画面'}).waitFor();
    assert.equal(starts,3);
    await page.evaluate(()=>sessionStorage.removeItem('a11y-studio:url-capture'));
    await page.reload();
    assert.equal(new URL(page.url()).hash,'#url-capture');
    await open();await page.getByRole('region',{name:'应用内原网页实时画面'}).waitFor();
    assert.equal(starts,4);
    const screen=page.getByRole('region',{name:'应用内原网页实时画面'});
    await screen.scrollIntoViewIfNeeded();
    const box=await screen.boundingBox();assert.ok(box);
    await page.mouse.move(box.x+box.width*.25,box.y+Math.min(box.height*.5,100));
    await page.mouse.wheel(0,400);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.65,box.y+Math.min(box.height*.5,100),{steps:5});
    await page.mouse.up();
    for(let i=0;i<50&&!actions.some(item=>item.action==='pointerUp');i++)await page.waitForTimeout(100);
    assert.ok(actions.some(item=>item.action==='scroll'&&(item.delta??0)>0),'滚轮应转发至目标网页');
    await target.waitForFunction(()=>window.scrollY>0);
    assert.ok(await target.evaluate(()=>window.scrollY)>0,'目标网页应实际向下滚动');
    const down=actions.findIndex(item=>item.action==='pointerDown');
    const up=actions.findIndex(item=>item.action==='pointerUp');
    assert.ok(down>=0&&up>down,'拖动应先按下再松开');
    assert.ok((actions[up].x??0)>(actions[down].x??0),'松开时的位置应随拖动改变');
  } finally {
    await browser?.close();
    if(service.exitCode===null&&service.signalCode===null){const stopped=new Promise<void>(resolve=>service.once('exit',()=>resolve()));service.kill('SIGTERM');await stopped;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
