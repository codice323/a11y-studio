import type { Page } from 'playwright-core';
import type { Control, PanoramaStep } from '../../packages/shared/panorama';

const risky = /支付|删除|发送|购买|付款|注销|下单|注册|上传|退出登录|\b(?:pay(?:ment)?|buy|delete|remove|send|purchase|checkout|logout|signout|sign-out|sign-up|register|unsubscribe|upload|destroy|order)\b/i;

export function safeExplorerLink(url: URL, name: string) {
  return url.origin === 'http://a11y.local' && !url.search && !risky.test(name + ' ' + decodeURIComponent(url.pathname + url.hash)) &&
    (!url.hash || /^#\/[\w/%-]*$/.test(url.hash)) && !/\.(?!html?$)[a-z0-9]+$/i.test(url.pathname);
}

export function explorerBudget(guest: boolean) {
  const max = (name: string, fallback: number) => {
    const value = Number(process.env['A11Y_EXPLORER_' + name]);
    return Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  };
  return {
    pages: max('PAGES', guest ? 4 : 20),
    states: max('STATES', guest ? 8 : 60),
    actions: max('ACTIONS', guest ? 18 : 150),
    depth: max('DEPTH', 3),
    durationMs: max('TIME_MS', guest ? 45_000 : 300_000),
  };
}

export async function explorerEligibility(page: Page, target: Control) {
  if (risky.test(target.name)) return {kind:'blocked'} as const;
  const locator = page.getByRole(target.role, {name:target.name,exact:true});
  if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) return {kind:'ambiguous'} as const;
  const info = await locator.evaluate(el => {
    const anchor = el instanceof HTMLAnchorElement;
    const button = el instanceof HTMLButtonElement;
    const input = el instanceof HTMLInputElement;
    const form = button || input ? el.form : null;
    const associated = el.getAttribute('aria-controls') || el.getAttribute('commandfor') || el.getAttribute('popovertarget');
    const dialog = el.closest('dialog[open],[role=dialog][aria-modal=true]');
    return {
      href: anchor && !el.hasAttribute('download') && (!el.target || el.target === '_self') ? el.href : '',
      tab: el.getAttribute('role') === 'tab' && Boolean(el.closest('[role=tablist]')) && el.getAttribute('aria-selected') !== 'true',
      disclosure: el.hasAttribute('aria-expanded') && (Boolean(associated) || ['menu','true'].includes(el.getAttribute('aria-haspopup') ?? '')),
      dialog: el.getAttribute('aria-haspopup') === 'dialog' || ['show-modal','close','request-close'].includes(el.getAttribute('command') ?? '') && Boolean(associated),
      popover: Boolean(el.getAttribute('popovertarget') && associated && document.getElementById(associated)?.hasAttribute('popover')),
      modalClose: Boolean(dialog && button && el.type === 'button' && /^(?:close|dismiss|cancel)(?:\s|$)|关闭|取消/i.test(el.getAttribute('aria-label') ?? el.textContent ?? '')),
      submission: (button || input) && Boolean(form?.querySelector(':invalid')) && ['submit','image'].includes(el.type),
      fill: input && ['text','search'].includes(el.type) && !el.readOnly && !el.autocomplete.startsWith('cc-') &&
        Boolean(el.form?.querySelector('button[type=submit],button:not([type]),input[type=submit]')),
    };
  });
  if (target.role === 'link' && info.href) {
    const url = new URL(info.href);
    try {
      if (safeExplorerLink(url,target.name)) return {kind:'navigation', path:url.pathname + url.hash} as const;
    } catch { /* malformed URL encoding */ }
  }
  if (info.submission) return {kind:'validate'} as const;
  if (target.role === 'textbox' && info.fill) return {kind:'fill'} as const;
  if (target.role === 'tab' && info.tab || target.role === 'button' && (info.disclosure || info.dialog || info.modalClose || info.popover)) {
    return {kind:'click'} as const;
  }
  return {kind:'unsupported'} as const;
}

export async function explorerCandidates(page: Page, controls: Control[], dynamic: boolean) {
  const steps: PanoramaStep[] = [];
  const omitted: Record<string,number> = {};
  for (const target of controls) {
    const eligible = await explorerEligibility(page,target);
    if (eligible.kind === 'navigation') steps.push({action:'click',target,navigationPath:eligible.path,explorer:true});
    else if (eligible.kind === 'click' || eligible.kind === 'validate' || dynamic && eligible.kind === 'fill') {
      steps.push({action:eligible.kind,target,explorer:true});
    } else {
      omitted[eligible.kind] = (omitted[eligible.kind] ?? 0) + 1;
    }
  }
  const summaries = await page.locator('details > summary:first-of-type').evaluateAll(elements =>
    elements.filter(element => element.getClientRects().length > 0).slice(0,12)
      .map(element => (element.textContent ?? '').trim().replace(/\s+/g,' ')));
  for (const name of new Set(summaries)) {
    if (name && name.length <= 100 && !risky.test(name) && !/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d(?:[\d -]{7,})\d\b/i.test(name)) {
      steps.push({action:'toggle-details',name});
    }
  }
  if (await page.locator('dialog:modal,[role=dialog][aria-modal=true]:visible').count()) steps.push({action:'tab'},{action:'escape'});
  return {steps, omitted};
}

export async function explorerFingerprint(page: Page, includeFocus: boolean) {
  return page.evaluate(focus => {
    const groups = [
      'h1,h2,main,nav,form', 'dialog[open],[role=dialog],[role=alertdialog]', 'details[open]',
      '[popover]:popover-open', '[aria-expanded=true]', '[role=tab][aria-selected=true]',
      '[role=tabpanel]', '[aria-invalid=true],:user-invalid', '[role=status],[role=alert]',
      'a[href],button,input,select,textarea,[tabindex],[aria-current],[aria-pressed]',
    ];
    const locator = { position(node:Element) {
      const parts:string[] = [];
      for (let current:Element|null=node; current?.parentElement && parts.length<12; current=current.parentElement) {
        parts.unshift(current.localName + ':' + Array.from(current.parentElement.children).indexOf(current));
      }
      return parts.join('/');
    }};
    const states = groups.map(group => [...document.querySelectorAll(group)].slice(0,45).flatMap(node => {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return [];
      // Avoid unstable IDs, input values, long content and volatile numeric fragments.
      const text = node.matches('details') ? node.querySelector(':scope > summary')?.textContent
        : node.matches('h1,h2,summary,a,button,[role=tab],[role=tabpanel],[role=status],[role=alert]') ? node.textContent : '';
      const name = (node.getAttribute('aria-label') || text || '').trim().replace(/\s+/g,' ').replace(/\d+/g,'#').slice(0,90);
      return [[locator.position(node),node.getAttribute('role'),name,
        ...['href','aria-expanded','aria-selected','aria-pressed','aria-current','disabled','aria-disabled'].map(attr=>node.getAttribute(attr))]];
    }));
    return JSON.stringify([states,focus && document.activeElement ? locator.position(document.activeElement) : '']);
  }, includeFocus);

}

// Wait for two consecutive matching DOM samples after the existing interaction delay.
export async function stableExplorerFingerprint(page: Page, focus: boolean, signal: AbortSignal) {
  let previous = await explorerFingerprint(page,focus);
  for (let attempt=0;attempt<4;attempt++) {
    signal.throwIfAborted();
    await page.waitForTimeout(75);
    const next = await explorerFingerprint(page,focus);
    if (previous === next) return next;
    previous = next;
  }
  throw new Error('页面交互状态持续变化，无法稳定采集。');
}

export function explorerPriority(step?: PanoramaStep) {
  if (!step) return 0;
  if ('navigationPath' in step && step.navigationPath) return 1;
  if (step.action === 'fill') return 3;
  if (step.action === 'tab' || step.action === 'shift-tab' || step.action === 'escape') return 4;
  return 2;
}

type PlanningStats = {calls:number;elapsedMs:number;inputTokens:number;outputTokens:number;fallbacks:number};
const configuredCalls = () => Math.min(10,Math.max(0,Math.floor(Number(process.env.A11Y_EXPLORER_AI_CALLS) || 0)));
let processCalls = 0;

export function explorerPlanner(requested:boolean) {
  const key = process.env.AI_API_KEY;
  const enabled = requested && Boolean(key) && processCalls < configuredCalls();
  const stats:PlanningStats = {calls:0,elapsedMs:0,inputTokens:0,outputTokens:0,fallbacks:0};
  return {enabled,stats,async choose(steps:PanoramaStep[],signal:AbortSignal) {
    if (!enabled || stats.calls || processCalls >= configuredCalls() || steps.length < 2) return;
    const candidates = steps.slice(0,24).map((step,index)=>({
      index,action:step.action,role:'target' in step ? step.target.role : undefined,
      navigation:'navigationPath' in step && Boolean(step.navigationPath),
    }));
    stats.calls++;
    processCalls++;
    const start = performance.now();
    try {
      const base = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/$/,'');
      const response = await fetch(base+'/chat/completions',{
        method:'POST',redirect:'error',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},
        signal:AbortSignal.any([signal,AbortSignal.timeout(4000)]),
        body:JSON.stringify({model:process.env.AI_MODEL || 'deepseek-chat',max_tokens:32,temperature:0,
          messages:[{role:'system',content:'Choose the next interaction most likely to expose a distinct accessibility state. Return only a JSON object with an integer index.'},
            {role:'user',content:JSON.stringify(candidates)}]}),
      });
      if (!response.ok) throw new Error('Planner response unavailable');
      const result = await response.json();
      stats.inputTokens = Number(result.usage?.prompt_tokens) || 0;
      stats.outputTokens = Number(result.usage?.completion_tokens) || 0;
      const index:unknown = JSON.parse(result.choices?.[0]?.message?.content ?? '').index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index<0 || index>=candidates.length) throw new Error('Invalid candidate index');
      return index;
    } catch {
      stats.fallbacks++;
    } finally {
      stats.elapsedMs += Math.round(performance.now()-start);
    }
  }};
}
