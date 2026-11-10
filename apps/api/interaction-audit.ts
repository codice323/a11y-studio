import type { Page } from 'playwright-core';
import type { InteractionFinding } from '../../packages/shared/panorama';

export async function readInteractionState(page: Page) {
  return page.evaluate(() => {
    const dom = {
      key(node: Element) {
        if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) return '#' + CSS.escape(node.id);
        const parts = [];
        for (let element: Element | null = node; element && element !== document.body; element = element.parentElement) {
          const index = Array.from(element.parentElement?.children ?? []).indexOf(element);
          parts.unshift(element.localName + ':nth-child(' + (index + 1) + ')');
        }
        return parts.length ? 'body > ' + parts.join(' > ') : '';
      },
      visible(node: Element) {
        if (!node.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && !node.closest('[hidden],[inert]');
      },
    };
    const active = document.activeElement;
    const focus = active && active !== document.body && active !== document.documentElement ? dom.key(active) : '';
    const modal = Array.from(document.querySelectorAll(':modal,[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]'))
      .filter(dom.visible).slice(-1)[0];
    const expanded = Array.from(document.querySelectorAll('[aria-expanded][aria-controls]')).slice(0, 40).flatMap(node => {
      const ids = (node.getAttribute('aria-controls') ?? '').trim().split(/\s+/);
      const panels = ids.length === 1 && ids[0] ? document.querySelectorAll('#' + CSS.escape(ids[0])) : [];
      const value = node.getAttribute('aria-expanded');
      return panels.length === 1 && dom.visible(node) && (value === 'true' || value === 'false')
        ? [{control:dom.key(node),panel:dom.key(panels[0]),expanded:value === 'true',visible:dom.visible(panels[0])}] : [];
    });
    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"],:user-invalid')).filter(dom.visible).slice(0,24).map(node => {
      const ids = ((node.getAttribute('aria-describedby') ?? '') + ' ' + (node.getAttribute('aria-errormessage') ?? '')).trim().split(/\s+/);
      const referenced = ids.some(id => {
        const matches = id ? document.querySelectorAll('#' + CSS.escape(id)) : [];
        return matches.length === 1 && Boolean(matches[0].textContent?.trim());
      });
      return {selector:dom.key(node),referenced};
    });
    return {
      path:location.pathname + location.hash, focus, title:document.title, heading:document.querySelector('main h1,h1')?.textContent?.trim() ?? '',
      modal:modal ? {selector:dom.key(modal),focusInside:Boolean(active && modal.contains(active))} : null,
      expanded, invalid,
      live:Array.from(document.querySelectorAll('[role=status],[role=alert],[aria-live]')).slice(0,30)
        .map(node => [dom.key(node),node.getAttribute('aria-live'),node.textContent?.trim().slice(0,200)]),
    };
  });
}

type State = Awaited<ReturnType<typeof readInteractionState>>;
type NativeInvalid = {id:string;referenced:boolean};

export function createInteractionAudit() {
  let opener = '';
  let tabStreak = 0;
  return (before: State, after: State, action: string, step: number, activated = '', nativeInvalid: NativeInvalid[] = []) => {
    const findings: InteractionFinding[] = [];
    const add = (ruleId: string, selector: string, explanation: string, status: InteractionFinding['status'] = 'needs-review') => {
      findings.push({ruleId,selector,explanation,status,step});
    };

    if (after.modal && after.modal.selector !== before.modal?.selector) {
      opener = activated || before.focus;
      if (!after.modal.focusInside) add('modal-focus-entry',after.modal.selector,'打开模态弹窗后焦点未进入弹窗。','confirmed');
    }
    if (before.modal && !after.modal && opener) {
      if (after.focus !== opener) add('modal-focus-return',opener,'关闭模态弹窗后焦点没有回到触发控件。请确认是否有合理的流程目标。');
      opener = '';
    }
    const keyboard = action === 'tab' || action === 'shift-tab';
    tabStreak = keyboard && before.focus && before.focus === after.focus && !after.modal ? tabStreak + 1 : 0;
    if (tabStreak === 3) add('repeated-tab-focus',after.focus,'三次 Tab 或 Shift+Tab 后焦点停留在同一控件。需检查是否存在合理的退出方式。');
    if (keyboard && after.modal && before.modal?.selector === after.modal.selector && before.modal.focusInside && !after.modal.focusInside && after.focus) {
      add('modal-tab-escape',after.focus,'模态弹窗保持打开，但 Tab 将焦点移到弹窗之外。','confirmed');
    }
    if (keyboard && before.focus && !after.focus && after.modal && before.modal?.selector === after.modal.selector) {
      add('modal-focus-lost',after.modal.selector,'弹窗仍打开，Tab 后没有可定位的文档焦点。请核实焦点是否移到浏览器界面。');
    }
    if (action === 'click') for (const panel of after.expanded) {
      const previous = before.expanded.find(item => item.control === panel.control && item.panel === panel.panel);
      if (panel.control === activated && previous && previous.visible === previous.expanded &&
          previous.visible !== panel.visible && panel.expanded !== panel.visible) {
        add('expanded-state-mismatch',panel.control,'操作改变了关联区域的可见性，但 aria-expanded 未反映变化。请核对折叠区域的实际用途。');
      }
    }
    if (action === 'validate' || action === 'fill') for (const field of after.invalid) {
      if (!field.referenced && !before.invalid.some(item => item.selector === field.selector) &&
          (action !== 'validate' || nativeInvalid.length)) {
        add('form-error-association',field.selector,'操作后字段进入错误状态，未找到可解析的关联错误文本。需核实浏览器提示及实际播报。');
      }
    }
    if (before.path !== after.path && before.title === after.title && before.heading === after.heading && before.focus === after.focus) {
      add('route-context-unchanged','','导航后标题、主标题和焦点均未变化。请确认辅助技术能否感知新的页面上下文。');
    }
    if (JSON.stringify(before.live) !== JSON.stringify(after.live)) {
      add('live-region-changed','','操作后实时区域发生变化。请通过辅助技术确认更新是否得到适当播报。','observed');
    }
    return findings;
  };
}
