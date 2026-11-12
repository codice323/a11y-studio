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

test('实时工作台画面可对原浏览器页面执行点击、文字输入和滚动', {timeout:60000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-original-live-'));
  const socket=http.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),BETTER_AUTH_URL:`http://127.0.0.1:${port}`,A11Y_DATA_DIR:dir},stdio:'ignore'});
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<100;i++){try{ready=(await fetch(base+'/api/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready);
    await registerTestAccount(base);
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    try{
      const context=await browser.newContext({viewport:{width:900,height:700}});
      await attachTestAccount(context,base);
      const original=await context.newPage();
      await original.setContent('<button id="target">原网页按钮</button><input id="field" aria-label="原网页输入"><div style="height:3000px">可滚动的原网页</div>');
      await original.evaluate(()=>document.querySelector('#target')!.addEventListener('click',event=>{(event.currentTarget as HTMLElement).textContent='已点击原网页';}));
      const cdp=await context.newCDPSession(original);
      const viewer=await context.newPage();
      await viewer.exposeBinding('a11yTestBridge',async(_source,message:{command:string;payload:any})=>{
        const p=message.payload||{};
        if(message.command==='frame'){
          const metrics=await cdp.send('Page.getLayoutMetrics');const shot=await cdp.send('Page.captureScreenshot',{format:'jpeg',quality:60});
          return {image:'data:image/jpeg;base64,'+shot.data,width:metrics.cssVisualViewport.clientWidth,height:metrics.cssVisualViewport.clientHeight};
        }
        if(message.command==='click'){
          await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});
          await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});return {ok:true};
        }
        if(message.command==='move'){await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});return {ok:true};}
        if(message.command==='scroll'){await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:450,y:350,deltaX:0,deltaY:p.delta});return {ok:true};}
        if(message.command==='text'){await cdp.send('Input.insertText',{text:p.text});return {ok:true};}
        throw new Error('测试不支持此操作');
      });
      await viewer.addInitScript(()=>window.addEventListener('message',async event=>{
        if(event.source!==window||event.data?.channel!=='a11y-original-request')return;
        try{const value=await (window as any).a11yTestBridge(event.data);window.postMessage({channel:'a11y-original-response',id:event.data.id,value},location.origin);}
        catch(error){window.postMessage({channel:'a11y-original-response',id:event.data.id,error:String(error)},location.origin);}
      }));
      await viewer.goto(base+'/#original-live');
      const screen=viewer.getByRole('region',{name:'原网页实时画面'});
      await screen.waitFor({timeout:15000});
      const clickOriginal=async(selector:string)=>{
        const target=await original.locator(selector).boundingBox(),display=await screen.boundingBox();
        assert.ok(target&&display);
        await viewer.mouse.click(display.x+(target.x+target.width/2)*display.width/900,display.y+(target.y+target.height/2)*display.height/700);
      };
      await clickOriginal('#target');
      await original.getByText('已点击原网页').waitFor();
      await clickOriginal('#field');
      await viewer.getByLabel('向已选输入框输入文字').fill('真实输入');
      await viewer.getByRole('button',{name:'输入',exact:true}).click();
      await original.waitForFunction(()=> (document.querySelector('#field') as HTMLInputElement).value==='真实输入');
      await viewer.getByRole('button',{name:'向下滚动'}).click();
      await original.waitForFunction(()=>window.scrollY>100);
      assert.ok(await original.evaluate(()=>window.scrollY)>100);
      await context.close();
    } finally {await browser.close();}
  } finally {
    if(service.exitCode===null&&service.signalCode===null){const stopped=new Promise<void>(resolve=>service.once('exit',()=>resolve()));service.kill('SIGKILL');await stopped;}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
