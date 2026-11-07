import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { captureUrlSnapshot, isPublicAddress } from '../apps/api/url-snapshot';

const upstream = 'http://public-source.net';
const publicIp = '93.184.216.34';
type Reply = { body?: Buffer | string; type?: string; status?: number; location?: string; length?: string };

function upstreamResponses(t: TestContext, replies: Record<string, Reply>, dnsOverrides: Record<string, string[]> = {}) {
  const visited: string[] = [];
  const resolutions: string[] = [];
  const resolver = t.mock.method(dns, 'lookup', async (host: string) => {
    resolutions.push(host);
    return (dnsOverrides[host] ?? [publicIp]).map(address => ({ address, family: 4 }));
  });
  syncBuiltinESMExports();
  t.after(() => { resolver.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(http, 'get', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    visited.push(url.href);
    assert.equal(options.agent, false);
    assert.equal(options.signal?.aborted, false);
    assert.equal(options.family, 4);
    options.lookup?.(url.hostname, { family: 4 }, (error, address) => {
      assert.ifError(error);
      assert.equal(address, publicIp);
    });
    const reply = replies[url.href];
    const request = new EventEmitter();
    process.nextTick(() => {
      if (!reply) return request.emit('error', new Error('Unexpected outbound request'));
      const payload = Buffer.from(reply.body ?? '');
      const response = Object.assign(Readable.from([payload]), {
        statusCode: reply.status ?? 200,
        headers: { 'content-type': reply.type ?? 'text/html', location: reply.location, 'content-length': reply.length },
      });
      callback(response as unknown as http.IncomingMessage);
    });
    return request;
  });
  return { visited, resolutions };
}

test('URL 地址校验拒绝非公网、保留地址及替代写法', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '198.18.0.1', '192.0.2.5', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '64:ff9b::a9fe:a9fe']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://localhost./', 'http://me@example.com/', 'https://example.com:80/', 'file:///etc/passwd']) {
    await assert.rejects(captureUrlSnapshot(url), /公网|公开|默认端口/);
  }
});

test('每次重定向重新校验，DNS 只要返回一个非公网地址就拒绝连接', async t => {
  const { visited, resolutions } = upstreamResponses(t, {
    [upstream + '/start']: { status: 302, location: 'http://mixed-source.net/page' },
    [upstream + '/private']: { status: 302, location: 'http://169.254.169.254/' },
    [upstream + '/loop']: { status: 302, location: '/loop' },
  }, { 'mixed-source.net': [publicIp, '10.0.0.1'] });
  await assert.rejects(captureUrlSnapshot(upstream + '/start'), /非公网/);
  assert.deepEqual(visited, [upstream + '/start']);
  assert.deepEqual(resolutions, ['public-source.net', 'mixed-source.net']);
  await assert.rejects(captureUrlSnapshot(upstream + '/private'), /非公网/);
  await assert.rejects(captureUrlSnapshot(upstream + '/loop'), /重定向次数/);
  assert.equal(visited.length, 7);
});

test('URL 快照保存 HTML、CSS 和同源图片，去除主动内容并跳过跨源重定向', async t => {
  const { visited } = upstreamResponses(t, {
    [upstream + '/start']: { status: 302, location: '/folder/page' },
    [upstream + '/folder/page']: { body: `<html lang="zh-CN"><head><title>快照测试</title>
      <meta http-equiv="refresh" content="0;url=http://third-party.net">
      <link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/cross.css"></head>
      <body onload="run()"><script>run()</script><iframe src="/embed"></iframe>
      <img src="../image.png" srcset="/other.png 2x"><img src="http://third-party.net/image.png" alt="外部图片">
      <button id="empty"></button><a href="javascript:run()">无效链接</a></body></html>` },
    [upstream + '/theme.css']: { type: 'text/css', body: '@import "/extra.css"; button {background: url(/image.png); width: 2rem}' },
    [upstream + '/cross.css']: { status: 302, location: 'http://third-party.net/theme.css' },
    [upstream + '/image.png']: { type: 'image/png', body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  });
  const snapshot = await captureUrlSnapshot(upstream + '/start');
  assert.equal(snapshot.name, '快照测试 · public-source.net');
  assert.deepEqual(snapshot.assets, { stylesheets: 1, images: 1, skipped: 3 });
  const html = snapshot.files.get('index.html')?.toString() ?? '';
  assert.match(html, /href="style-1.css"/);
  assert.match(html, /src="image-1.png"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /id="empty"/);
  assert.doesNotMatch(html, /<script|<iframe|onload=|srcset=|javascript:|third-party\.net/);
  assert.match(snapshot.files.get('style-1.css')?.toString() ?? '', /url\("image-1\.png"\)/);
  assert.equal(visited.filter(url => url.endsWith('/image.png')).length, 1);
  assert.ok(visited.every(url => url.startsWith(upstream)));
});

test('URL 导入拒绝非 HTML、非 2xx 和超限响应', async t => {
  upstreamResponses(t, {
    [upstream + '/image']: { type: 'image/png', body: 'not HTML' },
    [upstream + '/missing']: { status: 404 },
    [upstream + '/large']: { length: '3000000' },
    [upstream + '/stream-large']: { body: Buffer.alloc(2 * 1024 * 1024 + 1) },
  });
  await assert.rejects(captureUrlSnapshot(upstream + '/image'), /不是 HTML/);
  await assert.rejects(captureUrlSnapshot(upstream + '/missing'), /HTTP 404/);
  await assert.rejects(captureUrlSnapshot(upstream + '/large'), /超过大小/);
  await assert.rejects(captureUrlSnapshot(upstream + '/stream-large'), /超过大小/);
});
