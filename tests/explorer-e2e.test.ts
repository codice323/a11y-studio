import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { campusFixtures } from '../scripts/campus-fixtures';
import { registerTestAccount, testFetch } from './helpers/account';
import type { ExplorerGraph, PanoramaCapture } from '../packages/shared/panorama';

const html = (body:string) => '<!doctype html><html lang="en"><head><title>Exhibit reservations</title></head><body>'+body+'</body></html>';
const project = {
  'package.json':JSON.stringify({dependencies:{react:'*','react-dom':'*'},devDependencies:{vite:'*'}}),
  'index.html':html('<div id="root"></div><script type="module" src="/src/index.tsx"></script>'),
  'src/index.tsx':`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
function Exhibit(){
 const [route,go]=useState('/'),[dialog,setDialog]=useState(false),[tab,setTab]=useState(false),[menu,setMenu]=useState(false);
 return <main>
 <h1>{route==='/'?'Exhibit reservations':route==='/tickets'?'Tickets':'Visit information'}</h1>
 {route==='/' && <nav aria-label="Main">
 <a href="/tickets" onClick={e=>{e.preventDefault();history.pushState({},'','/tickets');go('/tickets')}}>Tickets</a>
 <a href="/visit" onClick={e=>{e.preventDefault();history.pushState({},'','/visit');go('/visit')}}>Visit information</a>
 <a href="/checkout" onClick={()=>document.body.dataset.unsafe='true'}>Checkout</a>
 </nav>}
 {route==='/tickets' && <>
 <button type="button" aria-haspopup="dialog" onClick={()=>setDialog(true)}>Ticket terms</button>
 {dialog && <section role="dialog" aria-modal="true" aria-label="Ticket terms" onKeyDown={e=>{if(e.key==='Escape')setDialog(false)}}>
 <button type="button" id="print-terms"><span aria-hidden="true">⎙</span></button>
 <button type="button" onClick={()=>setDialog(false)}>Close terms</button></section>}
 </>}
 {route==='/visit' && <>
 <button type="button" aria-expanded={menu} aria-controls="schedule" onClick={()=>setMenu(!menu)}>Schedule</button>
 <section id="schedule" hidden={!menu}><button type="button">Well named</button></section>
 <div role="tablist" aria-label="Visit options"><button role="tab" aria-selected={!tab} onClick={()=>setTab(false)}>Today</button><button role="tab" aria-selected={tab} onClick={()=>setTab(true)}>Tomorrow</button></div>
 <p role="tabpanel">{tab?'Tomorrow afternoon':'Today morning'}</p>
 <form><label htmlFor="code">Visit code</label><input id="code" required pattern="[0-9]+"/><button>Check availability</button></form>
 </>}
 </main>;
}
createRoot(document.querySelector('#root')).render(<Exhibit/>);`,
};

type Evidence = PanoramaCapture & {stateId:string;screenshot:string};
const archive = (files:Record<string,string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,body])=>[name,strToU8(body)]))));

test('Chrome Explorer follows real campus and React paths, blocks unsafe actions, preserves reports and replays a repair', {timeout:380_000}, async()=>{
  const data = await mkdtemp(path.join(os.tmpdir(),'a11y-explorer-e2e-'));
  const output = process.env.A11Y_EXPLORER_EVIDENCE;
  if (output) await mkdir(output,{recursive:true});
  const probe = net.createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin = 'http://127.0.0.1:'+port;
  let mockCalls=0;
  const mock=http.createServer(async (req,res)=>{
    const chunks:Buffer[]=[];
    for await (const chunk of req) chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString());
    mockCalls++;
    const tool = (id:string,name:string,args:object)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
    const message=request.messages.some((item:{role:string})=>item.role==='tool')
      ? {content:JSON.stringify({value:'Print terms',reason:'按钮用于打印弹窗中的票务条款。',needsReview:true})}
      : {tool_calls:[tool('inspect','inspect_issue',{}),tool('search','search_wcag',{query:'button accessible name'})]};
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message}]}));
  });
  mock.listen(0,'127.0.0.1');
  await once(mock,'listening');
  const service = spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,
    PORT:String(port),A11Y_DATA_DIR:data,AI_API_KEY:'local-mock',AI_BASE_URL:'http://127.0.0.1:'+(mock.address() as net.AddressInfo).port},stdio:['ignore','ignore','pipe']});
  let errors='';
  service.stderr.on('data',part=>{errors+=part;});
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  if(output) await context.tracing.start({screenshots:true,snapshots:true});
  const page = await context.newPage();
  const save = async (file:string,content:unknown) => {if(output) await writeFile(path.join(output,file),JSON.stringify(content,null,2));};
  const network:{path:string;method:string;status:number}[] = [];
  page.on('response',r=>{const url = new URL(r.url());if(url.origin===origin)network.push({path:url.pathname,method:r.request().method(),status:r.status()});});
  async function upload(name:string,buffer:Buffer,mode:'ZIP'|'源码工程') {
    if(await page.getByRole('button',{name:'切换项目',exact:true}).isVisible()) await page.getByRole('button',{name:'切换项目',exact:true}).click();
    else await page.goto(origin);
    await page.getByRole('button',{name:mode,exact:true}).click();
    await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/zip',buffer});
    await page.getByRole('button',{name:'自动探索与检测'}).waitFor();
    const projects=await (await testFetch(origin+'/api/projects')).json();
    const imported=projects.find((item:{name:string})=>item.name===name);
    assert.ok(imported);
    return imported.id as string;
  }
  async function explore(projectId:string) {
    const button=page.getByRole('button',{name:'自动探索与检测'});
    await button.click({timeout:30_000});
    const waiting=page.getByRole('heading',{name:'结果报告',exact:true});
    await waiting.waitFor({timeout:165_000});
    await page.getByText(/自动探索记录/).waitFor();
    const response=await testFetch(origin+'/api/projects/'+projectId+'/reports');
    assert.ok(response.ok,await response.clone().text());
    const {site}=await response.json() as {site:{exploration:ExplorerGraph;states:Evidence[]}};
    const {exploration:graph,states}=site;
    if (!graph?.nodes.some(node=>node.captureId)) await save('failed-exploration.json',{graph,states});
    assert.ok(graph && graph.nodes.some(node=>node.captureId),JSON.stringify(graph?.edges));
    assert.equal(graph.projectId,projectId);
    assert.equal(graph.maxContextConcurrency,1);
    assert.ok(graph.replayStepsReserved<=graph.budget.actions);
    assert.ok(graph.nodes.every(node=>!node.captureId || states.some(state=>state.id===node.captureId && state.path===node.path && state.scan?.engine.version)));
    return {graph,states};
  }
  try {
    for(let i=0;!(await fetch(origin+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error(errors || '启动超时');
      await delay(100);
    }
    const credentials={email:'explorer-'+randomBytes(6).toString('hex')+'@example.test',password:randomBytes(9).toString('hex'),name:'Explorer test'};
    await registerTestAccount(origin,credentials);
    await page.goto(origin);
    await page.getByLabel('邮箱',{exact:true}).fill(credentials.email);
    await page.getByLabel('密码',{exact:true}).fill(credentials.password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('heading',{name:'我的项目',exact:true}).waitFor();
    const campus=await campusFixtures(path.join(data,'campus'));
    const campusId=await upload('campus-multipage.zip',await readFile(campus.zip),'ZIP');
    const campusResult=await explore(campusId);
    await save('campus.json',campusResult);
    assert.equal(campusResult.graph.pages.filter(p=>p.status==='visited').length,6);
    assert.equal(new Set(campusResult.states.map(p=>p.path)).size,6);
    assert.ok(campusResult.states.every(p=>p.scan?.resources.images===p.scan?.resources.loadedImages && p.scan?.resources.stylesheets===p.scan?.resources.loadedStylesheets));
    const dynamicId=await upload('exhibit-engineering.zip',archive(project),'源码工程');
    const {graph,states}=await explore(dynamicId);
    await save('react.json',{graph,states});
    assert.deepEqual(graph.pages.filter(p=>p.status==='visited').map(p=>p.path).sort(),['/index.html','/tickets','/visit']);
    assert.ok(!graph.edges.some(e=>e.path==='/checkout'));
    assert.ok(graph.omitted.blocked > 0);
    assert.ok(graph.edges.some(e=>e.status==='duplicate'));
    assert.ok(graph.edges.some(e=>e.step?.action==='validate' && e.interaction?.some(i=>i.ruleId.includes('form'))));
    const modal=states.find(s=>s.path==='/tickets' && s.ax.includes('dialog "Ticket terms"') && s.issues.some(i=>i.ruleId==='button-name' && i.selector==='#print-terms'));
    assert.ok(modal);
    assert.ok(modal.scan?.interaction?.findings.some(i=>i.ruleId==='modal-focus-entry' && i.status==='confirmed'),
      JSON.stringify(modal.scan?.interaction?.findings));
    assert.ok(states.some(s=>s.ax.includes('button "Well named"') && !s.issues.some(i=>i.ruleId==='button-name')));
    assert.ok(states.some(s=>s.ax.includes('Tomorrow afternoon')));
    assert.ok(modal.screenshot && (await testFetch(origin+modal.screenshot)).ok);
    if(output) await page.screenshot({path:path.join(output,'report.png'),fullPage:false});
    const other=await browser.newContext();
    const guest=await other.request.post(origin+'/api/auth/sign-in/anonymous',{headers:{origin},data:{}});
    assert.ok(guest.ok(),await guest.text());
    for(const resource of ['/api/projects/'+dynamicId+'/reports',modal.screenshot]) {
      assert.ok([403,404].includes((await other.request.get(origin+resource)).status()));
    }
    await other.close();

    const detail=page.locator('details').filter({has:page.locator('summary').filter({hasText:'自主探索 · Ticket terms'})}).last();
    await detail.locator('summary').first().click();
    await detail.getByRole('button',{name:'在诊断中查看'}).first().click();
    await page.getByRole('button',{name:'AI 分析与修复'}).click();
    await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#repair-value')?.value==='Print terms');
    assert.equal(mockCalls,2);
    await page.getByRole('button',{name:'生成补丁预览'}).click();
    await page.getByRole('button',{name:'确认应用修复'}).click({timeout:55_000});
    await page.getByLabel('我已核对修复内容和页面用途，确认适合应用').check();
    await page.getByRole('button',{name:'确认应用并复测'}).click();
    await page.getByText('已在同一交互状态中验证按钮名称，当前版本已更新。').waitFor({timeout:90_000});
    const after=await (await testFetch(origin+'/api/projects/'+dynamicId+'/reports')).json() as {site:{states:Evidence[];snapshotId:string}};
    const replay=after.site.states.find(item=>item.stateId===modal.stateId);
    assert.notEqual(after.site.snapshotId,graph.snapshotId);
    await save('repair-replay.json',{before:modal,after:replay});
    assert.ok(replay?.ax.includes('button "Print terms"') &&
      !replay.issues.some(i=>i.ruleId==='button-name' && i.selector==='#print-terms'));
    assert.ok(replay.scan?.interaction?.findings.some(item=>item.ruleId==='modal-focus-entry'));
    if(output) await page.screenshot({path:path.join(output,'verified-repair.png'),fullPage:false});
    const exported=await page.request.get(origin+'/api/projects/'+dynamicId+'/export');
    assert.ok(exported.ok());
    const zip=await exported.body();
    const entries=unzipSync(zip);
    assert.match(strFromU8(entries['source/src/index.tsx']),/aria-label\s*=\s*(?:["']Print terms["']|\{\s*["']Print terms["']\s*\})/);
    assert.ok(entries['report/report.json']);
    if(output) await writeFile(path.join(output,'verified-project.zip'),zip);
    const holdoutId=await upload('archive-holdout.zip',archive({
      'index.html':html('<main><h1>Local history</h1><a href="guides/index.html">Reading guides</a></main>'),
      'guides/index.html':html('<main><h1>Reading guides</h1><a href="../index.html">Local history</a>'+
        '<details><summary>Map notes</summary><p><button id="unlabeled-archive"><span aria-hidden="true">+</span></button>'+
        '<button id="named-archive">Read index</button></p></details></main>'),
    }),'ZIP');
    const holdout=await explore(holdoutId);
    await save('holdout.json',holdout);
    assert.equal(holdout.graph.pages.filter(item=>item.status==='visited').length,2);
    assert.ok(holdout.graph.edges.some(edge=>edge.step?.action==='toggle-details' && edge.status==='captured'));
    const positive=holdout.states.some(item=>item.path==='/guides/index.html' && item.issues.some(issue=>issue.ruleId==='button-name' && issue.selector==='#unlabeled-archive'));
    const negative=holdout.states.some(item=>item.issues.some(issue=>issue.ruleId==='button-name' && issue.selector==='#named-archive'));
    assert.ok(positive && !negative);
    await save('holdout-score.json',{pageCoverage:{actual:2,expected:2},stateCoverage:{
      actual:holdout.graph.nodes.filter(item=>item.captureId).length,expected:3},
      labeledControls:{tp:Number(positive),fn:Number(!positive),fp:Number(negative),tn:Number(!negative)}});

    const cancelUrl=origin+'/api/projects/'+holdoutId+'/explore';
    const started=await testFetch(cancelUrl,{method:'POST'});
    assert.equal(started.status,202);
    const ticket=await started.json();
    assert.equal((await testFetch(cancelUrl,{method:'POST'})).status,409);
    assert.ok([401,403,404].includes((await fetch(origin+'/api/jobs/'+ticket.id)).status));
    const cancel=await testFetch(origin+'/api/jobs/'+ticket.id+'/cancel',{method:'POST'});
    assert.ok(cancel.ok,await cancel.text());
    for(let i=0;i<40;i++){
      const job=await (await testFetch(origin+'/api/jobs/'+ticket.id)).json();
      if(job.status==='cancelled'){await save('cancellation.json',job);break;}
      assert.ok(i<39,'cancelled job did not release its browser in time');
      await delay(250);
    }
  } catch (error) {
    await save('failure.json',{message:(error as Error).message,stack:(error as Error).stack,server:errors});
    throw error;
  } finally {
    await save('network.json',network);
    await save('model-mock.json',{calls:mockCalls,externalCalls:0});
    mock.close();
    if(output) await context.tracing.stop({path:path.join(output,'exploration-trace.zip')});
    await browser.close();
    if (service.exitCode===null) {service.kill();await once(service,'exit');}
    await rm(data,{recursive:true,force:true});
  }
});
