import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';

test('已登录页面的原始截图和检测结果可导入，同时保留独立的本地副本', {timeout:90000}, async () => {
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-browser-capture-'));
  process.env.A11Y_DATA_DIR=data;
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(!req.headers.cookie?.includes('session=authenticated'))return res.end('<html lang="zh-CN"><title>登录</title><body>请登录</body></html>');
    res.end('<!doctype html><html lang="zh-CN"><head><title>账户页面</title></head><body><main><h1 id="welcome"></h1><input type="hidden" name="token" value="PRIVATE-TOKEN"><button id="missing" style="width:40px;height:40px"></button><iframe srcdoc="child"></iframe></main><script>document.getElementById("welcome").textContent="已登录的账户内容"</script></body></html>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const context=await browser.newContext({viewport:{width:900,height:700}});
    const port=(server.address() as AddressInfo).port;
    await context.addCookies([{name:'session',value:'authenticated',url:`http://127.0.0.1:${port}`}]);
    const page=await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByText('已登录的账户内容').waitFor();
    await page.addScriptTag({path:'browser-extension-dist/axe.min.js'});
    await page.addScriptTag({path:'browser-extension-dist/capture.js'});
    const capture:any=await page.evaluate(()=> (globalThis as any).a11yStudioCapture());
    capture.screenshot='data:image/png;base64,'+(await page.screenshot()).toString('base64');
    assert.match(capture.html,/已登录的账户内容/);
    assert.doesNotMatch(capture.html,/PRIVATE-TOKEN|<script/i);
    assert.ok(capture.violations.some((item:any)=>item.id==='button-name'));
    assert.ok(capture.limitations.some((item:string)=>item.includes('内嵌框架')));
    const { importBrowserCapture, browserCapture, browserCaptureScreenshot }=await import('../apps/api/browser-capture');
    const { projectState }=await import('../apps/api/version-state');
    const { runAudit }=await import('../apps/api/scan');
    const { db }=await import('../apps/api/storage');
    try {
      const file={originalname:'capture.json',buffer:Buffer.from(JSON.stringify(capture))} as Express.Multer.File;
      const project=await importBrowserCapture(file);
      const audit=await runAudit(project.id,project.currentSnapshot);
      assert.ok(audit.issues.some(item=>item.ruleId==='button-name'));
      assert.equal(browserCapture(project.id).title,'账户页面');
      assert.ok(fs.existsSync(browserCaptureScreenshot(project.id)));
      assert.ok(projectState(project.id).browserCapture.violations.some((item:any)=>item.id==='button-name'));
      await assert.rejects(importBrowserCapture({...file,buffer:Buffer.from('{}')}),/格式无效/);
    } finally {db.close();}
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    fs.rmSync(data,{recursive:true,force:true});
  }
});
