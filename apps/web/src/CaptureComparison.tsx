import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkspacePageDiagnostics } from '../../../packages/shared/page-diagnostics';
import { workspaceFetch } from './workspace-fetch';

type CaptureDocument = { html: string; blocked?: string; candidateSelector?: string; anchors?: Record<string, string>; viewport: { width: number; height: number } };
type Side = 'left' | 'right';

type LocationIssue = { id: string; selector: string };
type Selection = { id: string; attempt: number };
const locationMessages = {
  located: '已标出问题位置',
  missing: '此版本找不到对应元素',
  ambiguous: '此版本有多个匹配元素，无法准确定位',
  hidden: '已找到节点，当前版本将其隐藏',
  noBox: '已找到节点，此元素没有可高亮的画面区域',
  outside: '已找到节点，元素在预览的可见范围之外',
  unavailable: '网页未返回定位结果',
};

type NodeEvidence = { tag: string; id: string; role: string | null; attributes: string[]; tabIndex: string | null };

function CapturePane({ label, url, register, selector: requestedSelector, selection, active, onReplay, onBlocked, groupSelectors, initialScroll }: {
  groupSelectors?: string[];
  initialScroll?: number;
  label: string; url: string; register: (frame: HTMLIFrameElement | null) => void;
  selector?: string | null; selection?: Selection; active: boolean; onReplay?: () => void; onBlocked: (url: string, reason: string) => void;
}) {
  const [result, setResult] = useState<{ url: string; document?: CaptureDocument; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const container = useRef<HTMLDivElement>(null);
  const document = result?.url === url ? result.document : undefined;
  const selector = document?.candidateSelector ?? requestedSelector;
  const error = result?.url === url ? result.error : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void workspaceFetch(url, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '无法加载此版本的网页。');
      if (!controller.signal.aborted) {
        setResult({ url, document: body });
        if (body.blocked) onBlocked(url,body.blocked);
      }
    }).catch(problem => {
      if (!controller.signal.aborted) setResult({ url, error: problem.message });
    });
    return () => controller.abort();
  }, [url, retry, onBlocked]);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      if (contentRect.width > 0 && contentRect.height > 0) {
        setSize({ width: contentRect.width, height: contentRect.height });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState<CaptureDocument>();
  const [unavailable, setUnavailable] = useState<CaptureDocument>();
  useEffect(() => {
    if (!active || !loaded) return;
    function onControl(event: MessageEvent) {
      if (event.source === frame.current?.contentWindow && event.origin === 'null' &&
        ['a11y-capture-control-unavailable','a11y-capture-link-unavailable'].includes(event.data?.type)) setUnavailable(loaded);
    }
    window.addEventListener('message', onControl);
    return () => window.removeEventListener('message', onControl);
  }, [active, loaded]);
  const [location, setLocation] = useState<{ key: string; status: keyof typeof locationMessages; node?: NodeEvidence }>();
  const locationKey = JSON.stringify([url, retry, selection, selector, size.width, size.height, groupSelectors]);
  useEffect(() => {
    const child = frame.current?.contentWindow;
    if (!active || !child || !document || loaded !== document || !size.width || !size.height) return;
    if (!selector || !selection) {
      child.postMessage({ type: 'a11y-capture-locate', token: '', selector: null }, '*');
      return;
    }
    const token = locationKey;
    function onLocation(event: MessageEvent) {
      const data = event.data;
      if (event.source !== child || event.origin !== 'null' || data?.type !== 'a11y-capture-location' ||
          data.token !== token || !Object.hasOwn(locationMessages, data.status)) return;
      window.clearTimeout(timeout);
      setLocation({ key: token, status: data.status, node: data.node });
    }
    const timeout = window.setTimeout(() => setLocation({ key: token, status: 'unavailable' }), 2500);
    window.addEventListener('message', onLocation);
    function locatorFor(value: string) {
      const anchors = document?.anchors;
      const anchor = anchors && Object.hasOwn(anchors, value) ? anchors[value] : undefined;
      return anchor && /^\d+$/.test(anchor) ? `[data-a11y-comparison-anchor="${anchor}"]` : value;
    }
    const locator = locatorFor(selector);
    const selectors = groupSelectors?.map(locatorFor);
    // Let Chromium update the iframe's viewport before reading its geometry.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => child.postMessage({ type: 'a11y-capture-locate', token, selector: locator, selectors }, '*'));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(timeout);
      window.removeEventListener('message', onLocation);
    };
  }, [active, document, loaded, selector, selection, locationKey, size.width, size.height, groupSelectors]);

  const matched = location?.key === locationKey ? location : undefined;
  const status = !selection || error || document?.blocked ? undefined : selector === null ? '此版本没有可靠的元素位置' :
    matched ? locationMessages[matched.status] : '正在定位…';
  const node = status ? matched?.node : undefined;
  const viewport = document?.viewport;
  const scale = viewport ? Math.min(1, (size.width || viewport.width) / viewport.width) : 1;
  return <section className="capture-compare-pane" aria-label={label}>
    <h3>{label}</h3>
    {document && unavailable === document && <div className="capture-control-feedback">
      <p role="status">此操作需要原站页面或脚本。</p>
      {onReplay && <button type="button" className="secondary" onClick={onReplay}>切换到脚本回放</button>}
      <button type="button" className="secondary" onClick={() => setUnavailable(undefined)}>关闭提示</button>
    </div>}
    {document?.blocked && <p className="capture-compare-message" role="alert">{document.blocked}</p>}
    {status && <p className="capture-location-status" role="status">{status}</p>}
    {node && <dl className="capture-node-evidence" aria-label="节点语义证据">
      <dt>元素</dt><dd><code>{node.tag}{node.id && '#' + node.id}</code></dd>
      {node.role !== null && <><dt>ARIA 角色</dt><dd><code>{node.role || '空值'}</code></dd></>}
      {node.attributes.length > 0 && <><dt>ARIA 属性</dt><dd><code>{node.attributes.join('、')}</code></dd></>}
      {node.tabIndex !== null && <><dt>tabindex</dt><dd><code>{node.tabIndex || '空值'}</code></dd></>}
    </dl>}
    <div className="capture-compare-viewport" ref={container} hidden={Boolean(document?.blocked)}>
      {document?.blocked ? null : document && viewport ? <iframe ref={node => { frame.current = node; register(node); }} onLoad={() => {
        if (initialScroll !== undefined) {
          frame.current?.contentWindow?.postMessage({ type: 'a11y-capture-scroll', x: 0, y: initialScroll }, '*');
        }
        setLoaded(document);
      }}
        title={label + '网页'} sandbox="allow-scripts" srcDoc={document.html}
        style={{ width: viewport.width, height: Math.ceil((size.height || viewport.height) / scale), transform: `scale(${scale})` }} />
      : error ? <div className="capture-compare-message" role="alert">
        <span>{error}</span>
        <button className="secondary" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>重试</button>
      </div> : <p className="capture-compare-message" role="status">正在载入网页…</p>}
    </div>
  </section>;
}

export function CaptureComparison({ project, left, right, names, versions, onClose, onReplay, limitations, current, issue, active, candidateId, targetPair, afterSelector, onDiagnostics, single = false, groupSelectors, locateRevision = 0, initialScroll, positionRef }: {
  single?: boolean; groupSelectors?: string[]; locateRevision?:number;
  initialScroll?: number; positionRef?: { current: number };
  project: string; left: string; right: string; names: Record<Side, string>;
  current: string; issue?: LocationIssue; active: boolean; candidateId?: string; targetPair: { left:string; right:string }; afterSelector?:string;
  versions: ReactNode; onClose?: () => void; onReplay?: () => void; limitations: string[];
  onDiagnostics?: (result:WorkspacePageDiagnostics|undefined)=>void;
}) {
  const frames = useRef<Record<Side, HTMLIFrameElement | null>>({ left: null, right: null });
  const [sync, setSync] = useState(true);
  const [layout, setLayout] = useState<'both' | Side>(single ? 'right' : 'both');
  const [attempt, setAttempt] = useState(0);
  const [blocked, setBlocked] = useState<Record<string,string>>({});
  const reportBlocked = useCallback((url:string, reason:string) => setBlocked(previous=>({...previous,[url]:reason})), []);
  const selectedId = issue?.id;
  const selectedSelector = issue?.selector;
  const selection = useMemo(() => selectedId ? { id: selectedId, attempt:attempt+locateRevision } : undefined, [selectedId, attempt, locateRevision]);
  const canLocate = Boolean(selectedSelector && selectedSelector.length <= 2000 && !/^(?:html|body|:root)$/i.test(selectedSelector.trim()));
  const comparisonKey = JSON.stringify([project, left, right, selectedId, selectedSelector, selection?.attempt]);
  const [resolved, setResolved] = useState<{ key: string; selectors: Record<Side, string | null> }>();

  useEffect(() => {
    if (!active || !canLocate || !selectedId || !selectedSelector || (left === current && right === current)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ left, right, issueId: selectedId, selector: selectedSelector });
    void workspaceFetch(`/api/projects/${project}/compare?${params}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('无法读取版本定位。');
      const result = await response.json();
      if (!controller.signal.aborted) setResolved({ key: comparisonKey, selectors: {
        left: result.left?.selector ?? null, right: result.right?.selector ?? null,
      } });
    }).catch(() => {
      if (!controller.signal.aborted) setResolved({ key: comparisonKey, selectors: { left: null, right: null } });
    });
    return () => controller.abort();
  }, [active, canLocate, comparisonKey, current, left, project, right, selectedId, selectedSelector]);

  function selectorFor(side: Side) {
    if (!canLocate) return null;
    const version = side === 'left' ? left : right;
    if (afterSelector && version === targetPair.right) return afterSelector;
    if (version === targetPair.left || version === current) return selectedSelector;
    return resolved?.key === comparisonKey ? resolved.selectors[side] : undefined;
  }

  useEffect(() => {
    if (!active) return;
    const mirror = (event: MessageEvent) => {
      const { left, right } = frames.current;
      if (!event.source || event.origin !== 'null') return;
      const source = event.source === left?.contentWindow ? 'left' : event.source === right?.contentWindow ? 'right' : undefined;
      if (!source || (layout !== 'both' && layout !== source)) return;
      if (event.data?.type !== 'a11y-capture-scroll' || !Number.isFinite(event.data.x) || !Number.isFinite(event.data.y)) return;
      if (positionRef && single) positionRef.current = event.data.y;
      if (sync && layout === 'both') {
        frames.current[source === 'left' ? 'right' : 'left']?.contentWindow?.postMessage(event.data, '*');
      }
    };
    window.addEventListener('message', mirror);
    return () => window.removeEventListener('message', mirror);
  }, [active, sync, layout, positionRef, single]);
  useEffect(() => () => { onDiagnostics?.(undefined); }, [onDiagnostics]);

  const url = (version: string) => `/api/projects/${project}/browser-capture/comparison/${version}`;
  const rightUrl = candidateId ? `/api/proposals/${candidateId}/interactive-candidate` : url(right);
  const blockedReason = (layout !== 'right' && blocked[url(left)]) || (layout !== 'left' && blocked[rightUrl]);
  useEffect(() => {
    if (!active) return;
    onDiagnostics?.(blockedReason ? {
      kind:'live',projectId:project,version:right,path:'',status:'failed',error:blockedReason,
    } : undefined);
  },[active,blockedReason,onDiagnostics,project,right]);
  return <section className="capture-compare">
      <div className="capture-compare-controls">
        {versions}
        <div className="capture-compare-options">
          {!single && <><label>显示方式<select value={layout} onChange={event => setLayout(event.target.value as typeof layout)}>
            <option value="both">并排对比</option>
            <option value="left">放大左侧</option>
            <option value="right">放大右侧</option>
          </select></label>
          <label className="capture-compare-sync"><input type="checkbox" checked={sync} disabled={layout !== 'both'}
            onChange={event => setSync(event.target.checked)} />同步滚动</label></>}
          {canLocate && <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>重新定位</button>}
          {onReplay && !blockedReason && <button type="button" className="secondary" onClick={onReplay}>回放原站脚本</button>}
          {onClose && <button className="secondary" onClick={onClose}>返回诊断工作台</button>}
        </div>
      </div>
      {!blockedReason && <p className="muted capture-compare-note">版本副本支持滚动、页内跳转和原生表单控件。{candidateId ? '右侧展示待审核的补丁。' : onReplay ? '菜单、轮播等可切换到脚本回放测试。' : '此采集没有原站脚本回放资源。'}</p>}
      {limitations.length > 0 && <details className="capture-compare-note"><summary>查看采集限制</summary>
        <ul>{limitations.map(item => <li key={item}>{item}</li>)}</ul>
      </details>}
      <div className="capture-compare-grid" data-layout={layout}>
        {(single ? ['right'] as const : ['left','right'] as const).map(side => {
          const visible = layout === 'both' || layout === side;
          return <div key={side} hidden={!visible}>
            <CapturePane label={single ? names[side] : (side === 'left' ? '左侧' : '右侧') + ' · ' + names[side]} groupSelectors={groupSelectors} initialScroll={initialScroll}
              url={side === 'left' ? url(left) : rightUrl} register={node => { frames.current[side] = node; }}
              selector={selectorFor(side)} selection={selection} active={active && visible} onReplay={blockedReason ? undefined : onReplay} onBlocked={reportBlocked} />
          </div>;
        })}
      </div>
  </section>;
}
