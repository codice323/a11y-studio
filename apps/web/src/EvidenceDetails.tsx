import { useEffect, useRef, useState } from 'react';
import type { Semantics } from './semantics';
import type { Bounds } from './types';

export type SemanticResult = { before: Semantics; after: Semantics | null };

export function Screenshot({ title, src, bounds, size, location, locationStatus = '暂无元素定位', emptyText = '此版本暂无截图。' }: {
  title: string; src?: string; bounds?: Bounds | null;
  size?: { width: number; height: number }; location?: string; locationStatus?: string; emptyText?: string;
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
  useEffect(center, [bounds, size, zoomed]);
  const locate = bounds && size && size.width > 0 && size.height > 0;
  return <figure className="shot">
    <figcaption>{title}</figcaption>
    {src && !failed ? <div className="screen-wrap" ref={viewport} tabIndex={0} role="region" aria-label={title + '截图'}>
      <div className={`screen-image${zoomed ? ' zoomed' : ''}`}>
        <img src={src} alt={title + '的页面截图'} onLoad={center} onError={() => setFailed(true)} />
        {locate && <div ref={marker} className="highlight" aria-hidden="true" style={{
          left: `${bounds.x / size.width * 100}%`, top: `${bounds.y / size.height * 100}%`,
          width: `${bounds.width / size.width * 100}%`, height: `${bounds.height / size.height * 100}%`,
        }} />}
      </div>
    </div> : <p className="shot-empty">{failed ? '截图缺失或加载失败。' : emptyText}</p>}
    {src && !failed && <div className="shot-foot">
      {locate ? <button type="button" title={location} onClick={center}>定位元素</button> : <span>{locationStatus}</span>}
      <button type="button" aria-label={`放大${title}`} aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>放大 150%</button>
      <a href={src} download={src.startsWith('data:') ? '候选页面.jpg' : undefined}
        target={src.startsWith('data:') ? undefined : '_blank'} rel="noreferrer"
        aria-label={src.startsWith('data:') ? '下载完整截图（' + title + '）' : `打开完整截图（${title}，新标签页）`}>完整截图</a>
    </div>}
  </figure>;
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
