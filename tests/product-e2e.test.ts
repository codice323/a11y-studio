import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';

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
      const page = await browser.newPage({ viewport: { width: 375, height: 780 } });
      await page.goto(base);
      await page.getByRole('button', { name: 'URL', exact: true }).click();
      await page.getByLabel('仅采集静态 HTML').check();
      await page.getByLabel('公开网页地址').fill('http://93.184.216.34/page');
      await page.getByRole('button', { name: '导入 URL 并检测' }).click();
      await page.getByText(/URL 快照已导入并完成检测/).waitFor({ timeout: 15000 });
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
      await page.getByText('当前为原始版本 V0，尚无修复后版本。').waitFor();
      assert.equal(await page.locator('.shots img').count(), 1);
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
      assert.equal(await page.locator('.shots .highlight').count(), 1);
      assert.deepEqual(proposalRequests, []);
      await page.getByLabel('建议的文本内容').fill('打开导航');
      await page.getByRole('button', { name: '生成补丁预览' }).click();
      const pendingDiff = page.getByLabel('待审核的源码差异');
      await pendingDiff.waitFor();
      await page.getByRole('button', { name: '审核并应用' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '再检查一下');
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
      await page.getByRole('button', { name: '审核并应用' }).click();
      await page.getByRole('button', { name: '确认并验证' }).click();
      const semantics = page.getByRole('table');
      await semantics.getByText('打开导航', { exact: false }).waitFor({ timeout: 25000 });
      assert.match(await semantics.innerText(), /可访问名称\s+（空）\s+打开导航/);
      assert.match(await semantics.innerText(), /角色\s+button\s+button/);
      assert.equal(await assistantTab.getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByRole('button', { name: '审核并应用' }).count(), 0);
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
    service.kill('SIGTERM');
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
