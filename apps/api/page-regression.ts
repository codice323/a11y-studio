import { auditCandidate } from './scan';
import { walk } from './storage';

type Scope = { dir: string; entry: string; projectId: string; snapshotId: string };

export async function checkOtherPages(ctx: Scope, dir: string, signal?: AbortSignal) {
  const pages = walk(ctx.dir).filter(file => /\.html?$/i.test(file) && file !== ctx.entry).sort();
  if (pages.length > 8) throw new Error('附页超过自动复测上限（8 页）。请缩小补丁范围并人工检查共享样式。');
  for (const page of pages) {
    signal?.throwIfAborted();
    const before = await auditCandidate(ctx.projectId, ctx.snapshotId, ctx.dir, page, signal, undefined, true);
    const after = await auditCandidate(ctx.projectId, ctx.snapshotId, dir, page, signal, undefined, true);
    const previous = new Set(before.issues.map(issue => issue.id));
    const added = after.issues.filter(issue => !previous.has(issue.id));
    if (added.length) throw new Error(`跨页回归：${page} 新增 ${added.map(issue => issue.ruleId + ' ' + issue.selector).join('、')}。`);
    const a = before.detection.behavior, b = after.detection.behavior;
    if (a.status !== 'completed' || b.status !== 'completed') throw new Error(`无法完整复测 ${page} 的键盘行为，请人工检查。`);
    if (JSON.stringify([a.tabSequence,a.findings,before.functionChecks]) !== JSON.stringify([b.tabSequence,b.findings,after.functionChecks])) {
      throw new Error(`跨页回归：${page} 的 Tab、焦点证据或静态交互属性发生变化。`);
    }
    for (const [index, capture] of before.regression!.entries()) {
      const candidate = after.regression![index];
      if (capture.semantics !== candidate.semantics) throw new Error(`跨页回归：${page} 在 ${capture.width}px 的可访问语义发生变化。`);
      if (capture.style !== candidate.style) throw new Error(`跨页回归：${page} 在 ${capture.width}px 出现未授权的视觉变化（截图 SHA-256 ${capture.visual} → ${candidate.visual}）。`);
    }
  }
  return {name:'跨页复测',detail:pages.length ? `全部 ${pages.length} 个附页的 axe、Tab、语义与双视口计算样式未发现回归` : '当前快照没有其他 HTML 页面'};
}
