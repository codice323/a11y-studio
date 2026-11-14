import { normalizeCaptureUrl } from '../../packages/shared/capture-url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { ROOT, DATA, hash } from './storage';
import { parsePublicUrl, requestPublicBrowserResource, type PublicBrowserBudget } from './url-snapshot';
import { importBrowserCaptureData } from './browser-capture';
import { diagnosePage, isWebsiteVerificationPage, locatePageElement, requireTargetPage, verificationPageMessage } from './page-diagnostics';
import type { LiveFrame } from '../../packages/shared/live-comparison';
import type { PageDiagnostics } from '../../packages/shared/page-diagnostics';

const MAX_SESSIONS = 2;
const SESSION_TTL = 20 * 60 * 1000;
const MAX_REQUESTS = 1200;
const MAX_PARALLEL_REQUESTS = 24;
const NETWORK_BUDGET = 96 * 1024 * 1024;
const MAX_NAVIGATION_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const VIEWPORT = { width: 1280, height: 820 };
const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean) as string[];

type Frame = { image: string; width: number; height: number; title: string; url: string; scrollHeight:number; failedResources:number; resourceFailures?: Record<string,number>; blocked?:string; location?:LiveFrame['location'] };
type Session = {
  id: string;
  ownerUserId: string;
  authSessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  controller: AbortController;
  budget: PublicBrowserBudget;
  requests: number;
  activeRequests: number;
  requestWaiters: Array<() => void>;
  failedResources: number;
  resourceFailures: Record<string,number>;
  actions: number;
  frames: number;
  queue: Promise<unknown>;
  expires: ReturnType<typeof setTimeout>;
  closed: boolean;
  navigationError?: unknown;
  diagnostics: Map<string,PageDiagnostics>;
  target?: {url:string;selector:string;selectors:string[]};
  pendingRedirect?: {page:Page;url:URL};
  openingNavigation?: {url: string; redirect?: URL};
  replay: Map<string,{type:string;body:string}>;
  replayBytes: number;
  replayDocuments: WeakMap<Page, {url:string;key:string}>;
};
const sessions = new Map<string, Session>();
let startQueue: Promise<unknown> = Promise.resolve();

function ownedSession(id: string, ownerUserId: string, authSessionId: string) {
  const session = sessions.get(id);
  if (!session || session.closed || session.ownerUserId !== ownerUserId || session.authSessionId !== authSessionId) {
    throw new Error('采集会话不存在或已结束，请重新输入网址。');
  }
  return session;
}

async function closeSession(session: Session) {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.expires);
  session.controller.abort(new Error('采集会话已结束。'));
  sessions.delete(session.id);
  await session.browser.close().catch(() => {});
}

function cookieForBrowser(raw: string, requestUrl: URL) {
  const parts = raw.split(';').map(part => part.trim());
  const separator = parts[0]?.indexOf('=') ?? -1;
  if (separator < 1) return null;
  const name = parts[0].slice(0, separator).trim();
  const value = parts[0].slice(separator + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\r\n;]/.test(value)) return null;
  const cookie: {name:string;value:string;url?:string;domain?:string;path?:string;expires?:number;httpOnly?:boolean;secure?:boolean;sameSite?:'Strict'|'Lax'|'None'} = { name, value, url:requestUrl.origin };
  for (const part of parts.slice(1)) {
    const [rawName, ...rest] = part.split('=');
    const key = rawName.toLowerCase();
    const attribute = rest.join('=').trim();
    if (key === 'domain') {
      const domain = attribute.replace(/^\./, '').toLowerCase();
      if (!domain || !(requestUrl.hostname === domain || requestUrl.hostname.endsWith('.' + domain))) return null;
      cookie.domain = domain;
      delete cookie.url;
    } else if (key === 'path' && attribute.startsWith('/')) cookie.path = attribute.slice(0, 200);
    else if (key === 'expires') {
      const time = Date.parse(attribute);
      if (Number.isFinite(time)) cookie.expires = Math.floor(time / 1000);
    } else if (key === 'max-age' && /^-?\d+$/.test(attribute)) cookie.expires = Math.floor(Date.now() / 1000) + Number(attribute);
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const value = attribute.toLowerCase();
      if (value === 'strict') cookie.sameSite = 'Strict';
      else if (value === 'lax') cookie.sameSite = 'Lax';
      else if (value === 'none') cookie.sameSite = 'None';
    }
  }
  return cookie;
}

async function acquireRequestSlot(session: Session) {
  const signal = session.controller.signal;
  while (session.activeRequests >= MAX_PARALLEL_REQUESTS) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const index = session.requestWaiters.indexOf(wake);
        if (index !== -1) session.requestWaiters.splice(index, 1);
        reject(signal.reason);
      };
      session.requestWaiters.push(wake);
      signal.addEventListener('abort', abort, {once:true});
    });
  }
  signal.throwIfAborted();
  session.activeRequests++;
}

function recordResourceFailure(session: Session, type: string, reason: string) {
  if (!['script','image','stylesheet','xhr','fetch','font'].includes(type)) return;
  session.failedResources++;
  const key = type + ' · ' + reason;
  session.resourceFailures[key] = (session.resourceFailures[key] ?? 0) + 1;
}

async function routeResponse(session: Session, route: Route) {
  const request = route.request();
  let navigationPage: Page | undefined;
  if (request.isNavigationRequest()) {
    try {
      const frame = request.frame();
      if (frame === frame.page().mainFrame()) navigationPage = frame.page();
    } catch { /* Some navigation requests are emitted before a frame exists. */ }
  }
  let acquired = false;
  try {
    session.controller.signal.throwIfAborted();
    if (++session.requests > MAX_REQUESTS) {
      throw new Error('采集浏览器的请求已达上限，请重新打开采集。');
    }
    await acquireRequestSlot(session);
    acquired = true;
    const url = parsePublicUrl(request.url());
    const response = await requestPublicBrowserResource(request.url(), request.method(), await request.allHeaders(),
      request.postDataBuffer() ?? undefined, session.budget, session.controller.signal, Boolean(navigationPage));
    const headerValues = response.headers['set-cookie'];
    if (headerValues) {
      const values = Array.isArray(headerValues) ? headerValues : [headerValues];
      for (const raw of values) {
        const cookie = cookieForBrowser(raw, url);
        if (cookie) await session.context.addCookies([cookie]).catch(() => {});
      }
    }
    const opening = session.openingNavigation;
    if (navigationPage === session.page && request.method() === 'GET' && REDIRECT_STATUSES.has(response.status)) {
      if (!response.headers.location) throw new Error('目标网站返回了无效的跳转地址。');
      const destination = parsePublicUrl(new URL(response.headers.location,url));
      // Chromium follows fulfilled redirects outside the route handler.
      // Queue a fresh, guarded navigation after aborting the original.
      if (opening?.url === url.href) opening.redirect = destination;
      else session.pendingRedirect = {page:navigationPage,url:destination};
      await route.abort('aborted');
      return;
    }
    const key = hash(url.href);
    const size = response.body.length;
    const resourceLimit = navigationPage ? 4_000_000 : 2_000_000;
    const archiveLimit = navigationPage ? 24_000_000 : 20_000_000;
    if (request.method()==='GET' && response.status===200 && ['document','script','stylesheet','image','font','xhr','fetch'].includes(request.resourceType()) &&
        size<=resourceLimit && session.replayBytes+size<=archiveLimit && !session.replay.has(key)) {
      session.replay.set(key,{type:String(response.headers['content-type'] || 'application/octet-stream').slice(0,160),body:response.body.toString('base64')});
      session.replayBytes+=size;
    }
    if (navigationPage && response.status >= 200 && response.status < 300) {
      if (session.replay.has(key)) session.replayDocuments.set(navigationPage, {url:url.href,key});
      else session.replayDocuments.delete(navigationPage);
    }
    if (response.status >= 400) recordResourceFailure(session,request.resourceType(),'HTTP '+response.status);
    const forwarded: Record<string,string> = {};
    const responseHeaderPattern = /^(?:content-type|content-language|content-disposition|location|cache-control|expires|last-modified|etag|vary|www-authenticate|content-security-policy(?:-report-only)?|referrer-policy|x-content-type-options|x-frame-options|permissions-policy|access-control-allow-[a-z-]+|access-control-expose-headers)$/i;
    for (const [name, value] of Object.entries(response.headers)) {
      const key = name.toLowerCase();
      if (key === 'set-cookie' || key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') continue;
      if (responseHeaderPattern.test(key) && value !== undefined) forwarded[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    await route.fulfill({ status:response.status, headers:forwarded, body:response.body });
  } catch (error) {
    if (navigationPage === session.page) session.navigationError = error;
    if (!session.controller.signal.aborted) {
      const message = (error as Error).message;
      const reason = /超过采集限制|流量已达上限|请求已达上限/.test(message) ? '超过采集限制' :
        /DNS/.test(message) ? 'DNS 解析失败' :
        /压缩内容/.test(message) ? '响应编码不受支持' :
        /公开网页|公网|默认端口/.test(message) ? '地址受限' :
        /连接失败/.test(message) ? '连接失败' : '请求失败';
      recordResourceFailure(session,request.resourceType(),reason);
    }
    await route.abort('failed').catch(() => {});
  } finally {
    if (acquired) {
      session.activeRequests--;
      session.requestWaiters.shift()?.();
    }
  }
}

async function openPage(session: Session, input: URL) {
  const deadline = Date.now() + 25000;
  let url = input;
  for (let hop = 0; hop <= MAX_NAVIGATION_REDIRECTS; hop++) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('网页连接超时，请点击重试。');
    const requestUrl = new URL(url);
    requestUrl.hash = '';
    const opening: NonNullable<Session['openingNavigation']> = {url:requestUrl.href};
    session.openingNavigation = opening;
    session.navigationError = undefined;
    try {
      const response = await session.page.goto(url.href,{waitUntil:'domcontentloaded',timeout});
      if (response && response.status() >= 400) throw new Error(`目标网站返回 HTTP ${response.status()}，请检查链接或稍后重试。`);
      return;
    } catch (error) {
      if (session.navigationError || !opening.redirect) throw session.navigationError ?? error;
      url = opening.redirect;
    } finally {
      session.openingNavigation = undefined;
    }
  }
  throw new Error('目标网站重定向次数过多，请检查链接。');
}

function serialize<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  const result = session.queue.catch(() => {}).then(() => {
    if (session.closed || session.controller.signal.aborted) throw new Error('采集会话已结束，请重新打开。');
    return operation();
  });
  session.queue = result.catch(() => {});
  return result;
}

async function frame(session: Session): Promise<Frame> {
  return serialize(session, async () => {
    const redirect = session.pendingRedirect;
    session.pendingRedirect = undefined;
    if (redirect?.page === session.page) await openPage(session,redirect.url);
    if (session.page.isClosed()) throw new Error('网页已关闭，请重新打开采集会话。');
    if (++session.frames > 2000) throw new Error('采集画面刷新次数已达上限，请结束本次采集后重新开始。');
    const image = await session.page.screenshot({ type:'jpeg', quality:62, timeout:15000,
      animations:'disabled', mask:[session.page.locator('input[type="password"],input[type="email"],input[type="tel"],input[type="file"]')] }).catch(async () =>
      session.page.screenshot({ type:'jpeg', quality:48, timeout:15000, animations:'disabled' }));
    const { visibleText, ...meta } = await session.page.evaluate(() => ({ width:innerWidth, height:innerHeight, title:document.title, url:window.location.href,
      visibleText:document.body?.innerText.slice(0,12000) ?? '',
      scrollHeight:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight ?? 0) }));
    const target = session.target;
    const highlight = target && target.url === meta.url ? await locatePageElement(session.page, target.selector,false,target.selectors) : undefined;
    const blocked = isWebsiteVerificationPage(meta.title,visibleText) ? verificationPageMessage : undefined;
    if (blocked) session.diagnostics.delete(meta.url);
    return { blocked, location:highlight, image:'data:image/jpeg;base64,' + image.toString('base64'), ...meta, failedResources:session.failedResources, resourceFailures:{...session.resourceFailures} };
  });
}

const actionShape = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') throw new Error('网页操作参数无效。');
  const value = raw as Record<string,unknown>;
  const number = (key:string, min:number, max:number) => {
    const item = value[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max) throw new Error('网页操作参数无效。');
    return item;
  };
  if (value.action === 'click' || value.action === 'move' || value.action === 'pointerDown' || value.action === 'pointerMove' || value.action === 'pointerUp') return { action:value.action, x:number('x',0,VIEWPORT.width), y:number('y',0,VIEWPORT.height) } as const;
  if (value.action === 'scroll') return { action:'scroll' as const, delta:number('delta',-1800,1800), x:typeof value.x==='number'?Math.max(0,Math.min(VIEWPORT.width,value.x)):VIEWPORT.width/2,
    y:typeof value.y==='number'?Math.max(0,Math.min(VIEWPORT.height,value.y)):VIEWPORT.height/2 };
  if (value.action === 'key' && typeof value.key === 'string' && ['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown',' ','Space'].includes(value.key)) {
    return { action:'key' as const, key:value.key, shift:value.shift===true };
  }
  if (value.action === 'text' && typeof value.text === 'string' && value.text.length <= 500) return { action:'text' as const, text:value.text };
  if (value.action === 'locate' && typeof value.url === 'string' && typeof value.selector === 'string' && value.selector.length <= 2000) {
    const selectors = Array.isArray(value.selectors) ? value.selectors.slice(0,300).filter((item): item is string => typeof item === 'string' && item.length <= 2000) : [];
    return { action:'locate' as const, url:value.url, selector:value.selector, selectors };
  }
  if (value.action === 'reload') return { action:'reload' as const };
  if (value.action === 'back') return { action:'back' as const };
  throw new Error('网页操作暂不支持。');
};

async function perform(session: Session, raw: unknown) {
  const action = actionShape(raw);
  await serialize(session, async () => {
    if (++session.actions > 1500) throw new Error('本次采集的网页操作次数已达上限，请结束后重新开始。');
    const page = session.page;
    if (page.isClosed()) throw new Error('网页已关闭，请重新打开采集会话。');
    if (action.action === 'locate') {
      if (page.url() !== action.url) throw new Error('网页已切换，请重新选择问题。');
      session.target = {url:action.url,selector:action.selector,selectors:action.selectors};
      await locatePageElement(page,action.selector,true,action.selectors);
    } else if (action.action === 'click') await page.mouse.click(action.x, action.y);
    else if (action.action === 'move') await page.mouse.move(action.x, action.y, { steps:1 });
    else if (action.action === 'pointerDown') { await page.mouse.move(action.x,action.y); await page.mouse.down(); }
    else if (action.action === 'pointerMove') await page.mouse.move(action.x,action.y);
    else if (action.action === 'pointerUp') { await page.mouse.move(action.x,action.y); await page.mouse.up(); }
    else if (action.action === 'scroll') {
      await page.mouse.move(action.x, action.y, { steps:1 });
      await page.mouse.wheel(0, action.delta);
      await page.waitForTimeout(120);
    } else if (action.action === 'key') await page.keyboard.press((action.shift ? 'Shift+' : '') + (action.key==='Space'?' ':action.key));
    else if (action.action === 'text') await page.keyboard.insertText(action.text);
    else if (action.action === 'back') {
      session.target = undefined;
      await page.goBack({waitUntil:'domcontentloaded',timeout:10000}).catch(() => null);
    } else {
      session.failedResources = 0;
      session.resourceFailures = {};
      await openPage(session,parsePublicUrl(page.url()));
      await page.waitForTimeout(350);
    }
    if (action.action === 'click' || action.action === 'key' || action.action === 'text') await page.waitForTimeout(180);
  });
  return frame(session);
}

export async function startManagedBrowserSession(input: unknown, ownerUserId: string, authSessionId: string) {
  const url = parsePublicUrl(normalizeCaptureUrl(typeof input === 'string' ? input : ''));
  const opening = startQueue.then(() => openManagedBrowserSession(url,ownerUserId,authSessionId));
  startQueue = opening.catch(() => {});
  return opening;
}

async function openManagedBrowserSession(url: URL, ownerUserId: string, authSessionId: string) {
  // A refresh or new capture replaces only this authenticated browser session's old capture.
  await Promise.all([...sessions.values()]
    .filter(session => session.ownerUserId === ownerUserId && session.authSessionId === authSessionId)
    .map(closeSession));
  if (sessions.size >= MAX_SESSIONS) throw new Error('当前实时采集会话较多，请稍后再试。');
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('未找到 Chromium 或 Chrome，请设置 CHROME_PATH 后重启后端。');
  let browser: Browser | undefined;
  let session: Session | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless:true, chromiumSandbox:true,
      args:['--disable-quic','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND'] });
    const context = await browser.newContext({ viewport:VIEWPORT, deviceScaleFactor:1, serviceWorkers:'block', acceptDownloads:false,
      javaScriptEnabled:true, locale:'zh-CN' });
    await context.routeWebSocket('**/*', socket => socket.close());
    const controller = new AbortController();
    session = { id:randomUUID(), ownerUserId, authSessionId, browser, context, page:await context.newPage(), controller,
      budget:{remaining:NETWORK_BUDGET}, requests:0, activeRequests:0, requestWaiters:[], failedResources:0, resourceFailures:{}, actions:0, frames:0, queue:Promise.resolve(), expires:setTimeout(()=>{},0), closed:false, diagnostics:new Map(), replay:new Map(),replayBytes:0,replayDocuments:new WeakMap() };
    clearTimeout(session.expires);
    session.expires = setTimeout(()=>void closeSession(session!), SESSION_TTL);
    session.expires.unref?.();
    sessions.set(session.id,session);
    browser.on('disconnected',()=>{
      if(!session!.closed){session!.closed=true;clearTimeout(session!.expires);sessions.delete(session!.id);}
    });
    await context.route('**/*', route => routeResponse(session!,route));
    await context.addInitScript(() => {
      Object.defineProperty(window,'RTCPeerConnection',{value:undefined,configurable:false});
      Object.defineProperty(window,'webkitRTCPeerConnection',{value:undefined,configurable:false});
    });
    const watchPage = (page:Page) => {
      if (page !== session!.page) session!.page = page;
      page.on('close', () => {
        if (page === session!.page && !session!.closed) {
          const remaining = [...context.pages()].filter(candidate => !candidate.isClosed());
          if (remaining.length) session!.page = remaining.at(-1)!;
          else void closeSession(session!);
        }
      });
    };
    context.on('page',watchPage);
    watchPage(session.page);
    session.page.setDefaultTimeout(8000);
    await openPage(session,url);
    await session.page.waitForTimeout(700);
    const initial = await frame(session);
    return { id:session.id, frame:initial };
  } catch (error) {
    if (session) await closeSession(session);
    else await browser?.close().catch(() => {});
    const message = (error as Error).message;
    if (/timeout|Navigation timeout/i.test(message)) throw new Error('网页连接超时，请点击重试。');
    if (/^(?:page\.goto:|fetch failed$)/i.test(message)) throw new Error('暂时无法加载目标网页，请点击重试。');
    throw error;
  }
}

export async function getManagedBrowserFrame(id: string, ownerUserId: string, authSessionId: string) {
  return frame(ownedSession(id,ownerUserId,authSessionId));
}

export async function actManagedBrowserSession(id: string, ownerUserId: string, authSessionId: string, action: unknown) {
  return perform(ownedSession(id,ownerUserId,authSessionId),action);
}

export async function diagnoseManagedBrowserPage(id: string, ownerUserId: string, authSessionId: string, input: unknown) {
  const session = ownedSession(id,ownerUserId,authSessionId);
  const {url,refresh} = (input ?? {}) as {url?:unknown;refresh?:unknown};
  if (typeof url !== 'string' || url.length > 2048) throw new Error('检测页面地址无效。');
  return serialize(session,async () => {
    const page = session.page;
    if (session.pendingRedirect || page.url() !== url) throw new Error('网页已切换，请重试检测。');
    await requireTargetPage(page);
    const cached = session.diagnostics.get(url);
    if (cached && !cached.coverage?.stillLoading && refresh !== true) return cached;
    const result = await diagnosePage(page,url,{waitForContent:true});
    if (session.page !== page) throw new Error('网页已切换，请重试检测。');
    if (!cached && session.diagnostics.size >= 50) session.diagnostics.delete(session.diagnostics.keys().next().value!);
    session.diagnostics.set(url,result);
    return result;
  });
}

export async function captureManagedBrowserSession(id: string, ownerUserId: string, authSessionId: string, expectedUrl?: unknown) {
  const session = ownedSession(id,ownerUserId,authSessionId);
  if (expectedUrl !== undefined && (typeof expectedUrl !== 'string' || expectedUrl.length > 2048)) throw new Error('采集页面地址无效。');
  const project = await serialize(session,async () => {
    const page = session.page;
    const checkPage = () => {
      if (expectedUrl !== undefined && (session.pendingRedirect || session.page !== page || page.url() !== expectedUrl)) {
        throw new Error('网页已切换，请重新选择要修复的问题。');
      }
    };
    checkPage();
    await requireTargetPage(page);
    const cdp=await session.context.newCDPSession(page);
    try {
      await cdp.send('Page.setBypassCSP',{enabled:true});
      await page.addScriptTag({ path:path.join(ROOT,'node_modules/axe-core/axe.min.js') });
      await page.addScriptTag({ path:path.join(ROOT,'apps/api/capture-page.js') });
      const imageUrls = await page.evaluate(() => [...new Set(Array.from(document.images, image => image.currentSrc))].filter(Boolean).slice(0,600));
      const archivedImages: Record<string,string> = Object.create(null);
      let imageBudget = 600_000;
      for (const url of imageUrls) {
        const asset = session.replay.get(hash(url.split('#')[0]));
        const type = asset?.type.split(';')[0].toLowerCase();
        if (!asset || !type || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(type) || asset.body.length > 400_000) continue;
        const data = 'data:' + type + ';base64,' + asset.body;
        if (data.length > imageBudget) continue;
        archivedImages[url] = data;
        imageBudget -= data.length;
      }
      const captured = await page.evaluate(async images => {
        const capture = (globalThis as typeof globalThis & {a11yStudioCapture?:(images:Record<string,string>)=>Promise<Record<string,unknown>>}).a11yStudioCapture;
        if (!capture) throw new Error('无障碍页面采集脚本未能启动。');
        return capture(images);
      }, archivedImages).catch((error: Error) => {
        const captureError = error.message.match(/^(?:page\.evaluate: )?(?:Error: )?((?:精简图片和样式后，页面副本仍超过 4 MB|页面元素超过 8000 个|无障碍页面采集脚本未能启动)[^\r\n]*?)(?:\s+at\s|\r?\n|$)/);
        throw new Error(captureError?.[1] ?? '保存网页副本失败，请重试。');
      });
      const dimensions = await page.evaluate(() => ({ width:document.documentElement.scrollWidth, height:document.documentElement.scrollHeight }));
      const mask = [page.locator('input[type="password"],input[type="email"],input[type="tel"],input[type="file"]')];
      let screenshot:Uint8Array = new Uint8Array(), screenshotFullPage = false;
      if (dimensions.width <= 12000 && dimensions.height <= 12000 && dimensions.width * dimensions.height <= 60_000_000) {
        try {
          screenshot = await page.screenshot({ type:'png', fullPage:true, timeout:20000, animations:'disabled', mask });
          screenshotFullPage = screenshot.length <= 4_000_000;
        } catch { screenshotFullPage=false; }
      }
      if (!screenshotFullPage) screenshot = await page.screenshot({ type:'png', timeout:15000, animations:'disabled', mask });
      if (screenshot.length > 4_000_000) throw new Error('当前页面截图体积过大，请缩小页面内容后再采集。');
      const violations = Array.isArray(captured.violations) ? captured.violations : [];
      const limitations = Array.isArray(captured.limitations) ? captured.limitations.map(String).slice(0,18) : [];
      if (!screenshotFullPage) limitations.push('完整页面截图超出采集尺寸或文件大小限制；原始证据保存为当前可视区域。');
      const payload = { ...captured, screenshot:'data:image/png;base64,'+Buffer.from(screenshot).toString('base64'), screenshotFullPage,
        viewport:{width:VIEWPORT.width,height:VIEWPORT.height}, violations:violations.slice(0,300), limitations:limitations.slice(0,20) };
      if (Buffer.byteLength(JSON.stringify(payload)) > 10_500_000) throw new Error('当前页面采集结果过大，请减少页面内容后再试。');
      await requireTargetPage(page);
      checkPage();
      const project = await importBrowserCaptureData(payload,ownerUserId);
      const entry = session.replayDocuments.get(page);
      if (entry) {
        const directory=path.join(DATA,'browser-replays');
        try {
          fs.mkdirSync(directory,{recursive:true,mode:0o700});
          fs.writeFileSync(path.join(directory,project.id+'.json'),JSON.stringify({version:1,entry:entry.url,entryKey:entry.key,resources:Object.fromEntries(session.replay)}),{mode:0o600});
        } catch (error) { console.warn('动态回放资源保存失败:',(error as Error).message); }
      }
      return project;
    } finally {
      await cdp.send('Page.setBypassCSP',{enabled:false}).catch(()=>{});
      await cdp.detach().catch(()=>{});
    }
  });
  await closeSession(session);
  return project;
}

export async function closeManagedBrowserSession(id: string, ownerUserId: string, authSessionId: string) {
  const session = ownedSession(id,ownerUserId,authSessionId);
  await closeSession(session);
}

export function closeManagedCaptureSessionsForAuth(authSessionId: string) {
  for (const session of sessions.values()) if (session.authSessionId === authSessionId) void closeSession(session);
}
