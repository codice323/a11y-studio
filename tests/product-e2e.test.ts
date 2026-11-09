import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';

function listen(server: http.Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
function close(server: http.Server) {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

async function stopService(service: ChildProcess) {
  if (service.exitCode !== null || service.signalCode !== null) return;
  const exited = once(service, 'exit');
  service.kill();
  if (!await Promise.race([exited.then(() => true), delay(3000, false, {ref: false})])) {
    service.kill('SIGKILL');
    await exited;
  }
}

test('URL 快照从首页导入，经真实扫描、修复和三视图复测后导出', { timeout: 120000 }, async () => {
  const hits: string[] = [];
  const upstream = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/redirect-private') {
      res.writeHead(302, { Location: 'http://127.0.0.1/secret' }).end();
    } else if (req.url === '/theme.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' }).end('button {width:40px;height:40px;background:white}');
    } else if (req.url === '/sample.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qpQAAAAASUVORK5CYII=', 'base64',
      ));
    } else if (req.url === '/dynamic') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="zh-CN"><head><title>动态导入</title><link rel="stylesheet" href="/dynamic.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    } else if (req.url === '/dynamic.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' }).end('/*' + 'x'.repeat(280000) + '*/ #dynamic-button{width:50px}');
    } else if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(`document.querySelector('#root').innerHTML='<main><h1>脚本渲染页面</h1><button id="dynamic-button"></button><p id="data"></p></main>';const style=document.createElement('style');document.head.append(style);style.sheet.insertRule('#dynamic-button { border: 5px solid red }',0);fetch('/data').then(r=>r.text()).then(text=>document.querySelector('#data').textContent=text);fetch('/mutation',{method:'POST'}).catch(()=>{});fetch('http://127.0.0.1/private').catch(()=>{});`);
    } else if (req.url === '/data') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('异步加载完成');
    } else if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
        <html lang="zh-CN"><head><title>URL 导入测试</title><link rel="stylesheet" href="/theme.css"></head>
        <body><main><h1>静态快照测试</h1><img src="/sample.png" alt="测试图"><button id="target"></button><button id="skipped" tabindex="-1">归档</button><button id="focusless" style="outline:none">保存</button>
        <script>document.querySelector("#target").textContent="脚本内容"</script></main></body></html>`);
    } else {
      res.writeHead(404).end();
    }
  });
  const upstreamPort = await listen(upstream);
  const portProbe = http.createServer();
  const appPort = await listen(portProbe);
  await close(portProbe);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-product-test-'));
  const service = spawn(process.execPath, ['--require', './tests/helpers/url-upstream.cjs', '--import', 'tsx', 'apps/api/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(appPort), A11Y_DATA_DIR: dataDir, A11Y_TEST_UPSTREAM_PORT: String(upstreamPort) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${appPort}`;
  function api(route: string, data?: unknown) {
    return fetch(base + route, data === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await api('/api/status').then(res => res.ok, () => false)) break;
      if (attempt === 99) throw new Error('测试服务启动超时。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const rejected = await api('/api/projects/import-url', { url: 'http://93.184.216.34/redirect-private' });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /非公网/);
    assert.deepEqual(hits, ['/redirect-private']);
    assert.deepEqual(await (await api('/api/projects')).json(), []);

    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
    });
    try {
      const context = await browser.newContext({ viewport: { width: 375, height: 780 } });
      const page = await context.newPage();
      await page.goto(base);
      await page.getByRole('button', { name: 'URL', exact: true }).click();
      await page.getByLabel('仅采集静态 HTML').check();
      await page.getByLabel('公开网页地址').fill('http://93.184.216.34/page');
      await page.getByRole('button', { name: '导入 URL 并检测' }).click();
      await page.getByText(/URL 快照已导入并完成检测/).waitFor({ timeout: 15000 });
      await page.getByRole('button', {name: '精准修复', exact: true}).click();
      assert.deepEqual(hits.slice(1).sort(), ['/page', '/sample.png', '/theme.css']);
      await page.setViewportSize({ width: 1440, height: 900 });
      const [controls, evidence] = await page.locator('.workbench > div').evaluateAll(columns =>
        columns.map(column => {
          const { x, y, width, height } = column.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
      assert.equal(controls.y, evidence.y);
      assert.equal(controls.height, evidence.height);
      assert.ok(evidence.x > controls.x && evidence.width >= controls.width * 1.9);
      assert.equal(await page.locator('.metrics').count(), 0);
      await page.getByText(/这两个版本暂无可检测差异/).waitFor();
      assert.equal(await page.locator('.shots img').count(), 2);
      const issuesTab = page.getByRole('tab', { name: '问题与历史' });
      const assistantTab = page.getByRole('tab', { name: 'AI 修复助手' });
      const assistantPanel = page.getByRole('tabpanel', { name: 'AI 修复助手' });
      assert.equal(await issuesTab.getAttribute('aria-selected'), 'true');
      const reviewToggle = page.locator('.workbench-review > summary');
      await reviewToggle.click();
      const review = page.getByRole('region', { name: 'V2 检测证据' });
      await review.getByText('#skipped', { exact: true }).waitFor();
      await review.locator(':scope > ul').getByText('#focusless', { exact: true }).waitFor();
      assert.match(await review.innerText(), /待复核/);
      assert.match(await review.innerText(), /浏览器观测/);
      await review.getByText(/实际 Tab 顺序/).click();
      assert.ok(await review.locator('ol').getByText('#focusless', { exact: true }).isVisible());
      assert.equal(await page.getByRole('region', { name: '待处理问题' }).getByRole('button').count(), 1);
      assert.deepEqual(await page.locator('.workbench > div').evaluateAll(columns =>
        columns.map(column => column.getBoundingClientRect().height)), [controls.height, evidence.height]);
      await reviewToggle.click();
      await issuesTab.press('ArrowRight');
      assert.equal(await assistantTab.getAttribute('aria-selected'), 'true');
      assert.ok(await assistantTab.evaluate(tab => tab === document.activeElement));
      await assistantTab.press('Home');
      assert.equal(await issuesTab.getAttribute('aria-selected'), 'true');
      const [importedProject] = await (await api('/api/projects')).json();
      const initialState = await (await api('/api/projects/' + importedProject.id)).json();
      const buttonIssue = initialState.current.issues.find((item: { ruleId: string }) => item.ruleId === 'button-name');
      const severity = page.getByLabel('严重程度');
      await severity.selectOption(buttonIssue.impact);
      const issueButton = page.getByRole('button', { name: /按钮缺少名称/ });
      const proposalRequests: string[] = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/proposals')) {
          proposalRequests.push(request.postDataJSON().source);
        }
      });
      await issueButton.click();
      await assistantPanel.waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'control-panel-assistant');
      await page.waitForFunction(() => document.querySelectorAll('.shots .highlight').length === 2);
      assert.deepEqual(proposalRequests, []);
      await page.getByLabel('建议的文本内容').fill('打开导航');
      await page.getByRole('button', { name: '生成补丁预览' }).click();
      await page.getByRole('region', { name: '修复内容摘要' }).waitFor();
      const enlarge = page.getByRole('button', { name: '放大对比' });
      await enlarge.click();
      const large = page.getByRole('dialog', { name: '放大查看页面对比' });
      await large.waitFor();
      await large.locator('.shots img').nth(1).waitFor({ timeout: 30000 });
      assert.equal(await large.locator('.shots img').count(), 2);
      assert.equal(await large.getByRole('checkbox', { name: '同步滚动' }).isChecked(), true);
      await large.getByRole('button', { name: '200%', exact: true }).click();
      assert.equal(await large.getByRole('button', { name: '200%', exact: true }).getAttribute('aria-pressed'), 'true');
      await large.locator('.screen-wrap').first().evaluate(element => { element.scrollLeft = 120; });
      await page.waitForFunction(() => (document.querySelectorAll<HTMLDivElement>('dialog[open] .screen-wrap')[1]?.scrollLeft ?? 0) > 0);
      await large.getByRole('button', { name: '只看右侧' }).click();
      assert.equal(await large.locator('.shots img').count(), 1);
      const dialogAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      assert.deepEqual(dialogAudit.violations.filter(item => item.impact === 'critical' || item.impact === 'serious').map(item => item.id), []);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: '放大查看页面对比' }).count(), 0);
      assert.ok(await enlarge.evaluate(button => button === document.activeElement));
      await page.getByText('开发者选项', { exact: true }).click();
      await page.getByRole('button', { name: '代码变更', exact: true }).click();
      const pendingDiff = page.getByLabel('待审核的源码差异');
      await pendingDiff.waitFor();
      await page.getByRole('button', { name: '确认应用修复' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '取消');
      await page.keyboard.press('Escape');
      await issuesTab.click();
      assert.equal(await issueButton.getAttribute('aria-pressed'), 'true');
      assert.equal(await severity.inputValue(), buttonIssue.impact);
      assert.ok(await pendingDiff.isVisible());
      await issueButton.click();
      assert.equal(await assistantTab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByLabel('建议的文本内容').inputValue(), '打开导航');
      assert.ok(await pendingDiff.isVisible());
      assert.deepEqual(proposalRequests, ['manual']);
      const currentHeights = await page.locator('.workbench > div').evaluateAll(columns =>
        columns.map(column => column.getBoundingClientRect().height),
      );
      assert.deepEqual(currentHeights, [controls.height, evidence.height]);
      await page.getByRole('button', { name: '确认应用修复' }).click();
      await page.getByRole('button', { name: '确认应用并复测' }).click();
      await page.getByRole('button', { name: '无障碍语义', exact: true }).click();
      const semantics = page.getByRole('table');
      await semantics.getByText('打开导航', { exact: false }).waitFor({ timeout: 25000 });
      assert.match(await semantics.innerText(), /可访问名称\s+（空）\s+打开导航/);
      assert.match(await semantics.innerText(), /角色\s+button\s+button/);
      assert.equal(await assistantTab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByRole('button', { name: '确认应用修复' }).count(), 0);
      await page.getByRole('button', { name: '查看历史补丁' }).click();
      assert.match(await page.getByLabel('已保存的源码差异').innerText(), /aria-label="打开导航"/);
      await page.getByRole('button', { name: '页面对照' }).click();
      assert.equal(await page.locator('.shots img').count(), 2);
      await page.waitForFunction(() => document.querySelectorAll('.shots .highlight').length === 2);
      await page.getByRole('button', { name: '仅修复后' }).click();
      assert.equal(await page.locator('.shots img').count(), 1);
      await page.getByRole('button', { name: /放大修复后/ }).click();
      assert.equal(await page.locator('.shots .zoomed').count(), 1);
      await page.setViewportSize({ width: 375, height: 780 });
      await issuesTab.click();
      await page.getByRole('button', { name: /待处理\s*0/ }).click();
      await page.getByText('当前无待处理问题', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '结果报告', exact: true }).click();
      assert.equal(await page.locator('.metrics > div').count(), 4);
      await page.getByRole('heading', { name: 'V2 检测证据' }).waitFor();
      assert.ok(await page.getByText('#skipped', { exact: true }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: /按钮缺少名称.*查看证据/ }).click();
      await page.getByRole('button', { name: '无障碍语义' }).click();
      await page.getByRole('table').getByText('打开导航', { exact: false }).waitFor({ timeout: 25000 });

      const [project] = await (await api('/api/projects')).json();
      const archive = unzipSync(new Uint8Array(await (await api(`/api/projects/${project.id}/export`)).arrayBuffer()));
      assert.match(strFromU8(archive['website/index.html']), /aria-label="打开导航"/);
      assert.ok(archive['website/style-1.css']);
      assert.ok(archive['website/image-1.png']);
      const exported = JSON.parse(strFromU8(archive['report/report.json']));
      assert.equal(exported.current.detection.behavior.status, 'completed');
      assert.ok(exported.current.detection.behavior.findings.some((item: { selector: string; status: string }) =>
        item.selector === '#skipped' && item.status === 'needs-review'));
      assert.equal(exported.current.issues.length, 0);
      const state = await (await api('/api/projects/' + project.id)).json();
      const historic = state.verifications[0];
      const rolled = await api(`/api/projects/${project.id}/rollback`, { snapshotId: state.snapshots[0].id });
      assert.equal(rolled.status, 200);
      const restored = await (await api('/api/projects/' + project.id)).json();
      assert.ok(restored.current.issues.some((item: { ruleId: string }) => item.ruleId === 'button-name'));
      const historyProof = await (await api(`/api/projects/${project.id}/audits/${historic.audit}/semantics?selector=%23target`)).json();
      assert.equal(historyProof.name, '打开导航');
      assert.equal(historyProof.role, 'button');

      await page.getByRole('button', { name: '切换项目' }).click();
      await page.getByRole('button', { name: 'URL', exact: true }).click();
      await page.getByLabel('执行 JavaScript 后采集（推荐）').check();
      await page.getByLabel('公开网页地址').fill('http://93.184.216.34/dynamic');
      await page.getByRole('button', { name: '导入 URL 并检测' }).click();
      await page.getByText(/已运行页面脚本/).waitFor({ timeout: 30000 });
      const [dynamicProject] = await (await api('/api/projects')).json();
      const dynamicState = await (await api('/api/projects/' + dynamicProject.id)).json();
      const dynamicHtml = fs.readFileSync(path.join(dataDir, 'projects', dynamicProject.id, dynamicProject.currentSnapshot, 'index.html'), 'utf8');
      assert.match(dynamicHtml, /脚本渲染页面/);
      assert.match(dynamicHtml, /异步加载完成/);
      assert.match(dynamicHtml, /border:\s*5px solid red/);
      assert.doesNotMatch(dynamicHtml, /<script/i);
      assert.ok(fs.statSync(path.join(dataDir, 'projects', dynamicProject.id, dynamicProject.currentSnapshot, 'style-1.css')).size > 256 * 1024);
      assert.ok(dynamicState.current.issues.some((item: { ruleId: string; selector: string }) => item.ruleId === 'button-name' && item.selector === '#dynamic-button'));
      assert.ok(hits.includes('/app.js') && hits.includes('/data'));
      assert.equal(hits.filter(hit => hit === '/dynamic.css').length, 1);
      assert.ok(!hits.includes('/mutation'));
    } finally {
      await browser.close();
    }
  } finally {
    await stopService(service);
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('真实快照可双向对比，分叉及切换项目后仍使用正确的版本', { timeout: 120000 }, async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-compare-test-'));
  const service = spawn(process.execPath, ['--import', 'tsx', 'apps/api/server.ts'], {
    env: { ...process.env, PORT: String(port), A11Y_DATA_DIR: dataDir }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function api(route: string, body?: unknown) {
    const data = body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(base + '/api' + route, data === undefined ? undefined : {
      method: 'POST', body: data, headers: typeof data === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    });
    assert.ok(response.ok, `${route} · ${response.status}`);
    return response.json();
  }
  async function complete(job: { id: string }) {
    for (let i = 0; i < 150; i++) {
      const state = await api('/jobs/' + job.id);
      if (state.status === 'completed') return state.result;
      assert.ok(['queued', 'running'].includes(state.status), state.error);
      await delay(100);
    }
    throw new Error('等待扫描任务超时。');
  }
  async function create(fixture: string) {
    const form = new FormData();
    form.set('fixture', fixture);
    const { id } = await api('/projects', form);
    const route = '/projects/' + id;
    await complete(await api(route + '/audits', {}));
    return route;
  }

  try {
    for (let i = 0; !(await fetch(base + '/api/status').then(res => res.ok, () => false)); i++) {
      assert.ok(i < 100, '测试服务启动超时');
      await delay(100);
    }
    const route = await create('demo-mixed');
    const v0 = (await api(route)).originalSnapshotId;
    async function fix(ruleId: string, value: string) {
      const state = await api(route);
      const issue = state.current.issues.find((issue: { ruleId: string }) => issue.ruleId === ruleId);
      assert.ok(issue, ruleId);
      const proposal = await api(route + '/issues/' + issue.id + '/proposals', {
        source: 'manual', value, imagePurpose: ruleId === 'image-alt' ? 'informative' : undefined,
      });
      const proof = await complete(await api('/proposals/' + proposal.id + '/apply', { semanticReviewed: true }));
      assert.equal(proof.status, 'passed', proof.reason);
      return proof.toSnapshot;
    }

    const v1 = await fix('button-name', '打开菜单');
    const v2 = await fix('image-alt', '盆栽绿植插画');
    const v3 = await fix('color-contrast', '#1c2731');
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1140 } });
      page.setDefaultTimeout(12000);
      const evidence = page.getByRole('region', { name: '修复效果对比' });
      const left = evidence.getByLabel('左侧版本');
      const right = evidence.getByLabel('右侧版本');
      const images = page.locator('.shots img');
      const summary = page.getByRole('region', { name: '版本差异摘要' });
      const open = async (name: string) => {
        await page.locator('.recent-list').getByRole('button', { name }).click();
        await page.getByRole('button', {name: '精准修复', exact: true}).click();
      };
      const show = async (name: string) => {
        if (name === '代码变更' && !await evidence.locator('.developer-options').evaluate(element => (element as HTMLDetailsElement).open)) {
          await evidence.getByText('开发者选项', { exact: true }).click();
        }
        await evidence.getByRole('button', { name, exact: true }).click();
      };
      const waitForImages = async () => {
        await page.waitForFunction(() => {
          const images = [...document.querySelectorAll<HTMLImageElement>('.shots img')];
          return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
        });
        return images.evaluateAll(nodes => nodes.map(node => node.getAttribute('src')!));
      };
      await page.goto(base);
      await open('慢绿生活');
      await summary.waitFor();
      assert.equal(await left.inputValue(), v0);
      assert.equal(await right.inputValue(), v3);
      assert.match(await summary.innerText(), /右侧不再报告 3 个问题/);
      const original = await waitForImages();
      assert.notEqual(original[0], original[1]);
      if (process.env.A11Y_COMPARE_SCREENSHOT) await page.screenshot({ path: process.env.A11Y_COMPARE_SCREENSHOT });

      await left.selectOption(v1);
      assert.equal(await right.inputValue(), v3);
      await right.selectOption(v2);
      const second = await waitForImages();
      assert.notEqual(second[0], original[0]);
      assert.notEqual(second[1], original[1]);
      await show('代码变更');
      const diff = page.getByRole('region', { name: 'index.html 版本差异' });
      await diff.locator('ins').filter({ hasText: '盆栽绿植插画' }).waitFor();
      assert.doesNotMatch(await diff.innerText(), /打开菜单|1c2731/);
      await evidence.getByRole('button', { name: '交换版本' }).press('Enter');
      assert.equal(await left.inputValue(), v2);
      assert.equal(await right.inputValue(), v1);
      await diff.locator('del').filter({ hasText: '盆栽绿植插画' }).waitFor();

      await right.selectOption(v3);
      await diff.locator('ins').filter({ hasText: '#1c2731' }).waitFor();
      await show('页面对照');
      const third = await waitForImages();
      assert.deepEqual(third, [second[1], original[1]]);
      const [oldPixels, newPixels] = await Promise.all(third.map(src => fetch(base + src).then(res => res.arrayBuffer())));
      assert.notDeepEqual(Buffer.from(oldPixels), Buffer.from(newPixels));
      await page.getByRole('button', { name: /已解决\s*3/ }).click();
      await page.getByRole('button', { name: /图片缺少替代文本/ }).click();
      await show('自由版本对比');
      await left.selectOption(v1);
      await right.selectOption(v2);
      await show('无障碍语义');
      const semantics = evidence.getByRole('table');
      await semantics.waitFor();
      assert.match(await semantics.innerText(), /可访问名称\s+（空）\s+盆栽绿植插画/);
      await show('交换版本');
      await semantics.waitFor();
      assert.match(await semantics.innerText(), /可访问名称\s+盆栽绿植插画\s+（空）/);
      assert.equal((await api(route)).project.currentSnapshot, v3);

      await api(route + '/rollback', { snapshotId: v1 });
      const branch = await fix('link-name', '查看种植灵感');
      const branchState = await api(route);
      assert.equal(branchState.snapshots.find((snapshot: { id: string }) => snapshot.id === branch).parent_id, v1);
      await page.reload();
      await open('慢绿生活');
      assert.equal(await left.inputValue(), v0);
      assert.equal(await right.inputValue(), branch);
      assert.equal(await left.locator('option').count(), 5);
      await left.selectOption(v3);
      await show('代码变更');
      await diff.locator('del').filter({ hasText: '盆栽绿植插画' }).waitFor();
      await diff.locator('ins').filter({ hasText: '查看种植灵感' }).waitFor();
      assert.equal((await api(route)).project.currentSnapshot, branch);
      await page.route('**/screenshot', request => request.continue());
      fs.unlinkSync(path.join(dataDir, 'screenshots', branchState.current.id + '.png'));
      await show('页面对照');
      await evidence.getByText('截图缺失或加载失败。').waitFor();
      assert.equal(await images.count(), 1);

      const other = await create('demo-form');
      const otherRoot = (await api(other)).originalSnapshotId;
      assert.equal((await fetch(base + '/api' + other + `/compare?left=${v3}&right=${otherRoot}`)).status, 400);
      await page.reload();
      await open('课程报名');
      assert.equal(await left.inputValue(), otherRoot);
      assert.equal(await right.inputValue(), otherRoot);
      await page.getByText(/这两个版本暂无可检测差异/).waitFor();
      await page.setViewportSize({ width: 375, height: 780 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await browser.close();
    }
  } finally {
    await stopService(service);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
