import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { registerTestAccount, attachTestAccount } from './helpers/account';

test('真实扩展连接已登录标签页并完成实时操作与当前状态导入', {timeout:90000,skip:process.env.A11Y_RUN_EXTENSION_E2E==='1' ? false : '需要支持扩展的 Playwright Chromium'}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-real-extension-'));
  const unused=http.createServer();await new Promise<void>(resolve=>unused.listen(0,'127.0.0.1',resolve));
  const appPort=(unused.address() as AddressInfo).port;await new Promise<void>(resolve=>unused.close(()=>resolve()));
  const nextSite=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><title>跨站跳转页面</title><main><h1>跨站内容</h1><div style="height:3000px">可滚动页面</div></main></html>');});
  await new Promise<void>(resolve=>nextSite.listen(0,'localhost',resolve));
  const nextUrl=`http://localhost:${(nextSite.address() as AddressInfo).port}/next`;
  const site=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(!req.headers.cookie?.includes('session=ok'))return res.end('<html><body>请登录</body></html>');
    res.end(`<!doctype html><html lang="zh-CN"><title>已登录测试页面</title><main><h1>已登录内容</h1><button id="target">原网页按钮</button><input id="field" aria-label="原网页输入"><a id="cross" target="_blank" href="${nextUrl}">跨站新标签链接</a><button id="popup" onclick="window.open('${nextUrl}','_blank','noopener')">脚本打开新页面</button><div style="height:3000px;padding-top:700px"><span id="dynamic">向下滚动</span></div></main><script>document.getElementById("target").onclick=function(){this.textContent="已点击原网页"};window.addEventListener("scroll",function(){if(scrollY>100)document.getElementById("dynamic").textContent="滚动后动态加载的内容"});</script></html>`);
  });
  await new Promise<void>(resolve=>site.listen(0,'127.0.0.1',resolve));
  const app=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(appPort),BETTER_AUTH_URL:`http://127.0.0.1:${appPort}`,A11Y_DATA_DIR:path.join(dir,'data')},stdio:'ignore'});
  let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try{
    const base=`http://127.0.0.1:${appPort}`;let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready);
    await registerTestAccount(base);
    const ext=path.join(dir,'extension');fs.cpSync('browser-extension-dist',ext,{recursive:true});
    const manifestFile=path.join(ext,'manifest.json');const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    // The isolated test opens the popup as a tab; this local-only host grant simulates activeTab for the fixture.
    manifest.host_permissions=['http://127.0.0.1/*'];fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    for(const file of ['background.js','bridge.js']){
      const target=path.join(ext,file);fs.writeFileSync(target,fs.readFileSync(target,'utf8').replaceAll('4173',String(appPort)));
    }
    context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:process.env.A11Y_EXTENSION_HEADED!=='1',viewport:{width:900,height:700},args:['--disable-extensions-except='+ext,'--load-extension='+ext]});
    await attachTestAccount(context,base);
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:15000});
    const extensionId=new URL(worker.url()).host;
    let target=await context.newPage();const siteUrl=`http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    await context.addCookies([{name:'session',value:'ok',url:siteUrl}]);await target.goto(siteUrl);
    await target.getByText('已登录内容').waitFor();
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await target.bringToFront();
    const newViewer=context.waitForEvent('page',{timeout:15000});await popup.locator('#live').click();
    const viewer=await newViewer;await viewer.waitForURL(base+'/#original-live',{timeout:15000});
    const screen=viewer.getByRole('region',{name:'原网页实时画面'});
    try{await screen.waitFor({timeout:12000});}catch(error){throw new Error('实时页面未就绪：'+(await viewer.locator('body').innerText()).slice(0,1200),{cause:error});}
    const keyboard=viewer.getByRole('checkbox',{name:'向原网页转发键盘（Shift + Esc 退出）'});
    await keyboard.check();assert.equal(await keyboard.isChecked(),true);
    await keyboard.uncheck();assert.equal(await viewer.getByRole('button',{name:'向下滚动'}).isEnabled(),true);
    const imageBefore=await screen.locator('img').getAttribute('src');
    const area=await screen.boundingBox();assert.ok(area);
    await viewer.mouse.move(area.x+area.width/2,area.y+area.height/2);
    await viewer.mouse.wheel(0,500);
    await target.waitForFunction(()=>window.scrollY>100);
    await target.getByText('滚动后动态加载的内容').waitFor();
    await viewer.waitForFunction(previous=>document.querySelector('.original-live-screen img')?.getAttribute('src')!==previous,imageBefore,{timeout:10000});
    const imageScrolled=await screen.locator('img').getAttribute('src');
    const scrollBeforeUp=await target.evaluate(()=>window.scrollY);
    await viewer.getByRole('button',{name:'向上滚动'}).click();
    await target.waitForFunction(previous=>window.scrollY<previous,scrollBeforeUp,{timeout:7000,polling:100});
    for(let i=0;i<4&&await target.evaluate(()=>window.scrollY)>0;i++){
      const previous=await target.evaluate(()=>window.scrollY);
      await viewer.getByRole('button',{name:'向上滚动'}).click();
      await target.waitForFunction(value=>window.scrollY<value,previous,{timeout:7000,polling:100});
    }
    assert.equal(await target.evaluate(()=>window.scrollY),0);
    await viewer.waitForFunction(previous=>document.querySelector('.original-live-screen img')?.getAttribute('src')!==previous,imageScrolled,{timeout:10000});
    const clickTarget=async(selector:string)=>{const a=await target.locator(selector).boundingBox(),b=await screen.boundingBox();assert.ok(a&&b);await viewer.mouse.click(b.x+(a.x+a.width/2)*b.width/900,b.y+(a.y+a.height/2)*b.height/700);};
    await clickTarget('#target');await target.getByText('已点击原网页').waitFor({timeout:10000});
    await keyboard.check();
    await clickTarget('#field');await viewer.keyboard.type('abc');
    await target.waitForFunction(()=> (document.querySelector('#field') as HTMLInputElement).value==='abc');
    await keyboard.uncheck();
    await viewer.getByLabel('向已选输入框输入文字').fill('实时输入');await viewer.getByRole('button',{name:'输入',exact:true}).click();
    await target.waitForFunction(()=> (document.querySelector('#field') as HTMLInputElement).value==='abc实时输入');
    const tabsBefore=context.pages().length;
    const beforeNavigation=await screen.locator('img').getAttribute('src');
    await clickTarget('#cross');
    await target.waitForURL(nextUrl,{timeout:10000});
    assert.equal(context.pages().length,tabsBefore);
    await target.getByText('跨站内容').waitFor();
    await viewer.waitForFunction(previous=>{const src=document.querySelector('.original-live-screen img')?.getAttribute('src');return !!src&&src!==previous;},beforeNavigation,{timeout:10000});
    const crossImage=await screen.locator('img').getAttribute('src');
    await target.goBack();await target.getByText('已登录内容').waitFor();
    await viewer.waitForFunction(previous=>{const src=document.querySelector('.original-live-screen img')?.getAttribute('src');return !!src&&src!==previous;},crossImage,{timeout:10000});
    const oldTarget=target;
    const newTab=context.waitForEvent('page',{timeout:10000});
    await clickTarget('#popup');target=await newTab;
    await target.waitForURL(nextUrl,{timeout:10000});
    await viewer.getByText('已切换到新页面。').waitFor({timeout:10000});
    await viewer.getByRole('region',{name:'原网页实时画面'}).waitFor({timeout:10000});
    assert.equal(oldTarget.isClosed(),false);
    await viewer.getByRole('button',{name:'向下滚动'}).click();await target.waitForFunction(()=>window.scrollY>100);
    await viewer.getByRole('button',{name:'检测当前状态并创建修复副本'}).click();
    await viewer.getByText('浏览器原始页面证据',{exact:false}).waitFor({timeout:45000});
    assert.ok(await viewer.getByText('跨站跳转页面',{exact:false}).count()>0);
    await viewer.close();
  } finally {
    await context?.close();
    if(app.exitCode===null&&app.signalCode===null){const stopped=new Promise<void>(resolve=>app.once('exit',()=>resolve()));app.kill('SIGKILL');await stopped;}
    await new Promise<void>(resolve=>site.close(()=>resolve()));await new Promise<void>(resolve=>nextSite.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});
  }
});
