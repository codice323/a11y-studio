import { useEffect, useRef, useState, type UIEvent } from 'react';
import type { Semantics } from './semantics';
import type { Bounds } from './types';

export type SemanticResult = { before: Semantics; after: Semantics | null };

export type ScreenshotData = { title: string; src?: string; bounds?: Bounds | null; size?: { width: number; height: number }; location?: string; locationStatus?: string; emptyText?: string };

export function syncScreenshotScroll(source: HTMLDivElement, target: HTMLDivElement | null) {
  if (!target) return;
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  const ratio = sourceRange > 0 ? source.scrollTop / sourceRange : 0;
  const top = ratio * targetRange;
  if (Math.abs(target.scrollTop - top) > 1) target.scrollTo({ top });
}

export function Screenshot({ title, src, bounds, size, location, locationStatus = '暂无元素定位', emptyText = '此版本暂无截图。', scale, onViewport, onScroll }: ScreenshotData & {
  scale?: number; onViewport?: (node: HTMLDivElement | null) => void; onScroll?: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  function center() {
    const pane = viewport.current;
    const target = marker.current;
    if (!pane || !target) return;
    const frame = pane.getBoundingClientRect();
    const point = target.getBoundingClientRect();
    pane.scrollTo({
      top: pane.scrollTop + point.top - frame.top - (pane.clientHeight - point.height) / 2,
      left: pane.scrollLeft + point.left - frame.left - (pane.clientWidth - point.width) / 2,
    });
  }
  useEffect(center, [bounds, size, zoomed, scale]);
  const locate = bounds && size && size.width > 0 && size.height > 0;
  return <figure className="shot">
    <figcaption>{title}</figcaption>
    {src && !failed ? <div className="screen-wrap" ref={node => { viewport.current = node; onViewport?.(node); }} tabIndex={0} role="region" aria-label={title + '截图'} onScroll={onScroll}>
      <div className={`screen-image${zoomed && !scale ? ' zoomed' : ''}`} style={scale ? { width: `${scale}%` } : undefined}>
        <img src={src} alt={title + '的页面截图'} onLoad={center} onError={() => setFailed(true)} />
        {locate && <div ref={marker} className="highlight" aria-hidden="true" style={{
          left: `${bounds.x / size.width * 100}%`, top: `${bounds.y / size.height * 100}%`,
          width: `${bounds.width / size.width * 100}%`, height: `${bounds.height / size.height * 100}%`,
        }} />}
      </div>
    </div> : <p className="shot-empty">{failed ? '截图缺失或加载失败。' : emptyText}</p>}
    {src && !failed && <div className="shot-foot">
      {locate ? <button type="button" title={location} onClick={center}>定位元素</button> : <span>{locationStatus}</span>}
      {!scale && <button type="button" aria-label={`放大${title}`} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>放大 150%</button>}
      <a href={src} download={src.startsWith('data:') ? '候选页面.jpg' : undefined}
        target={src.startsWith('data:') ? undefined : '_blank'} rel="noreferrer"
        aria-label={src.startsWith('data:') ? '下载完整截图（' + title + '）' : `打开完整截图（${title}，新标签页）`}>完整截图</a>
    </div>}
  </figure>;
}

export function EnlargedComparison({ left, right }: { left: ScreenshotData; right: ScreenshotData }) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(() => window.matchMedia('(max-width: 720px)').matches ? 300 : 150);
  const [layout, setLayout] = useState<'both' | 'left' | 'right'>('both');
  const [sync, setSync] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const panes = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({ left: null, right: null });
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    close.current?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  function syncScroll(side: 'left' | 'right', event: UIEvent<HTMLDivElement>) {
    if (!sync || layout !== 'both') return;
    const source = event.currentTarget;
    const target = panes.current[side === 'left' ? 'right' : 'left'];
    if (!target) return;
    const horizontal = source.scrollWidth - source.clientWidth;
    const vertical = source.scrollHeight - source.clientHeight;
    const x = horizontal > 0 ? source.scrollLeft / horizontal : 0;
    const y = vertical > 0 ? source.scrollTop / vertical : 0;
    const leftPos = x * (target.scrollWidth - target.clientWidth);
    const topPos = y * (target.scrollHeight - target.clientHeight);
    if (Math.abs(target.scrollLeft - leftPos) > 1 || Math.abs(target.scrollTop - topPos) > 1) target.scrollTo({ left: leftPos, top: topPos });
  }

  return <>
    <button type="button" className="secondary enlarge-comparison" disabled={!left.src && !right.src} onClick={() => setOpen(true)}>放大对比</button>
    {open && <dialog ref={dialog} className="comparison-dialog" aria-labelledby="large-comparison-title" aria-describedby="large-comparison-help" onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <div className="large-comparison-header"><div><h2 id="large-comparison-title">放大查看页面对比</h2><p id="large-comparison-help">放大后可上下、左右滚动截图，比例以面板宽度为基准。同步滚动按页面比例对齐；页面布局变化时位置可能不同。</p></div>
        <button ref={close} type="button" className="secondary" onClick={() => setOpen(false)}>关闭对比</button></div>
      <div className="large-comparison-controls">
        <div className="shot-options" role="group" aria-label="大图排列">
          {([['both', '并排查看'], ['left', '只看左侧'], ['right', '只看右侧']] as const).map(([value, text]) =>
            <button key={value} type="button" aria-pressed={layout === value} onClick={() => setLayout(value)}>{text}</button>)}
        </div>
        <div className="shot-options" role="group" aria-label="截图放大比例">
          {[100, 150, 200, 300].map(value => <button key={value} type="button" aria-pressed={scale === value} onClick={() => setScale(value)}>{value}%</button>)}
        </div>
        <label className="sync-scroll"><input type="checkbox" checked={sync} disabled={layout !== 'both'} onChange={event => setSync(event.target.checked)} />同步滚动{layout !== 'both' && '（并排时生效）'}</label>
      </div>
      <div className={layout === 'both' ? 'shots' : 'shots single-shot'}>
        {(layout === 'both' || layout === 'left') && <Screenshot {...left} scale={scale} onViewport={node => { panes.current.left = node; }} onScroll={event => syncScroll('left', event)} />}
        {(layout === 'both' || layout === 'right') && <Screenshot {...right} scale={scale} onViewport={node => { panes.current.right = node; }} onScroll={event => syncScroll('right', event)} />}
      </div>
    </dialog>}
  </>;
}

export function SemanticTable({ result, repaired, afterLabel, beforeLabel, compare = false }: { result: { before: Semantics | null; after: Semantics | null }; repaired?: boolean; afterLabel: string; beforeLabel?: string; compare?: boolean }) {
  const stateText = (item: Semantics) => item.states.map(([key, value]) => `${key}=${value}`).join(' · ') || '无记录的控件状态';
  const rows: [string, (item: Semantics) => string][] = [
    ['可访问名称', item => item.ignored ? '未暴露' : item.name || '（空）'],
    ['说明', item => item.ignored ? '未暴露' : item.description || '（空）'],
    ['角色', item => item.ignored ? '未暴露' : item.role || '无具名角色'],
    ['无障碍树', item => item.ignored ? '忽略' + (item.ignoredReasons.length ? `（${item.ignoredReasons.join('、')}）` : '') : '已暴露'],
    ['可聚焦性', item => item.focusable ? '可聚焦' : '不可聚焦'],
    ['控件状态', stateText],
  ];
  return <table className="semantic-table">
    <thead><tr><th scope="col">语义字段</th><th scope="col">{beforeLabel ?? (result.after ? repaired ? '修复前' : '原始版本' : '当前扫描版本')}</th>{(result.after || compare) && <th scope="col">{afterLabel}</th>}</tr></thead>
    <tbody>{rows.map(([label, value]) => {
      const old = result.before ? value(result.before) : '证据不可用';
      const next = result.after ? value(result.after) : '证据不可用';
      const changed = result.before && result.after && old !== next;
      return <tr key={label}><th scope="row">{label}</th><td>{old}</td>
        {(result.after || compare) && <td className={changed ? 'changed' : undefined}>{next}{changed && <small>已变化</small>}</td>}
      </tr>;
    })}</tbody>
  </table>;
}
