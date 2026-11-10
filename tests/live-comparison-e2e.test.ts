import { testFetch as fetch, registerTestAccount, attachTestAccount } from './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
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
      {modal && <section id="dialog" role="dialog" aria-modal="true" aria-label="Booking details"><button id="modal-bad" type="button"><span aria-hidden="true">!</span></button><button type="button" onClick={()=>{setModal(false); opener.current.focus()}}>Close details</button></section>}
      <form><label htmlFor="slot">Slot code</label><input id="slot" required pattern="[0-9]+"/><button>Validate booking</button></form>
      {['A','B','C','D'].map(letter=><button type="button" key={letter}>Station {letter}</button>)}
      <button type="button" id="trap" onKeyDown={e=>{if(e.key==='Tab')e.preventDefault()}}>Locked control</button>
      <button type="button">Refresh estimate</button><a href="https://example.com/">External guide</a>
    </>}</main>;
}
createRoot(document.querySelector('#root')).render(<App/>);`,
};

test('Chrome 实时双侧比较：校园 ZIP 导航及 React 独立状态、动态检查与语义失配', {timeout:120_000}, async()=>{
  const data = await mkdtemp(path.join(os.tmpdir(),'a11y-live-e2e-'));
  const output = process.env.A11Y_LIVE_EVIDENCE;
  if (output) await mkdir(output,{recursive:true});
  const portProbe = net.createServer().listen(0,'127.0.0.1');
  await once(portProbe,'listening');
  const port = (portProbe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>portProbe.close(()=>resolve()));
  const origin = 'http://127.0.0.1:'+port;
  const service = spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{env:{...process.env,PORT:String(port),A11Y_DATA_DIR:data},stdio:['ignore','pipe','pipe']});
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
      await page.getByRole('button',{name:'刷新实时画面'}).isEnabled();
      return body;
    }
    const control=async (region:ReturnType<Page['getByRole']>,name:string,operation='操作控件')=>{
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
      await left.getByRole('button',{name:'检测当前状态'}).waitFor();
    }
    async function scan(region:typeof left,name:string) {
      const waiting=page.waitForResponse(r=>/\/live\/[^/]+\/scan\/(left|right)$/.test(r.url()));
      await region.getByRole('button',{name:'检测当前状态',exact:true}).click();
      const response=await waiting;
      const body=await response.json();
      assert.ok(response.ok(),JSON.stringify(body));
      assert.ok(body.engine.version && body.ax && body.dom.length);
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
      const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(fixture).map(([file,contents])=>[file,strToU8(contents)]))));
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
      const menu=await control(left,'Filter by period (button)');
      assert.equal(menu.outcome.matched,false);
      const menuAudit=await scan(left,'react-menu');
      assert.ok(menuAudit.observations.some((r:{rule:string})=>r.rule==='expanded-visibility-mismatch'));
      assert.ok(menuAudit.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('menu-bad'))));
      await control(left,'Details (tab)');
      await control(left,'Booking details (button)');
      const old=await scan(left,'react-modal-v0');
      const fixed=await scan(right,'react-modal-current');
      assert.ok(old.observations.some((r:{rule:string})=>r.rule==='dialog-focus-entry'));
      assert.ok(old.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('modal-bad'))));
      assert.ok(!fixed.violations.some((r:{id:string;targets:string[]})=>r.id==='button-name'&&r.targets.some(t=>t.includes('modal-bad'))));
      assert.ok(!fixed.observations.some((r:{rule:string})=>r.rule==='expanded-visibility-mismatch'));
      await control(left,'Close details (button)');
      await control(left,'Slot code (textbox)','填入测试值');
      const validation=await control(left,'Validate booking (button)');
      assert.equal(validation.outcome.matched,true);
      assert.equal(validation.left.focus,'#slot');
      const form=await scan(left,'react-form');
      assert.ok(form.observations.some((r:{rule:string})=>r.rule==='form-error-context'));
      assert.ok(form.observations.some((r:{rule:string})=>r.rule==='status-message-changed'));
      await control(left,'Station A (button)');
      await left.getByLabel(/转发网页画面中的 Tab/).check();
      await liveScreen.focus();
      for(let i=0;i<3;i++) await action(()=>liveScreen.press('Tab'));
      assert.equal(await liveScreen.evaluate(node=>node===document.activeElement),true);
      await liveScreen.press('Shift+Escape');
      assert.ok(!(await scan(left,'react-keyboard-negative')).observations.some((r:{rule:string})=>r.rule==='possible-keyboard-trap'));
      await control(left,'Locked control (button)');
      for(let i=0;i<3;i++) await action(()=>left.getByRole('button',{name:'Tab',exact:true}).click());
      assert.ok((await scan(left,'react-keyboard')).observations.some((r:{rule:string})=>r.rule==='possible-keyboard-trap'));
      await liveScreen.scrollIntoViewIfNeeded();
      const wheelBox=await liveScreen.boundingBox();
      assert.ok(wheelBox);
      await page.mouse.move(wheelBox.x+wheelBox.width/2,wheelBox.y+wheelBox.height/2);
      const scroll=await action(()=>page.mouse.wheel(0,360));
      assert.ok(scroll.left.scroll>0);
      assert.equal(scroll.left.scroll,scroll.right.scroll);
      const miss=await control(left,'Refresh estimate (button)');
      assert.equal(miss.outcome.matched,false);
      await page.getByRole('alert').filter({hasText:'操作匹配失败'}).waitFor();
      await page.getByLabel('同步操作').uncheck();
      const independent=await action(()=>right.getByRole('button',{name:'向下滚动',exact:true}).click());
      assert.notEqual(independent.left.scroll,independent.right.scroll);
      await left.getByLabel('语义控件').selectOption({label:'External guide (link)'});
      await left.getByRole('button',{name:'操作控件',exact:true}).click();
      await page.getByRole('alert').filter({hasText:/外部链接/}).waitFor();
      assert.ok(!netLog.some(r=>r.url.startsWith('https://example.com/')));
      const report=await (await fetch(origin+'/api/projects/'+project.id+'/reports')).json();
      assert.ok(report.site.liveStates.some((row:{version:string;path:string})=>row.version===next&&row.path==='/bookings'));
      if(output) await page.screenshot({path:path.join(output,'live-comparison.png'),fullPage:true});
    } finally {
      await Promise.allSettled(sessions.map(url=>fetch(url,{method:'DELETE'})));
      await save('actions.json',trace);
      await save('workbench-network.json',netLog);
      if(output) await ctx.tracing.stop({path:path.join(output,'playwright-trace.zip')});
      await browser.close();
    }
  } finally {
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
