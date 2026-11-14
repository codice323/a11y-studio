import type { Semantics } from './semantics';

export type SemanticResult = { before: Semantics; after: Semantics | null };

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
