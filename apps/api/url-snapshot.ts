import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import fs from 'node:fs';
import { chromium, type Browser } from 'playwright-core';

const MAX_HTML = 2 * 1024 * 1024;
const MAX_CSS = 256 * 1024;
const MAX_IMAGE = 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_STYLES = 8;
const MAX_IMAGES = 20;
const MAX_REDIRECTS = 4;
const imageExtensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};
const redirects = new Set([301, 302, 303, 307, 308]);
type Address = { address: string; family: number };
type Resource = { url: URL; type: string; contentType: string; body: Buffer };
type Budget = { remaining: number };

export function isPublicAddress(address: string) {
  if (!isIP(address) || address.includes('%')) return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  return ip instanceof ipaddr.IPv4 || ip.match(ipaddr.IPv6.parse('2000::'), 3);
}

function parseUrl(input: string | URL) {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error('请输入完整的 HTTP 或 HTTPS 网页地址。'); }
  // WHATWG URL canonicalizes IP literals and strips default ports.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 2048) {
    throw new Error('仅支持使用默认端口且不含账号信息的 HTTP 或 HTTPS 地址。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!isIP(host) && (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host))) {
    throw new Error('仅支持公开网页地址。');
  }
  url.hash = '';
  return url;
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// Local proxy clients sometimes return synthetic 198.18/15 addresses for every domain.
// Query a trusted public resolver only in that case; the resulting real IPs are still
// checked and pinned. IP literals and ordinary private/mixed answers never fall back.
async function resolveSyntheticHostname(hostname: string, signal: AbortSignal): Promise<Address[]> {
  const records = await Promise.all(['A', 'AAAA'].map(async type => {
    const url = new URL('https://dns.alidns.com/resolve');
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);
    const response = await fetch(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('无法通过公共 DNS 解析网页地址。');
    const body = await response.arrayBuffer();
    if (body.byteLength > 65536) throw new Error('公共 DNS 响应过大。');
    let data: { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    try { data = JSON.parse(Buffer.from(body).toString('utf8')); }
    catch { throw new Error('公共 DNS 响应无效。'); }
    if (data.Status !== 0) throw new Error('无法通过公共 DNS 解析网页地址。');
    const expected = type === 'A' ? 1 : 28;
    return (data.Answer ?? []).filter(item => item.type === expected && typeof item.data === 'string')
      .map(item => ({ address: item.data!, family: isIP(item.data!) }));
  }));
  return records.flat();
}

type DnsFallbackCache = Map<string, Promise<Address[]>>;
async function selectAddress(url: URL, signal: AbortSignal, fallbackCache: DnsFallbackCache): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  let addresses = family ? [{ address: hostname, family }]
    : await withAbort(lookup(hostname, { all: true }), signal).catch(() => {
      signal.throwIfAborted();
      throw new Error('无法解析该网页地址。');
    });
  if (!family && addresses.length && addresses.every(item => {
    const ip = ipaddr.parse(item.address);
    return ip instanceof ipaddr.IPv4 && ip.match(ipaddr.IPv4.parse('198.18.0.0'), 15);
  })) {
    let fallback = fallbackCache.get(hostname);
    if (!fallback) { fallback = resolveSyntheticHostname(hostname, signal); fallbackCache.set(hostname, fallback); }
    addresses = await withAbort(fallback, signal);
  }
  if (!addresses.length || addresses.some(item => !item.family || !isPublicAddress(item.address))) {
    throw new Error('网页地址解析到内网、保留或其他非公网地址。');
  }
  return addresses.find(item => item.family === 4) ?? addresses[0];
}

function readResource(url: URL, selected: Address, maxBytes: number, budget: Budget, signal: AbortSignal) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Resource | URL>((resolve, reject) => {
    const request = client.get(url, {
      agent: false,
      family: selected.family,
      // Connect to the checked address while retaining the original Host and TLS identity.
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
      signal,
      headers: {
        'User-Agent': 'A11yStudio/0.1 (static accessibility audit)',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (redirects.has(status)) {
        response.destroy();
        try {
          if (!response.headers.location) throw new Error();
          resolve(new URL(response.headers.location, url));
        } catch { reject(new Error('网页重定向地址无效。')); }
        return;
      }
      function stop(message: string) {
        reject(new Error(message));
        response.destroy();
      }
      response.on('error', reject);
      if (status < 200 || status >= 300) return stop(`网页返回 HTTP ${status}。`);
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        return stop('网页返回了暂不支持的压缩内容。');
      }
      if (Number(response.headers['content-length']) > Math.min(maxBytes, budget.remaining)) {
        return stop('网页或资源超过大小限制。');
      }
      const contentType = response.headers['content-type'] ?? '';
      const type = contentType.split(';')[0].trim().toLowerCase();
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        budget.remaining -= chunk.length;
        if (bytes > maxBytes || budget.remaining < 0) stop('网页或资源超过大小限制。');
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ url, type, contentType, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

async function fetchResource(input: string | URL, maxBytes: number, budget: Budget, total: AbortSignal, fallbackCache: DnsFallbackCache, origin?: string) {
  const signal = AbortSignal.any([total, AbortSignal.timeout(6500)]);
  try {
    let target = parseUrl(input);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      signal.throwIfAborted();
      if (origin && target.origin !== origin) throw new Error('已跳过跨源资源。');
      const address = await selectAddress(target, signal, fallbackCache);
      const result = await readResource(target, address, maxBytes, budget, signal);
      if (!(result instanceof URL)) return result;
      target = parseUrl(result);
    }
    throw new Error('网页重定向次数过多。');
  } catch (error) {
    if (signal.aborted) throw new Error('网页请求超时或已中止。');
    if (error instanceof Error && 'code' in error) throw new Error('无法连接网页，请检查地址、TLS 证书或网站访问限制。');
    throw error;
  }
}

function asText(resource: Resource) {
  const charset = resource.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  const htmlCharset = resource.type === 'text/html' && resource.body.subarray(0, 4096).toString('latin1').match(/<meta\s[^>]*charset\s*=\s*["']?([^;\s"'/>]+)/i)?.[1];
  try { return new TextDecoder(charset || htmlCharset || 'utf-8').decode(resource.body); }
  catch { return resource.body.toString('utf8'); }
}

export function isRasterImage(resource: Pick<Resource, 'type' | 'body'>) {
  const { type, body } = resource;
  if (type === 'image/png') return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return body.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (type === 'image/gif') return /^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'));
  return type === 'image/webp' && body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP';
}

function resourceUrl(reference: string, base: URL) {
  try { return new URL(reference, base); } catch { return null; }
}

async function rewriteCss(source: string, base: URL, image: (reference: string, base: URL) => Promise<string | null>, skip: () => void) {
  let css;
  try { css = postcss.parse(source); }
  catch { skip(); return ''; }
  css.walkAtRules(/^import$/i, rule => { skip(); rule.remove(); });
  const updates: Promise<void>[] = [];
  css.walkDecls(declaration => {
    // URL values containing escaped delimiters may be left for the offline CSP to block.
    const tokens = [...declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"]+))\s*\)/gi)];
    if (!tokens.length) return;
    updates.push(Promise.all(tokens.map(async token => {
      const reference = token[1] ?? token[2] ?? token[3];
      if (reference.startsWith('#')) return token[0];
      const file = await image(reference, base);
      return file ? `url("${file}")` : 'none';
    })).then(replacements => {
      let value = declaration.value;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const { index } = tokens[i];
        value = value.slice(0, index) + replacements[i] + value.slice(index + tokens[i][0].length);
      }
      declaration.value = value;
    }));
  });
  await Promise.all(updates);
  return css.toString();
}

async function renderPage(initial: Resource, budget: Budget, total: AbortSignal, fallbackCache: DnsFallbackCache) {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean) as string[];
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('未找到 Chromium 或 Chrome，请设置 CHROME_PATH。');
  let browser: Browser | undefined;
  let requests = 0;
  let blocked = 0;
  const resources = new Map<string, Resource>();
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  try {
    total.throwIfAborted();
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, args: ['--disable-quic', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'] });
    total.throwIfAborted();
    total.addEventListener('abort', closeBrowser, { once: true });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block', acceptDownloads: false });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
        Object.defineProperty(window, name, { value: undefined, configurable: false });
      }
    });
    let initialPending = true;
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        if (request.method() !== 'GET' || ++requests > 100) { blocked++; await route.abort(); return; }
        const requested = parseUrl(request.url());
        // Every outbound request is made by the server through the same public-IP
        // validation and pinned DNS connection as static imports. The browser never connects directly.
        const resource = initialPending && requested.href === initial.url.href
          ? initial : await fetchResource(requested, 3 * 1024 * 1024, budget, total, fallbackCache);
        initialPending = false;
        if (['stylesheet', 'image'].includes(request.resourceType())) resources.set(requested.href, resource);
        await route.fulfill({ status: 200, contentType: resource.contentType || 'application/octet-stream', body: resource.body,
          headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
      } catch { blocked++; await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    page.on('popup', popup => { void popup.close(); });
    await page.goto(initial.url.href, { waitUntil: 'domcontentloaded', timeout: 18000 });
    // Allow asynchronous application rendering without waiting forever for polling.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1000);
    total.throwIfAborted();
    // CSS-in-JS libraries often insert rules into CSSOM without updating the
    // <style> text node. Materialize accessible inline rules before serialization.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('style')) {
        try {
          const rules = element.sheet?.cssRules;
          if (rules?.length) element.textContent = Array.from(rules, rule => rule.cssText).join('\n');
        } catch { /* Styles inaccessible to the page are handled as missing assets. */ }
      }
    });
    const finalUrl = parseUrl(page.url());
    const html = await page.content();
    if (Buffer.byteLength(html) > MAX_HTML) throw new Error('渲染后的网页超过大小限制。');
    return { page: { ...initial, url: finalUrl, type: 'text/html', contentType: 'text/html; charset=utf-8', body: Buffer.from(html) }, requests, blocked, resources };
  } finally {
    total.removeEventListener('abort', closeBrowser);
    await browser?.close();
  }
}

export async function captureUrlSnapshot(input: string, signal?: AbortSignal, mode: 'static' | 'rendered' = 'static') {
  const deadline = AbortSignal.timeout(mode === 'rendered' ? 45000 : 20000);
  const total = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const budget = { remaining: mode === 'rendered' ? 24 * 1024 * 1024 : MAX_TOTAL };
  const fallbackCache: DnsFallbackCache = new Map();
  let page = await fetchResource(input, MAX_HTML, budget, total, fallbackCache);
  if (!['text/html', 'application/xhtml+xml'].includes(page.type)) throw new Error('该地址返回的不是 HTML 网页。');
  const rendered = mode === 'rendered' ? await renderPage(page, budget, total, fallbackCache) : undefined;
  if (rendered) page = rendered.page;
  const $ = cheerio.load(asText(page));
  const files = new Map<string, Buffer>();
  const imageRequests = new Map<string, Promise<string | null>>();
  let stylesheets = 0;
  let images = 0;
  let skipped = 0;
  let imageSlots = 0;
  const skip = () => { skipped++; };
  // Keep only bounded same-origin raster assets. Deduplicate references across HTML and CSS.
  function image(reference: string, base: URL) {
    const url = resourceUrl(reference, base);
    if (!reference || !url || (mode === 'static' && url.origin !== page.url.origin)) { skip(); return Promise.resolve(null); }
    url.hash = '';
    const cached = imageRequests.get(url.href);
    if (cached) return cached;
    if (imageRequests.size >= MAX_IMAGES) { skip(); return Promise.resolve(null); }
    const slot = ++imageSlots;
    const task = (rendered?.resources.has(url.href)
      ? Promise.resolve(rendered.resources.get(url.href)!)
      : fetchResource(url, MAX_IMAGE, budget, total, fallbackCache, mode === 'static' ? page.url.origin : undefined)).then(result => {
      if (result.body.length > MAX_IMAGE) throw new Error('图片超过大小限制。');
      if (!isRasterImage(result)) throw new Error('图片格式不受支持。');
      const name = `image-${slot}.${imageExtensions[result.type]}`;
      files.set(name, result.body);
      images++;
      return name;
    }).catch(() => { skip(); return null; });
    imageRequests.set(url.href, task);
    return task;
  }

  $('script, iframe, frame, frameset, object, embed, base, meta[http-equiv], portal, animate, animateMotion, animateTransform, set, audio, video, source, track').remove();
  // Remove active navigation and network attributes before saving an exportable document.
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    const node = $(element);
    for (const attribute of Object.keys(element.attribs)) {
      if (/^on/i.test(attribute) || /^(?:srcdoc|ping|srcset|imagesrcset|imagesizes|action|formaction|background|attributionsrc|src|href|xlink:href)$/i.test(attribute)) {
        if (attribute === 'src' && (element.name === 'img' || (element.name === 'input' && node.attr('type')?.toLowerCase() === 'image'))) continue;
        if (attribute === 'href' && ['a', 'area', 'link'].includes(element.name)) continue;
        if ((attribute === 'href' || attribute === 'xlink:href') && node.attr(attribute)?.startsWith('#')) continue;
        node.removeAttr(attribute);
      }
    }
    if (element.name === 'a' || element.name === 'area') {
      const href = node.attr('href');
      if (href === undefined || href.startsWith('#')) return;
      const destination = resourceUrl(href, page.url);
      if (destination && ['http:', 'https:'].includes(destination.protocol) && !destination.username && !destination.password) node.attr('href', destination.href);
      else node.removeAttr('href');
    }
  });
  const stylesheetSelector = 'link[rel~="stylesheet" i][href]';
  const stylesheetLinks = $(stylesheetSelector).toArray();
  $('link').not(stylesheetSelector).remove();
  const styleTasks = stylesheetLinks.map(async (element, index) => {
    const node = $(element);
    const href = resourceUrl(node.attr('href') ?? '', page.url);
    if (index >= MAX_STYLES || !href || (mode === 'static' && href.origin !== page.url.origin)) { skip(); node.remove(); return; }
    try {
      const resource = rendered?.resources.get(href.href) ?? await fetchResource(href, mode === 'rendered' ? 2 * 1024 * 1024 : MAX_CSS, budget, total, fallbackCache, mode === 'static' ? page.url.origin : undefined);
      if (resource.body.length > (mode === 'rendered' ? 2 * 1024 * 1024 : MAX_CSS)) throw new Error('样式表超过大小限制。');
      if (resource.type !== 'text/css') throw new Error('样式表格式不受支持。');
      const css = await rewriteCss(asText(resource), resource.url, image, skip);
      if (!css.trim()) { node.remove(); return; }
      const name = `style-${index + 1}.css`;
      files.set(name, Buffer.from(css));
      node.attr('href', name).removeAttr('integrity crossorigin referrerpolicy');
      stylesheets++;
    } catch { skip(); node.remove(); }
  });
  const inlineTasks = $('style, [style]').toArray().map(async element => {
    const node = $(element);
    if (element.name === 'style') {
      const css = await rewriteCss(node.html() ?? '', page.url, image, skip);
      node.text(css.replace(/<\/style/gi, '<\\/style'));
    }
    const inline = node.attr('style');
    if (inline) {
      const css = await rewriteCss(`x{${inline}}`, page.url, image, skip);
      if (css.startsWith('x{') && css.endsWith('}')) node.attr('style', css.slice(2, -1));
      else node.removeAttr('style');
    }
  });
  const imageTasks = $('img[src], input[type="image" i][src]').toArray().map(async element => {
    const node = $(element);
    const reference = node.attr('src') ?? '';
    if (/^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(reference)) return;
    const name = await image(reference, page.url);
    if (name) node.attr('src', name);
    else node.removeAttr('src');
  });
  await Promise.all([...styleTasks, ...inlineTasks, ...imageTasks]);
  signal?.throwIfAborted();

  // The scanner supplies its own equivalent policy. This one also protects the exported page.
  $('meta[charset]').remove();
  $('head').prepend('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; form-action \'none\'; base-uri \'none\'">');
  const html = $.html();
  if (Buffer.byteLength(html) > MAX_HTML) throw new Error('保存后的网页超过大小限制。');
  files.set('index.html', Buffer.from(html));
  const title = $('title').text().replace(/\s+/g, ' ').trim().slice(0, 80);
  const empty = !$('body').text().trim() && !$('body img, body input, body button, body svg, body canvas, body video').length;
  return { name: title ? `${title} · ${page.url.hostname}` : page.url.hostname, files, assets: { stylesheets, images, skipped },
    ...(rendered ? { rendering: { mode, requests: rendered.requests, blocked: rendered.blocked, empty } } : {}) };
}
