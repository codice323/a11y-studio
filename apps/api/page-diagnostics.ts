import type { Page } from 'playwright-core';
import type { PageDiagnostics } from '../../packages/shared/page-diagnostics';
import type { LiveFrame } from '../../packages/shared/live-comparison';
import { scanRules } from './scan-rules';
import { hash } from './storage';

export const verificationPageMessage = '当前页面显示网站安全验证，尚未检测到目标网页。请在原网站完成验证，再返回工作台重新采集正文。';

export function isWebsiteVerificationPage(title: string, visibleText: string) {
  return /^百度安全验证$|^just a moment[.!…]*$|^attention required[! |:]+cloudflare$/i.test(title.trim()) ||
    (/百度安全验证/.test(visibleText) && /请完成下方验证后继续操作/.test(visibleText));
}

export async function requireTargetPage(page: Page) {
  const {title,text} = await page.evaluate(() => ({
    title:document.title, text:document.body?.innerText.slice(0,12000) ?? '',
  }));
  if (isWebsiteVerificationPage(title,text)) throw new Error(verificationPageMessage);
}

export async function diagnosePage(page: Page, path: string, options: { waitForContent?: boolean } = {}): Promise<PageDiagnostics> {
  const url = page.url();
  const stillLoading = options.waitForContent ? !(await waitForPageContent(page)) : undefined;
  if (page.url() !== url) throw new Error('网页已切换，请重试检测。');
  await requireTargetPage(page);
  const result = await scanRules(page);
  const findings = result.violations.flatMap(rule => rule.nodes.map(node => {
    const selector = node.target.length === 1 && typeof node.target[0] === 'string' ? node.target[0].slice(0, 2000) : '';
    return {
      id: hash(rule.id + '|' + JSON.stringify(node.target)).slice(0, 20),
      ruleId: rule.id, selector, help: rule.help, description: rule.description,
      impact: node.impact ?? rule.impact ?? 'unknown', html: /^<[\w-]+/.exec(node.html)?.[0] ?? '', bounds: null,
    };
  }));
  const groups = await page.evaluate(findings => {
    const byRule = new Map<string, {
      id: string;
      ancestors: Element[];
      top: number;
    }[]>();
    const groups: Record<string,string> = {};
    for (const {id,selector,ruleId,impact} of findings) {
      if (!selector) continue;
      let matches: NodeListOf<Element>;
      try { matches = document.querySelectorAll(selector); } catch { continue; }
      if (matches.length !== 1) continue;
      const element = matches[0];
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility !== 'visible') continue;
      const ancestors: Element[] = [];
      for (let parent=element.parentElement; parent && ancestors.length<4; parent=parent.parentElement) {
        if (parent.matches('body,html,main,[role=main]')) break;
        ancestors.push(parent);
        if (parent.matches('nav,[role=navigation],[role=tablist],header,footer,aside,section,article')) break;
      }
      const key = JSON.stringify([ruleId,impact,element.localName]);
      const locations = byRule.get(key) ?? [];
      locations.push({id,ancestors,top:rect.top});
      byRule.set(key,locations);
    }
    for (const locations of byRule.values()) {
      locations.sort((a,b)=>a.top-b.top);
      const regions: {id:string; ancestors:Element[]; top:number}[] = [];
      for (const location of locations) {
        const region = regions.find(candidate => location.top-candidate.top<=120 &&
          location.ancestors.some(parent=>candidate.ancestors.includes(parent)));
        if (region) {
          region.ancestors = region.ancestors.filter(parent=>location.ancestors.includes(parent));
          groups[location.id] = region.id;
        } else {
          regions.push(location);
          groups[location.id] = location.id;
        }
      }
    }
    return groups;
  },findings.map(({id,selector,ruleId,impact})=>({id,selector,ruleId,impact})));
  const title = (await page.title()).slice(0, 160);
  if (page.isClosed() || page.url() !== url) throw new Error('页面在检测过程中发生变化。');
  const summarize = ({ id, help, nodes }: (typeof result.violations)[number]) => ({ id, help, count:nodes.length });
  return {
    path, title,
    coverage: {
      review:result.incomplete.map(summarize),
      bestPractices:result.bestPractices.violations.map(summarize),
      stillLoading,
    },
    findings: findings.map(item=>({...item,locationGroup:groups[item.id]})),
  };
}

async function waitForPageContent(page: Page) {
  return page.evaluate(() => new Promise<boolean>(resolve => {
    const start = performance.now();
    let lastChange = start;
    const observer = new MutationObserver(() => { lastChange = performance.now(); });
    observer.observe(document.documentElement, {
      childList:true, subtree:true, characterData:true,
      attributes:true, attributeFilter:['class','hidden','aria-hidden','aria-busy'],
    });
    const timer = window.setInterval(() => {
      const now = performance.now();
      const settled = document.readyState === 'complete' && now - start >= 1000 && now - lastChange >= 550;
      if (!settled && now - start < 3500) return;
      observer.disconnect();
      window.clearInterval(timer);
      resolve(settled);
    },100);
  }));
}

export async function locatePageElement(page: Page, selector?: string, scroll = false, selectors: string[] = []): Promise<LiveFrame['location']> {
  if (!selector || /^(?:html|body|:root)$/i.test(selector.trim())) return undefined;
  return page.evaluate(({selector,scroll,selectors}) => {
    const elements = [...new Set([selector,...selectors])].flatMap(value => {
      if (/^(?:html|body|:root)$/i.test(value.trim())) return [];
      try {
        const matches = document.querySelectorAll(value);
        return matches.length === 1 ? [matches[0]] : [];
      } catch { return []; }
    });
    if (!elements.length) return {status:'missing'};
    const visible = [...new Set(elements)].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === 'visible';
    });
    if (!visible.length) return {status:'hidden'};
    if (scroll) visible[0].scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const highlights = visible.flatMap(element => {
      const box = element.getBoundingClientRect();
      const x = Math.max(0,box.left), y = Math.max(0,box.top);
      const width = Math.min(innerWidth,box.right)-x, height = Math.min(innerHeight,box.bottom)-y;
      return width > 0 && height > 0 ? [{x,y,width,height}] : [];
    });
    return highlights.length ? {status:'located',bounds:highlights[0],highlights} : {status:'outside'};
  },{selector,scroll,selectors});
}
