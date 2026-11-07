import type { Page } from 'playwright-core';
import type { BehaviorAudit, BehaviorFinding, SemanticCandidate } from '../../packages/shared/types';

const MAX_CONTROLS = 60;
const MAX_TAB_STEPS = 75;
const BUDGET_MS = 6500;
const limitNotes = [
  '仅检查禁用页面脚本的静态 Chromium 快照。动态组件的按键处理、打开后的菜单及业务操作需要人工验证。',
  '焦点样式比较基于计算样式，不能判断复杂背景、动画、遮挡或全部可见焦点模式。',
];

type Control = {
  selector: string;
  role: string;
  tabindex: number;
  radio: boolean;
  managed: boolean;
  tabbableCandidate: boolean;
  focusStyle: string | null;
  declaredState: { name: 'checked' | 'selected'; value: string } | null;
  expanded: string | null;
  controlledHidden: boolean | null;
  kind: SemanticCandidate['kind'];
  context: string;
};

export function keyboardFindings(controls: Control[], sequence: string[], complete: boolean): BehaviorFinding[] {
  const results: BehaviorFinding[] = [];
  const reached = new Set(sequence);
  for (const control of controls) {
    const { selector, role, tabindex, radio, managed, tabbableCandidate, expanded, controlledHidden } = control;
    if (tabbableCandidate && !radio && !managed && !reached.has(selector) && (tabindex < 0 || complete)) {
      results.push({ ruleId: 'keyboard-unreached', selector, status: 'needs-review',
        explanation: '在静态快照中未通过 Tab 到达此控件。请复核是否有其他键盘入口或组件导航。',
        evidence: { role, tabindex, completedTabCycle: complete } });
    }
    if (reached.has(selector) && tabindex > 0) {
      results.push({ ruleId: 'focus-order-positive-tabindex', selector, status: 'needs-review',
        explanation: 'Tab 到达了使用正 tabindex 的控件。请对照实际 Tab 次序和阅读顺序。',
        evidence: { tabindex, tabPosition: sequence.indexOf(selector) + 1 } });
    }
    if ((expanded === 'true' && controlledHidden === true) || (expanded === 'false' && controlledHidden === false)) {
      results.push({ ruleId: 'expanded-visibility-mismatch', selector, status: 'needs-review',
        explanation: '静态 aria-expanded 与唯一 aria-controls 目标的渲染状态不一致，需结合真实组件交互复核。',
        evidence: { expanded, controlledHidden } });
    }
  }
  return results;
}

export async function scanBehavior(page: Page, signal?: AbortSignal): Promise<BehaviorAudit> {
  const started = Date.now();
  const withinBudget = () => { signal?.throwIfAborted(); return Date.now() - started < BUDGET_MS; };
  const handles = await page.evaluateHandle(limit => {
    const selectorFor = (element: Element): string => {
      if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) return '#' + CSS.escape(element.id);
      const tag = CSS.escape(element.localName);
      const parent = element.parentElement;
      if (!parent) return tag;
      const index = Array.from(parent.children).filter(child => child.localName === element.localName).indexOf(element) + 1;
      return selectorFor(parent) + ' > ' + tag + ':nth-of-type(' + index + ')';
    };
    const shown = (element: Element) => element.getClientRects().length > 0
      && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const signature = (element: Element) => ['', '::before', '::after'].map(pseudo => {
      const style = getComputedStyle(element, pseudo || null);
      return [
        style.outlineStyle === 'none' ? '' : style.outline,
        style.boxShadow, style.border, style.backgroundColor, style.backgroundImage,
        style.color, style.textDecoration, style.content,
      ];
    }).flat().join('|');
    const native = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=true]';
    const widgets = '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=textbox],[role=combobox]';
    const candidates = document.querySelectorAll<HTMLElement>(native + ',' + widgets + ',[tabindex],img[alt]');
    const sampled: HTMLElement[] = [];
    let truncated = false;
    for (const element of candidates) {
      if (!shown(element) || element.matches(':disabled') || element.closest('[inert]')) continue;
      if (sampled.length === limit) { truncated = true; break; }
      sampled.push(element);
    }
    const controls: Control[] = sampled.map(element => {
      const target = element.getAttribute('aria-controls')?.trim();
      const targets = target && !/\s/.test(target) ? document.querySelectorAll('#' + CSS.escape(target)) : [];
      const checked = element.getAttribute('aria-checked');
      const selected = element.getAttribute('aria-selected');
      const context = element.closest<HTMLElement>('label,fieldset,figure,li,p') ?? element.parentElement;
      return {
        selector: selectorFor(element),
        role: element.getAttribute('role') || element.localName,
        tabindex: element.tabIndex,
        radio: element.matches('input[type=radio], [role=radio]'),
        managed: Boolean(element.closest('[role=tablist],[role=radiogroup],[role=listbox],[role=menu],[role=tree],[role=grid],[role=toolbar]')),
        tabbableCandidate: element.matches(native + ',' + widgets),
        focusStyle: document.activeElement === element ? null : signature(element),
        declaredState: checked !== null ? { name: 'checked', value: checked } : selected !== null ? { name: 'selected', value: selected } : null,
        expanded: element.getAttribute('aria-expanded'),
        controlledHidden: targets.length === 1 ? !shown(targets[0]) : null,
        kind: element.matches('img') ? 'image' : element.matches('input:not([type=button],[type=submit],[type=reset],[type=image]),select,textarea,[role=textbox],[role=combobox]') ? 'form' : 'action',
        context: context?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 260) ?? '',
      };
    });
    return {
      controls, truncated,
      readFocus() {
        const element = document.activeElement;
        if (!element || element === document.body || element === document.documentElement) return null;
        return { selector: selectorFor(element), focusStyle: signature(element), focusVisible: element.matches(':focus-visible') };
      },
    };
  }, MAX_CONTROLS);
  try {
    const { controls, truncated } = await handles.evaluate(value => ({ controls: value.controls, truncated: value.truncated }));
    const bySelector = new Map(controls.map(control => [control.selector, control]));
    const tabSequence: string[] = [];
    const seen = new Set<string>();
    const findings: BehaviorFinding[] = [];
    let complete = false;
    let rootVisits = (await handles.evaluate(value => value.readFocus())) ? 0 : 1;
    for (let step = 0; step < MAX_TAB_STEPS && withinBudget(); step++) {
      await page.keyboard.press('Tab');
      const active = await handles.evaluate(value => value.readFocus());
      if (!active) {
        if (++rootVisits === 2) { complete = true; break; }
        continue;
      }
      if (seen.has(active.selector)) { complete = true; break; }
      seen.add(active.selector);
      tabSequence.push(active.selector);
      const control = bySelector.get(active.selector);
      if (control && active.focusStyle === control.focusStyle) {
        findings.push({ ruleId: 'focus-style-unchanged', selector: active.selector, status: 'needs-review',
          explanation: '实际 Tab 聚焦后，目标元素与其伪元素的主要计算样式未观察到变化。请检查外层焦点样式与实际可见性。',
          evidence: { focusVisiblePseudoClass: active.focusVisible, tabPosition: tabSequence.length, sampledStylesChanged: false } });
      }
    }
    findings.push(...keyboardFindings(controls, tabSequence, complete));
    const semanticCandidates: SemanticCandidate[] = [];
    const session = await page.context().newCDPSession(page);
    let candidatesChecked = 0;
    try {
      const { root } = await session.send('DOM.getDocument');
      for (const control of controls) {
        if (!withinBudget()) break;
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: control.selector });
        if (!nodeId) continue;
        const { nodes: [node] } = await session.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
        if (!node) continue;
        candidatesChecked++;
        const role = typeof node.role?.value === 'string' ? node.role.value : '';
        const name = typeof node.name?.value === 'string' ? node.name.value : '';
        if (node.ignored && seen.has(control.selector)) {
          findings.push({ ruleId: 'focused-node-ignored', selector: control.selector, status: 'observed',
            explanation: '此元素在静态快照中获得了 Tab 焦点，但 Chromium 将该节点标记为忽略。',
            evidence: { role, name, ignored: true } });
        }
        if (node.ignored) continue;
        if (control.tabbableCandidate && ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem'].includes(role) && !name.trim()) {
          findings.push({ ruleId: 'empty-computed-control-name', selector: control.selector, status: 'observed',
            explanation: 'Chromium 为此交互控件计算出的可访问名称为空。此记录可与 axe 规则证据重复。',
            evidence: { role, name, ignored: false } });
        }
        if (control.tabbableCandidate && control.role !== role && ['generic', 'none', 'presentation'].includes(role)) {
          findings.push({ ruleId: 'generic-interactive-role', selector: control.selector, status: 'needs-review',
            explanation: '交互候选元素的浏览器角色缺少具体控件语义。',
            evidence: { declaredRole: control.role, role, name } });
        }
        const declared = control.declaredState;
        if (declared && ['true', 'false', 'mixed'].includes(declared.value)) {
          const property = node.properties?.find(property => property.name === declared.name);
          const actual = property ? String(property.value.value) : null;
          if (actual !== declared.value) findings.push({
            ruleId: 'widget-state-not-reflected', selector: control.selector, status: 'needs-review',
            explanation: '静态 ARIA 状态未按声明值出现在 Chromium 无障碍树，请结合控件角色和真实交互复核。',
            evidence: { role, state: declared.name, declared: declared.value, actual },
          });
        }
        if (name.trim() && (control.tabbableCandidate || control.kind === 'image')) {
          semanticCandidates.push({ selector: control.selector, role, name: name.slice(0, 300), kind: control.kind, context: control.context });
        }
      }
    } finally { await session.detach(); }
    const limitations = [...limitNotes];
    if (!complete) limitations.push('Tab 序列达到检查时间或步数上限，未观察到完整循环。');
    if (truncated || candidatesChecked < controls.length) limitations.push('达到候选元素或执行时间上限，语义采样不完整。');
    return { status: !complete || truncated || candidatesChecked < controls.length ? 'partial' : 'completed',
      tabSequence, candidatesChecked, findings, limitations, semanticCandidates };
  } finally { await handles.dispose(); }
}

export function unavailableBehavior(): BehaviorAudit {
  return { status: 'unavailable', tabSequence: [], candidatesChecked: 0, findings: [],
    limitations: [...limitNotes, '浏览器行为检测未完成。此扫描的 axe 规则证据仍可使用。'], semanticCandidates: [] };
}
