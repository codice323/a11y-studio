import { testFetch as fetch, registerTestAccount, attachTestAccount } from './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, zipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';
import { campusFixtures } from '../scripts/campus-fixtures';

const fixture = {
  'package.json': JSON.stringify({dependencies:{react:'*','react-dom':'*'},devDependencies:{vite:'*'}}),
  'index.html': '<!doctype html><html lang="en"><head><title>Field station</title></head><body><div id="root"></div><script type="module" src="/src/app.tsx"></script></body></html>',
  'src/app.tsx': `import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
function App(){
  const [route,setRoute]=useState('/'),[menu,setMenu]=useState(false),[modal,setModal]=useState(false),[active,setActive]=useState(false);
  const opener=useRef(null);
  return <main style={{minHeight:1800}}><h1>{route==='/'?'Field station':'Bookings'}</h1>
    {route==='/' ? <a style={{position:'absolute',top:100,left:40,width:160,height:44}} href="/bookings" onClick={event=>{event.preventDefault();history.pushState({},'',event.currentTarget.href);setRoute('/bookings')}}>Bookings</a> :
    <>
      <button id="menu-control" type="button" aria-controls="options" aria-expanded={false} onClick={()=>setMenu(!menu)}>Filter by period</button>
      {menu && <section id="options"><button id="menu-bad" type="button"><span aria-hidden="true">?</span></button></section>}
      <div role="tablist" aria-label="Booking view"><button role="tab" aria-selected={!active} onClick={()=>setActive(false)}>Overview</button><button role="tab" aria-selected={active} onClick={()=>setActive(true)}>Details</button></div>
      {active && <p role="status">Details available</p>}
      <button id="opener" type="button" ref={opener} onClick={()=>setModal(true)}>Booking details</button>
      {modal && <section id="dialog" role="dialog" aria-modal="true" aria-label="Booking details"><button id="modal-bad" type="button"><span aria-hidden="true">!</span></button><button id="modal-schedule" type="button">View schedule</button><button type="button" onClick={()=>{setModal(false); opener.current.focus()}}>Close details</button></section>}
      <form><label htmlFor="slot">Slot code</label><input id="slot" required pattern="[0-9]+"/><button>Validate booking</button></form>
      {['A','B','C','D'].map(letter=><button type="button" key={letter}>Station {letter}</button>)}
      <button type="button" id="trap" onKeyDown={e=>{if(e.key==='Tab')e.preventDefault()}}>Locked control</button>
      <a id="back-link" style={{position:'absolute',top:280,left:200,width:160,height:30}} href="/index.html" onClick={event=>{event.preventDefault();history.pushState({},'',event.currentTarget.href);setRoute('/')}}>Back to station</a>
      <section id="scrollbox" aria-label="Notes" tabIndex={0} style={{position:'absolute',top:240,left:540,width:250,height:120,overflow:'auto',overscrollBehavior:'contain'}}>
        {Array.from({length:18},(_,i)=><p key={i}>Station note {i+1}</p>)}
      </section>
      <button type="button">Refresh estimate</button><a href="https://example.com/">External guide</a>
    </>}</main>;
}
createRoot(document.querySelector('#root')).render(<App/>);`,
};

const repairFixture = {
  'package.json':fixture['package.json'],
  'index.html':fixture['index.html'].replace('Field station','Museum reservations'),
  'src/app.tsx':`import React,{useState,useRef,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
function Museum(){
  const [open,setOpen]=useState(false);
  const dialog=useRef(null);
  const opener=useRef(null);
  useEffect(()=>{if(open)dialog.current.showModal()},[open]);
  return <main style={{minHeight:1700}}><h1>Museum reservations</h1>
    <button id="tickets" ref={opener} onClick={()=>setOpen(true)}>Review tickets</button>
    {open && <dialog ref={dialog} aria-label="Ticket review">
      <p>Print your ticket or return to reservations.</p>
      <button id="print-ticket" type="button"><span aria-hidden="true">↧</span></button>
      <button type="button" autoFocus onClick={()=>{dialog.current.close();setOpen(false);opener.current.focus()}}>Return to reservations</button>
    </dialog>}
  </main>
}
createRoot(document.querySelector('#root')).render(<Museum/>);`,
};

test('Chrome 实时双侧比较：校园 ZIP 导航及 React 独立状态、动态检查与语义失配', {timeout:210_000}, async()=>{
  const data = await mkdtemp(path.join(os.tmpdir(),'a11y-live-e2e-'));
  const output = process.env.A11Y_LIVE_EVIDENCE;
  if (output) await mkdir(output,{recursive:true});
  const portProbe = net.createServer().listen(0,'127.0.0.1');
  await once(portProbe,'listening');
  const port = (portProbe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
  const origin = 'http://127.0.0.1:'+port;
  let agentEvidence = false;
  const model = http.createServer(async (req,res)=>{
    try {
      let body = '';
      for await (const part of req) body += part;
      const {messages} = JSON.parse(body);
      const inspected = messages.find((item:{role:string;tool_call_id?:string})=>item.role==='tool' && item.tool_call_id==='inspect');
      const message = inspected ? {
        content:JSON.stringify({value:'Print ticket',reason:'The replay shows a print control in Ticket review.',needsReview:true})
      } : {tool_calls:[
        {id:'inspect',type:'function',function:{name:'inspect_issue',arguments:'{}'}},
        {id:'wcag',type:'function',function:{name:'search_wcag',arguments:JSON.stringify({query:'WCAG button accessible name 4.1.2'})}},
      ]};
      if (inspected) {
        const {context} = JSON.parse(inspected.content);
        agentEvidence = context.route==='/index.html' && context.accessibilitySnapshot.includes('Ticket review') &&
          context.interactions.some((step:{action:string})=>step.action==='click');
      }
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({choices:[{message}]}));
    } catch {res.writeHead(400).end();}
  }).listen(0,'127.0.0.1');
  await once(model,'listening');
  const modelOrigin = 'http://127.0.0.1:'+(model.address() as net.AddressInfo).port;
  const service = spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),A11Y_DATA_DIR:data,AI_API_KEY:'local-fixture-only',AI_BASE_URL:modelOrigin},stdio:['ignore','pipe','pipe']});
  let serviceLog='';
  service.stderr.on('data',part=>{serviceLog+=part;});
  const save = async (file:string,content:unknown)=>{
    if (output) await writeFile(path.join(output,file),JSON.stringify(content,null,2));
  };
  try {
    for(let i=0;!(await fetch(origin+'/api/health').then(r=>r.ok,()=>false));i++){
      if(i>100 || service.exitCode!==null) throw new Error(serviceLog || '启动超时');
      await delay(100);
    }
    await registerTestAccount(origin);
    process.env.A11Y_DATA_DIR=data;
    const {db,id,now,snapshotDir,treeHash}=await import('../apps/api/storage');
    const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
    const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
    await attachTestAccount(ctx,origin);
    const page=await ctx.newPage();
    const netLog:{url:string;status:number;method:string}[]=[];
    page.on('response',r=>netLog.push({url:r.url(),status:r.status(),method:r.request().method()}));
    const trace:unknown[]=[];
    if (output) await ctx.tracing.start({screenshots:true,snapshots:true,sources:true});
    const left=page.getByRole('region',{name:'左侧实时浏览器',exact:true});
    const right=page.getByRole('region',{name:'右侧实时浏览器',exact:true});
    async function action(click:()=>Promise<void>) {
      const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/action'));
      await click();
      const received=await response;
      const body=await received.json();
      assert.ok(received.ok(),JSON.stringify(body));
      trace.push({outcome:body.outcome,left:{path:body.left.path,focus:body.left.focus,scroll:body.left.scroll},
        right:{path:body.right.path,focus:body.right.focus,scroll:body.right.scroll},differences:body.differences});
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='刷新实时画面'&&!button.disabled));
      return body;
    }
    const more=async (region:ReturnType<Page['getByRole']>)=>{
      const advanced=page.getByRole('button',{name:'更多操作',exact:true});
      if (!await advanced.count()) return;
      if (await advanced.getAttribute('aria-expanded')!=='true') await advanced.click();
      const summary=region.locator('summary').filter({hasText:/更多操作/});
      if (!(await summary.evaluate(el=>el.parentElement?.hasAttribute('open')))) await summary.click();
    };
    const control=async (region:ReturnType<Page['getByRole']>,name:string,operation='操作控件')=>{
      await more(region);
      await region.getByLabel('语义控件').selectOption({label:name});
      return action(()=>region.getByRole('button',{name:operation,exact:true}).click());
    };
    const sessions:string[] = [];
    async function openLive() {
      const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/live'));
      await page.getByRole('button',{name:'实时浏览器',exact:true}).click();
      const response=await waiting;
      assert.ok(response.ok(),response.ok()?'':await response.text());
      sessions.push(response.url()+'/'+(await response.json()).id);
      await page.getByRole('button',{name:/^检测(?:左侧状态|当前状态)$/}).first().waitFor();
    }
    async function scan(region:typeof left,name:string) {
      const waiting=page.waitForResponse(r=>/\/live\/[^/]+\/scan\/(left|right)$/.test(r.url()));
      await page.getByRole('button',{name:region===left?'检测左侧状态':'检测右侧状态',exact:true}).click();
      const response=await waiting;
      const body=await response.json();
      assert.ok(response.ok(),JSON.stringify(body));
      assert.ok(body.engine.version && body.ax && body.dom.length && body.styles.length);
      assert.match(body.screenshot,/^data:image\/jpeg;base64,/);
      await save(name+'.json',body);
      return body;
    }
    async function upload(name:string,bytes:Buffer,mode:'ZIP'|'源码工程') {
      const switchProject = page.getByRole('button',{name:'切换项目',exact:true});
      if (await switchProject.isVisible()) await switchProject.click();
      else await page.goto(origin);
      await page.getByRole('button',{name:mode,exact:true}).click();
      await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/zip',buffer:bytes});
      await page.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
      const projects=await (await fetch(origin+'/api/projects')).json();
      const project=projects.find((p:{name:string})=>p.name===name);
      assert.ok(project);
      return project;
    }
    try {
      const campusSource=await campusFixtures(path.join(data,'campus-fixtures'));
      const campus=await upload('campus-multipage.zip',await readFile(campusSource.zip),'ZIP');
      await openLive();
      const campusHome=await scan(left,'campus-home');
      assert.equal(campusHome.path,'/index.html');
      assert.ok(campusHome.violations.some((r:{id:string})=>r.id==='image-alt'));
      const courses=await control(left,'课程中心 (link)');
      assert.equal(courses.left.path,'/pages/courses.html');
      assert.equal(courses.right.path,courses.left.path);
      assert.equal(courses.outcome.matched,true);
      await scan(right,'campus-courses');
      const enroll=await control(left,'课程报名 (link)');
      assert.equal(enroll.right.path,'/pages/enroll.html');
      const tab=await action(()=>left.getByRole('button',{name:'Tab',exact:true}).click());
      assert.ok(tab.left.focus);
      assert.equal(tab.left.focus,tab.right.focus);
      assert.equal(campus.currentSnapshot,await page.getByLabel('左侧版本').inputValue());
      await page.getByRole('button',{name:'诊断工作台',exact:true}).click();
      const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(fixture).map(([file,contents])=>[
        file,strToU8(process.env.A11Y_SCROLL_BENCH ? contents.replace(/      <a id="back-link"[^\n]+\n|      <section id="scrollbox"[\s\S]*?<\/section>\n/g,'') : contents),
      ]))));
      const project=await upload('field-station.zip',zip,'源码工程');
      const next=id();
      const nextDir=snapshotDir(project.id,next);
      await cp(snapshotDir(project.id,project.currentSnapshot),nextDir,{recursive:true});
      const source=path.join(nextDir,'src','app.tsx');
      await writeFile(source,fixture['src/app.tsx']
        .replace('aria-expanded={false}','aria-expanded={menu}')
        .replace('id="modal-bad" type="button"','id="modal-bad" aria-label="Booking information" type="button"')
        .replace('Refresh estimate','Updated estimate'));
      db.prepare('INSERT INTO snapshots (id,project_id,parent_id,entry,hash,created_at,description) VALUES (?,?,?,?,?,?,?)')
        .run(next,project.id,project.currentSnapshot,'index.html',treeHash(nextDir),now(),'live test fixture');
      db.prepare('UPDATE projects SET current_snapshot=? WHERE id=?').run(next,project.id);
      await page.reload();
      await page.getByRole('heading',{name:'网页无障碍工作台',exact:true}).waitFor();
      await openLive();
      assert.equal(await page.getByLabel('左侧版本').inputValue(),project.currentSnapshot);
      assert.equal(await page.getByLabel('右侧版本').inputValue(),next);
      const liveScreen=left.getByRole('button',{name:'左侧可操作网页画面'});
      const box=await liveScreen.boundingBox();
      assert.ok(box);
      const clicked=await action(()=>liveScreen.click({position:{x:80/900*box.width,y:120/700*box.height}}));
      assert.equal(clicked.outcome.target,'Bookings');
      assert.equal(clicked.left.path,'/bookings');
      assert.equal(clicked.right.path,'/bookings');
      if (output) await page.screenshot({path:path.join(output,'default-workbench.png')});
      if (process.env.A11Y_SCROLL_BENCH) {
        await page.evaluate(() => {
          const screen = document.querySelector('.live-screen')!;
          const data = {events:[] as number[], updates:[] as number[], unavailable:0, minTop:Infinity, maxTop:-Infinity};
          Object.assign(window,{scrollEvidence:data});
          screen.addEventListener('wheel',()=>data.events.push(performance.now()));
          new MutationObserver(() => {
            const image = screen.querySelector('img')!;
            void image.decode().then(()=>data.updates.push(performance.now()),()=>{});
          }).observe(screen,{attributes:true,subtree:true,attributeFilter:['src']});
          const monitor = { sample() {
            const image = screen.querySelector('img');
            if (data.events.length) {
              if (!image?.complete || !image.naturalWidth) data.unavailable++;
              const top=screen.getBoundingClientRect().top;
              data.minTop=Math.min(data.minTop,top);
              data.maxTop=Math.max(data.maxTop,top);
            }
            requestAnimationFrame(monitor.sample);
          } };
          requestAnimationFrame(monitor.sample);
        });
        const replies: {scroll:number; right:number; sent:number; capture:{count:number;elapsedMs:number}}[] = [];
        page.on('response',async response=>{
          if (!response.url().endsWith('/action') || !response.ok()) return;
          const result = await response.json();
          if (result.outcome?.action==='scroll') replies.push({scroll:result.left.scroll,right:result.right.scroll,sent:Number(Boolean(result.left.image))+Number(Boolean(result.right.image)),capture:result.capture});
        });
        const screen=left.getByRole('button',{name:'左侧可操作网页画面'});
        await screen.hover();
        const outer=await page.evaluate(()=>scrollY);
        for (let index=0; index<40;index++) await page.mouse.wheel(0,12);
        await delay(1300);
        const evidence=await page.evaluate(()=>Reflect.get(window,'scrollEvidence'));
        const report={browser:browser.version(),...evidence,replies,outerBefore:outer,outerAfter:await page.evaluate(()=>scrollY)};
        await save('scroll-benchmark.json',report);
        if (output) await page.screenshot({path:path.join(output,'scroll-workbench.png')});
        console.log(JSON.stringify(report));
        if (process.env.A11Y_SCROLL_STRESS) {
          const sessionStarts=netLog.filter(entry=>entry.url.endsWith('/live')&&entry.method==='POST').length;
          for (let index=0;index<120;index++) await page.mouse.wheel(0,index%60<30 ? 12 : -12);
          await delay(900);
          const final=await page.evaluate(()=>Reflect.get(window,'scrollEvidence'));
          assert.equal(final.events.length,160);
          assert.equal(final.unavailable,0);
          assert.equal(replies.at(-1)?.scroll,480);
          assert.ok(replies.every(reply=>Math.abs(reply.scroll-reply.right)<=3));
          assert.equal(netLog.filter(entry=>entry.url.endsWith('/live')&&entry.method==='POST').length,sessionStarts);
          await save('scroll-stress.json',{eventCount:final.events.length,unavailable:final.unavailable,
            requests:replies.length,captures:replies.reduce((sum,reply)=>sum+reply.capture.count,0),final:replies.at(-1)});
        }
        return;
      }
      assert.equal(await left.getByRole('button',{name:'Tab',exact:true}).isVisible(),false);
      assert.equal(await page.getByRole('button',{name:/向[上下]滚动/}).count(),0);
      const initialOuter=await page.evaluate(()=>scrollY);
      await liveScreen.hover({position:{x:25,y:100}});
      const shortScroll=await action(()=>page.mouse.wheel(0,-120));
      assert.equal(shortScroll.capture.count,0);
      assert.equal(shortScroll.left.scroll,0);
      const area=await liveScreen.boundingBox();
      assert.ok(area);
      await page.mouse.move(area.x+area.width*620/900,area.y+area.height*290/700);
      const inner=await action(()=>page.mouse.wheel(0,90));
      assert.equal(inner.outcome.scroll.left.container,'#scrollbox');
      assert.equal(inner.outcome.scroll.left.position,90);
      assert.equal(inner.outcome.scroll.right.position,90);
      assert.equal(inner.left.scroll,0);
      const rightViewport=right.getByRole('button',{name:'右侧可操作网页画面'});
      await rightViewport.hover({position:{x:30,y:100}});
      const fromRight=await action(()=>page.mouse.wheel(0,120));
      assert.equal(fromRight.outcome.side,'right');
      assert.equal(fromRight.left.scroll,120);
      assert.equal(fromRight.right.scroll,120);
      assert.equal(await page.evaluate(()=>scrollY),initialOuter);
      const lower=await action(()=>rightViewport.press('PageDown'));
      assert.ok(lower.right.scroll>fromRight.right.scroll);
      const edge=await action(()=>page.mouse.wheel(0,1600));
      assert.equal(edge.left.scroll,edge.right.scroll);
      const still=await action(()=>page.mouse.wheel(0,1600));
      assert.equal(still.right.scroll,edge.right.scroll);
      assert.equal(still.capture.count,0);
      const top=await action(()=>page.mouse.wheel(0,-1600));
      assert.equal(top.right.scroll,0);
      await page.evaluate(()=>document.body.style.minHeight='1800px');
      await page.getByRole('button',{name:'关闭实时浏览器'}).hover();
      await page.waitForFunction(()=>!document.querySelector('.live-screen:hover'));
      const outside=await page.evaluate(()=>scrollY);
      await page.mouse.wheel(0,150);
      await page.waitForFunction(start=>window.scrollY>start,outside);
      await page.evaluate(()=>{document.body.style.minHeight='';window.scrollTo(0,0);});
      await liveScreen.hover({position:{x:25,y:100}});
      const beforeNavigation=await action(()=>page.mouse.wheel(0,100));
      assert.equal(beforeNavigation.left.scroll,100);
      const navBox=await liveScreen.boundingBox();
      assert.ok(navBox);
      const navigated=await action(()=>liveScreen.click({position:{x:235/900*navBox.width,y:192/700*navBox.height}}));
      assert.equal(navigated.outcome.target,'Back to station');
      assert.equal(navigated.right.path,'/index.html');
      assert.equal((await control(left,'Bookings (link)')).right.path,'/bookings');
      const menu=await control(left,'Filter by period (button)');
      assert.equal(menu.outcome.matched,false);
      assert.equal(menu.outcome.executions.right.status,'executed');
      const menuAudit=await scan(left,'react-menu');
      assert.ok(menuAudit.observations.some((r:{rule:string})=>r.rule==='expanded-state-mismatch'));
      assert.ok(menuAudit.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('menu-bad'))));
      await control(left,'Details (tab)');
      await control(left,'Booking details (button)');
      const old=await scan(left,'react-modal-v0');
      const fixed=await scan(right,'react-modal-current');
      assert.ok(old.observations.some((r:{rule:string})=>r.rule==='modal-focus-entry'));
      assert.ok(old.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('modal-bad'))));
      assert.ok(!fixed.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('modal-bad'))));
      assert.ok(!fixed.observations.some((r:{rule:string})=>r.rule==='expanded-state-mismatch'));
      await control(left,'View schedule (button)');
      await action(()=>left.getByRole('button',{name:'Tab',exact:true}).click());
      const escaped=await action(()=>left.getByRole('button',{name:'Tab',exact:true}).click());
      assert.equal(escaped.left.focus,'#slot');
      assert.ok(escaped.observations.left.some((item:{rule:string;status:string})=>item.rule==='modal-tab-escape' && item.status==='confirmed'));
      await scan(left,'react-tab-escape');
      await control(left,'Close details (button)');
      await control(left,'Slot code (textbox)','填入测试值');
      const validation=await control(left,'Validate booking (button)');
      assert.equal(validation.outcome.matched,true);
      assert.equal(validation.left.focus,'#slot');
      const form=await scan(left,'react-form');
      assert.ok(form.observations.some((r:{rule:string})=>r.rule==='form-error-association'));
      assert.ok(form.observations.some((r:{rule:string})=>r.rule==='live-region-changed'));
      await control(left,'Station A (button)');
      await left.getByLabel(/转发网页画面中的 Tab/).check();
      await liveScreen.focus();
      for(let i=0;i<3;i++) await action(()=>liveScreen.press('Tab'));
      assert.equal(await liveScreen.evaluate(node=>node===document.activeElement),true);
      await liveScreen.press('Shift+Escape');
      assert.ok(!(await scan(left,'react-keyboard-negative')).observations.some((r:{rule:string})=>r.rule==='repeated-tab-focus'));
      await control(left,'Locked control (button)');
      for(let i=0;i<3;i++) await action(()=>left.getByRole('button',{name:'Tab',exact:true}).click());
      assert.ok((await scan(left,'react-keyboard')).observations.some((r:{rule:string})=>r.rule==='repeated-tab-focus'));
      await liveScreen.scrollIntoViewIfNeeded();
      const wheelBox=await liveScreen.boundingBox();
      assert.ok(wheelBox);
      await page.mouse.move(wheelBox.x+wheelBox.width/2,wheelBox.y+wheelBox.height/2);
      const scroll=await action(()=>page.mouse.wheel(0,360));
      assert.ok(scroll.left.scroll>0);
      assert.equal(scroll.left.scroll,scroll.right.scroll);
      const miss=await control(left,'Refresh estimate (button)');
      assert.equal(miss.outcome.matched,false);
      assert.equal(miss.outcome.executions.left.status,'executed');
      assert.equal(miss.outcome.executions.right.status,'unmatched');
      await page.getByRole('alert').filter({hasText:'操作匹配失败'}).waitFor();
      await page.getByLabel('同步操作').uncheck();
      const rightScreen=right.getByRole('button',{name:'右侧可操作网页画面'});
      const independent=await action(()=>rightScreen.press('PageDown'));
      assert.notEqual(independent.left.scroll,independent.right.scroll);
      await more(left);
      await left.getByLabel('语义控件').selectOption({label:'External guide (link)'});
      await left.getByRole('button',{name:'操作控件',exact:true}).click();
      await page.getByRole('alert').filter({hasText:/外部链接/}).waitFor();
      assert.ok(!netLog.some(r=>r.url.startsWith('https://example.com/')));
      const report=await (await fetch(origin+'/api/projects/'+project.id+'/reports')).json();
      assert.ok(report.site.liveStates.some((row:{version:string;path:string})=>row.version===next&&row.path==='/bookings'));
      if(output) await page.screenshot({path:path.join(output,'live-comparison.png'),fullPage:true});
      const repairZip=Buffer.from(zipSync(Object.fromEntries(Object.entries(repairFixture).map(([file,contents])=>[file,strToU8(contents)]))));
      await upload('museum-reservations.zip',repairZip,'源码工程');
      await openLive();
      if (!(await page.getByLabel('同步操作').isChecked())) await page.getByLabel('同步操作').check();
      const dialog=await control(right,'Review tickets (button)');
      assert.equal(dialog.outcome.matched,true);
      assert.equal(dialog.right.focus,dialog.left.focus);
      const museumBefore=await scan(right,'museum-before');
      assert.ok(museumBefore.repairable.length);
      await right.getByText('定位可修复的问题',{exact:true}).click();
      const adopting = page.waitForResponse(response=>response.url().endsWith('/repair-state'));
      await right.getByRole('button',{name:/在诊断中修复.*print-ticket/}).click();
      const adoption = await adopting;
      assert.ok(adoption.ok(),await adoption.text());
      await page.getByRole('button',{name:'AI 分析与修复'}).waitFor({timeout:55000});
      await page.getByRole('button',{name:'AI 分析与修复'}).click();
      await page.locator('#repair-value').waitFor();
      await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#repair-value')?.value==='Print ticket');
      assert.equal(agentEvidence,true);
      await page.getByRole('button',{name:'生成补丁预览'}).click();
      await page.getByRole('button',{name:'确认应用修复'}).click({timeout:65000});
      await page.getByLabel('我已核对修复内容和页面用途，确认适合应用').check();
      await page.getByRole('button',{name:'确认应用并复测'}).click();
      await page.getByText('已在同一交互状态中验证按钮名称，当前版本已更新。').waitFor({timeout:65000});
      await openLive();
      await control(right,'Review tickets (button)');
      const museumLeft=await scan(left,'museum-replayed-original');
      const museumRight=await scan(right,'museum-replayed-repaired');
      assert.notEqual(museumLeft.version,museumRight.version);
      assert.equal(museumLeft.sequenceKey,museumRight.sequenceKey);
      assert.ok(museumRight.observations.some((item:{rule:string})=>item.rule==='modal-focus-entered'));
      await page.getByText('交互证据与差异',{exact:true}).click();
      await page.getByText(/同一路由与操作序列的状态证据 · 消失 1 项/).waitFor();
      assert.match(museumRight.ax,/button "Print ticket"/);
      assert.doesNotMatch(museumLeft.ax,/button "Print ticket"/);
      assert.ok(museumLeft.findings.some((item:{selector:string})=>item.selector.includes('print-ticket')));
      assert.ok(!museumRight.findings.some((item:{selector:string})=>item.selector.includes('print-ticket')));
      const closed=await control(right,'Return to reservations (button)');
      assert.equal(closed.right.focus,'#tickets');
      assert.ok(closed.observations.right.some((item:{rule:string;selector:string})=>item.rule==='modal-closed' && item.selector==='#tickets'));
      await more(right);
      const zoomed=await action(()=>right.getByLabel('缩放').selectOption('125'));
      assert.equal(zoomed.outcome.matched,true);
      assert.equal(zoomed.left.zoom,125);
      const replacedSession=sessions.at(-1)!;
      await right.getByRole('button',{name:'右侧可操作网页画面'}).hover();
      const rolling=page.waitForRequest(request=>request.url().endsWith('/action') && request.postDataJSON().operation.action==='scroll');
      await page.mouse.wheel(0,96);
      await rolling;
      const newLive=page.waitForResponse(response=>response.request().method()==='POST' && response.url().endsWith('/live'));
      await page.getByLabel('右侧版本').selectOption(await page.getByLabel('左侧版本').inputValue());
      const newSession=await newLive;
      assert.ok(newSession.ok(),await newSession.text());
      const ownedSession=newSession.url()+'/'+(await newSession.json()).id;
      sessions.push(ownedSession);
      assert.notEqual(ownedSession,replacedSession);
      assert.ok(!(await fetch(replacedSession+'/scan/right',{method:'POST'})).ok);
      const stranger=await browser.newContext();
      const creds={email:'other-live@example.test',password:'random-other-secret!',name:'Other workspace'};
      for(const endpoint of ['sign-up/email','sign-in/email']) {
        const response=await stranger.request.post(origin+'/api/auth/'+endpoint,{headers:{origin},data:creds});
        assert.ok(response.ok(),await response.text());
      }
      const forbidden=await stranger.request.post(ownedSession+'/scan/right',{headers:{origin}});
      assert.equal(forbidden.status(),404);
      await stranger.close();
      await right.getByRole('button',{name:'右侧可操作网页画面'}).hover();
      const closingWheel=page.waitForRequest(request=>request.url().endsWith('/action') && request.postDataJSON().operation.action==='scroll');
      await page.mouse.wheel(0,96);
      await closingWheel;
      const removed=page.waitForResponse(response=>response.url()===ownedSession && response.request().method()==='DELETE');
      await page.getByRole('button',{name:'关闭实时浏览器'}).click();
      assert.equal((await removed).status(),204);
      assert.ok(!(await fetch(ownedSession+'/scan/right',{method:'POST'})).ok);
      assert.equal(await right.isVisible(),false);
      if(output) await page.screenshot({path:path.join(output,'museum-repair-workbench.png'),fullPage:true});
    } finally {
      await Promise.allSettled(sessions.map(url=>fetch(url,{method:'DELETE'})));
      await save('actions.json',trace);
      await save('workbench-network.json',netLog);
      if(output) await ctx.tracing.stop({path:path.join(output,'playwright-trace.zip')});
      await browser.close();
    }
  } finally {
    model.closeAllConnections();
    await new Promise<void>(resolve=>model.close(()=>resolve()));
    if (service.exitCode === null && service.signalCode === null) {
      const exited=once(service,'exit');
      service.kill();
      const stop=setTimeout(()=>service.kill('SIGKILL'),2500);
      await exited;
      clearTimeout(stop);
    }
    await rm(data,{recursive:true,force:true});
  }
});
