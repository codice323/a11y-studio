import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { strToU8, zipSync } from 'fflate';
import { registerTestAccount, attachTestAccount } from './helpers/account';
import { seedBrowserCapture } from './helpers/project-import';
import { normalizeCaptureUrl } from '../packages/shared/capture-url';

test('URL 和 ZIP 可在诊断工作台内交互、修复和验证', {timeout:120000}, async()=>{
  assert.equal(normalizeCaptureUrl(' baidu.com '),'https://baidu.com/');
  assert.throws(()=>normalizeCaptureUrl('javascript:alert(1)'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-managed-ui-'));
  const socket=http.createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=(socket.address() as AddressInfo).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const base=`http://127.0.0.1:${port}`;
  const modelRequests: Array<{messages:Array<{role:string;content:unknown}>}> = [];
  let modelColor='#080808';
  const model = http.createServer(async (req,res)=>{
    const chunks: Buffer[]=[];
    for await (const chunk of req) chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString()) as (typeof modelRequests)[number];
    modelRequests.push(request);
    res.setHeader('Content-Type','application/json');
    const colorRequest=request.messages.some(message=>message.role==='user' && String(message.content).includes('color-contrast'));
    const colorTools=request.messages.filter(message=>message.role==='tool');
    const message=colorRequest ? (colorTools.length
      ? {content:JSON.stringify({plan:{defaultColor:modelColor,overrides:[]},reason:'调暗文字以提高对比度。'})}
      : {tool_calls:[
        {id:'inspect',type:'function',function:{name:'inspect_issue',arguments:'{}'}},
        {id:'wcag',type:'function',function:{name:'search_wcag',arguments:'{"query":"文字 颜色 对比度 4.5"}'}},
        {id:'samples',type:'function',function:{name:'read_contrast_samples',arguments:'{}'}},
      ]}) : request.messages[0]?.content?.toString().includes('image-text') ? {content:JSON.stringify({
        description:'浅灰色的报名通知文字。',purpose:'informative',contentAlt:'报名通知',reason:'图片传达报名时间。',
        legibility:{kind:'image-text',observation:'文字过浅。',recommendation:'用深色文字重排。',textOnly:'报名截止时间：周五'},
      })} : {content:'{}'};
    res.end(JSON.stringify({choices:[{message}]}));
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const modelPort=(model.address() as AddressInfo).port;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),BETTER_AUTH_URL:base,A11Y_DATA_DIR:dir,
    AI_BASE_URL:'http://127.0.0.1:'+modelPort,AI_VISION_MODEL:'test-vision',AI_API_KEY:'test-key'},stdio:'ignore'});
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
    await target.setContent('<!doctype html><html><body><main style="height:4000px">顶部<div style="margin-top:2500px">页面底部内容</div><input id="search" style="position:fixed;left:30px;top:35px"><script>search.onkeydown=e=>{if(e.key==="Enter")search.dataset.submitted=search.value}</script></main></body></html>');
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const image='data:image/png;base64,'+fs.readFileSync('tests/fixtures/vision/bars.png').toString('base64');
    const payload={format:'a11y-studio-browser-capture',version:1,title:'课程报名',capturedAt:new Date().toISOString(),
      viewport:{width:1280,height:820},screenshot:image,violations:[],incomplete:0,limitations:[],
      html:`<!doctype html><html lang="zh-CN"><title>课程报名</title><main><h1>报名条件</h1><p>参加课程需填写报名表。</p><img id="test-element" src="${image}" width="60" height="60"><h2>报名材料</h2><ul><li>姓名</li></ul><a data-a11y-reading-href="https://example.com/course">课程详情</a><button type="button">查看报名状态</button><p hidden>不应显示</p><details><summary>展开报名信息</summary><p>报名截止时间</p></details><label>报名姓名<input></label><label><input type="checkbox">确认参加</label><div style="height:2200px"></div><footer>页尾</footer></main></html>`};
    const project=await seedBrowserCapture(page,base,dir,payload);
    const entry='https://baidu.com/';
    const entryKey=createHash('sha256').update(entry).digest('hex');
    const replayDir=path.join(dir,'browser-replays');
    fs.mkdirSync(replayDir,{recursive:true});
    fs.writeFileSync(path.join(replayDir,project.id+'.json'),JSON.stringify({version:1,entry,entryKey,
      resources:{[entryKey]:{type:'text/html',body:Buffer.from(`<!doctype html><html lang="zh-CN"><head><title>课程报名</title></head><body><img id="test-element" src="${image}" width="60" height="60"><button id="open" style="position:absolute;left:40px;top:100px;width:180px;height:48px">查看报名状态</button><input id="unlabelled" style="position:absolute;left:40px;top:160px;width:180px;height:40px"><p id="result" hidden>报名已开放</p><p id="typed"></p><a href="/uncaptured" target="_blank" style="position:absolute;left:40px;top:220px">未采集课程</a><div style="height:1800px"></div><script>document.getElementById("open").onclick=()=>{document.getElementById("result").hidden=false};document.getElementById("unlabelled").onkeydown=event=>{if(event.key==="Enter")document.getElementById("typed").textContent=event.currentTarget.value};</script></body></html>`).toString('base64')}}}));
    let starts=0;
    let activeUrl='https://baidu.com/';
    const diagnosticVisits:string[]=[];
    let forcedScans=0;
    const secondUrl='https://baidu.com/second';
    const uncapturedUrl='https://baidu.com/uncaptured';
    const currentIssues=()=>page.getByRole('region',{name:'待处理问题'});

    const actions:Array<{action:string;delta?:number;x?:number;y?:number}>=[];
    const frame={image:'data:image/png;base64,'+fs.readFileSync('tests/fixtures/vision/bars.png').toString('base64'),width:1280,height:820,title:'采集成功',url:'https://baidu.com/',scrollHeight:820,failedResources:2};
    await page.route('**/api/browser-capture-sessions**',async route=>{
      const req=route.request();
      if(req.method()==='DELETE')return route.fulfill({status:204});
      if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/browser-capture-sessions'){
        activeUrl=req.postDataJSON().url;
        starts++;assert.equal(activeUrl,starts===5 ? uncapturedUrl : entry);
        if(starts===1)return route.fulfill({status:404,json:{error:'资源不存在。'}});
        return route.fulfill({status:201,json:{id:'session-'+starts,frame:{...frame,url:activeUrl}}});
      }
      if(req.method()==='POST' && new URL(req.url()).pathname.endsWith('/diagnostics')) {
        const {url,refresh}=req.postDataJSON();
        diagnosticVisits.push(url);
        if(refresh) forcedScans++;
        return route.fulfill({json:{path:url,title:url===secondUrl?'第二页':'已检测网页',coverage:{review:[{id:'color-contrast',help:'文字对比度待核查',count:3}],bestPractices:[{id:'landmark-one-main',help:'缺少主内容地标',count:1}]},findings:[{
          id:url, ruleId:url===secondUrl?'button-name':'image-alt',selector:'#test-element',
          help:'测试问题',description:'测试问题',impact:'critical',bounds:null,
        },...(url===secondUrl ? ['pictures','videos'].map(id=>({
          id,ruleId:'color-contrast',selector:'#'+id,locationGroup:'search-tabs',
          help:'文字对比度不足',description:'文字对比度不足',impact:'serious',bounds:null,
        })) : [])]}});
      }
      if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/action')){
        const action=req.postDataJSON();actions.push(action);
        if(action.action==='pointerUp'){
          if(action.x<200)await target.mouse.click(action.x,action.y);
          else activeUrl=secondUrl;
        }
        if(action.action==='text')await target.keyboard.insertText(action.text);
        if(action.action==='key')await target.keyboard.press(action.key);
        if(action.action==='back') activeUrl='https://baidu.com/';

        if(action.action==='scroll'){
          await target.mouse.move(action.x??640,action.y??410);
          await target.mouse.wheel(0,action.delta);
        }
      }
      if(req.method()==='POST'&&new URL(req.url()).pathname.endsWith('/capture')) {
        assert.equal(req.postDataJSON().expectedUrl,activeUrl);
        return route.fulfill({status:201,json:project});
      }
      return route.fulfill({json:{...frame,url:activeUrl}});
    });
    const open=async()=>{
      await page.getByRole('button',{name:'URL',exact:true}).click();
      await page.getByLabel('网页地址',{exact:true}).fill('baidu.com');
      await page.getByRole('button',{name:'打开采集浏览器'}).click();
    };
    await page.goto(base);await open();
    assert.equal(await page.getByRole('navigation',{name:'工作空间导航'}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'诊断工作台',exact:true}).getAttribute('aria-current'),'page');
    assert.equal(new URL(page.url()).hash,'');
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
    assert.equal(new URL(page.url()).hash,'');
    await open();await page.getByRole('region',{name:'应用内原网页实时画面'}).waitFor();
    assert.equal(starts,4);
    await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).waitFor();
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
    await currentIssues().getByRole('button',{name:/按钮缺少名称/}).waitFor();
    assert.equal(await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).count(),0);
    const contrastIssues = currentIssues().getByRole('button',{name:/文字对比度不足.*影响 2 处/});
    assert.equal(await contrastIssues.count(),1);
    await contrastIssues.click();
    const locations = page.getByLabel('问题位置');
    await locations.waitFor();
    assert.equal(await locations.locator('option').count(),2);
    await locations.selectOption('videos');
    assert.equal(await locations.inputValue(),'videos');
    const visitsBeforeBack=diagnosticVisits.length;
    await page.getByRole('button',{name:'返回上一页'}).click();
    await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).waitFor();
    assert.equal(diagnosticVisits.length,visitsBeforeBack,'返回已检测的 URL 应命中缓存');
    assert.equal(await page.getByRole('checkbox',{name:/向原网页转发键盘/}).count(),0);
    assert.equal(await page.getByRole('button',{name:'向下滚动',exact:true}).count(),0);
    await screen.click({position:{x:65/1280*box.width,y:44/820*box.height}});
    await page.keyboard.type('A1');
    await page.keyboard.press('Backspace');
    const inputSession=await context.newCDPSession(page);
    await inputSession.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    await inputSession.send('Input.insertText',{text:'中文'});
    await inputSession.detach();
    await page.keyboard.press('Enter');
    await target.waitForFunction(()=>document.querySelector<HTMLInputElement>('#search')?.dataset.submitted==='A中文');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('textbox',{name:'在当前网页中输入'}).evaluate(field=>document.activeElement===field),false);
    await currentIssues().getByText('待人工复核 · 3 处',{exact:true}).click();
    await currentIssues().getByText('文字对比度不足 · 3 处',{exact:true}).waitFor();
    await currentIssues().getByText('最佳实践建议 · 1 处',{exact:true}).waitFor();
    const forcedScan = (response:import('playwright-core').Response) =>
      response.request().method() === 'POST' && response.url().endsWith('/diagnostics') && response.request().postDataJSON()?.refresh === true;
    await Promise.all([
      page.waitForResponse(forcedScan),
      page.getByRole('button',{name:'重新检测当前页面',exact:true}).click(),
    ]);
    await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).waitFor();
    assert.equal(forcedScans,1);
    await Promise.all([
      page.waitForResponse(forcedScan),
      page.getByRole('button',{name:'刷新页面',exact:true}).click(),
    ]);
    await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).waitFor();
    assert.equal(forcedScans,2);
    await currentIssues().getByRole('button',{name:/图片缺少替代文本/}).click();
    const details=page.getByRole('region',{name:'当前页面问题详情'});
    await details.getByRole('button',{name:'修复此问题',exact:true}).click();
    const assistant=page.getByRole('tabpanel',{name:'AI 修复助手'});
    await assistant.getByRole('heading',{name:'图片缺少替代文本'}).waitFor().catch(async error=>{
      throw new Error(String(error)+'\n'+(await page.getByRole('alert').allTextContents()).join('\n'));
    });
    await assistant.getByRole('button',{name:'AI 分析与修复',exact:true}).click();
    const visual = assistant.getByRole('region',{name:'图片可读性建议'});
    await visual.getByText('报名截止时间：周五',{exact:true}).waitFor();
    const downloadEvent=page.waitForEvent('download');
    await visual.getByRole('button',{name:'下载高对比 PNG'}).click();
    const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),'high-contrast-text.png');
    const png=fs.readFileSync((await download.path())!);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.ok(png.readUInt32BE(16)>64 && png.readUInt32BE(20)>64);
    await assistant.getByRole('radio',{name:'内容性图片'}).check();
    await assistant.getByLabel('建议的文本内容').fill('课程报名图示');
    await assistant.getByRole('button',{name:'生成补丁预览'}).click();
    await page.getByRole('button',{name:'确认应用修复',exact:true}).waitFor();
    const comparison=page.getByRole('region',{name:'诊断工作区'}).locator('.inline-interactive');
    const screenReplay = comparison.getByRole('button',{name:'可操作网页画面',exact:true});
    await screenReplay.waitFor({timeout:30000});
    assert.equal(await comparison.locator('.live-screen').count(),1);
    assert.equal(await page.getByText('扫描截图',{exact:true}).count(),0);
    assert.equal(await comparison.getByRole('checkbox',{name:'查看原始状态'}).count(),0);
    await page.getByText(/已完成当前页面自动检测|自动检测暂未确认问题/).waitFor();
    const replayBox = await screenReplay.boundingBox();
    assert.ok(replayBox);
    const clickReply = page.waitForResponse(response=>response.url().endsWith('/action') &&
      response.request().postDataJSON()?.operation?.action === 'click');
    await screenReplay.click({position:{x:130/1280*replayBox.width,y:124/820*replayBox.height}});
    const clickResponse = await clickReply;
    const result = await clickResponse.json();
    assert.ok(clickResponse.ok() && result.outcome, JSON.stringify(result.outcome ?? result.error));
    assert.equal(result.outcome.executions.right.status,'executed');
    const verifyReplay=page.waitForResponse(response=>response.url().endsWith('/scan/right'));
    await comparison.getByRole('button',{name:'更多操作'}).click();
    await comparison.getByRole('button',{name:'检测当前页面',exact:true}).click();
    assert.match((await (await verifyReplay).json()).ax,/报名已开放/);

    await comparison.getByRole('button',{name:'查看采集副本'}).click();
    const iframe=comparison.locator('iframe');
    const copy=comparison.frameLocator('iframe');
    await copy.getByRole('heading',{name:'报名条件'}).waitFor();
    assert.equal(await iframe.count(),1);
    assert.equal(await copy.locator('html').evaluate(()=>innerWidth),1280);
    await copy.getByText('展开报名信息').press('Enter');
    await copy.getByText('报名截止时间').waitFor();
    await copy.getByLabel('报名姓名').fill('测试');
    assert.equal(await copy.getByLabel('报名姓名').inputValue(),'测试');
    const originalUrl=page.url();
    const tabCount=context.pages().length;
    await copy.getByRole('link',{name:'课程详情'}).focus();
    await copy.getByRole('link',{name:'课程详情'}).press('Enter');
    await comparison.getByText('此操作需要原站页面或脚本。',{exact:true}).waitFor();
    assert.equal(context.pages().length,tabCount);
    assert.equal(page.url(),originalUrl);
    assert.equal(starts,4);

    const navigation=page.getByRole('navigation',{name:'工作空间导航'});
    assert.deepEqual(await navigation.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label'))),
      ['诊断工作台','结果报告']);
    const reading=base+'/api/projects/'+project.id+'/reading';
    assert.equal((await page.request.get(reading)).status(),404);
    assert.equal((await page.request.post(reading+'/guide',{headers:{origin:base},data:{}})).status(),404);
    assert.equal(new URL(page.url()).searchParams.get('project'),project.id);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('a11y-studio:url-capture')),null);
    assert.equal(await comparison.getByRole('button',{name:'实时操作原网页',exact:true}).count(),0);
    await page.getByRole('button',{name:'确认应用修复',exact:true}).click();
    await page.getByRole('checkbox',{name:/我已确认图片用途和替代文本/}).check();
    await page.getByRole('button',{name:'确认应用并复测',exact:true}).click();
    await assistant.getByRole('heading',{name:'复测通过',exact:true}).waitFor();
    await screenReplay.waitFor();
    await comparison.getByRole('heading',{name:'当前状态',exact:true}).waitFor();
    await comparison.getByRole('button',{name:'查看采集副本'}).click();
    await copy.locator('#test-element[alt="课程报名图示"]').waitFor();
    const viewOriginal=comparison.getByRole('checkbox',{name:'查看原始状态'});
    await viewOriginal.check();
    await copy.locator('#test-element:not([alt])').waitFor();
    await viewOriginal.uncheck();
    await copy.locator('#test-element[alt="课程报名图示"]').waitFor();
    await comparison.getByRole('button',{name:'回放原站脚本',exact:true}).click();
    await screenReplay.waitFor({timeout:20000});
    await comparison.getByRole('heading',{name:'当前状态',exact:true}).waitFor();
    const repairedBox=await screenReplay.boundingBox();
    assert.ok(repairedBox);
    await screenReplay.click({position:{x:100/1280*repairedBox.width,y:175/820*repairedBox.height}});
    await page.keyboard.type('A1');
    await page.keyboard.press('Backspace');
    const replayIme=await context.newCDPSession(page);
    await replayIme.send('Input.imeSetComposition',{text:'zhong',selectionStart:5,selectionEnd:5});
    await replayIme.send('Input.insertText',{text:'中文'});
    await replayIme.detach();
    const enter=page.waitForResponse(response=>response.url().endsWith('/action') &&
      response.request().postDataJSON()?.operation?.key==='Enter');
    await page.keyboard.press('Enter');
    assert.equal((await (await enter).json()).outcome.executions.right.status,'executed');
    const repairedScan=page.waitForResponse(response=>response.url().endsWith('/scan/right'));
    if (await comparison.getByRole('button',{name:'更多操作'}).getAttribute('aria-expanded')!=='true') {
      await comparison.getByRole('button',{name:'更多操作'}).click();
    }
    await comparison.getByRole('button',{name:'检测当前页面',exact:true}).click();
    assert.match((await (await repairedScan).json()).ax,/A中文/);
    const repairedTabCount=context.pages().length;
    const missingLink=page.waitForResponse(response=>response.url().endsWith('/action') &&
      response.request().postDataJSON()?.operation?.action==='click');
    await screenReplay.click({position:{x:60/1280*repairedBox.width,y:230/820*repairedBox.height}});
    const beforePreview=await (await missingLink).json();
    assert.equal(beforePreview.outcome.uncapturedUrl,uncapturedUrl);
    await screenReplay.hover({position:{x:repairedBox.width/2,y:100}});
    const beforeScroll=page.waitForResponse(response=>response.url().endsWith('/action') &&
      response.request().postDataJSON()?.operation?.action==='scroll');
    await page.mouse.wheel(0,200);
    const previousScroll=(await (await beforeScroll).json()).right.scroll;
    assert.ok(previousScroll>0);
    const repairedUrl=page.url();
    await page.getByRole('button',{name:'在工作台检测链接'}).click();
    await screen.waitFor();
    await page.getByRole('status').filter({hasText:'已检测网页'}).waitFor();
    assert.equal(diagnosticVisits.at(-1),uncapturedUrl);
    assert.equal(context.pages().length,repairedTabCount);
    assert.equal(page.url(),repairedUrl);
    await page.getByRole('button',{name:'返回修复版本'}).click();
    await screenReplay.waitFor();
    await comparison.getByRole('heading',{name:'当前状态',exact:true}).waitFor();
    assert.equal(page.url(),repairedUrl);
    const scrollReply=page.waitForResponse(response=>response.url().endsWith('/action') &&
      response.request().postDataJSON()?.operation?.action==='scroll');
    await screenReplay.hover({position:{x:repairedBox.width/2,y:100}});
    await page.mouse.wheel(0,400);
    const afterPreview=await (await scrollReply).json();
    assert.equal(afterPreview.id,beforePreview.id);
    assert.ok(afterPreview.right.scroll>previousScroll);
    await page.goto(base+'/?project='+project.id);
    await page.reload();
    await page.waitForURL(base+'/?project='+project.id);
    await screenReplay.waitFor({timeout:20000}).catch(async error=>{
      throw new Error(String(error)+'\n'+(await page.getByRole('alert').allTextContents()).join('\n'));
    });
    assert.equal(await page.getByRole('link',{name:'实时操作原网页',exact:true}).count(),0);
    const legacy=await seedBrowserCapture(page,base,dir,{...payload,
      html:'<!doctype html><title>搜索</title><body>百度安全验证<h1>请完成下方验证后继续操作</h1></body>',
    });
    await page.goto(base+'/?project='+legacy.id);
    await page.locator('.workspace-page-status').getByText(/显示网站安全验证/).waitFor();
    await page.getByText('未完成检测',{exact:true}).waitFor();
    const tabs = page.getByRole('tablist',{name:'诊断工作台操作'});
    assert.ok((await tabs.boundingBox())!.height < 100,'检测失败时切换栏仍应保持正常高度');
    assert.equal(await page.getByRole('region',{name:'待处理问题'}).getByText('当前页面检测失败').count(),1);
    assert.equal(await page.locator('.capture-compare-pane iframe').count(),0);

    await page.getByRole('button',{name:'切换项目'}).click();
    const html = '<!doctype html><html lang="zh-CN"><head><title>分组修复测试</title></head><body><main><h1>分组修复测试</h1>' +
      '<ul class="cards" style="margin-top:1200px"><li><span style="color:#fff;background:#ddd">说明一</span></li><li><span style="color:#fff;background:#4e6ef2">说明二</span></li></ul>' +
      '<p id="separate-color" style="color:#ccc;background:#fff">额外说明</p><div style="height:1200px"></div></main></body></html>';
    await page.locator('input[type=file]').setInputFiles({
      name:'grouped-fix.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'index.html':strToU8(html)})),
    });
    const screenZip = page.getByRole('button',{name:'可操作网页画面',exact:true});
    await screenZip.waitFor();
    const issueGroup = currentIssues().getByRole('button',{name:/文字对比度不足.*2 处/});
    await issueGroup.waitFor();
    await page.locator('[data-entry-audited=true]').waitFor();
    assert.equal(await page.getByRole('checkbox',{name:'查看原始状态'}).count(),0);
    await issueGroup.click();
    await page.waitForFunction(()=>document.querySelectorAll('.live-screen .highlight').length===2);
    await page.getByLabel('问题位置').selectOption({index:1});
    assert.equal(await page.getByRole('checkbox',{name:'修复同组 2 处'}).isChecked(),true);
    const repairColor = page.getByLabel('修复颜色');
    assert.equal(await repairColor.getAttribute('type'),'color');
    await repairColor.fill('#1c2731');
    const customColorPreview=assistant.getByRole('button',{name:'生成补丁预览'});
    const applyCustomColor=page.getByRole('button',{name:'确认应用修复',exact:true});
    await customColorPreview.click();
    await page.getByText(/对比度 4\.34:1 → 3\.49:1，要求 4\.5:1/).waitFor();
    await page.getByText('同组 2 处，预览验证 1 处达标。',{exact:true}).waitFor();
    await page.getByText(/1\/2 处对比度达标/).waitFor();
    assert.equal(await applyCustomColor.isDisabled(),true);
    const recommend=page.getByRole('button',{name:'AI 分析与修复'});
    await recommend.click();
    await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#repair-value')?.value==='#080808');
    await customColorPreview.click();
    await page.getByText(/对比度 4\.34:1 → 4\.6\d:1，要求 4\.5:1/).waitFor();
    assert.equal(await repairColor.inputValue(),'#080808');
    await page.getByText('同组 2 处，预览验证 2 处达标。',{exact:true}).waitFor();
    const contextMessage=modelRequests.at(-1)?.messages.find(message=>message.role==='tool' && String(message.content).includes('"samples"'));
    const samples=JSON.parse(String(contextMessage?.content)).samples;
    assert.equal(samples.length,2);
    assert.ok(samples.some((sample:{background:number[];required:number})=>
      sample.background.join(',')==='78,110,242' && sample.required===4.5));
    modelColor='#ffffff';
    await recommend.click();
    await assistant.getByText(/模型未给出可通过全部位置检查的配色/).first().waitFor();
    await repairColor.fill('#080808');
    await customColorPreview.click();
    await page.getByText('2 处对比度均达标，可以应用修复。',{exact:true}).waitFor();
    await repairColor.fill('#1c2731');
    assert.equal(await applyCustomColor.isDisabled(),true);
    await repairColor.fill('#080808');
    await applyCustomColor.click();
    await page.getByRole('dialog',{name:'确认应用修复？'}).getByRole('button',{name:'应用并复测'}).click();
    const original = page.getByRole('checkbox',{name:'查看原始状态'});
    await original.waitFor();
    await assistant.getByText('修复了 2 处，复测后均达标',{exact:true}).waitFor();
    const projectApi=base+'/api/projects/'+new URL(page.url()).searchParams.get('project');
    const state = await (await page.request.get(projectApi)).json();
    assert.equal(state.current.issues.filter((issue:{ruleId:string})=>issue.ruleId==='color-contrast').length,1);
    assert.equal(state.verifications[0].patch.contrastTargets.length,2);
    assert.ok(state.verifications[0].patch.contrastTargets.every((target:{value:string})=>target.value==='#080808'));
    assert.equal(state.verifications[0].additionalContrast[0].valid,true);
    await page.getByRole('tab',{name:'问题与历史'}).click();
    await page.getByRole('button',{name:/^待处理/}).click();
    await currentIssues().getByRole('button',{name:/文字对比度不足/}).click();
    await repairColor.fill('#080808');
    await customColorPreview.click();
    await applyCustomColor.click().catch(async error=>{
      throw new Error((await page.locator('#patch-review-status').allTextContents()).join(' '),{cause:error});
    });
    await page.getByRole('dialog',{name:'确认应用修复？'}).getByRole('button',{name:'应用并复测'}).click();
    await assistant.getByRole('heading',{name:'复测通过',exact:true}).waitFor();
    const repaired = await (await page.request.get(projectApi)).json();
    assert.equal(repaired.verifications[0].fromSnapshot,state.project.currentSnapshot);
    assert.notEqual(repaired.project.currentSnapshot,state.project.currentSnapshot);
    assert.equal(repaired.current.issues.filter((issue:{ruleId:string})=>issue.ruleId==='color-contrast').length,0);
    assert.equal(await page.getByLabel('切换项目版本').count(),0);
    await page.getByRole('heading',{name:'当前状态',exact:true}).waitFor();
    const previewStart = (snapshot:string) => (response:import('playwright-core').Response) =>
      response.ok() && response.request().method()==='POST' && response.url().endsWith('/live') &&
      response.request().postDataJSON().right===snapshot;
    const [before] = await Promise.all([page.waitForResponse(previewStart(repaired.originalSnapshotId),{timeout:12000}),original.check()]);
    await screenZip.waitFor();
    assert.equal((await before.json()).capture.count,1);
    await page.getByRole('heading',{name:'原始状态',exact:true}).waitFor();
    await Promise.all([page.waitForResponse(previewStart(repaired.project.currentSnapshot),{timeout:12000}),original.uncheck()]);
    assert.equal((await (await page.request.get(projectApi)).json()).project.currentSnapshot,repaired.project.currentSnapshot);
    await page.getByRole('heading',{name:'当前状态',exact:true}).waitFor();
    assert.equal(await page.locator('.live-screen').count(),1);

  } finally {
    await browser?.close();
    if(service.exitCode===null&&service.signalCode===null){const stopped=new Promise<void>(resolve=>service.once('exit',()=>resolve()));service.kill('SIGKILL');await stopped;}
    await new Promise<void>(resolve=>model.close(()=>resolve()));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
