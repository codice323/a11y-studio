import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { requireTargetPage } from './page-diagnostics';
import { DATA, db, snapshot, hash } from './storage';

type Patch = {selector:string;operation:'set-alt'|'set-label'|'set-name'|'set-color';value:string};
type Archive = {version:number;entry:string;entryKey:string;resources:Record<string,{type:string;body:string}>};
const replayArchives = new WeakMap<Page, Archive>();

export class UncapturedReplayPage extends Error {
  constructor(readonly url:string) {
    super('这个链接页面尚未采集。');
  }
}

export function replayLink(page:Page,href:string,download:boolean,newTab:boolean) {
  const archive = replayArchives.get(page);
  if (!archive) return;
  const current = new URL(page.url());
  const original = new URL(archive.entry);
  const destination = new URL(href,current);
  if (download || !['http:','https:'].includes(destination.protocol) || destination.username || destination.password ||
      ![current.origin,original.origin].includes(destination.origin)) {
    throw new Error('此链接超出当前回放范围。');
  }
  if (destination.origin===current.origin && !newTab && destination.pathname===current.pathname && destination.search===current.search) return;
  const fragment = destination.hash;
  destination.hash='';
  const originalDestination = new URL(original.origin);
  originalDestination.pathname = destination.pathname;
  originalDestination.search = destination.search;
  const key = hash(originalDestination.href);
  if (!archive.resources[key]?.type.match(/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i)) {
    originalDestination.hash = fragment;
    throw new UncapturedReplayPage(originalDestination.href);
  }
  if (destination.origin===current.origin && !newTab) return;
  return current.origin+destination.pathname+destination.search+fragment;
}

export function replayAvailable(projectId:string) {
  return fs.existsSync(path.join(DATA,'browser-replays',projectId+'.json'));
}

function patchesFor(projectId:string,version:string):Patch[] {
  const patches:Patch[]=[];
  let current:string|null=version;
  while(current) {
    const record=snapshot(projectId,current);
    if(!record.parent_id) break;
    const rows=db.prepare("SELECT data FROM verifications WHERE project_id=? AND status='passed' ORDER BY rowid DESC").all(projectId) as {data:string}[];
    const verification=rows.map(row=>JSON.parse(row.data)).find(item=>item.toSnapshot===current);
    const patch=verification?.patch;
    if(!patch || !['set-alt','set-label','set-name','set-color'].includes(patch.operation) || typeof patch.selector!=='string' || typeof patch.value!=='string') {
      throw new Error('此版本包含无法在动态回放中验证的修改，请使用静态版本对比。');
    }
    const targets:Pick<Patch,'selector'|'value'>[] = patch.contrastTargets ?? [patch];
    patches.unshift(...targets.map(target=>({selector:target.selector,operation:patch.operation,value:target.value})));
    current=record.parent_id;
  }
  return patches;
}

export async function withReplayPage<T>(projectId:string,version:string,signal:AbortSignal,inspect:(page:Page)=>Promise<T>,onMissing?:(type:string,url:string)=>void) {
  const archive=JSON.parse(fs.readFileSync(path.join(DATA,'browser-replays',projectId+'.json'),'utf8')) as Archive;
  if(archive.version!==1 || !archive.resources[archive.entryKey]) throw new Error('动态回放资源不完整，请重新采集网页。');
  const patches=patchesFor(projectId,version);
  const original=new URL(archive.entry);
  const executable=[process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(item=>item && fs.existsSync(item));
  if(!executable)throw new Error('未找到 Chromium 或 Chrome，请设置 CHROME_PATH。');
  const browser=await chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true,args:['--disable-quic','--no-proxy-server','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--host-resolver-rules=MAP * ~NOTFOUND']});
  const close=()=>{void browser.close().catch(()=>{});};
  signal.addEventListener('abort',close,{once:true});
  try {
    signal.throwIfAborted();
    const context=await browser.newContext({viewport:{width:1280,height:820},serviceWorkers:'block',acceptDownloads:false});
    await context.routeWebSocket('**/*',socket=>socket.close());
    context.on('page',page=>page.on('popup',popup=>{void popup.close();}));
    await context.addInitScript({content:`(() => {
      const changes=${JSON.stringify(patches)};
      for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(window,name,{value:undefined});
      document.addEventListener('submit',event=>event.preventDefault(),true);
      const apply=()=>{
        const desired=new Map();
        for(const patch of changes) {
          let matches;
          try {matches=document.querySelectorAll(patch.selector);} catch {continue;}
          if(matches.length!==1)continue;
          const element=matches[0];
          const property=patch.operation==='set-color'?'color':patch.operation==='set-alt'?'alt':'aria-label';
          if(!desired.has(element)) desired.set(element,new Map());
          desired.get(element).set(property,patch.value);
        }
        for(const [element,properties] of desired) {
          for(const [property,value] of properties) {
            if(property==='color') {
              const probe=document.createElement('span');probe.style.color=value;
              if(element.style.getPropertyValue('color')!==probe.style.color || element.style.getPropertyPriority('color')!=='important') element.style.setProperty('color',value,'important');
            } else if(element.getAttribute(property)!==value) element.setAttribute(property,value);
          }
        }
      };
      new MutationObserver(apply).observe(document,{subtree:true,childList:true,attributes:true});
      document.addEventListener('DOMContentLoaded',apply,{once:true});
    })();`});
    let requests=0;
    await context.route('**/*',async route=>{
      const req=route.request();
      if(++requests>1200 || req.method()!=='GET') return route.abort();
      const url=new URL(req.url());
      if(req.isNavigationRequest() && url.origin!=='http://a11y.local') return route.fulfill({status:204});
      let key=hash(url.href);
      if(url.origin==='http://a11y.local') key=url.pathname===original.pathname && url.search===original.search ? archive.entryKey : hash(new URL(url.pathname+url.search,original.origin).href);
      let resource=archive.resources[key];
      // Protocol-relative asset URLs inherit the replay origin's HTTP scheme. The
      // original HTTPS page requested the same asset over HTTPS during capture.
      if(!resource && url.protocol==='http:' && url.origin!=='http://a11y.local') {
        const secure=new URL(url.href);secure.protocol='https:';
        resource=archive.resources[hash(secure.href)];
      }
      if(!resource) {
        onMissing?.(req.resourceType(),url.origin+url.pathname);
        return req.isNavigationRequest() ? route.fulfill({status:204}) : route.abort();
      }
      let body=Buffer.from(resource.body,'base64');
      let contentType=resource.type;
      if(key===archive.entryKey && req.isNavigationRequest()) {
        const base='http://a11y.local'+original.pathname.replace(/[^/]*$/,'');
        const charset=resource.type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ??
          body.subarray(0,1024).toString('latin1').match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8';
        let decoder:TextDecoder;
        try {decoder=new TextDecoder(charset);} catch {decoder=new TextDecoder();}
        const html=decoder.decode(body).replace(/<base\b[^>]*>/gi,'').replace(/<head(\s[^>]*)?>/i,match=>match+'<base href="'+base+'">');
        body=Buffer.from(html);
        contentType=resource.type.split(';')[0]+'; charset=utf-8';
      }
      return route.fulfill({status:200,body,headers:{'content-type':contentType,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src data: http: https:; font-src data: http: https:; connect-src http: https:; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri http://a11y.local"}});
    });
    const page=await context.newPage();
    replayArchives.set(page,archive);
    await page.goto('http://a11y.local'+original.pathname+original.search,{waitUntil:'load',timeout:15000});
    await requireTargetPage(page);
    if(patches.length) {
      const missing=await page.evaluate((changes:Patch[])=>changes.some(patch=>{
        try {return document.querySelectorAll(patch.selector).length!==1;} catch {return true;}
      }),patches);
      if(missing)throw new Error('动态回放中无法唯一定位修复目标，请使用静态版本对比。');
    }
    return await inspect(page);
  } finally {signal.removeEventListener('abort',close);await browser.close().catch(()=>{});}
}
