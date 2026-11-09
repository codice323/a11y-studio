import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shell = (title: string, contents: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${contents}</body></html>`;
const css = 'body{background:white;color:#161616} input,button{min-height:36px}';
const png = readFileSync(new URL('./fixtures/engineering/stamp.png', import.meta.url));
const realModel = process.env.A11Y_ENGINEERING_REAL_MODEL === '1';
const reactPackage = JSON.stringify({
  type: 'module', scripts: { build: 'vite build', postinstall: 'exit 99' },
  dependencies: { react: '^19', 'react-dom': '^19' }, devDependencies: { vite: '^8' },
});
const fixtures = [
  {
    mode: 'static-source',
    title: 'Museum archive',
    files: {
      'index.html': shell('Museum archive', '<link rel="stylesheet" href="/styles/site.css"><main><h1>Museum archive</h1><input id="reference" name="reference"><p id="notice">Archive notice</p><a href="/catalog.html">Catalogue</a></main>'),
      'catalog.html': shell('Catalogue', '<link rel="stylesheet" href="/styles/site.css"><main><h1>Catalogue</h1><p>Print collections</p></main>'),
      'styles/site.css': css + '#notice{color:#aaa}',
    },
    repairs: [
      { rule: 'label', selector: '#reference', value: 'Archive reference', file: 'index.html', check: /<label for="reference">Archive reference<\/label>/ },
      { rule: 'color-contrast', selector: '#notice', value: '#222222', file: 'styles/site.css', check: /color:\s*#222222/i },
    ],
    name: 'Archive reference',
  },
  {
    mode: 'react-source',
    title: 'Community workshop',
    files: {
      'package.json': reactPackage,
      'index.html': shell('Community workshop', '<div id="root"></div><script type="module" src="/src/entry.tsx"></script>'),
      'src/entry.tsx': 'import React from "react"; import { createRoot } from "react-dom/client"; import Workshop from "./Workshop"; createRoot(document.getElementById("root")!).render(<Workshop />);',
      'src/Workshop.tsx': 'import React from "react"; import "./workshop.css"; export default function Workshop(){return <main><h1>Community workshop</h1><input id="contact" type="email" /><button id="reserve" type="button" onClick={() => {document.querySelector("#status")!.textContent="Reserved"}}></button><p id="status"></p><img id="badge" src="/stamp.png" width={48} height={48}/><a id="schedule" href="#agenda"></a><h2 id="agenda">Workshop agenda</h2><p id="muted">Materials are provided.</p><button id="details" type="button">Workshop details</button></main>;}',
      'src/workshop.css': css + '#muted{color:#aaa} #schedule{display:inline-block;min-width:36px;min-height:36px} #details{appearance:none;color:#222;background:white;border:1px solid #222} #details:focus{outline:none;box-shadow:none}',
      'public/stamp.png': png,
    },
    repairs: [
      { rule: 'label', selector: '#contact', value: 'Email for booking', file: 'src/Workshop.tsx', check: /<label htmlFor=\{"contact"\}>\{"Email for booking"\}<\/label>/ },
      { rule: 'button-name', selector: '#reserve', value: 'Reserve a seat', file: 'src/Workshop.tsx', check: /aria-label=\{"Reserve a seat"\}/ },
      { rule: 'image-alt', selector: '#badge', value: 'Red circle on white', file: 'src/Workshop.tsx', check: /alt=\{"Red circle on white"\}/ },
      { rule: 'link-name', selector: '#schedule', value: 'Workshop agenda', file: 'src/Workshop.tsx', check: /aria-label=\{"Workshop agenda"\}/ },
      { rule: 'color-contrast', selector: '#muted', value: '#222222', file: 'src/workshop.css', check: /color:\s*#222222/i },
      { rule: 'focus-style-unchanged', selector: '#details', value: '', file: 'src/workshop.css', check: /#details:focus-visible/ },
    ],
    name: 'Email for booking',
  },
];

function archive(files: Record<string, string | Buffer>) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) =>
    [name, typeof content === 'string' ? strToU8(content) : content]))));
}

test('静态与 React 源码工程经真实工作台审核、复测和独立 Vite 重建', { timeout: 160_000 }, async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-engineering-e2e-'));
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const service = spawn(process.execPath, ['--import', 'tsx', 'apps/api/server.ts'], {
    env: { ...process.env, PORT: String(port), A11Y_DATA_DIR: path.join(scratch, 'data') },
    stdio: ['ignore', realModel ? 'pipe' : 'ignore', 'pipe'],
  });
  let serviceErrors = '';
  const visionRequests: string[] = [];
  service.stdout?.on('data', chunk => {
    for (const line of String(chunk).split('\n')) if (line.startsWith('vision-request ')) visionRequests.push(line);
  });
  service.stderr.on('data', chunk => { serviceErrors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const post = (route: string, body: unknown) => fetch(base + '/api' + route, {
    method: 'POST', ...(body instanceof FormData ? { body } : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  const get = async (route: string) => {
    const response = await fetch(base + '/api' + route);
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    for (let attempt = 0; ; attempt++) {
      if (await fetch(base + '/api/status').then(res => res.ok, () => false)) break;
      if (attempt === 99 || service.exitCode !== null) assert.fail('服务启动失败：' + serviceErrors);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
      for (const fixture of fixtures) {
        const started = performance.now();
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.setDefaultTimeout(25_000);
        await page.goto(base);
        await page.getByRole('button', { name: '源码工程', exact: true }).click();
        await page.locator('input[type=file]').setInputFiles({ name: fixture.title + '.zip', mimeType: 'application/zip',
          buffer: archive(fixture.files as Record<string, string | Buffer>) });
        const modeName = fixture.mode === 'static-source' ? '静态源码工程' : 'React 原始组件工程';
        await page.getByText(modeName + '：', { exact: false }).waitFor();
        const [project] = await get('/projects');
        assert.equal(project.mode, fixture.mode);
        const route = '/projects/' + project.id;
        const timings: number[] = [];
        for (let attempt = 0; !(await get(route)).current; attempt++) {
          if (attempt === 80) assert.fail('未完成首轮扫描：' + await page.locator('body').innerText());
          await delay(125);
        }
        await page.getByRole('button', {name: '精准修复', exact: true}).click();
        for (const [index, repair] of fixture.repairs.entries()) {
          const step = performance.now();
          await page.getByRole('tab', { name: '问题与历史' }).click();
          await page.getByRole('button', { name: /^待处理 / }).click();
          const current = (await get(route)).current;
          const focus = repair.rule === 'focus-style-unchanged';
          const findings = focus ? current.detection.behavior.findings : current.issues;
          const issue = findings.find((finding: any) => finding.ruleId === repair.rule && finding.selector === repair.selector);
          assert.ok(issue, JSON.stringify({ expected: repair.rule + ' ' + repair.selector,
            issues: current.issues.map((finding: any) => [finding.ruleId, finding.selector]), incomplete: current.incomplete }));
          const item = page.getByRole('region', { name: '待处理问题' }).getByRole('button').filter({ hasText: repair.selector });
          if (focus) {
            assert.equal(current.sourceLocations[repair.selector].file, 'src/Workshop.tsx');
            await page.locator('.workbench-review > summary').click();
            await page.getByRole('button', { name: '查看焦点修复 · ' + repair.selector }).click();
          } else {
            if (fixture.mode === 'react-source') assert.equal(issue.source.file, 'src/Workshop.tsx');
            await item.click();
          }
          if (repair.rule === 'image-alt') {
            if (realModel) {
              const responsePromise = page.waitForResponse(response =>
                response.url().includes('/proposals') && response.request().method() === 'POST');
              await page.getByRole('button', { name: 'AI 分析与修复' }).click();
              const response = await responsePromise;
              const result = await response.json();
              assert.equal(response.status(), 200, JSON.stringify(result));
              assert.match(result.description, /红|red/i);
              assert.match(result.description, /圆|circle/i);
              assert.ok(result.contentAlt && result.media.bytes > 0);
              await page.waitForFunction(value =>
                (document.querySelector('#repair-value') as HTMLInputElement)?.value === value, result.contentAlt);
              console.log(JSON.stringify({ imageAnalysis: result.description, candidate: result.contentAlt, purpose: result.purpose, image: result.media }));
            }
            const pixels = await fetch(base + '/api' + route + '/issues/' + issue.id + '/image-preview?snapshot=' + (await get(route)).project.currentSnapshot);
            assert.equal(pixels.status, 200);
            assert.match(pixels.headers.get('content-type') ?? '', /^image\//);
            await page.getByLabel('内容性图片').check();
          }
          if (focus || repair.rule === 'link-name') {
            await page.getByRole('button', { name: 'AI 分析与修复' }).click();
          } else {
            await page.locator('#repair-value').fill(repair.value);
            await page.getByRole('button', { name: '生成补丁预览' }).click();
          }
          await page.getByRole('region', { name: '修复内容摘要' }).waitFor();
          await page.getByText('开发者选项', { exact: true }).click();
          await page.getByRole('button', { name: '代码变更', exact: true }).click();
          await page.getByRole('region', { name: repair.file + ' 源码差异', exact: true }).waitFor()
            .catch(async error => { throw new Error(await page.locator('.error, .proposal').allTextContents().then(lines => lines.join(' | ')), { cause: error }); });
          await page.getByRole('button', { name: '确认应用修复' }).click();
          await page.getByLabel('我已核对修复内容和页面用途，确认适合应用').check();
          await page.getByRole('button', { name: '确认应用并复测' }).click();
          await page.getByText(new RegExp('当前版本 V' + (index + 1))).waitFor();
          const verified = (await get(route)).verifications.find((entry: any) => entry.patch.ruleId === repair.rule);
          assert.equal(verified.status, 'passed', JSON.stringify(verified));
          assert.deepEqual(verified.added, []);
          assert.match(verified.sourceReview.changes.find((change: any) => change.file === repair.file).after, repair.check);
          assert.equal(verified.sourceReview.usage.requests, 0);
          timings.push(Math.round(performance.now() - step));
        }
        if (process.env.A11Y_ENGINEERING_SCREENSHOTS) {
          await fs.mkdir(process.env.A11Y_ENGINEERING_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.A11Y_ENGINEERING_SCREENSHOTS, fixture.mode + '.png') });
        }
        const exported = await fetch(base + '/api' + route + '/export');
        assert.equal(exported.status, 200);
        const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
        const root = path.join(scratch, fixture.mode);
        for (const [name, bytes] of Object.entries(files)) {
          if (!name.startsWith('source/')) continue;
          const output = path.join(root, name.slice('source/'.length));
          await fs.mkdir(path.dirname(output), { recursive: true });
          await fs.writeFile(output, bytes);
        }
        for (const repair of fixture.repairs) assert.match(await fs.readFile(path.join(root, repair.file), 'utf8'), repair.check);
        if (fixture.mode === 'react-source') {
          assert.doesNotMatch(await fs.readFile(path.join(root, 'src/Workshop.tsx'), 'utf8'), /data-a11y-origin/);
          await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
        }
        const buildStarted = performance.now();
        await build({ root, configFile: false, logLevel: 'silent', build: fixture.mode === 'static-source'
          ? { rollupOptions: { input: [path.join(root, 'index.html'), path.join(root, 'catalog.html')] } } : {} });
        const buildMs = Math.round(performance.now() - buildStarted);
        const rebuilt = await preview({ root, configFile: false, logLevel: 'silent', preview: { host: '127.0.0.1', port: 0 } });
        try {
          const origin = 'http://127.0.0.1:' + (rebuilt.httpServer.address() as AddressInfo).port;
          await page.goto(origin);
          await page.getByRole('textbox', { name: fixture.name, exact: true }).waitFor();
          await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
          const violations = await page.evaluate(async () =>
            (await (window as any).axe.run()).violations.map((item: { id: string }) => item.id));
          for (const repair of fixture.repairs) assert.ok(!violations.includes(repair.rule), JSON.stringify(violations));
          if (fixture.mode === 'react-source') {
            await page.getByRole('img', { name: 'Red circle on white' }).waitFor();
            await page.getByRole('link', { name: 'Workshop agenda' }).waitFor();
            for (let step = 0; step < 8; step++) {
              await page.keyboard.press('Tab');
              if (await page.locator('#details').evaluate(element => element === document.activeElement)) break;
            }
            assert.equal(await page.locator('#details').evaluate(element =>
              element === document.activeElement && element.matches(':focus-visible') && getComputedStyle(element).outlineWidth === '3px'), true);
            await page.getByRole('button', { name: 'Reserve a seat' }).click();
            await page.getByText('Reserved', { exact: true }).waitFor();
          } else {
            await page.getByRole('link', { name: 'Catalogue' }).click();
            await page.getByRole('heading', { name: 'Catalogue' }).waitFor();
          }
        } finally { await new Promise<void>(resolve => rebuilt.httpServer.close(() => resolve())); }
        const restored = await post(route + '/rollback', { snapshotId: project.currentSnapshot });
        assert.equal(restored.status, 200);
        const original = await get(route);
        assert.equal(original.project.currentSnapshot, project.currentSnapshot);
        assert.equal(original.snapshots.length, fixture.repairs.length + 1);
        assert.ok(original.current.issues.some((issue: any) => issue.ruleId === 'label'));
        await page.close();
        console.log(JSON.stringify({ mode: fixture.mode, repairs: fixture.repairs.length, repairMs: timings,
          buildMs, totalMs: Math.round(performance.now() - started), modelRequests: fixture.mode === 'react-source' ? visionRequests.length : 0 }));
      }
      if (realModel) {
        assert.equal(visionRequests.length, 1);
        assert.match(visionRequests[0], /"contentTypes":\["text","image_url"\]/);
        console.log(visionRequests[0]);
      }
      const files = fixtures[1].files;
      const unsafe = new FormData();
      unsafe.set('mode', 'source');
      unsafe.set('file', new Blob([archive({ ...files, 'src/entry.tsx': 'import "node:fs";' })]), 'untrusted.zip');
      const refused = await post('/projects', unsafe);
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /仅支持本地相对路径/);
      assert.equal((await get('/projects')).length, fixtures.length);

      const repeated = new FormData();
      repeated.set('mode', 'source');
      repeated.set('file', new Blob([archive({ ...files, 'src/Workshop.tsx':
        'function Icon({id}:{id:string}){return <button id={id} style={{minWidth:40,minHeight:40}}/>} export default function App(){return <main><h1>Workshop</h1><Icon id="first"/><Icon id="second"/></main>}'
      })]), 'repeated.zip');
      const imported = await post('/projects', repeated);
      assert.equal(imported.status, 201, await imported.clone().text());
      const project = await imported.json();
      const route = '/projects/' + project.id;
      const completed = async (response: Response) => {
        assert.equal(response.status, 202);
        const {id} = await response.json();
        for (let attempt = 0; attempt < 80; attempt++) {
          const job = await get('/jobs/' + id);
          if (job.status === 'completed' || job.status === 'failed') return job;
          await delay(125);
        }
        assert.fail('工程任务未结束');
      };
      assert.equal((await completed(await post(route + '/audits', {}))).status, 'completed');
      const { issues } = (await get(route)).current;
      const issue = issues.find((item: any) => item.selector === '#first' && item.ruleId === 'button-name');
      assert.ok(issue);
      assert.equal(issue.source, undefined);
      const job = await completed(await post(route + '/issues/' + issue.id + '/proposals', {
        source: 'manual', sourceRepair: true, snapshotId: project.currentSnapshot, intent: 'First action',
      }));
      assert.equal(job.status, 'failed');
      assert.match(job.error, /无法唯一定位原始组件/);
    } finally { await browser.close(); }
  } catch (error) {
    throw new Error(serviceErrors || '源码工程端到端验证失败', { cause: error });
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit');
      service.kill();
      if (!await Promise.race([exited.then(() => true), delay(2500, false, { ref: false })])) {
        service.kill('SIGKILL');
        await exited;
      }
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
});
