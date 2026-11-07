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
    } else if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
        <html lang="zh-CN"><head><title>URL 导入测试</title><link rel="stylesheet" href="/theme.css"></head>
        <body><main><h1>静态快照测试</h1><img src="/sample.png" alt="测试图"><button id="target"></button>
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
      await page.getByLabel('公开网页地址').fill('http://93.184.216.34/page');
      await page.getByRole('button', { name: '导入 URL 并检测' }).click();
      await page.getByText(/URL 快照已导入并完成检测/).waitFor({ timeout: 15000 });
      assert.deepEqual(hits.slice(1).sort(), ['/page', '/sample.png', '/theme.css']);
      await page.getByRole('button', { name: /按钮缺少名称/ }).click();
      await page.getByLabel('建议的文本内容').fill('打开导航');
      await page.getByRole('button', { name: '生成补丁预览' }).click();
      await page.getByRole('button', { name: '审核并应用' }).click();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '再检查一下');
      await page.getByRole('button', { name: '确认并验证' }).click();
      const semantics = page.getByRole('table');
      await semantics.getByText('打开导航', { exact: false }).waitFor({ timeout: 25000 });
      assert.match(await semantics.innerText(), /可访问名称\s+（空）\s+打开导航/);
      assert.match(await semantics.innerText(), /角色\s+button\s+button/);
      await page.getByRole('button', { name: '代码 Diff' }).click();
      assert.match(await page.getByLabel('已保存的源码差异').innerText(), /aria-label="打开导航"/);
      await page.getByRole('button', { name: '视觉对比' }).click();
      assert.equal(await page.locator('.shots img').count(), 2);
      await page.waitForFunction(() => document.querySelectorAll('.shots .highlight').length === 2);
      await page.getByRole('button', { name: '仅修复后' }).click();
      assert.equal(await page.locator('.shots img').count(), 1);
      await page.getByRole('button', { name: /待处理\s*0/ }).click();
      await page.getByText('当前无待处理问题', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '结果报告', exact: true }).click();
      await page.getByRole('button', { name: /按钮缺少名称.*查看证据/ }).click();
      await page.getByRole('button', { name: '无障碍语义' }).click();
      await page.getByRole('table').getByText('打开导航', { exact: false }).waitFor({ timeout: 25000 });

      const [project] = await (await api('/api/projects')).json();
      const archive = unzipSync(new Uint8Array(await (await api(`/api/projects/${project.id}/export`)).arrayBuffer()));
      assert.match(strFromU8(archive['website/index.html']), /aria-label="打开导航"/);
      assert.ok(archive['website/style-1.css']);
      assert.ok(archive['website/image-1.png']);
      const state = await (await api('/api/projects/' + project.id)).json();
      const historic = state.verifications[0];
      const rolled = await api(`/api/projects/${project.id}/rollback`, { snapshotId: state.snapshots[0].id });
      assert.equal(rolled.status, 200);
      const restored = await (await api('/api/projects/' + project.id)).json();
      assert.ok(restored.current.issues.some((item: { ruleId: string }) => item.ruleId === 'button-name'));
      const historyProof = await (await api(`/api/projects/${project.id}/audits/${historic.audit}/semantics?selector=%23target`)).json();
      assert.equal(historyProof.name, '打开导航');
      assert.equal(historyProof.role, 'button');
    } finally {
      await browser.close();
    }
  } finally {
    service.kill('SIGTERM');
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
