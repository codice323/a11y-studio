import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import { isWebsiteVerificationPage, verificationPageMessage } from './page-diagnostics';
import { browserCapture } from './browser-capture';
import { sanitizedHtml } from './scan';
import { project, safePath, snapshot, snapshotDir } from './storage';

import { latestSnapshotAudit, projectVerifications } from './version-state';

const raster = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/]+=*$/i;

export function captureComparison(projectId: string, version: string, candidate?: {directory:string; entry:string; selector:string}) {
  const capture = browserCapture(projectId);
  if (!capture) throw new Error('此项目没有浏览器采集副本。');
  const record = snapshot(projectId, version);
  const source = fs.readFileSync(safePath(candidate?.directory ?? snapshotDir(projectId, version), candidate?.entry ?? record.entry), 'utf8');
  const $ = cheerio.load(sanitizedHtml(source));
  const viewport = capture.viewport as { width: number; height: number };
  const renderedBody = $('body').clone();
  renderedBody.find('[hidden],script,style,template').remove();
  if (isWebsiteVerificationPage($('title').first().text(),renderedBody.text().trim().slice(0,12000))) {
    return { html:'', blocked:verificationPageMessage, viewport };
  }
  // Audit selectors can depend on attributes such as target that the interactive copy removes.
  const attribute = 'data-a11y-comparison-anchor';
  $(`[${attribute}]`).removeAttr(attribute);
  const current = project(projectId).current_snapshot as string;
  const selectors = new Set([
    ...[...new Set([version, current])].flatMap(id => (latestSnapshotAudit(projectId, id)?.issues ?? []).map(issue => issue.selector)),
    ...projectVerifications(projectId).flatMap(item => item.sourceTarget ? [item.sourceTarget] : []),
  ]);
  if (candidate) selectors.add(candidate.selector);
  const anchors: Record<string, string> = Object.create(null);
  let nextAnchor = 0;
  for (const selector of selectors) {
    if (!selector || selector.length > 2000) continue;
    try {
      const match = $(selector);
      if (match.length !== 1) continue;
      const key = match.attr(attribute) ?? String(++nextAnchor);
      match.attr(attribute, key);
      anchors[selector] = key;
    } catch { /* Browser-only selectors can still be tried against the rendered copy. */ }
  }
  $('link, meta, frame, frameset, portal, fencedframe, audio, video, source, animate, animateMotion, animateTransform, set').remove();
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    const node = $(element);
    const sourceLink = node.attr('href');
    for (const [attribute, value] of Object.entries(element.attribs)) {
      const name = attribute.toLowerCase();
      const fragment = value.startsWith('#');
      if (
        (['href', 'xlink:href'].includes(name) && !fragment) ||
        (name === 'src' && (element.name !== 'img' || !raster.test(value))) ||
        ['srcset', 'background', 'poster', 'ping', 'target', 'download', 'action', 'formaction', 'autofocus', 'nonce'].includes(name)
      ) node.removeAttr(attribute);
    }
    if (element.name === 'a' && !node.attr('href')) {
      // Keep links working in projects saved before the capture attribute was renamed.
      const destination = node.attr('data-a11y-capture-href') ?? node.attr('data-a11y-reading-href') ?? sourceLink;
      if (destination && destination.length <= 2048) {
        try {
          const url = new URL(destination);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
            node.attr('href',url.href);
          }
        } catch { /* Relative destinations need an original page URL. */ }
      }
    }
  });
  const nonce = randomBytes(18).toString('base64');
  $('head').prepend(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">`);
  $('body').append(`<script nonce="${nonce}">
    (() => {
      const root = document.scrollingElement;
      let mirrored = null;
      function position() { return { x: root.scrollLeft, y: root.scrollTop }; }
      addEventListener('scroll', () => {
        const { x, y } = position();
        if (mirrored && x === mirrored.x && y === mirrored.y) { mirrored = null; return; }
        mirrored = null;
        parent.postMessage({ type: 'a11y-capture-scroll', x, y }, '*');
      }, { passive: true });
      let target, marker;
      const marked = new Map();
      function markGroup(selectors, primary) {
        for (const selector of selectors) {
          if (typeof selector !== 'string' || selector.length > 2000 || /^(html|body|:root)$/i.test(selector.trim())) continue;
          try {
            const matches = document.querySelectorAll(selector);
            const node = matches[0];
            if (matches.length !== 1 || node === primary || marked.has(node)) continue;
            marked.set(node, [node.style.getPropertyValue('outline'), node.style.getPropertyPriority('outline')]);
            node.style.setProperty('outline', '4px solid #af341a', 'important');
          } catch { /* Ignore unavailable selectors. */ }
        }
      }
      const resize = new ResizeObserver(updateMarker);
      function clearMarker() {
        for (const [node, [value, priority]] of marked) node.style.setProperty('outline', value, priority);
        marked.clear();
        resize.disconnect();
        marker?.remove();
        target = marker = undefined;
      }
      function updateMarker() {
        if (!marker || !target) return;
        const rect = target.getBoundingClientRect();
        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const width = Math.min(innerWidth, rect.right) - x;
        const height = Math.min(innerHeight, rect.bottom) - y;
        marker.style.display = width > 0 && height > 0 ? 'block' : 'none';
        Object.assign(marker.style, {
          left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px',
        });
        marker.firstElementChild.style.bottom = y < 36 ? 'auto' : '100%';
        marker.firstElementChild.style.top = y < 36 ? '100%' : 'auto';
      }
      addEventListener('scroll', updateMarker, { passive: true, capture: true });
      addEventListener('resize', updateMarker, { passive: true });
      function locate(selector, selectors) {
        clearMarker();
        let matches;
        try { matches = document.querySelectorAll(selector); } catch { return { status: 'missing' }; }
        if (matches.length !== 1) return { status: matches.length > 1 ? 'ambiguous' : 'missing' };
        const element = matches[0];
        markGroup(selectors, element);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const hidden = style.visibility !== 'visible' || style.display === 'none' ||
          (!element.getClientRects().length && style.display !== 'contents');
        const evidence = () => ({
          tag: element.localName,
          id: (element.id || '').slice(0, 200),
          role: element.getAttribute('role')?.slice(0, 200) ?? null,
          attributes: element.getAttributeNames().filter(name => name.startsWith('aria-')).slice(0, 24),
          tabIndex: element.getAttribute('tabindex')?.slice(0, 12) ?? null,
        });
        if (hidden) return { status: 'hidden', node: evidence() };
        if (!rect.width || !rect.height) {
          // A semantic-only node has no box. Its nearest rendered container gives page context.
          let container = element.parentElement;
          while (container && !container.getClientRects().length) container = container.parentElement;
          container?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
          mirrored = position();
          return { status: 'noBox', node: evidence() };
        }
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        mirrored = position();
        target = element;
        marker = document.createElement('div');
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText = 'all:initial;position:fixed;box-sizing:border-box;z-index:2147483647;pointer-events:none;border:4px solid #af341a;box-shadow:inset 0 0 0 2px white,0 0 0 2px white;background:#f3762926';
        const label = document.createElement('span');
        label.textContent = '问题位置';
        label.style.cssText = 'all:initial;position:absolute;bottom:100%;left:0;white-space:nowrap;background:#9f3019;color:white;font:700 20px system-ui;padding:4px 8px;pointer-events:none';
        marker.append(label);
        document.documentElement.append(marker);
        resize.observe(target);
        updateMarker();
        if (marker.style.display === 'none') { clearMarker(); return { status: 'outside', node: evidence() }; }
        return { status: 'located' };
      }
      addEventListener('message', event => {
        if (event.source !== parent) return;
        const data = event.data;
        if (data?.type === 'a11y-capture-locate' && typeof data.token === 'string') {
          if (data.selector === null) { clearMarker(); return; }
          if (typeof data.selector !== 'string' || !data.selector || data.selector.length > 2000) return;
          const result = locate(data.selector, Array.isArray(data.selectors) ? data.selectors.slice(0,300) : []);
          parent.postMessage({ type: 'a11y-capture-location', token: data.token, ...result }, '*');
        } else if (data?.type === 'a11y-capture-scroll' && Number.isFinite(data.x) && Number.isFinite(data.y)) {
          root.scrollTo({ left: data.x, top: data.y, behavior: 'instant' });
          mirrored = position();
        }
      });
      document.addEventListener('submit', event => event.preventDefault(), true);
      document.addEventListener('click', event => {
        const control = event.target.closest?.('button,input[type=button],[role=button],[role=tab]');
        if (control && !control.matches('summary,[type=reset]') && !control.closest('a[href]')) {
          parent.postMessage({type:'a11y-capture-control-unavailable'}, '*');
        }
        const link = event.target.closest?.('a,area');
        const fragment = link?.getAttribute('href') ?? link?.getAttribute('xlink:href');
        if (fragment && /^https?:/i.test(fragment)) {
          event.preventDefault();
          parent.postMessage({type:'a11y-capture-link-unavailable'}, '*');
          return;
        }
        if (!fragment?.startsWith('#')) return;
        event.preventDefault();
        if (fragment === '#') { root.scrollTo(0, 0); return; }
        try {
          const id = decodeURIComponent(fragment.slice(1));
          (document.getElementById(id) || document.getElementsByName(id)[0])?.scrollIntoView();
        } catch { /* A malformed fragment has no local target. */ }
      }, true);
    })();
  </script>`);
  const retained = new Set($(`[${attribute}]`).map((_, node) => $(node).attr(attribute)!).get());
  for (const [selector, key] of Object.entries(anchors)) {
    if (!retained.has(key)) delete anchors[selector];
  }
  return { html: $.html(), anchors, candidateSelector: candidate?.selector, viewport };
}
