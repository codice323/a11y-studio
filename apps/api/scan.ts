import fs from 'node:fs';import path from 'node:path';import {chromium,type Browser,type Page} from 'playwright-core';import * as cheerio from 'cheerio';
import {db,id,now,hash,DATA,safePath,snapshotDir,snapshot,audit} from './storage';
import { scanRules } from './scan-rules';
import { scanBehavior, unavailableBehavior } from './scan-behavior';
import type { BehaviorAudit, DetectionEvidence } from '../../packages/shared/types';

let activeScans=0;const MAX_SCANS=2;
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
export function sanitizedHtml(source:string){const $=cheerio.load(source);$('script,iframe,object,embed,base,meta[http-equiv]').remove();$('*').each((_,el)=>{for(const attr of Object.keys((el as any).attribs||{}))if(/^on/i.test(attr)||['srcdoc','formaction'].includes(attr.toLowerCase())||(/^(href|src|action)$/i.test(attr)&&/^\s*javascript:/i.test($(el).attr(attr)||'')))$(el).removeAttr(attr)});return $.html();}
function executable(){ const candidates=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].filter(Boolean) as string[];return candidates.find(x=>fs.existsSync(x));}
export async function withSnapshotPage<T>(projectId: string, snapshotId: string, signal: AbortSignal | undefined, inspect: (page: Page) => Promise<T>) {
 const snap = snapshot(projectId, snapshotId);
 const dir = snapshotDir(projectId, snapshotId);
 let browser: Browser | undefined;
 const closeBrowser = () => { void browser?.close().catch(() => {}); };
 if (activeScans >= MAX_SCANS) throw new Error('扫描任务过多，请稍后再试。');
 try {
  activeScans++;
  if(signal?.aborted)throw new Error('任务已取消。');
  const exe=executable();if(!exe)throw new Error('未找到 Chromium 或 Chrome，请设置 CHROME_PATH。');
  browser=await chromium.launch({executablePath:exe,headless:true});if(signal?.aborted)throw new Error('任务已取消。');signal?.addEventListener('abort', closeBrowser, { once:true });const context=await browser.newContext({viewport:{width:900,height:700},deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
  await context.route('**/*',async(route)=>{const req=route.request();const u=new URL(req.url());if(u.hostname!=='a11y.local'||!['http:'].includes(u.protocol)||req.resourceType()==='script'||req.method()!=='GET')return route.abort();
    try {const relative=decodeURIComponent(u.pathname).replace(/^\/+/, '');const file=safePath(dir,relative);const ext=path.extname(file).toLowerCase();if(!mime[ext]||!fs.statSync(file).isFile())return route.abort();let body:Buffer|string=fs.readFileSync(file);if(ext==='.html'||ext==='.htm')body=sanitizedHtml(body.toString('utf8'));await route.fulfill({status:200,contentType:mime[ext],body,headers:{'Cache-Control':'no-store','X-DNS-Prefetch-Control':'off','Content-Security-Policy':"default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'none'; script-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"}});
    } catch {await route.abort();}});
  const page=await context.newPage();await page.goto('http://a11y.local/'+snap.entry.split('/').map(encodeURIComponent).join('/'),{waitUntil:'load',timeout:15000});
  return await inspect(page);
 } finally {
  signal?.removeEventListener('abort', closeBrowser);
  try { await browser?.close(); } finally { activeScans--; }
 }
}

export async function inspectAuditElement(projectId: string, auditId: string, selector: string, signal?: AbortSignal) {
 const record = audit(auditId);
 if (record.project_id !== projectId || record.status !== 'completed') throw new Error('没有可用的扫描证据。');
 return withSnapshotPage(projectId, record.snapshot_id, signal, async page => {
  const session = await page.context().newCDPSession(page);
  const { root } = await session.send('DOM.getDocument');
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  if (nodeIds.length !== 1) throw new Error('扫描版本中无法唯一定位目标元素。');
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { nodeId: nodeIds[0], fetchRelatives: false });
  const node = nodes[0];
  if (!node) throw new Error('浏览器未返回目标元素的语义证据。');
  const properties = node.properties ?? [];
  const size = record.result.size;
  const renderedSize = await page.evaluate(() => ({
   width: document.documentElement.scrollWidth,
   height: document.documentElement.scrollHeight,
  }));
  const matchesScreenshot = size?.width === renderedSize.width && size?.height === renderedSize.height;
  const reportedStates = new Set(['disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'invalid', 'readonly', 'busy', 'multiselectable', 'hasPopup', 'level']);
  return {
   role: typeof node.role?.value === 'string' ? node.role.value : null,
   name: typeof node.name?.value === 'string' ? node.name.value : '',
   ignored: node.ignored,
   ignoredReasons: node.ignoredReasons?.map(reason => reason.name) ?? [],
   focusable: properties.find(property => property.name === 'focusable')?.value.value === true,
   states: properties.filter(property => reportedStates.has(property.name)).map(property => [property.name, String(property.value.value)]),
   bounds: matchesScreenshot ? await page.locator(selector).boundingBox({ timeout: 1500 }) : null,
   size,
  };
 });
}

export async function runAudit(projectId:string,snapshotId:string,signal?:AbortSignal,contrastSelector?:string) {
 const auditId=id(),created=now();
 db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(auditId,projectId,snapshotId,'running',null,null,created);
 try {
  return await withSnapshotPage(projectId, snapshotId, signal, async page => {
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
  const issues=[];for(const violation of results.violations)for(const node of violation.nodes){const selector=typeof node.target[0]==='string'?node.target[0]:'';let bounds=null;try {const box=selector?await page.locator(selector).first().boundingBox({timeout:1500}):null;if(box)bounds=box;}catch{} issues.push({id:hash(violation.id+'|'+selector).slice(0,20),ruleId:violation.id,selector,impact:violation.impact||'unknown',help:violation.help,description:violation.description,helpUrl:violation.helpUrl,html:node.html,wcag:violation.tags.filter((t:string)=>/^wcag\d/.test(t)),bounds});}
  const functionChecks=await page.evaluate(()=>{const controls=Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]'));if(controls.length>2000)throw new Error('交互控件超过检测上限。');return controls.map((el,index)=>{
    const style=getComputedStyle(el),visible=style.display!=='none'&&style.visibility!=='hidden'&&el.getClientRects().length>0,disabled=el.hasAttribute('disabled');let focusable=false;
    if(visible&&!disabled&&el.tabIndex>=0){el.focus({preventScroll:true});focusable=document.activeElement===el;el.blur();}
    return {index,tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),href:el.getAttribute('href'),tabIndex:el.tabIndex,disabled,visible,focusable};
  });});
  let contrastCheck:null|{ratio:number;required:number;valid:boolean;uncertain:boolean}=null;
  if(contrastSelector){try{contrastCheck=await page.locator(contrastSelector).first().evaluate((el:Element)=>{
    const parse=(s:string)=>{const m=s.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]]:null;};
    const blend=(f:number[],b:number[])=>[0,1,2].map(i=>f[i]*f[3]+b[i]*(1-f[3]));
    const styles=getComputedStyle(el),fg=parse(styles.color);let background=[255,255,255];let uncertain=!fg;const layers:number[][]=[];
    for(let n:Element|null=el;n;n=n.parentElement){const st=getComputedStyle(n);if(st.backgroundImage!=='none'||Number(st.opacity)<1)uncertain=true;const color=parse(st.backgroundColor);if(color)layers.push(color);else uncertain=true;}
    for(let i=layers.length-1;i>=0;i--)background=blend(layers[i],background);
    const foreground=fg?blend(fg,background):background;
    const lum=(rgb:number[])=>rgb.map(c=>{const v=c/255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)}).reduce((x,c,i)=>x+c*[0.2126,0.7152,0.0722][i],0);
    const a=lum(foreground),b=lum(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);const size=parseFloat(styles.fontSize),weight=parseInt(styles.fontWeight,10);const required=(size>=24||(size>=18.66&&weight>=700))?3:4.5;
    return {ratio,required,uncertain,valid:!uncertain&&ratio>=required&&styles.display!=='none'&&styles.visibility!=='hidden'};
   },{timeout:1500});}catch{contrastCheck={ratio:0,required:4.5,valid:false,uncertain:true};}}
  const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));if(size.width>5000||size.height>10000)throw new Error('页面尺寸超过扫描限制。');fs.mkdirSync(path.join(DATA,'screenshots'),{recursive:true});await page.screenshot({path:path.join(DATA,'screenshots',auditId+'.png'),fullPage:true,timeout:10000});
  // Leave the existing screenshot and repair regression signature independent of the Tab probe.
  const behaviorStarted = performance.now();
  let behavior: BehaviorAudit;
  let behaviorTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const inspect = async () => {
    await page.reload({ waitUntil: 'load', timeout: 5000 });
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
  const result={id:auditId,projectId,snapshotId,status:'completed',issues,incomplete:incomplete.map(x=>({ruleId:x.id,help:x.help,count:x.nodes.length})),passes,functionChecks,contrastCheck,screenshot:`/api/audits/${auditId}/screenshot`,size,createdAt:created,detection};
  db.prepare('UPDATE audits SET status=?,result=? WHERE id=?').run('completed',JSON.stringify(result),auditId);return result;
  });
 } catch(error){const message=(error as Error).message;db.prepare('UPDATE audits SET status=?,error=? WHERE id=?').run('failed',message,auditId);throw error;}
}
