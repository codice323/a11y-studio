import { once } from 'node:events';
import { z } from 'zod';
import type { Locator, Page } from 'playwright-core';
import type { Control, PanoramaStep } from '../../packages/shared/panorama';
import type { LiveComparison, LiveFrame, LiveSide } from '../../packages/shared/live-comparison';
import { act, adoptLiveRecipe, controlsFor } from './panorama';
import { withRepairPage, type BrowserRequestEvidence, type ResourceFailure } from './scan';
import { createInteractionAudit, readInteractionState } from './interaction-audit';
import { scanRules } from './scan-rules';
import { db, hash, id, now, project as storedProject, snapshot, snapshotDir, walk } from './storage';
import { validSnapshots } from './version-state';

const localOrigin = 'http://a11y.local';
const sides = ['left','right'] as const;
const control = z.object({role:z.enum(['link','button','tab','textbox','combobox']),name:z.string().trim().min(1).max(100)});
const startInput = z.object({left:z.uuid(),right:z.uuid(),start:z.string().max(240).optional()});
const actionInput = z.object({side:z.enum(sides),sync:z.boolean(),revision:z.number().int().min(0), operation:z.union([
  z.object({action:z.literal('click'),x:z.number().int().min(0).max(899),y:z.number().int().min(0).max(699)}),
  z.object({action:z.enum(['click','fill','validate']),target:control}),
  z.object({action:z.enum(['activate','tab','shift-tab','escape','refresh'])}),
  z.object({action:z.literal('scroll'),delta:z.number().int().min(-1600).max(1600)}),
  z.object({action:z.literal('zoom'),percent:z.union([z.literal(75),z.literal(100),z.literal(125),z.literal(150)])}),
])});
const pathFor = (file:string) => '/' + file.split('/').map(encodeURIComponent).join('/');
const redact = (text:string) => text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d(?:[\d -]{7,})\d\b/gi,'[已隐藏]').replace(/a11y-test-invalid/g,'[测试输入]');
const risky = /支付|删除|发送|购买|付款|注销|下单|转账|提交订单|\b(?:pay|buy|delete|send|purchase|checkout|logout|transfer|order|unsubscribe)\b/i;
type Target = Control | {role:'summary';name:string};
type PageLease = {page:Page; start:string; mode:'source'|'snapshot'; resources:ResourceFailure[]; network:BrowserRequestEvidence[]};
type Session = {
  id:string; project:string; accountId:string; authSessionId:string; controller:AbortController; finished:Promise<unknown>[];
  pages:Partial<Record<LiveSide,PageLease>>; pending:boolean; revision:number;
  observations:LiveComparison['observations'];
  auditors:Record<LiveSide,ReturnType<typeof createInteractionAudit>>;
  journals:Record<LiveSide,PanoramaStep[]|null>;
  sequences:Record<LiveSide,string|null>;
  scans:Partial<Record<LiveSide,{id:string; revision:number; frame:string; selectors:Map<string,string>}>>;
  versions:Record<LiveSide,string>;
  frameKeys:Partial<Record<LiveSide,string>>;
  actions:NonNullable<LiveComparison['outcome']>[];
};
const sessions = new Map<string,Session>();

function lease(session:Session, side:LiveSide, dir:string, entry:string, start?:string) {
  const signal = session.controller.signal;
  return new Promise<void>((resolve,reject) => {
    const finished = withRepairPage(dir,entry,signal,async (page,_product,resources,network) => {
      page.setDefaultTimeout(2500);
      if (start && start !== entry) {
        if (!/\.html?$/i.test(start) || !walk(dir).includes(start)) throw new Error('该版本缺少所选 HTML 页面。');
        const response = await page.goto(localOrigin + pathFor(start),{waitUntil:'load',timeout:5000});
        if (!response?.ok()) throw new Error('所选页面加载失败。');
      }
      session.pages[side] = {page,resources,network,start:start ?? entry,mode:_product?'source':'snapshot'};
      session.sequences[side] = hash(start ?? entry);
      resolve();
      if (!signal.aborted) await once(signal,'abort');
    },3000,true,true).catch(error => {
      reject(error);
      if (!signal.aborted) session.controller.abort();
    });
    session.finished.push(finished);
  });
}

export async function startLive(project:string, input:unknown, accountId:string, authSessionId:string) {
  const {left,right,start} = startInput.parse(input);
  const versions = validSnapshots(project);
  const before = versions.find(version => version.id === left);
  const after = versions.find(version => version.id === right);
  if (!before || !after) throw new Error('只能对比本项目的有效版本。');
  if (sessions.size >= 2 || [...sessions.values()].some(session=>session.accountId===accountId)) throw new Error('当前已有实时对比，请先关闭另一处预览。');
  const controller = new AbortController();
  const session:Session = {id:id(),project,accountId,authSessionId,controller,finished:[],pages:{},pending:true,revision:0,versions:{left,right},frameKeys:{},actions:[],
    observations:{left:[],right:[]},auditors:{left:createInteractionAudit(),right:createInteractionAudit()},journals:{left:[],right:[]},sequences:{left:null,right:null},scans:{}};
  sessions.set(session.id,session);
  const expiration = setTimeout(() => controller.abort(),5 * 60 * 1000);
  controller.signal.addEventListener('abort',() => {
    clearTimeout(expiration);
    sessions.delete(session.id);
  },{once:true});
  const ready = [lease(session,'left',snapshotDir(project,left),snapshot(project,left).entry,start),lease(session,'right',snapshotDir(project,right),snapshot(project,right).entry,start)];
  try {
    await Promise.all(ready);
    return await inspect(session);
  } catch (error) {
    controller.abort();
    throw error;
  } finally { session.pending = false; }
}

function getSession(project:string, key:string, authSessionId:string) {
  const session = sessions.get(key);
  if (!session || session.project !== project || session.authSessionId !== authSessionId) throw new Error('实时会话已关闭，请重新打开。');
  return session;
}

export async function closeLive(project:string,key:string,authSessionId:string) {
  const session = sessions.get(key);
  if (session?.project === project && session.authSessionId === authSessionId) {
    session.controller.abort();
    await Promise.allSettled(session.finished);
  }
}

export function hasLiveProject(projectId:string) {
  return [...sessions.values()].some(session=>session.project===projectId);
}

export function closeAccountSession(authSessionId:string) {
  for (const session of sessions.values()) if (session.authSessionId === authSessionId) session.controller.abort();
}

async function pageState(page:Page) {
  const url = new URL(page.url());
  if (url.origin !== localOrigin || url.search) throw new Error('浏览器已离开可比较的本地页面。');
  const evidence = await page.evaluate(() => {
    const {visible} = {visible(selector:string) {return [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length > 0);}};
    const focused = document.activeElement;
    return {
      dom:visible('body *').slice(0,240).map(el => [el.localName,el.id,el.getAttribute('role'),
        el.getAttribute('aria-expanded'),el.getAttribute('aria-selected'),el.getAttribute('aria-invalid'),el.getAttribute('aria-controls'),
        el.childElementCount || el.matches('input,textarea,[contenteditable]') ? null : el.textContent?.trim().slice(0,120) ?? null]),
      title:document.title.slice(0,160),
      focus:focused && focused !== document.body ? focused.id ? '#'+focused.id : focused.localName+' @'+Array.from(document.getElementsByTagName(focused.localName)).indexOf(focused) : '',
      dialogs:visible('dialog[open], [aria-modal=true]').length,
      interaction:['details[open]','[aria-expanded=true]','[role=tab][aria-selected=true]','[popover]:popover-open']
        .map(selector=>visible(selector).map(el=>el.id || el.getAttribute('aria-controls') || el.textContent?.trim().slice(0,100))),
      zoom:Math.round((Number(getComputedStyle(document.documentElement).zoom)||1)*100),
      scroll:window.scrollY,
    };
  });
  return {...evidence,path:url.pathname + url.hash.split('?')[0],focus:redact(evidence.focus)};
}

type PageState = Awaited<ReturnType<typeof pageState>>;

function frameKey(state:PageState) {
  return JSON.stringify([state.path,state.dom,state.scroll,state.zoom]);
}

function interactionChanges(before:PageState, after:PageState) {
  return after.interaction.map((next,index)=>[
    next.filter(item=>!before.interaction[index].includes(item)),
    before.interaction[index].filter(item=>!next.includes(item)),
  ]);
}

async function settledState(page:Page) {
  let previous = await pageState(page);
  for (let attempt=0;attempt<5;attempt++) {
    await page.waitForTimeout(90);
    const next = await pageState(page);
    if (frameKey(previous)===frameKey(next)) return next;
    previous=next;
  }
  throw new Error('页面仍在变化，请刷新画面后再试。');
}

async function liveImage(page:Page) {
  return 'data:image/jpeg;base64,' + (await page.screenshot({type:'jpeg',quality:70,timeout:4000,caret:'hide',
    mask:[page.locator('input:not([type=button],[type=submit],[type=checkbox],[type=radio]),textarea,[contenteditable]')]})).toString('base64');
}

async function inspect(session:Session, outcome?:LiveComparison['outcome']):Promise<LiveComparison> {
  const [left,right] = await Promise.all(sides.map(async side => {
    const page = session.pages[side]!.page;
    const state = await pageState(page);
    session.frameKeys[side] = frameKey(state);
    const ax = redact(await page.locator('body').ariaSnapshot({timeout:2500})).slice(0,16000);
    const image = await liveImage(page);
    const frame:LiveFrame = {image,path:redact(state.path),title:redact(state.title),focus:state.focus,scroll:state.scroll,zoom:state.zoom,controls:await controlsFor(page)};
    return {frame,dom:JSON.stringify(state.dom),ax};
  }));
  return {id:session.id,revision:session.revision,left:left.frame,right:right.frame,outcome,observations:session.observations,
    modes:{left:session.pages.left!.mode,right:session.pages.right!.mode},
    differences:{route:left.frame.path !== right.frame.path,dom:left.dom !== right.dom,semantics:left.ax !== right.ax,
      focus:left.frame.focus !== right.frame.focus,visual:left.frame.image !== right.frame.image}};
}

function targetLocator(page:Page,target:Target) {
  if (target.role === 'summary') {
    const name = target.name.split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+');
    return page.locator('summary').filter({hasText:new RegExp('^\\s*'+name+'\\s*$')});
  }
  return page.getByRole(target.role,{name:target.name,exact:true});
}

async function resolveHit(page:Page, point?:{x:number;y:number}):Promise<Target> {
  const marker = 'data-a11y-live-target';
  const target = await page.evaluateHandle(point => {
    const clicked = point ? document.elementFromPoint(point.x,point.y) : document.activeElement;
    return clicked?.closest('a[href],button,input,textarea,select,summary,[role=link],[role=button],[role=tab],[role=textbox],[role=combobox]') ?? null;
  },point);
  const element = target.asElement();
  if (!element) { await target.dispose(); throw new Error('这里没有可安全操作的命名控件。'); }
  const key = id();
  const devtools = await page.context().newCDPSession(page);
  try {
    const summary = await element.evaluate((el,[marker,key]) => {
      el.setAttribute(marker,key);
      return el.matches('summary') ? (el.textContent ?? '').trim().replace(/\s+/g,' ') : null;
    },[marker,key]);
    if (summary && summary.length <= 100) return {role:'summary',name:summary};
    const {root} = await devtools.send('DOM.getDocument');
    const {nodeId} = await devtools.send('DOM.querySelector',{nodeId:root.nodeId,selector:'['+marker+'="'+key+'"]'});
    const {nodes} = await devtools.send('Accessibility.getPartialAXTree',{nodeId,fetchRelatives:false});
    const result = control.safeParse({role:nodes[0]?.role?.value,name:nodes[0]?.name?.value});
    if (!result.success) throw new Error('无法取得此控件的可访问角色和名称，请使用键盘或审核证据。');
    return result.data;
  } finally {
    await element.evaluate((el,marker) => el.removeAttribute(marker),marker).catch(()=>{});
    await element.dispose();
    await devtools.detach();
  }
}

async function describeTarget(page:Page, target:Target) {
  if (risky.test(target.name) || redact(target.name) !== target.name) throw new Error('目标可能有业务副作用或包含个人信息。');
  const locator = targetLocator(page,target);
  if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) throw new Error('语义目标不存在、不唯一或不可操作。');
  const descriptor = await locator.evaluate(el => {
    const link = el instanceof HTMLAnchorElement ? new URL(el.href) : null;
    const path = link && link.origin === location.origin && !link.search &&
      !el.hasAttribute('download') && (!el.getAttribute('target') || el.getAttribute('target') === '_self') ? link.pathname + link.hash : null;
    const input = el instanceof HTMLInputElement ? el : null;
    return {tag:el.localName,stableId:el.id && document.querySelectorAll('#'+CSS.escape(el.id)).length===1 ? el.id : '',
      link:Boolean(link),path,submit:el instanceof HTMLButtonElement && el.type==='submit' && Boolean(el.form),
      sensitive:Boolean(input && !['text','search','number'].includes(input.type))};
  });
  if ((descriptor.link && (!descriptor.path || risky.test(descriptor.path))) || descriptor.sensitive) {
    throw new Error('外部链接、业务操作和敏感字段已阻止。');
  }
  return {locator,...descriptor};
}

export async function operateLive(project:string,key:string,input:unknown,authSessionId:string) {
  const {side,sync,revision,operation} = actionInput.parse(input);
  const session = getSession(project,key,authSessionId);
  if (session.pending || revision !== session.revision) throw new Error('操作所依据的画面已过期，请刷新实时预览。');
  const other = side === 'left' ? 'right' : 'left';
  const signal = session.controller.signal;
  const page = session.pages[side]!.page;
  const opposite = session.pages[other]!.page;
  session.pending = true;
  const outcome:NonNullable<LiveComparison['outcome']> = {action:operation.action,side,matched:null,executions:{}};
  try {
    if (operation.action !== 'refresh') {
      const before = await pageState(page);
      if ('x' in operation && session.frameKeys[side]!==frameKey(before)) throw new Error('点击画面已经过期，请刷新实时画面。');
      const oppositeBefore = sync ? await pageState(opposite) : undefined;
      const target = 'target' in operation ? operation.target :
        'x' in operation ? await resolveHit(page,operation) : operation.action === 'activate' ? await resolveHit(page) : undefined;
      const action = operation.action === 'activate' ? 'click' : operation.action;
      const descriptor = target ? await describeTarget(page,target) : undefined;
      if (target) {outcome.target = target.name; outcome.role = target.role;}
      if ('delta' in operation) outcome.delta = operation.delta;
      if ('percent' in operation) outcome.percent = operation.percent;
      const execute = async (current:Page, isOther:boolean, scrollTarget?:number) => {
        const currentTarget = target ? (isOther ? await describeTarget(current,target) : descriptor) : undefined;
        if (isOther && currentTarget && (currentTarget.path !== descriptor?.path || currentTarget.submit !== descriptor?.submit ||
            currentTarget.tag !== descriptor?.tag || Boolean(currentTarget.stableId && descriptor?.stableId && currentTarget.stableId !== descriptor.stableId))) {
          throw new Error('控件目的地或表单行为不同。');
        }
        const targetSide = isOther ? other : side;
        const prior = await readInteractionState(current);
        let selected = '';
        let step:PanoramaStep | undefined;
        let invalid;
        if (target && currentTarget && (action === 'click' || action === 'fill' || action === 'validate')) {
          if (target.role === 'summary') {
            if (action !== 'click') throw new Error('此操作仅支持命名表单控件。');
            await currentTarget.locator.click({timeout:2500});
          } else {
            step = {action:currentTarget.submit && action==='click' ? 'validate' : action,target};
            invalid = await act(current,step,signal,selector=>{selected=selector;});
          }
        } else if (action === 'tab' || action === 'shift-tab' || action === 'escape') {
          step = {action};
          await act(current,step,signal);
        } else if ('delta' in operation) {
          await current.evaluate(({delta,y}) => window.scrollTo({top:y ?? window.scrollY+delta,behavior:'instant'}),
            {delta:operation.delta,y:scrollTarget});
        } else if ('percent' in operation) {
          await current.evaluate(percent=>{document.documentElement.style.zoom=String(percent/100);},operation.percent);
        }
        const result = await settledState(current);
        if ('delta' in operation && result.scroll <= 6000) step = {action:'scroll',y:result.scroll};
        const previousSequence = session.sequences[targetSide];
        if (previousSequence) session.sequences[targetSide] = hash(JSON.stringify([previousSequence,
          step ?? {action,target,zoom:'percent' in operation ? operation.percent : undefined}]));
        const journal = session.journals[targetSide];
        if (!step || !journal || journal.length >= 6) session.journals[targetSide] = null;
        else journal.push(step);
        const after = await readInteractionState(current);
        const observations = session.observations[targetSide];
        for (const item of session.auditors[targetSide](prior,after,step?.action ?? action,session.revision+1,selected,invalid)) {
          if (observations.length >= 32) break;
          const selector = redact(item.selector);
          observations.push({rule:item.ruleId,status:item.status,selector,step:item.step,
            evidence:redact(result.path)+' · '+item.explanation});
        }
        if (observations.length < 32 && after.modal?.focusInside && prior.modal?.selector!==after.modal.selector) {
          observations.push({rule:'modal-focus-entered',status:'observed',step:session.revision+1,
            selector:redact(after.focus),evidence:'已观测到焦点进入模态弹窗。'});
        }
        if (observations.length < 32 && prior.modal && !after.modal) {
          observations.push({rule:'modal-closed',status:'observed',step:session.revision+1,selector:redact(after.focus),
            evidence:'模态弹窗已关闭，当前焦点：'+(redact(after.focus)||'文档')});
        }
        outcome.executions![targetSide] = {status:'executed',path:redact(result.path),focus:result.focus};
        return {result,invalid:after.invalid.map(field=>field.selector),modal:after.modal?.selector};
      };
      try {
        const actual = await execute(page,false);
        if (sync) {
          try {
            if (before.path !== oppositeBefore?.path) throw new Error('两侧当前页面不同，请独立导航或重新打开对比。');
            const replay = await execute(opposite,true,actual.result.scroll);
            outcome.matched = replay.result.path===actual.result.path && replay.modal===actual.modal &&
              JSON.stringify(replay.invalid)===JSON.stringify(actual.invalid) &&
              JSON.stringify(interactionChanges(oppositeBefore!,replay.result))===JSON.stringify(interactionChanges(before,actual.result)) &&
              (!(action==='tab' || action==='shift-tab') || replay.result.focus===actual.result.focus) &&
              (!('delta' in operation) || Math.abs(replay.result.scroll-actual.result.scroll)<=3) &&
              (!('percent' in operation) || replay.result.zoom===actual.result.zoom);
            if (!outcome.matched) outcome.reason = '操作后路由、弹窗、校验状态或可滚动范围不同。';
          } catch (error) {
            outcome.matched = false;
            outcome.executions![other] = {status:'unmatched'};
            session.journals[other] = null;
            session.sequences[other] = null;
            outcome.reason = redact((error as Error).message.split('\n')[0]);
          }
        }
      } catch (error) {
        session.journals[side] = null;
        session.sequences[side] = null;
        outcome.executions![side] = {status:'failed'};
        outcome.matched = false;
        outcome.reason = redact((error as Error).message.split('\n')[0]);
      }
    }
    if (operation.action !== 'refresh' && session.actions.length < 100) session.actions.push(outcome);
    session.revision++;
    session.scans = {};
    return await inspect(session,outcome);
  } finally { session.pending = false; }
}

export async function scanLive(project:string,key:string,side:LiveSide,authSessionId:string) {
  const session = getSession(project,key,authSessionId);
  if (session.pending) throw new Error('请等待当前操作完成。');
  session.pending = true;
  try {
    const {page,resources,network} = session.pages[side]!;
    const state = await pageState(page);
    const result = await scanRules(page);
    const ax = redact(await page.locator('body').ariaSnapshot()).slice(0,16000);
    const version = session.versions[side];
    const screenshot = await liveImage(page);
    const styles = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(el=>el.getClientRects().length).slice(0,240)
      .map(el=>{const css=getComputedStyle(el);return [el.localName,el.id,css.color,css.backgroundColor,css.outlineStyle,css.outlineWidth,css.visibility];}));
    if (frameKey(state) !== frameKey(await pageState(page))) throw new Error('页面在检测过程中发生变化，请在稳定状态重试。');
    const stateId = hash(JSON.stringify([state.path,state.dom,state.focus,ax,state.scroll,state.zoom,session.sequences[side],session.actions])).slice(0,24);
    const selectors = new Map<string,string>();
    const repairable = session.pages[side]!.mode==='source' && !!session.journals[side]?.length;
    const report = {id:stateId,version,createdAt:now(),path:redact(state.path),title:redact(state.title),
      focus:state.focus,scroll:state.scroll,dom:state.dom.map(row=>row.map(value=>typeof value === 'string' ? redact(value) : value)),
      ax,screenshot,sequenceKey:session.sequences[side],
      project,owner:session.accountId,zoom:state.zoom,
      styles:styles.map(row=>row.map(redact)),
      engine:result.engine, rules:result.rules,
      violations:result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>redact(JSON.stringify(node.target)))})),
      findings:result.violations.flatMap(rule=>rule.nodes.map(node=>{
        const selector=redact(JSON.stringify(node.target));
        const findingId = hash(rule.id+'|'+selector).slice(0,20);
        if (repairable && rule.id==='button-name' && node.target.length===1 && typeof node.target[0]==='string' && redact(node.target[0])===node.target[0]) {
          selectors.set(findingId,node.target[0]);
        }
        return {id:findingId,ruleId:rule.id,selector,help:rule.help,description:rule.description,
          impact:node.impact ?? 'unknown',bounds:null};
      })),
      incomplete:result.incomplete.map(rule=>({id:rule.id,count:rule.nodes.length})), observations:session.observations[side],
      resources:resources.map(item=>({...item,path:redact(item.path)})), network:network.map(item=>({...item,path:redact(item.path)})), actions:session.actions,
      coverage:{ axe:'completed',behavior:'observed-user-actions',
        reason:session.actions.some(action=>action.executions?.[side]?.status==='executed') ? '仅检测已执行操作；未执行的步骤没有证据。' : '尚无已执行的交互步骤。', unsupported:['完整键盘路径','辅助技术播报','触屏实测','媒体内容质量'] },
      media:await page.locator('video,audio').evaluateAll(elements=>elements.map(el=>({type:el.localName,
        tracks:Array.from(el.querySelectorAll('track'),track=>({kind:track.kind,language:track.srclang}))})))};
    db.prepare(`INSERT INTO live_state_audits VALUES (?,?,?,?,?)
      ON CONFLICT(project_id,snapshot_id,state_id) DO UPDATE SET data=excluded.data,created_at=excluded.created_at`)
      .run(project,version,stateId,JSON.stringify(report),report.createdAt);
    session.scans[side] = {id:stateId,revision:session.revision,frame:frameKey(state),selectors};
    return {...report,repairable:[...selectors.keys()]};
  } finally { session.pending = false; }
}

export async function openLiveRepair(project:string,key:string,input:unknown,authSessionId:string) {
  const {side,stateId,issueId} = z.object({side:z.enum(sides),stateId:z.string().length(24),issueId:z.string().length(20)}).parse(input);
  const session = getSession(project,key,authSessionId);
  const saved = session.scans[side];
  const selector = saved?.selectors.get(issueId);
  const steps = session.journals[side];
  if (session.pending || saved?.id!==stateId || saved.revision!==session.revision || !selector || !steps?.length ||
      storedProject(project).current_snapshot!==session.versions[side]) throw new Error('实时证据已过期或不支持自动修复，请重新检测。');
  session.pending = true;
  try {
    const lease = session.pages[side]!;
    const state = await pageState(lease.page);
    if (frameKey(state)!==saved.frame) throw new Error('网页状态已变化，请重新检测。');
    return await adoptLiveRecipe(project,session.versions[side],lease.start,steps,state.path,selector,
      AbortSignal.any([session.controller.signal,AbortSignal.timeout(45000)]));
  } finally {session.pending = false;}
}
