import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';import path from 'node:path';import {chromium,type Browser,type Page} from 'playwright-core';import * as cheerio from 'cheerio';
import {db,id,now,hash,DATA,safePath,snapshotDir,snapshot,audit} from './storage';
import { buildReactProject, isReactProject, originAttribute, sourceSelector, type SourceLocation } from './project-build';
import { scanRules } from './scan-rules';
import { scanBehavior, unavailableBehavior } from './scan-behavior';
import type { BehaviorAudit, DetectionEvidence } from '../../packages/shared/types';

let activeScans=0;const MAX_SCANS=2;
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2'};
export function sanitizedHtml(source:string){const $=cheerio.load(source);$('script,iframe,object,embed,base,meta[http-equiv]').remove();$('*').each((_,el)=>{for(const attr of Object.keys((el as any).attribs||{}))if(/^on/i.test(attr)||['srcdoc','formaction'].includes(attr.toLowerCase())||(/^(href|src|action)$/i.test(attr)&&/^\s*javascript:/i.test($(el).attr(attr)||'')))$(el).removeAttr(attr)});return $.html();}
function executable(){ const candidates=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].filter(Boolean) as string[];return candidates.find(x=>fs.existsSync(x));}
export function withSnapshotPage<T>(projectId: string, snapshotId: string, signal: AbortSignal | undefined, inspect: (page: Page) => Promise<T>, waitForSlotMs = 6000) {
 const snap = snapshot(projectId, snapshotId);
 return withRepairPage(snapshotDir(projectId, snapshotId), snap.entry, signal, inspect, waitForSlotMs);
}

export type ResourceFailure = { type: string; path: string; reason: string; status?:number };
export async function withRepairPage<T>(dir: string, entry: string, signal: AbortSignal | undefined, inspect: (page: Page, product: Awaited<ReturnType<typeof buildReactProject>> | undefined, resources: ResourceFailure[]) => Promise<T>, waitForSlotMs = 6000, isolated = false) {
 let browser: Browser | undefined;
 const closeBrowser = () => { void browser?.close().catch(() => {}); };
 const engineering = isReactProject(dir);
 const deadline = Date.now() + waitForSlotMs;
 const localSignal = (engineering || isolated) ? AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(35000)]) : signal;
 // Preview and evidence requests can briefly occupy both browsers during patch review.
 while (activeScans >= MAX_SCANS && Date.now() < deadline) await delay(100, undefined, {signal});
 if (activeScans >= MAX_SCANS) throw new Error('扫描任务过多，请稍后再试。');
 try {
  activeScans++;
  if(signal?.aborted)throw new Error('任务已取消。');
  const product=engineering ? await buildReactProject(dir,entry) : undefined;
  localSignal?.throwIfAborted();
  const exe=executable();if(!exe)throw new Error('未找到 Chromium 或 Chrome，请设置 CHROME_PATH。');
  browser=await chromium.launch({executablePath:exe,headless:true,
    ...((engineering || isolated)?{chromiumSandbox:true,args:['--disable-quic','--no-proxy-server','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND']}:{}),
  });localSignal?.throwIfAborted();localSignal?.addEventListener('abort', closeBrowser, { once:true });const context=await browser.newContext({viewport:{width:900,height:700},deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
  if(product || isolated){
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.addInitScript(()=>{
      for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])Object.defineProperty(window,name,{value:undefined});
    });
    context.on('page',page=>page.on('popup',popup=>{void popup.close();}));
    if (isolated) await context.addInitScript(() => {
      document.addEventListener('submit', event => event.preventDefault(), true);
    });
  }
  await context.route('**/*',async(route)=>{
    const req=route.request(),u=new URL(req.url());
    if(u.origin!=='http://a11y.local'||req.method()!=='GET')return route.abort();
    try {
      const requested=decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const relative=isolated && !requested ? entry : requested;
      const output=product?.files.get(relative);
      const headers={'Cache-Control':'no-store','X-DNS-Prefetch-Control':'off','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':`default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src ${product?"'self'":"'none'"}; frame-src 'none'; worker-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`};
      if(output)return route.fulfill({status:200,contentType:output.type,body:output.body,headers});
      if(req.resourceType()==='script'||(product&&!/\.(?:png|jpe?g|webp|gif|css|woff2?)$/i.test(relative)))return route.abort();
      let file=safePath(dir,relative);
      if(product&&!fs.existsSync(file))file=safePath(dir,'public/'+relative);
      const ext=path.extname(file).toLowerCase();
      if (mime[ext] && ['image','stylesheet','font'].includes(req.resourceType()) && !fs.existsSync(file)) {
        recordResource(req, 404);
        return route.fulfill({status:404,contentType:mime[ext],body:'',headers});
      }
      if(!mime[ext]||!fs.realpathSync(file).startsWith(fs.realpathSync(dir)+path.sep)||!fs.statSync(file).isFile())return route.abort();
      let body:Buffer|string=fs.readFileSync(file);
      if(ext==='.html'||ext==='.htm')body=sanitizedHtml(body.toString('utf8'));
      return route.fulfill({status:200,contentType:mime[ext],body,headers});
    }catch{return route.abort();}
  });
  const page=await context.newPage();
  const resources: ResourceFailure[] = [];
  function recordResource(request: import('playwright-core').Request, status?: number) {
    const type = request.resourceType();
    if (!['image','stylesheet','font'].includes(type) || resources.length >= 30) return;
    const url = new URL(request.url());
    const file = url.origin === 'http://a11y.local' ? url.pathname : url.origin;
    const reason = status === 404 ? '本地快照缺少关联资源。请将 HTML、图片和 CSS 按原路径一起打包为 ZIP 后重新导入。' :
      url.origin === 'http://a11y.local' ? '本地资源格式不受支持或请求被阻止' : '隔离浏览器禁止请求外部资源';
    if (!resources.some(item => item.path === file && item.type === type)) resources.push({type, path:file, reason, status});
  }
  page.on('requestfailed', request => recordResource(request));
  page.on('response', response => { if (response.status() >= 400) recordResource(response.request(), response.status()); });
  const response=await page.goto('http://a11y.local/'+entry.split('/').map(encodeURIComponent).join('/'),{waitUntil:'load',timeout:15000});
  if (!response?.ok()) throw new Error('浏览器未成功加载项目入口。');
  if(product)await page.locator(`[${originAttribute}]`).first().waitFor({state:'attached',timeout:5000});
  return await inspect(page,product,resources);
 } finally {
  localSignal?.removeEventListener('abort', closeBrowser);
  try { await browser?.close(); } finally { activeScans--; }
 }
}

export async function inspectAuditElement(projectId: string, auditId: string, selector: string, signal?: AbortSignal) {
 const record = audit(auditId);
 if (record.project_id !== projectId || record.status !== 'completed') throw new Error('没有可用的扫描证据。');
 return withSnapshotPage(projectId, record.snapshot_id, signal, page => inspectPageElement(page, selector, record.result.size));
}

export async function inspectPageElement(page: Page, selector: string, screenshotSize?: {width:number;height:number}) {
  const session = await page.context().newCDPSession(page);
  const { root } = await session.send('DOM.getDocument');
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  if (nodeIds.length !== 1) throw new Error('扫描版本中无法唯一定位目标元素。');
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId: nodeIds[0], fetchRelatives: false });
  const node = nodes[0];
  if (!node) throw new Error('浏览器未返回目标元素的语义证据。');
  const properties = node.properties ?? [];

  const renderedSize = await page.evaluate(() => ({
   width: document.documentElement.scrollWidth,
   height: document.documentElement.scrollHeight,
  }));
  const size = screenshotSize ?? renderedSize;
  const matchesScreenshot = size.width === renderedSize.width && size.height === renderedSize.height;
  const reportedStates = new Set(['disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'invalid', 'readonly', 'busy', 'multiselectable', 'hasPopup', 'level']);
  return {
   role: typeof node.role?.value === 'string' ? node.role.value : null,
   name: typeof node.name?.value === 'string' ? node.name.value : '',
   description: typeof node.description?.value === 'string' ? node.description.value : '',
   ignored: node.ignored,
   ignoredReasons: node.ignoredReasons?.map(reason => reason.name) ?? [],
   focusable: properties.find(property => property.name === 'focusable')?.value.value === true,
   states: properties.filter(property => reportedStates.has(property.name)).map(property => [property.name, String(property.value.value)]),
   bounds: matchesScreenshot ? await page.locator(selector).boundingBox({ timeout: 1500 }) : null,
   size,
  };
}

export function runAudit(projectId:string,snapshotId:string,signal?:AbortSignal,contrastSelector?:string) {
 const {entry} = snapshot(projectId, snapshotId);
 return scanDirectory(projectId, snapshotId, snapshotDir(projectId, snapshotId), entry, true, signal, contrastSelector);
}

export function auditCandidate(projectId: string, snapshotId: string, dir: string, entry: string, signal?: AbortSignal, contrastSelector?: string, captureRegression = false) {
 return scanDirectory(projectId, snapshotId, dir, entry, false, signal, contrastSelector, captureRegression);
}

async function scanDirectory(projectId: string, snapshotId: string, dir: string, entry: string, persist: boolean, signal?: AbortSignal, contrastSelector?: string, captureRegression = false) {
 const auditId=id(),created=now();
 if(persist) db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(auditId,projectId,snapshotId,'running',null,null,created);
 try {
  return await withRepairPage(dir, entry, signal, async (page,product,resourceFailures) => {
  const location = async (selector:string) => {
    if(!product||!selector)return undefined;
    try {
      const target=page.locator(selector);
      if(await target.count()!==1)return undefined;
      const key=await target.getAttribute(originAttribute,{timeout:1000});
      if(key&&/^[a-f0-9]{20}$/.test(key)&&await page.locator(sourceSelector(key)).count()===1){
        const source=product.sources.get(key);
        if(source&&await target.evaluate(node=>node.localName)===source.tag)return source;
      }
    } catch { /* Unsupported selectors remain visible without a source link. */ }
  };
  const regression = captureRegression ? await capturePageRegression(page, signal) : null;
  const rulesStarted = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const results = await Promise.race([
   scanRules(page),
   new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('扫描超时。')), 30000);
    timeout.unref();
   }),
  ]).finally(() => clearTimeout(timeout));
  const rulesMs = performance.now() - rulesStarted;
  const issues=[];for(const violation of results.violations)for(const node of violation.nodes){const selector=typeof node.target[0]==='string'?node.target[0]:'';let bounds=null;try {const box=selector?await page.locator(selector).first().boundingBox({timeout:1500}):null;if(box)bounds=box;}catch{} issues.push({id:hash(violation.id+'|'+selector).slice(0,20),ruleId:violation.id,selector,impact:violation.impact||'unknown',help:violation.help,description:violation.description,helpUrl:violation.helpUrl,html:node.html,wcag:violation.tags.filter((t:string)=>/^wcag\d/.test(t)),bounds,source:await location(selector)});}
  const functionChecks=await page.evaluate(()=>{const controls=Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]'));if(controls.length>2000)throw new Error('交互控件超过检测上限。');return controls.map((el,index)=>{
    const style=getComputedStyle(el),visible=style.display!=='none'&&style.visibility!=='hidden'&&el.getClientRects().length>0,disabled=el.hasAttribute('disabled');let focusable=false;
    if(visible&&!disabled&&el.tabIndex>=0){el.focus({preventScroll:true});focusable=document.activeElement===el;el.blur();}
    return {index,tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),href:el.getAttribute('href'),tabIndex:el.tabIndex,disabled,visible,focusable};
  });});
  const contrastCheck=contrastSelector?await measurePageContrast(page,contrastSelector):null;
  const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));if(size.width>5000||size.height>10000)throw new Error('页面尺寸超过扫描限制。');if(persist){fs.mkdirSync(path.join(DATA,'screenshots'),{recursive:true});await page.screenshot({path:path.join(DATA,'screenshots',auditId+'.png'),fullPage:true,timeout:10000});}
  // Leave the existing screenshot and repair regression signature independent of the Tab probe.
  const behaviorStarted = performance.now();
  let behavior: BehaviorAudit;
  let behaviorTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const inspect = async () => {
    await page.reload({ waitUntil: 'load', timeout: 5000 });
    if(product)await page.locator(`[${originAttribute}]`).first().waitFor({state:'attached',timeout:5000});
    return scanBehavior(page, signal);
   };
   behavior = await Promise.race([
    inspect(),
    new Promise<never>((_, reject) => {
     behaviorTimeout = setTimeout(() => reject(new Error('行为检测超时。')), 13000);
     behaviorTimeout.unref();
    }),
   ]);
  } catch {
   signal?.throwIfAborted();
   behavior = unavailableBehavior();
  } finally {
   clearTimeout(behaviorTimeout);
  }
  const { engine, violations, incomplete, bestPractices, passes } = results;
  const timing = { rulesMs, behaviorMs: performance.now() - behaviorStarted };
  const detection: DetectionEvidence = { schemaVersion: 2, engine, timing, violations, incomplete, bestPractices, behavior };
  const sourceLocations:Record<string,SourceLocation>={};
  if(product)for(const finding of behavior.findings.filter(item=>item.ruleId==='focus-style-unchanged')){
    const source=await location(finding.selector);if(source)sourceLocations[finding.selector]=source;
  }
  const result={...(product?{build:{tool:'esbuild',milliseconds:product.milliseconds},sourceLocations}:{}),id:auditId,projectId,snapshotId,status:'completed',issues,incomplete:incomplete.map(x=>({ruleId:x.id,help:x.help,count:x.nodes.length})),passes,functionChecks,contrastCheck,regression,resourceFailures,screenshot:`/api/audits/${auditId}/screenshot`,size,createdAt:created,detection};
  if(persist) db.prepare('UPDATE audits SET status=?,result=? WHERE id=?').run('completed',JSON.stringify(result),auditId);return result;
  }, 6000);
 } catch(error){const message=(error as Error).message;if(persist) db.prepare('UPDATE audits SET status=?,error=? WHERE id=?').run('failed',message,auditId);throw error;}
}

async function capturePageRegression(page: Page, signal?: AbortSignal) {
 const captures = [];
 for (const width of [900, 390]) {
  signal?.throwIfAborted();
  await page.setViewportSize({width,height:700});
  const size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
  if (size[0] > 2500 || size[1] > 5000) throw new Error('关联页面截图超出安全复测范围，请手动检查。');
  const style = await page.evaluate(() => {
   const elements = Array.from(document.querySelectorAll('*'));
   if (elements.length > 5000) throw new Error('关联页面元素过多，请人工检查。');
   const properties = ['color','background-color','background-image','opacity','visibility','display',
    'font-size','font-family','font-weight','outline','outline-offset','box-shadow','content','transform'];
   return elements.map(el => {
    const bounds = el.getBoundingClientRect();
    return [el.localName, ...[bounds.x,bounds.y,bounds.width,bounds.height].map(n=>Math.round(n*100)/100),
      ...[null,'::before','::after'].flatMap(pseudo => {
        const computed = getComputedStyle(el,pseudo);
        return properties.map(prop=>computed.getPropertyValue(prop));
      })];
   });
  });
  captures.push({
   width,
   style: hash(JSON.stringify([size,style])),
   semantics: await page.locator('body').ariaSnapshot({timeout:3000}),
   visual: hash(await page.screenshot({fullPage:true,animations:'disabled',caret:'hide',timeout:8000})),
  });
 }
 await page.setViewportSize({width:900,height:700});
 return captures;
}

export async function measurePageContrast(page: Page, selector: string) {
  try {return await page.locator(selector).evaluate((el:Element)=>{
    // Method syntax survives tsx serialization without references to its __name helper.
    const colors = {
      parse(s: string) {
        const m = s.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
        return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
      },
      blend(f: number[], b: number[]) { return [0, 1, 2].map(i => f[i] * f[3] + b[i] * (1 - f[3])); },
      luminance(rgb: number[]) {
        return rgb.map(c => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }).reduce((x, c, i) => x + c * [0.2126, 0.7152, 0.0722][i], 0);
      },
    };
    const styles=getComputedStyle(el),fg=colors.parse(styles.color);let background=[255,255,255];let uncertain=!fg;const layers:number[][]=[];
    for(let n:Element|null=el;n;n=n.parentElement){const st=getComputedStyle(n);if(st.backgroundImage!=='none'||Number(st.opacity)<1)uncertain=true;const color=colors.parse(st.backgroundColor);if(color)layers.push(color);else uncertain=true;}
    for(let i=layers.length-1;i>=0;i--)background=colors.blend(layers[i],background);
    const foreground=fg?colors.blend(fg,background):background;
    const a=colors.luminance(foreground),b=colors.luminance(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);const size=parseFloat(styles.fontSize),weight=parseInt(styles.fontWeight,10);const required=(size>=24||(size>=18.66&&weight>=700))?3:4.5;
    return {ratio,required,uncertain,foreground:styles.color,effectiveBackground:background.map(Math.round),valid:!uncertain&&ratio>=required&&styles.display!=='none'&&styles.visibility!=='hidden'};
   },{timeout:1500});}catch{return {ratio:0,required:4.5,valid:false,uncertain:true};}
}
