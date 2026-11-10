import { testFetch as fetch, registerTestAccount, attachTestAccount } from './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, zipSync, unzipSync, strFromU8 } from 'fflate';
import { chromium } from 'playwright-core';

const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const staticSite = {
  'index.html': html('Reading club', '<link rel="stylesheet" href="/theme.css"><main><h1>Reading club</h1><a href="/classes.html">Classes</a></main>'),
  'classes.html': html('Classes', '<link rel="stylesheet" href="/theme.css"><main><h1>Classes</h1><button commandfor="info" command="show-modal">Open class information</button><dialog id="info" aria-labelledby="info-title"><h2 id="info-title">Class information</h2><button id="class-icon" type="button"><span aria-hidden="true">i</span></button><button commandfor="info" command="close">Close class information</button></dialog><form><label for="number">Course number</label><input id="number" required pattern="[0-9]+"><button>Check enrolment</button></form></main>'),
  'theme.css': 'body{background:white;color:#151a20}button,input{min-height:36px}button{min-width:40px}#class-icon{color:#171e30}',
};
const reactSite = {
  'package.json': JSON.stringify({type: 'module', dependencies: {react: '*', 'react-dom': '*'}}),
  'index.html': html('Workshop studio', '<div id="root"></div><script type="module" src="/src/app.tsx"></script>'),
  'src/app.tsx': `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
function App() {
  const [route, setRoute] = useState('/');
  const [selected, select] = useState('schedule');
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  return <main><h1>{route === '/workshops' ? 'Workshops' : 'Studio home'}</h1>
    <a href="/workshops" onClick={event => {event.preventDefault(); history.pushState({}, '', '/workshops'); setRoute('/workshops');}}>Workshops</a>
    {route === '/workshops' && <>
      <div role="tablist" aria-label="Workshop details"><button role="tab" aria-selected={selected === 'schedule'} aria-controls="schedule" onClick={() => select('schedule')}>Schedule</button>
      <button role="tab" aria-selected={selected === 'resources'} aria-controls="resources" onClick={() => select('resources')}>Resources</button></div>
      {selected === 'schedule' ? <div id="schedule" role="tabpanel">Workshop schedule</div> : <div id="resources" role="tabpanel">Handouts</div>}
      <form><label htmlFor="seat">Seat preference</label><input id="seat" required/><button>Check booking</button></form>
      <button id="menu" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Display options</button>
      {expanded && <p>Display options open</p>}
      <button onClick={() => setOpen(true)}>Open workshop details</button>
      {open && <section role="dialog" aria-label="Workshop details" onKeyDown={event => {if (event.key === 'Escape') setOpen(false);}}>
        <h2>Workshop details</h2><button id="workshop-icon" type="button" style={{minWidth: 40,minHeight: 36}}><span aria-hidden="true">i</span></button>
        <button onClick={() => setOpen(false)}>Close workshop details</button>
      </section>}
    </>}</main>;
}
createRoot(document.querySelector('#root')!).render(<App/>);`,
};
const zip = (files: Record<string, string>) => Buffer.from(zipSync(
  Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])),
));

test('全景工作台用真实 Chrome 采集静态多页和 React 路由，重放、修复及验证失配', {timeout: 190_000}, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-panorama-'));
  const data = path.join(scratch, 'data');
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = 'http://127.0.0.1:' + port;
  const service = spawn(process.execPath, ['--import', 'tsx', 'apps/api/server.ts'], {
    env: {...process.env, A11Y_DATA_DIR: data, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverLog = '';
  service.stderr.on('data', chunk => {serverLog += chunk;});
  const evidence = process.env.A11Y_PANORAMA_EVIDENCE;
  if (evidence) await fs.mkdir(evidence, {recursive: true});
  const screenshot = async (page: import('playwright-core').Page, name: string) => {
    if (evidence) await page.screenshot({path: path.join(evidence, name + '.png'), fullPage: true});
  };
  const api = async (route: string, body?: unknown) => {
    const response = await fetch(origin + '/api' + route, body === undefined ? undefined : {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    for (let i = 0; !(await fetch(origin + '/api/health').then(res => res.ok, () => false)); i++) {
      if (i === 100 || service.exitCode !== null) assert.fail('服务未启动：' + serverLog);
      await delay(100);
    }
    await registerTestAccount(origin);
    process.env.A11Y_DATA_DIR = data;
    const {db, id, now, treeHash, snapshotDir} = await import('../apps/api/storage');
    const {verifyPanorama} = await import('../apps/api/panorama');
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    });
    try {
      for (const scenario of [
        {name:'reading', files:staticSite, page:'/classes.html', opener:'Open class information', closer:'Close class information', id:'#class-icon'},
        {name:'workshop', files:reactSite, page:'/workshops', opener:'Open workshop details', closer:'Close workshop details', id:'#workshop-icon'},
      ]) {
        const page = await browser.newPage({viewport:{width: 1440, height: 960}});
        await attachTestAccount(page.context(),origin);
        page.setDefaultTimeout(22000);
        await page.goto(origin);
        await page.getByRole('button', {name:'源码工程',exact:true}).click();
        await page.locator('input[type=file]').setInputFiles({name:scenario.name+'.zip', mimeType:'application/zip', buffer:zip(scenario.files as Record<string, string>)});
        const panel = page.getByRole('region', {name:'修复效果对比'});
        const matched = panel.getByText(/左右已匹配同一页面和状态/);
        const ready = async () => {
          await matched.waitFor().catch(async error => {throw new Error(await panel.innerText(), {cause:error});});
        };
        const step = async (name: string, action = 'click') => {
          const previous = await panel.getByLabel('交互状态').inputValue();
          const disclosure = panel.locator('summary').filter({hasText:/^记录安全操作$/});
          if (!await disclosure.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await disclosure.click();
          const picker = panel.getByLabel('控件', {exact:true});
          const option = picker.getByRole('option').filter({hasText:new RegExp('^' + name + ' \\(')});
          const value = await option.getAttribute('value');
          assert.ok(value);
          await picker.selectOption(value);
          await panel.getByLabel('操作', {exact:true}).selectOption(action);
          await panel.getByRole('button', {name:'执行并重放'}).click();
          await ready();
          await page.waitForFunction(previous => {
            const selector = document.querySelector<HTMLSelectElement>('select[aria-label="交互状态"]');
            return selector?.value && selector.value !== previous && !selector.disabled;
          }, previous);
        };
        await ready();
        const [project] = await api('/projects');
        const route = '/projects/' + project.id;
        assert.equal(await panel.getByLabel('左侧版本').inputValue(), project.currentSnapshot);
        assert.equal(await panel.getByLabel('右侧版本').inputValue(), project.currentSnapshot);
        if (scenario.name === 'reading') {
          const initial = await panel.getByLabel('交互状态').inputValue();
          await panel.getByLabel('交互状态').selectOption(initial);
          await ready();
          const captures = panel.locator('.panorama-pair img');
          const oldSrc = await captures.first().getAttribute('src');
          const capture = oldSrc?.match(/captures\/([^/]+)\/full$/)?.[1];
          assert.ok(capture);
          await panel.getByLabel('完整页面').uncheck();
          await fs.unlink(path.join(data, 'panorama', capture + '-full.jpg'));
          await panel.getByLabel('完整页面').check();
          await panel.getByRole('alert').filter({hasText:'截图无法读取'}).first().waitFor();
          const payload = {left:project.currentSnapshot,right:project.currentSnapshot,stateId:initial};
          const [first, second] = await Promise.all([api(route + '/panorama', payload), api(route + '/panorama', payload)]);
          assert.equal(first.id, second.id);
          await panel.getByRole('button', {name:'重试采集', exact:true}).click();
          await ready();
          assert.notEqual(await captures.first().getAttribute('src'), oldSrc);
          await page.waitForFunction(() => [...document.querySelectorAll('.panorama-pair img')]
            .every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0));
          await screenshot(page, 'reading-recovered');
          await step('Classes');
          assert.equal(await panel.getByLabel('页面', {exact:true}).inputValue(), scenario.page);
          await panel.getByLabel('页面', {exact:true}).selectOption('/index.html');
          await ready();
          await panel.getByLabel('页面', {exact:true}).selectOption(scenario.page);
          await ready();
          await step('Course number', 'fill');
          await step('Check enrolment', 'validate');
          await panel.getByRole('button', {name:'Tab',exact:true}).click();
          await ready();
        } else {
          await step('Workshops');
          const routeState = await panel.getByLabel('交互状态').inputValue();
          const picker = panel.getByLabel('控件', {exact:true});
          await picker.selectOption({label:'Check booking (button)'});
          await panel.getByLabel('操作', {exact:true}).selectOption('click');
          await panel.getByRole('button', {name:'执行并重放'}).click();
          await panel.getByText(/不允许提交表单/).first().waitFor();
          await panel.getByLabel('交互状态').selectOption(routeState);
          await ready();
          await step('Check booking', 'validate');
          await panel.getByText('操作记录 · 2 步').click();
          await panel.getByText('检查原生表单校验 · Check booking', {exact:true}).waitFor();
          await screenshot(page, 'workshop-form-validation');
          await panel.getByLabel('交互状态').selectOption(routeState);
          await ready();
          await step('Resources');
          await step('Display options');
        }
        assert.equal(await panel.getByLabel('页面', {exact:true}).inputValue(), scenario.page);
        await step(scenario.opener);
        const modal = await panel.getByLabel('交互状态').inputValue();
        const issue = page.getByRole('region', {name:'待处理问题'}).getByRole('button').filter({hasText:scenario.id});
        await issue.waitFor();
        assert.equal(await panel.getByRole('region',{name:'当前状态问题'}).count(),0);
        await panel.getByRole('button', {name:'无障碍语义'}).click();
        await panel.getByText(/浏览器无障碍语义/).first().waitFor();
        assert.match(await panel.locator('.panorama-pair pre').first().innerText(), /dialog/);
        await screenshot(page, scenario.name + '-semantics');
        await issue.click();
        await page.locator('#repair-value').fill('Read workshop information');
        await page.getByRole('button', {name:'生成补丁预览'}).click();
        await page.getByRole('button', {name:'确认应用修复'}).click({timeout:65000});
        await page.getByLabel('我已核对修复内容和页面用途，确认适合应用').check();
        await page.getByRole('button', {name:'确认应用并复测'}).click();
        await page.getByText(/已在同一交互状态中验证按钮名称/).waitFor({timeout:65000});
        await ready();
        assert.notEqual(await panel.getByLabel('右侧版本').inputValue(), project.currentSnapshot);
        assert.equal(await panel.getByLabel('左侧版本').inputValue(), project.currentSnapshot);
        assert.equal(await panel.getByLabel('交互状态').inputValue(), modal);
        await page.getByRole('tab',{name:'问题与历史'}).click();
        await page.getByText(/右侧较左侧解决 1 个问题/).waitFor();
        await screenshot(page, scenario.name + '-verified');
        await panel.getByRole('button', {name:'交换版本', exact:true}).click();
        await page.getByText(/新增 1 个问题/).waitFor();
        assert.equal(await panel.getByLabel('交互状态').inputValue(), modal);
        await panel.getByRole('button', {name:'交换版本', exact:true}).click();
        await page.getByText(/右侧较左侧解决 1 个问题/).waitFor();
        await step(scenario.closer);
        assert.notEqual(await panel.getByLabel('交互状态').inputValue(), modal);
        await panel.getByLabel('交互状态').selectOption(modal);
        await ready();
        assert.equal(await panel.getByLabel('交互状态').inputValue(), modal);
        const state = await api(route);
        const inventory = await api(route + '/panorama?' + new URLSearchParams({left:project.currentSnapshot,right:state.project.currentSnapshot}));
        console.log(`${scenario.name}: ${new Set([...inventory.pages.map((file:string) => '/' + file), ...inventory.recipes.map((item:{path:string}) => item.path)]).size} 个页面，${inventory.recipes.length} 个已保存状态。`);
        assert.equal(state.verifications[0].status, 'passed');
        assert.ok(state.verifications[0].sourceChecks.some((check: {name:string}) => check.name === '已采集状态复测'));
        const exported = unzipSync(new Uint8Array(await (await fetch(origin + '/api' + route + '/export')).arrayBuffer()));
        assert.match(strFromU8(exported[scenario.name === 'reading' ? 'source/classes.html' : 'source/src/app.tsx']), /aria-label=.*Read workshop information/);

        const original = snapshotDir(project.id, project.currentSnapshot);
        const changed = path.join(scratch, scenario.name + '-changed');
        await fs.cp(original, changed, {recursive:true});
        if (scenario.name === 'reading') {
          await fs.appendFile(path.join(changed, 'theme.css'), '#class-icon{background:#ddd}');
          await assert.rejects(verifyPanorama(project.id, project.currentSnapshot, changed), /全景回归：\/classes.html/);
          console.log('静态工程：同态修复通过，共享样式回归已拦截。');
        } else {
          const name = path.join(changed, 'src/app.tsx');
          await fs.writeFile(name, (await fs.readFile(name, 'utf8')).replace(scenario.opener, 'Different control'));
          const altered = id();
          await fs.rename(changed, snapshotDir(project.id, altered));
          db.prepare('INSERT INTO snapshots(id,project_id,parent_id,entry,hash,created_at,description) VALUES(?,?,?,?,?,?,?)')
            .run(altered, project.id, project.currentSnapshot, 'index.html', treeHash(snapshotDir(project.id, altered)), now(), 'replay test');
          const {id: job} = await api(route + '/panorama', {left:project.currentSnapshot,right:altered,stateId:modal});
          for (let i = 0; ; i++) {
            const pending = await api('/jobs/' + job);
            if (pending.status === 'completed') {
              assert.equal(pending.result.left.status,'captured');
              assert.equal(pending.result.right.status,'unmatched');
              assert.equal(pending.result.right.step,4);
              break;
            }
            assert.ok(i < 100 && pending.status !== 'failed', JSON.stringify(pending));
            await delay(150);
          }
          await page.reload();
          await page.locator('.recent-list').getByRole('button', {name:/workshop\.zip/}).click();
          await ready();
          await panel.getByLabel('页面', {exact:true}).selectOption(scenario.page);
          await ready();
          await panel.getByLabel('交互状态').selectOption(modal);
          await ready();
          await panel.getByLabel('右侧版本').selectOption(altered);
          await panel.getByText('状态无法可靠匹配', {exact:true}).waitFor();
          await panel.getByText(/步骤 4 · 目标控件/).waitFor();
          await screenshot(page, 'workshop-unmatched');
          console.log('React 工程：同态修复通过，版本缺少控件时在第 4 步停止。');
        }
        await page.close();
      }
    } finally { await browser.close(); }
  } catch (error) {
    throw new Error((error as Error).stack + '\n后端日志：' + serverLog, {cause:error});
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit');
      service.kill();
      if (!await Promise.race([exited.then(() => true), delay(3000, false, {ref:false})])) {
        service.kill('SIGKILL');
        await exited;
      }
    }
    await fs.rm(scratch, {recursive:true,force:true});
  }
});
