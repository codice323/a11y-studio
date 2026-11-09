import { once } from 'node:events';
import { z } from 'zod';
import type { Locator, Page } from 'playwright-core';
import type { Control } from '../../packages/shared/panorama';
import type { LiveComparison, LiveFinding, LiveFrame, LiveSide } from '../../packages/shared/live-comparison';
import { act, controlsFor } from './panorama';
import { withRepairPage, type BrowserRequestEvidence, type ResourceFailure } from './scan';
import { scanRules } from './scan-rules';
import { db, hash, id, now, snapshot, snapshotDir, walk } from './storage';
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
])});
const pathFor = (file:string) => '/' + file.split('/').map(encodeURIComponent).join('/');
const redact = (text:string) => text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d(?:[\d -]{7,})\d\b/gi,'[已隐藏]');
const risky = /支付|删除|发送|购买|付款|注销|下单|转账|提交订单|\b(?:pay|buy|delete|send|purchase|checkout|logout|transfer|order|unsubscribe)\b/i;
type Target = Control | {role:'summary';name:string};
type PageLease = {page:Page; resources:ResourceFailure[]; network:BrowserRequestEvidence[]};
type Session = {
  id:string; project:string; controller:AbortController; ready:Promise<void>[];
  pages:Partial<Record<LiveSide,PageLease>>; pending:boolean; revision:number;
  observations:LiveComparison['observations']; dialogOpener:Partial<Record<LiveSide,string>>;
  versions:Record<LiveSide,string>;
  frameKeys:Partial<Record<LiveSide,string>>;
  actions:NonNullable<LiveComparison['outcome']>[];
  tabStreak:Record<LiveSide,number>;
};
const sessions = new Map<string,Session>();

function lease(session:Session, side:LiveSide, dir:string, entry:string, start?:string) {
  const signal = session.controller.signal;
  return new Promise<void>((resolve,reject) => {
    void withRepairPage(dir,entry,signal,async (page,_product,resources,network) => {
      page.setDefaultTimeout(2500);
      if (start && start !== entry) {
        if (!/\.html?$/i.test(start) || !walk(dir).includes(start)) throw new Error('该版本缺少所选 HTML 页面。');
        const response = await page.goto(localOrigin + pathFor(start),{waitUntil:'load',timeout:5000});
        if (!response?.ok()) throw new Error('所选页面加载失败。');
      }
      session.pages[side] = {page,resources,network};
      resolve();
      if (!signal.aborted) await once(signal,'abort');
    },3000,true,true).catch(error => {
      reject(error);
      if (!signal.aborted) session.controller.abort();
    });
  });
}

export async function startLive(project:string, input:unknown) {
  const {left,right,start} = startInput.parse(input);
  const versions = validSnapshots(project);
  const before = versions.find(version => version.id === left);
  const after = versions.find(version => version.id === right);
  if (!before || !after) throw new Error('只能对比本项目的有效版本。');
  if (sessions.size >= 1) throw new Error('当前已有实时对比，请先关闭另一处预览。');
  const controller = new AbortController();
  const session:Session = {id:id(),project,controller,ready:[],pages:{},pending:true,revision:0,versions:{left,right},frameKeys:{},actions:[],
    observations:{left:[],right:[]},dialogOpener:{},tabStreak:{left:0,right:0}};
  sessions.set(session.id,session);
  const expiration = setTimeout(() => controller.abort(),5 * 60 * 1000);
  controller.signal.addEventListener('abort',() => {
    clearTimeout(expiration);
    sessions.delete(session.id);
  },{once:true});
  session.ready = [lease(session,'left',snapshotDir(project,left),snapshot(project,left).entry,start),lease(session,'right',snapshotDir(project,right),snapshot(project,right).entry,start)];
  try {
    await Promise.all(session.ready);
    return await inspect(session);
  } catch (error) {
    controller.abort();
    throw error;
  } finally { session.pending = false; }
}

function getSession(project:string, key:string) {
  const session = sessions.get(key);
  if (!session || session.project !== project) throw new Error('实时会话已关闭，请重新打开。');
  return session;
}

export function closeLive(project:string,key:string) {
  const session = sessions.get(key);
  if (session?.project === project) session.controller.abort();
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
      title:document.title,
      heading:document.querySelector('h1')?.textContent?.trim().slice(0,160) ?? '',
      focus:focused && focused !== document.body ? focused.id ? '#'+focused.id : focused.localName+' @'+Array.from(document.getElementsByTagName(focused.localName)).indexOf(focused) : '',
      focusInsideDialog:Boolean(focused?.closest('dialog[open], [aria-modal=true]')),
      dialogs:visible('dialog[open], [aria-modal=true]').length,
      interaction:['details[open]','[aria-expanded=true]','[role=tab][aria-selected=true]','[popover]:popover-open']
        .map(selector=>visible(selector).length),
      invalid:visible(':user-invalid').map(el => ({id:el.id,referenced:['aria-describedby','aria-errormessage'].some(attr =>
        (el.getAttribute(attr) ?? '').split(/\s+/).some(value => Boolean(document.getElementById(value))))})),
      status:visible('[role=status], [role=alert], [aria-live]:not([aria-live=off])').slice(0,24).map(el => el.textContent?.trim().slice(0,200)),
      scroll:window.scrollY,
    };
  });
  return {...evidence,path:url.pathname + url.hash.split('?')[0],focus:redact(evidence.focus)};
}

type PageState = Awaited<ReturnType<typeof pageState>>;

function frameKey(state:PageState) {
  return JSON.stringify([state.path,state.dom,state.scroll]);
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

async function inspect(session:Session, outcome?:LiveComparison['outcome']):Promise<LiveComparison> {
  const [left,right] = await Promise.all(sides.map(async side => {
    const page = session.pages[side]!.page;
    const state = await pageState(page);
    session.frameKeys[side] = frameKey(state);
    const ax = redact(await page.locator('body').ariaSnapshot({timeout:2500})).slice(0,16000);
    const image = 'data:image/jpeg;base64,' + (await page.screenshot({type:'jpeg',quality:70,timeout:4000,
      mask:[page.locator('input[type=password],input[type=email],input[type=tel],input[type=file]')]})).toString('base64');
    const frame:LiveFrame = {image,path:state.path,focus:state.focus,scroll:state.scroll,controls:await controlsFor(page)};
    return {frame,dom:JSON.stringify(state.dom),ax};
  }));
  return {id:session.id,revision:session.revision,left:left.frame,right:right.frame,outcome,observations:session.observations,
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
    return {link:Boolean(link),path,submit:el instanceof HTMLButtonElement && el.type==='submit' && Boolean(el.form),
      sensitive:Boolean(input && !['text','search','number'].includes(input.type))};
  });
  if ((descriptor.link && (!descriptor.path || risky.test(descriptor.path))) || descriptor.sensitive) {
    throw new Error('外部链接、业务操作和敏感字段已阻止。');
  }
  return {locator,...descriptor};
}

async function observe(session:Session, side:LiveSide, before:Awaited<ReturnType<typeof pageState>>, after:typeof before,
  operation:string, target?:Locator) {
  const observations = session.observations[side];
  function add(rule:string,evidence:string) {
    if (observations.length < 32 && !observations.some(item=>item.rule===rule && item.evidence===evidence)) observations.push({rule,evidence,status:'needs-review'});
  }
  if (after.dialogs > before.dialogs) {
    session.dialogOpener[side] = await target?.evaluate(el => el.id ? '#'+el.id : el.localName+' @'+Array.from(document.getElementsByTagName(el.localName)).indexOf(el)).catch(()=>undefined) ?? before.focus;
    if (!after.focusInsideDialog) add('dialog-focus-entry',after.path+' · 打开弹窗后焦点仍在 '+(after.focus || '文档'));
  }
  if (after.dialogs < before.dialogs && session.dialogOpener[side] && session.dialogOpener[side] !== after.focus) {
    add('dialog-focus-return',after.path+' · 关闭后焦点为 '+(after.focus || '文档')+'，打开前为 '+session.dialogOpener[side]);
  }
  if (operation === 'tab' || operation === 'shift-tab') {
    session.tabStreak[side] = before.focus && before.focus === after.focus && !after.dialogs ? session.tabStreak[side]+1 : 0;
    if (session.tabStreak[side] >= 3) add('possible-keyboard-trap',after.path+' · 连续 Tab 操作后焦点停留在 '+after.focus);
  } else if (operation !== 'refresh') session.tabStreak[side] = 0;
  if (before.path !== after.path && before.title === after.title && before.heading === after.heading && before.focus === after.focus) {
    add('route-context-unchanged',after.path+' · 路由变化后标题、主标题和焦点均未改变，需确认导航反馈。');
  }
  if (JSON.stringify(before.status) !== JSON.stringify(after.status)) {
    const text = after.status.filter(Boolean).join(' · ');
    if (text) add('status-message-changed',after.path+' · 页面实时区域更新：'+redact(text).slice(0,220)+'。请通过辅助技术确认播报。');
  }
  if (operation === 'validate') for (const field of after.invalid) {
    if (!field.referenced) add('form-error-context',after.path+' · '+(field.id ? '#'+redact(field.id) : '无 ID 字段')+' · 原生校验失败，未找到关联的额外错误文本；检查浏览器提示是否充分。');
  }
  if (target && await target.count().catch(()=>0) === 1) {
    const expanded = await target.evaluate(el => {
      const state = el.getAttribute('aria-expanded');
      const ids = (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
      const panel = ids.length === 1 ? document.getElementById(ids[0]) : null;
      return panel && state !== null && (state === 'true') !== (panel.getClientRects().length > 0 && getComputedStyle(panel).visibility === 'visible');
    }).catch(()=>false);
    if (expanded) add('expanded-visibility-mismatch',after.path+' · 点击后 aria-expanded 与控制区域可见性不一致。');
  }
}

export async function operateLive(project:string,key:string,input:unknown) {
  const {side,sync,revision,operation} = actionInput.parse(input);
  const session = getSession(project,key);
  if (session.pending || revision !== session.revision) throw new Error('操作所依据的画面已过期，请刷新实时预览。');
  const other = side === 'left' ? 'right' : 'left';
  const signal = session.controller.signal;
  const page = session.pages[side]!.page;
  const opposite = session.pages[other]!.page;
  session.pending = true;
  const outcome:NonNullable<LiveComparison['outcome']> = {action:operation.action,side,matched:null};
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
      const execute = async (current:Page, isOther:boolean) => {
        const currentTarget = target ? (isOther ? await describeTarget(current,target) : descriptor) : undefined;
        if (isOther && currentTarget && (currentTarget.path !== descriptor?.path || currentTarget.submit !== descriptor?.submit)) {
          throw new Error('控件目的地或表单行为不同。');
        }
        let invalid: typeof before.invalid | undefined;
        if (target && currentTarget && (action === 'click' || action === 'fill' || action === 'validate')) {
          if (target.role === 'summary') {
            if (action !== 'click') throw new Error('此操作仅支持命名表单控件。');
            await currentTarget.locator.click({timeout:2500});
          } else {
            invalid = await act(current,{action:currentTarget.submit && action==='click' ? 'validate' : action,target},signal);
          }
        } else if (action === 'tab' || action === 'shift-tab' || action === 'escape') await act(current,{action},signal);
        else if ('delta' in operation) await current.evaluate(delta => window.scrollBy({top:delta,behavior:'instant'}),operation.delta);
        const result = await settledState(current);
        if (invalid) result.invalid = invalid;
        await observe(session,isOther ? other : side,isOther ? oppositeBefore! : before,result,
          currentTarget?.submit ? 'validate' : action,currentTarget?.locator);
        return result;
      };
      const actual = await execute(page,false);
      if (sync) {
        try {
          if ('delta' in operation) await opposite.evaluate(y=>window.scrollTo({top:y,behavior:'instant'}),actual.scroll);
          else if (before.path !== oppositeBefore?.path) throw new Error('两侧当前页面不同，请独立导航或重新打开对比。');
          const replay = 'delta' in operation ? await settledState(opposite) : await execute(opposite,true);
          outcome.matched = replay.path===actual.path && replay.dialogs===actual.dialogs && replay.invalid.length===actual.invalid.length &&
            replay.interaction.every((value,index)=>value-oppositeBefore!.interaction[index] === actual.interaction[index]-before.interaction[index]) &&
            (!('delta' in operation) || Math.abs(replay.scroll-actual.scroll)<=3);
          if (!outcome.matched) outcome.reason = '操作后路由、弹窗、校验状态或可滚动范围不同。';
        } catch (error) {
          outcome.matched = false;
          outcome.reason = redact((error as Error).message.split('\n')[0]);
        }
      }
    }
    if (operation.action !== 'refresh' && session.actions.length < 100) session.actions.push(outcome);
    session.revision++;
    return await inspect(session,outcome);
  } finally { session.pending = false; }
}

export async function scanLive(project:string,key:string,side:LiveSide) {
  const session = getSession(project,key);
  if (session.pending) throw new Error('请等待当前操作完成。');
  session.pending = true;
  try {
    const {page,resources,network} = session.pages[side]!;
    const state = await pageState(page);
    const result = await scanRules(page);
    const ax = redact(await page.locator('body').ariaSnapshot()).slice(0,16000);
    state.dom = state.dom.map(row=>row.map(value=>typeof value === 'string' ? redact(value) : value));
    const version = session.versions[side];
    const stateId = hash(JSON.stringify([state.path,state.dom,state.focus,ax,state.invalid])).slice(0,24);
    const report = {id:stateId,version,createdAt:now(),path:state.path, focus:state.focus, scroll:state.scroll, dom:state.dom, ax, engine:result.engine, rules:result.rules,
      violations:result.violations.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>redact(JSON.stringify(node.target)))})),
      findings:result.violations.flatMap(rule=>rule.nodes.map(node=>{
        const selector=redact(JSON.stringify(node.target));
        return {id:hash(rule.id+'|'+selector).slice(0,20),ruleId:rule.id,selector,help:rule.help,description:rule.description,
          impact:node.impact ?? 'unknown',bounds:null};
      })),
      incomplete:result.incomplete.map(rule=>({id:rule.id,count:rule.nodes.length})), observations:session.observations[side],
      resources, network:network.map(item=>({...item,path:redact(item.path)})), actions:session.actions,
      coverage:{ axe:'completed',behavior:'observed-user-actions', unsupported:['完整键盘路径','辅助技术播报','触屏实测','媒体内容质量'] },
      media:await page.locator('video,audio').evaluateAll(elements=>elements.map(el=>({type:el.localName,
        tracks:Array.from(el.querySelectorAll('track'),track=>({kind:track.kind,language:track.srclang}))})))};
    db.prepare(`INSERT INTO live_state_audits VALUES (?,?,?,?,?)
      ON CONFLICT(project_id,snapshot_id,state_id) DO UPDATE SET data=excluded.data,created_at=excluded.created_at`)
      .run(project,version,stateId,JSON.stringify(report),report.createdAt);
    return report;
  } finally { session.pending = false; }
}
